/*
 ==============================================================================
 This file is part of hoast360, the open-source, higher-order Ambisonics, 360
 degree audio/video player.

 https://github.com/thomasdeppisch/hoast360

 Authors: Thomas Deppisch, Nils Meyer-Kahlen

 This program is free software: you can redistribute it and/or modify
 it under the terms of the GNU General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU General Public License for more details.

 You should have received a copy of the GNU General Public License
 along with this program.  If not, see <http://www.gnu.org/licenses/>.
 ==============================================================================
 */

// SegmentAudioFeed: self-driven audio path for the combined-MPD (live) mode.
//
// Chromium delays any Web Audio tap on an MSE-fed media element by a fixed
// wall-clock span (~2 s), regardless of liveDelay, dash.js buffer targets, the
// tap API, or element playbackRate. The only fix is to stop feeding the HOA
// graph from the element: this module taps the audio DASH segments dash.js is
// already fetching (fragmentLoadingCompleted carries the bytes), decodes them
// with decodeAudioData, and schedules the decoded N-channel buffers on the
// AudioContext clock, aligned to the video element's currentTime.
//
// Contract (binding):
//  - The video element is the sole master clock. This module never writes
//    currentTime, playbackRate, muted, or volume. When the video jumps
//    (seek, GapController), audio flushes and chases. If audio cannot keep
//    up it goes silent (bounded, logged); it never leads or drags the video.
//  - All drift correction is whole-buffer schedule-time correction applied
//    to not-yet-started chunks. Each chunk is one AudioBufferSourceNode
//    holding all N channels, so every correction moves all channels
//    identically and inter-channel phase coherence is structural. There is
//    no playbackRate and no resampling anywhere in this path.
//  - The HOA rendering graph is untouched: this module's output is a single
//    GainNode (feedBus) that the host connects to rotator.in.
//
// N (16 for 3OA, 25 for 4OA) is read from the first decoded buffer, never
// hardcoded; the host derives the ambisonic order from it.

"use strict";

const HORIZON_S = 12;        // decode + schedule this far ahead of the playhead
const RING_BACK_S = 30;      // encoded ring span behind the playhead
const RING_AHEAD_S = 45;     // and ahead (dash.js prefetches ~liveDelay worth)
const DEADBAND_S = 0.020;    // |drift| below this: do nothing
const STEP_MAX_S = 0.005;    // max schedule-time correction per chunk boundary
const HARD_RESYNC_S = 0.100; // |drift| above this: flush and re-anchor
const FADE_S = 0.003;        // micro-fade at corrections, holes, run starts
const RAMP_S = 0.020;        // feedBus mute ramp for flushes
const STALL_FADE_S = 0.050;  // slower fade when the element stalls
const PUMP_MS = 500;         // scheduler tick; also woken by events
const START_LEAD_S = 0.08;   // scheduling lead when starting a run
const JOIN_TOL_S = 0.030;    // chunk considered contiguous within this
// crossfade span at junctions, in samples: pair-decode makes the overlapped
// content of consecutive decodes identical, so a linear fade pair sums to 1.0
// exactly and the join is immune to engine start()-time quantization (real
// Safari rounds to 128-sample quanta; butt joints there tick every 2 s).
const XF_SMP = 256;
// live MPD refresh: reread when the horizon nears the snapshot's last known
// segment, rate-limited so a stalled edge cannot spin
const MPD_REFRESH_LEAD_S = 4;
const MPD_REFRESH_MIN_MS = 5000;
// run start: wait for this much decoded content before anchoring, so Safari's
// busy first seconds do not underrun-resync audibly before settling
// Cushion required before the first note sounds, and it is load-bearing.
// Moving decode into a worker looked like it should have made this cheap, so it
// was swept downward on 2026-08-26 to cut startup latency. It does not survive:
//   1.2  resync on the first run, re-anchor at 0.79 s
//   2.0  resync in 2 of 3 runs, same 0.79 s re-anchor
//   2.5  resync in 2 of 3 runs
//   3.5  clean across every run
// The re-anchor lands around 0.8 s and is audible as a drop, which is a worse
// artifact than the wait it buys back. Do not lower this without re-running
// seam-check several times: a single clean run means nothing here, all three
// lower values passed once before failing.
const MIN_START_AHEAD_S = 3.5;    // chunk considered contiguous within this
const WATCHDOG_S = 15;       // no audio fragments for this long: degrade
const STRIKE_WINDOW_S = 60;  // decode-failure strikes counted in this window
const STRIKE_LIMIT = 3;
const UNDERRUN_FLOOR_S = 0.1;  // fade out when scheduled audio runs this low
const REJOIN_DEPTH_S = 2;      // and rejoin only with this much decoded again

export default class SegmentAudioFeed {

    // opts: { context, getElement, onReady(N), onDegrade(reason) }
    constructor(opts) {
        this.ctx = opts.context;
        this.getElement = opts.getElement;
        this.onReady = opts.onReady || function () { };
        this.onDegrade = opts.onDegrade || function () { };

        this.feedBus = this.ctx.createGain();
        this.feedBus.gain.value = 1;

        this.epoch = 0;
        this.presentationShiftS = 0; // video elst delay Chromium ignores (audio placed earlier by this)
        this.inits = new Map();      // representationId -> { bytes, epoch, timecodeScale }
        this.ring = [];              // { epoch, t, dur, bytes } sorted by t
        this.decoded = new Map();    // key -> { t, dur, buffer, lastUse }
        this.inflight = new Set();
        this.nodes = [];             // { src, gain, ctxStart, endCtx, key }
        this.anchor = null;          // { ctxAt, mediaAt }: media m plays at ctxAt + (m - mediaAt)
        this.nextT = null;           // media time of the next junction
        this.nextCtx = null;         // context time of the next junction
        this.state = 'idle';         // idle | running | paused | stalled | underrun
        this.N = 0;
        this.destroyed = false;
        this.degraded = false;
        this.degradeReason = null;
        this.connectedTo = null;

        this.driftSamples = [];
        this.lastSampleElT = -1;
        this.freezeCount = 0;
        this.outputLatency = 0;
        this.pumpCount = 0;
        this.lastFragAt = performance.now();
        this.sawAudioFrag = false;
        this.strikes = [];
        this.retried = new Set();
        this.counters = { decodes: 0, decodeFails: 0, resyncs: 0, steps: 0, holes: 0, epochBumps: 0,
            xfades: 0, fadedJoins: 0 };
        // media times of the first faded joins, for after-the-fact diagnosis
        // of which junctions were not seamless. Bounded; diagnostics only.
        this.fadedAt = [];

        // Optional decode backend. Chromium's decodeAudioData handles 16-ch
        // Opus-in-fMP4 natively; Safari's does not, and WasmOpusBackend decodes
        // the identical bytes through libopus-in-WASM with the same contract
        // (see that file). Null means the native path, unchanged.
        this.decodeBackend = opts.decodeBackend || null;
        // Self-fetch mode, for engines whose MSE refuses the audio type: dash.js
        // then drops the audio AdaptationSet and never loads an audio byte, so
        // there is nothing to tap. The feed instead fetches audio segments
        // itself, keyed to the VIDEO fragments dash.js still loads: same muxer,
        // same seg_duration, aligned numbering, so video segment N maps to
        // audio segment N through the manifest's SegmentTemplates. Video
        // startTime stands in for audio startTime; the tracks' presentation
        // offsets differ only by the Opus pre-skip (~7 ms), inside the drift
        // deadband, and junction chaining owns placement after the first chunk.
        this.selfFetchAudio = !!opts.selfFetchAudio;
        // The binaural decoder runs cardioid placeholder filters until its
        // HRIRs load; audio scheduled before that is quiet and non-spatial,
        // then jumps in level when the real filters arrive. Hold the anchor
        // until the render is real. Decoding continues meanwhile, so the
        // cushion is already built when audio does start.
        this.renderReady = opts.renderReady !== false;
        this._sf = null;              // { aInitUrl, aMedia(n)->url, vNumberRe, dN }
        this._sfFetched = new Set();  // audio numbers fetched this epoch

        this.mp = null;
        this._onFrag = this._onFrag.bind(this);
        this._listeners = [];
        this._seekTimer = null;
        this._pump = this._pump.bind(this);
        this._pumpTimer = setInterval(this._pump, PUMP_MS);
        this._bindElement();
    }

    // ---- public API --------------------------------------------------------

    setRenderReady(v) {
        if (this.renderReady === !!v) return;
        this.renderReady = !!v;
        if (this.renderReady) this._pump();
    }

    attach(mediaPlayer) {
        if (this.destroyed || this.mp === mediaPlayer) return;
        this.detach();
        this.mp = mediaPlayer;
        if (this.selfFetchAudio) this._selfFetchSetup(mediaPlayer);
        // string literal on purpose: the inlined dash.js instance may not be
        // the same module as any imported dashjs, so shared event constants
        // cannot be assumed
        mediaPlayer.on('fragmentLoadingCompleted', this._onFrag);
    }

    detach() {
        if (this.mp) {
            try { this.mp.off('fragmentLoadingCompleted', this._onFrag); } catch (e) { /* already detached */ }
            this.mp = null;
        }
    }

    connectTo(destination) {
        if (this.destroyed) return;
        if (this.N > 0) {
            this.feedBus.channelCount = this.N;
            this.feedBus.channelCountMode = 'explicit';
            this.feedBus.channelInterpretation = 'discrete';
        }
        if (this.connectedTo !== destination) {
            try { this.feedBus.disconnect(); } catch (e) { /* already detached */ }
            this.feedBus.connect(destination);
            this.connectedTo = destination;
        }
        this._pump();
    }

    forceDegrade(reason) { this._degrade(reason); }

    stats() {
        const el = this.getElement();
        return {
            state: this.state, epoch: this.epoch, N: this.N,
            ring: this.ring.length, decoded: this.decoded.size,
            scheduled: this.nodes.length,
            drift: this._medianDrift(),
            scheduledAheadSec: this.nextCtx != null ? Math.max(0, this.nextCtx - this.ctx.currentTime) : 0,
            degraded: this.degraded,
            degradeReason: this.degradeReason,
            renderReady: this.renderReady,
            seams: this._seamLog || [], counters: this.counters,
            fadedAt: this.fadedAt,
            // axis corroboration: the ring's media span should bracket elT
            elT: el ? Math.round(el.currentTime * 100) / 100 : null,
            ringT0: this.ring.length ? Math.round(this.ring[0].t) : null,
            ringT1: this.ring.length ? Math.round(this.ring[this.ring.length - 1].t + this.ring[this.ring.length - 1].dur) : null,
            outputLatency: Math.round(this.outputLatency * 1000),
            presentationShiftMs: Math.round(this.presentationShiftS * 1000),
            // the design's per-epoch sanity constant: content axis (cluster
            // timestamp) minus placement axis (request.startTime) for the
            // newest ring entry; a large constant here means dash.js's segment
            // start times do not sit on the media PTS axis and placement must
            // compensate
            axisDeltaMs: this._axisDeltaMs(),
        };
    }

    // Net presentation delay from an fMP4 init segment's edit list: an empty
    // edit (media_time -1) delays the track by duration/movieTimescale, and
    // the first real edit's media_time trims head media. Firefox applies
    // this; Chromium MSE does not, so Chromium presents the track early by
    // the returned amount. Returns null when there is no edit list.
    _parseElstShiftS(b) {
        function u32(o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
        function find(fourcc, from) {
            for (let i = from; i < b.length - 4; i++)
                if (b[i] === fourcc.charCodeAt(0) && b[i + 1] === fourcc.charCodeAt(1)
                    && b[i + 2] === fourcc.charCodeAt(2) && b[i + 3] === fourcc.charCodeAt(3)) return i;
            return -1;
        }
        const elst = find('elst', 0);
        if (elst < 0) return null;
        let movieTs = 1000, mediaTs = 90000;
        const mvhd = find('mvhd', 0);
        if (mvhd > 0) movieTs = u32(mvhd + 4 + (b[mvhd + 4] === 1 ? 20 : 12)) || 1000;
        const mdhd = find('mdhd', 0);
        if (mdhd > 0) mediaTs = u32(mdhd + 4 + (b[mdhd + 4] === 1 ? 20 : 12)) || 90000;
        const ver = b[elst + 4];
        const count = u32(elst + 8);
        let p = elst + 12, shift = 0;
        for (let i = 0; i < count && p + (ver === 1 ? 20 : 12) <= b.length; i++) {
            let dur, mt;
            if (ver === 1) {
                dur = u32(p) * 4294967296 + u32(p + 4);
                const hi = u32(p + 8), lo = u32(p + 12);
                mt = (hi === 0xFFFFFFFF && lo === 0xFFFFFFFF) ? -1 : hi * 4294967296 + lo;
                p += 20;
            } else {
                dur = u32(p);
                mt = u32(p + 4); if (mt === 0xFFFFFFFF) mt = -1;
                p += 12;
            }
            if (mt === -1) shift += dur / movieTs;
            else { shift -= mt / mediaTs; break; }
        }
        return shift;
    }

    _masterTime(el) {
        // what Chromium actually displays: currentTime plus the edit-list
        // delay it ignored; audio chases the picture, not the DASH clock
        return el.currentTime + this.presentationShiftS;
    }

    _axisDeltaMs() {
        if (!this.ring.length) return null;
        const entry = this.ring[this.ring.length - 1];
        const init = this._initFor(entry.epoch);
        if (!init) return null;
        const c = this._clusterTimestampS(entry.bytes, init.timecodeScale);
        if (c == null) return null;
        return Math.round((c - entry.t) * 1000);
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.detach();
        clearInterval(this._pumpTimer);
        if (this._rebindTimer) clearInterval(this._rebindTimer);
        if (this._seekTimer) clearTimeout(this._seekTimer);
        this._listeners.forEach(function (l) { l.target.removeEventListener(l.type, l.fn, l.opts); });
        this._listeners = [];
        this._flush(0);
        try { this.feedBus.disconnect(); } catch (e) { /* already detached */ }
        this.ring = []; this.decoded.clear(); this.inits.clear(); this.inflight.clear();
        this._sfFetched.clear(); if (this._sfRetry) { clearTimeout(this._sfRetry); this._sfRetry = null; }
    }

    // ---- element coupling (read-only master clock) -------------------------

    _bindElement() {
        const self = this;
        const bindWhenPresent = function () {
            const el = self.getElement();
            if (!el || self._boundEl === el) return;
            self._boundEl = el;
            self._on(el, 'pause', function () { self._enterPaused(); });
            self._on(el, 'play', function () { self._resume(); });
            self._on(el, 'playing', function () { self._resume(); });
            self._on(el, 'seeking', function () { self._flush(RAMP_S); self.state = self.state === 'paused' ? 'paused' : 'stalled'; });
            self._on(el, 'seeked', function () {
                if (self._seekTimer) clearTimeout(self._seekTimer);
                // debounced: GapController can emit bursts of micro-jumps
                self._seekTimer = setTimeout(function () {
                    self._seekTimer = null;
                    if (!self.getElement() || self.getElement().paused) return; // audible rebuild waits for play
                    self._resume();
                }, 150);
            });
            self._on(el, 'waiting', function () { self._enterStalled(); });
        };
        bindWhenPresent();
        this._on(document, 'visibilitychange', function () { self._pump(); });
        this._rebindTimer = setInterval(bindWhenPresent, 1000);
    }

    _on(target, type, fn, opts) {
        target.addEventListener(type, fn, opts);
        this._listeners.push({ target: target, type: type, fn: fn, opts: opts });
    }

    _enterPaused() {
        // scheduled sources keep playing through a paused element unless
        // stopped: the classic trap. Fade, stop, keep all caches.
        this._flush(RAMP_S);
        this.state = 'paused';
    }

    _enterStalled() {
        if (this.state === 'stalled' || this.state === 'paused') return;
        this._flush(STALL_FADE_S);
        this.state = 'stalled';
    }

    _resume() {
        const el = this.getElement();
        if (!el || el.paused || this.destroyed || this.degraded) return;
        // IDEMPOTENT. Both 'play' and 'playing' land here, and at startup they
        // fire ~0.7 s apart: without this guard the second one tore down the
        // chain the first had just built and re-anchored it, an audible drop
        // inside the first second on every engine. A chain that is already
        // running against a live anchor needs nothing. Every path that does
        // want a rebuild ('seeking', 'waiting', 'pause') leaves the state
        // stalled or paused first, so this cannot swallow one of those.
        if (this.state === 'running' && this.anchor && this.nodes.length) return;
        // fresh anchor: drift is definitionally zero after a rebuild, so the
        // post-stall rule (never bridge stall residue with steps) holds
        this._flush(0);
        this.state = 'running';
        this.driftSamples = [];
        this._pump();
    }

    // ---- dash.js tap -------------------------------------------------------

    // ---- self-fetched audio (MSE-refused engines) --------------------------

    _selfFetchSetup(mediaPlayer) {
        const self = this;
        let mpdUrl = null;
        try { mpdUrl = mediaPlayer.getSource(); } catch (e) { /* not ready */ }
        if (!mpdUrl || typeof mpdUrl !== 'string') { this._sfRetry = setTimeout(function () { self._selfFetchSetup(mediaPlayer); }, 500); return; }
        // dash.js hands back whatever it was given, which may be a bare path;
        // template resolution below needs an absolute base
        try { mpdUrl = new URL(mpdUrl, document.baseURI).href; } catch (e) { /* leave as-is; the fetch will say */ }
        fetch(mpdUrl, { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('MPD HTTP ' + r.status);
            return r.text();
        }).then(function (xml) {
            if (self.destroyed) return;
            const doc = new DOMParser().parseFromString(xml, 'text/xml');
            const sets = doc.querySelectorAll('AdaptationSet');
            const audioSets = [];
            let v = null;
            sets.forEach(function (as) {
                const rep0 = as.querySelector('Representation');
                const ct = (as.getAttribute('contentType') || '')
                    || ((as.getAttribute('mimeType') || (rep0 || as).getAttribute('mimeType') || '').split('/')[0]);
                if (ct === 'audio') audioSets.push(as);
                if (ct === 'video' && !v) v = as;
            });
            // MORE THAN ONE AUDIO SET since the WebKit keep-alive track (silent
            // stereo AAC, there only to stop a backgrounded element being
            // suspended). Taking the first audio set worked purely because the
            // keep-alive happens to be appended last - nothing here controls
            // muxer order. Select by CODEC instead: this feed decodes through
            // libopus, so "is it Opus" is exactly the question that decides
            // whether the bytes are playable at all. Channel count only breaks
            // ties between Opus sets, so it stays correct at 4 (1OA), 16 (3OA)
            // and 25 (4OA) rather than hardcoding one order.
            const codecOf = function (as) {
                const rep = as.querySelector('Representation');
                return (((rep && rep.getAttribute('codecs')) || as.getAttribute('codecs') || '')).toLowerCase();
            };
            const chOf = function (as) {
                const acc = as.querySelector('AudioChannelConfiguration');
                const n = acc ? parseInt(acc.getAttribute('value') || '', 10) : NaN;
                return isFinite(n) ? n : -1;
            };
            let a = null;
            audioSets.forEach(function (as) {
                if (codecOf(as).indexOf('opus') < 0) return;
                if (!a || chOf(as) > chOf(a)) a = as;
            });
            if (!a) audioSets.forEach(function (as) {   // no Opus set: widest audio set
                if (!a || chOf(as) > chOf(a)) a = as;
            });
            if (!a || !v) throw new Error('MPD lacks an audio+video AdaptationSet pair');
            if (audioSets.length > 1)
                console.log('SegmentAudioFeed: ' + audioSets.length + ' audio sets, chose codecs="'
                    + codecOf(a) + '" ' + chOf(a) + 'ch');
            const tpl = function (as) {
                const st = as.querySelector('SegmentTemplate');
                if (!st) throw new Error('no SegmentTemplate (self-fetch supports the template shape this stack ships)');
                const rep = as.querySelector('Representation');
                const rid = rep ? (rep.getAttribute('id') || '0') : '0';
                const ex = function (t, n) {
                    t = t.split('$RepresentationID$').join(rid);
                    t = t.replace(/\$Number(%0(\d+)d)?\$/, function (m, f, w) {
                        let d = String(n); if (w) while (d.length < +w) d = '0' + d; return d;
                    });
                    return new URL(t, mpdUrl).href;
                };
                const ts = parseFloat(st.getAttribute('timescale') || '1');
                const pto = parseFloat(st.getAttribute('presentationTimeOffset') || '0') / ts;
                const startNum = parseInt(st.getAttribute('startNumber') || '1', 10);
                // WALK THE REAL TIMELINE, never a modal duration. This stack's
                // audio segments are NOT uniform: the box's own live manifest
                // carries d=96464/96440 splice segments among runs of d=96000
                // wherever the demo loop wraps. Grid arithmetic drops those
                // ~9.5 ms each, which both misplaces content (~11 ms/min of
                // audio-leads-video that the drift corrector cannot see, since
                // it measures against the same grid) and makes the crossfade
                // overlay non-identical content, blipping at every splice.
                const segs = [];   // { n, t, d } in presentation seconds
                const ss = st.querySelectorAll('SegmentTimeline > S');
                if (ss.length) {
                    let n = startNum, tTicks = null;
                    for (let i = 0; i < ss.length; i++) {
                        const S = ss[i];
                        const tAttr = S.getAttribute('t');
                        if (tAttr !== null) tTicks = parseFloat(tAttr);
                        const d = parseFloat(S.getAttribute('d') || '0');
                        const reps = parseInt(S.getAttribute('r') || '0', 10) + 1;
                        for (let k = 0; k < reps; k++) {
                            if (tTicks === null) tTicks = 0;
                            segs.push({ n: n++, t: tTicks / ts - pto, d: d / ts });
                            tTicks += d;
                        }
                    }
                }
                const fixed = st.getAttribute('duration')
                    ? parseFloat(st.getAttribute('duration')) / ts : null;
                return { init: ex(st.getAttribute('initialization') || '', 0),
                         media: function (n) { return ex(st.getAttribute('media') || '', n); },
                         start: startNum, segs: segs, fixed: fixed,
                         // @duration manifests have no timeline to walk; the
                         // grid IS the truth there, so it stays the fallback
                         segDur: fixed || (segs.length ? segs[0].d : null),
                         p0: segs.length ? segs[0].t : 0, pto: pto,
                         mediaTpl: st.getAttribute('media') || '', rid: rid };
            };
            const A = tpl(a), V = tpl(v);
            // regex that recovers N from a completed video fragment URL
            const esc = V.mediaTpl.split('$RepresentationID$').join(V.rid)
                .replace(/[.*+?^{}()|[\]\\]/g, '\\$&')
                .replace(/\\\$Number(%0\d+d)?\\\$/, '(\\d+)');
            self._sfFails = 0;
            const prevSf = self._sf;
            const next = { aInitUrl: A.init, aMedia: A.media, aStart: A.start,
                           segs: A.segs, segDur: A.segDur || V.segDur, p0: A.p0,
                           vNumberRe: new RegExp(esc + '$'), dN: A.start - V.start,
                           at: performance.now() };
            // A REBASED TIMELINE IS A DISCONTINUITY, whatever the init bytes
            // say. ffmpeg regenerates byte-identical audio inits across
            // restarts for an unchanged encoder config, so the init-compare
            // epoch bump never fires here; without this, the new run's segment
            // numbers collide with the old run's dedup keys and are skipped
            // silently until the numbering passes the old high-water mark -
            // minutes of total silence after a restart.
            if (prevSf && (prevSf.aStart !== next.aStart
                           || Math.abs((prevSf.p0 || 0) - (next.p0 || 0)) > 0.5)) {
                self.epoch++;
                self.counters.epochBumps++;
                self._sfFetched.clear();
            }
            self._sf = next;
            self._sfFetchInit();
        }).catch(function (e) {
            if (self.destroyed) return;
            const msg = (e && e.message) || String(e);
            // Structural manifest problems are permanent; a lost request is
            // not. Degrading on the first network miss cost the whole session,
            // and on Safari the element-audio path degraded TO is silent
            // (dash.js dropped the audio set), so this must retry like every
            // other fetch in this file does.
            const structural = /AdaptationSet|SegmentTemplate/.test(msg);
            self._sfFails = (self._sfFails || 0) + 1;
            if (structural || self._sfFails > 8) {
                self._degrade('self-fetch setup: ' + msg);
                return;
            }
            const backoff = Math.min(5000, 500 * Math.pow(2, self._sfFails - 1));
            if (self._sfRetry) clearTimeout(self._sfRetry);
            self._sfRetry = setTimeout(function () {
                self._sfRetry = null;
                if (!self.destroyed && self.mp) self._selfFetchSetup(self.mp);
            }, backoff);
        });
    }

    _sfFetchInit() {
        const self = this;
        fetch(this._sf.aInitUrl, { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('audio init HTTP ' + r.status);
            return r.arrayBuffer();
        }).then(function (ab) {
            if (self.destroyed) return;
            self._sfInitFails = 0;
            self._onFrag({ request: { mediaType: 'audio', type: 'InitializationSegment', selfFetched: true,
                                      representationId: '0' }, response: ab });
        }).catch(function (e) {
            if (self.destroyed) return;
            // the init URL is permanent: a miss is transient by definition
            self._sfInitFails = (self._sfInitFails || 0) + 1;
            if (self._sfInitFails > 8) {
                self._degrade('audio init fetch: ' + ((e && e.message) || e));
                return;
            }
            const backoff = Math.min(5000, 500 * Math.pow(2, self._sfInitFails - 1));
            setTimeout(function () { if (!self.destroyed) self._sfFetchInit(); }, backoff);
        });
    }

    _sfEnsure(elT) {
        const sf = this._sf;
        if (sf.segs && sf.segs.length) {
            // real timeline: exact t and d per segment, no grid to drift off
            for (let i = 0; i < sf.segs.length; i++) {
                const g = sf.segs[i];
                if (g.t + g.d < elT - 0.5) continue;
                if (g.t > elT + HORIZON_S) break;
                this._sfFetch(g.n, g.t, g.d);
            }
            // live: the snapshot's timeline ends at the edge it was fetched
            // at, so refresh once the horizon reaches the last known segment
            const last = sf.segs[sf.segs.length - 1];
            if (elT + HORIZON_S > last.t + last.d - MPD_REFRESH_LEAD_S
                && performance.now() - (sf.at || 0) > MPD_REFRESH_MIN_MS
                && this.mp && !this._sfRefreshing) {
                this._sfRefreshing = true;
                const self = this;
                setTimeout(function () { self._sfRefreshing = false; self._selfFetchSetup(self.mp); }, 0);
            }
            return;
        }
        // @duration manifests carry no timeline; the grid is the truth there
        const rel = elT - sf.p0;
        const n0 = Math.max(sf.aStart, sf.aStart + Math.floor((rel - 0.5) / sf.segDur));
        let n1 = sf.aStart + Math.floor((rel + HORIZON_S) / sf.segDur);
        // STOP THE GRID AT THE END OF THE MEDIA. The horizon is 12 s, so from
        // about 10 s before the end of a finite clip this walked past the last
        // segment and asked for numbers that do not exist. Those 404s are not
        // behind the playhead, so the catch below used to drop their keys and
        // let every sweep ask again, for a set that grew as the horizon moved:
        // an accelerating request storm in the final seconds. An iPhone Xs died
        // there every time, at the same second, roughly 10 s before the end of
        // a 120 s clip, with everything healthy in the report before it.
        // A live stream has no meaningful duration and is unaffected.
        const elForDur = this.getElement();
        const elDur = elForDur && isFinite(elForDur.duration) && elForDur.duration > 0
            ? elForDur.duration : null;
        if (elDur !== null) {
            const nLast = sf.aStart + Math.max(0, Math.ceil(elDur / sf.segDur) - 1);
            if (n1 > nLast) n1 = nLast;
        }
        for (let n = n0; n <= n1; n++)
            this._sfFetch(n, sf.p0 + (n - sf.aStart) * sf.segDur, sf.segDur);
    }

    _sfOnVideoFrag(r) {
        if (!this._sf || !r.url) return;
        const m = String(r.url).match(this._sf.vNumberRe);
        if (!m) return;
        const n = parseInt(m[1], 10) + this._sf.dN;
        this._sfFetch(n, r.startTime, r.duration);
    }

    _sfFetch(n, t, dur) {
        const key = this.epoch + ':' + n;
        const epochAtStart = this.epoch;
        if (this._sfFetched.has(key)) return;
        this._sfFetched.add(key);
        if (this._sfFetched.size > 512) {           // bounded: oldest half dropped
            const keep = Array.from(this._sfFetched).slice(-256);
            this._sfFetched = new Set(keep);
        }
        const self = this;
        fetch(this._sf.aMedia(n), { cache: 'no-store' }).then(function (resp) {
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return resp.arrayBuffer();
        }).then(function (ab) {
            if (self.destroyed) return;
            // a rebase landed while this was in flight: these bytes belong to
            // the old timeline and must not enter the new epoch's ring
            if (epochAtStart !== self.epoch) return;
            self._onFrag({ request: { mediaType: 'audio', type: 'MediaSegment', selfFetched: true,
                                      representationId: '0', startTime: t, duration: dur },
                           response: ab });
        }).catch(function (err) {
            const el = self.getElement();
            const behind = el && t + (dur || 0) < el.currentTime;
            const is404 = /HTTP 404/.test(String(err && err.message || err));
            // A segment past the end of a finite clip is as permanent as an
            // expired one: it will never appear, so keep the key and stop
            // asking. Without this the sweep re-requested every number beyond
            // the last one, forever. The bound above should prevent this being
            // reached at all; it stays as the failsafe, because the bound
            // depends on the element reporting a duration.
            const past = el && isFinite(el.duration) && el.duration > 0 && t >= el.duration;
            if (!(is404 && (behind || past))) self._sfFetched.delete(key);
        });
    }

    _onFrag(e) {
        if (this.destroyed || this.degraded) return;
        if (!e || e.error || !e.response || !e.request) return;
        const r = e.request;

        // Video init segments carry the key to Chromium's constant A/V skew:
        // ffmpeg dashenc expresses the contribution's video start delay as an
        // edit list (empty edit + media offset). Firefox honors it; Chromium's
        // MSE ignores edit lists, so Chromium paints video EARLY by exactly
        // the edit's net delay. Audio must be placed that much earlier to
        // match what Chromium actually displays.
        if (this.selfFetchAudio && (r.mediaType || '') === 'video' && r.type === 'MediaSegment') {
            this._sfOnVideoFrag(r);
            // fall through: video media frags carry nothing else the feed wants
        }
        if ((r.mediaType || '') === 'video' && r.type === 'InitializationSegment') {
            if (this.selfFetchAudio && this._sf && this.mp) {
                // encoder restart rebases the timeline: re-read MPD and init
                this._sf = null;
                this._selfFetchSetup(this.mp);
            }
            const shift = this._parseElstShiftS(new Uint8Array(e.response));
            if (shift != null && Math.abs(shift - this.presentationShiftS) > 0.001) {
                this.presentationShiftS = shift;
                if (this.anchor !== null) this._hardResync('elst-shift');
            }
            return;
        }

        if ((r.mediaType || '') !== 'audio') return;
        // NOT OUR AUDIO. In self-fetch mode the feed downloads the 16-channel
        // Opus segments itself, so any audio fragment dash.js loads belongs to
        // a different AdaptationSet - specifically the silent stereo AAC
        // keep-alive track that stops WebKit suspending a backgrounded video
        // element. Before this guard those AAC bytes were handed to libopus and
        // came back as OPUS_INVALID_PACKET, 43 decode failures in 12 s and
        // silence, the moment a second audio set appeared in the manifest.
        // (the feed re-enters here with selfFetched:true to reuse this path)
        if (this.selfFetchAudio && !r.selfFetched) return;
        const rep = String(r.representationId != null ? r.representationId : '0');

        if (r.type === 'InitializationSegment') {
            const bytes = new Uint8Array(e.response.slice(0));
            const prev = this.inits.get(rep);
            if (prev && !this._bytesEqual(prev.bytes, bytes)) {
                // a different init on the same representation is an encoder
                // restart: new epoch, old entries stay playable until the
                // element itself rebases
                this.epoch++;
                this.counters.epochBumps++;
            }
            this.inits.set(rep, { bytes: bytes, epoch: this.epoch, timecodeScale: this._parseTimecodeScale(bytes) });
            return;
        }
        if (r.type !== 'MediaSegment') return;
        if (typeof r.startTime !== 'number' || !isFinite(r.startTime)) return;

        this.sawAudioFrag = true;
        this.lastFragAt = performance.now();
        const entry = {
            epoch: this.epoch,
            t: r.startTime,
            dur: (typeof r.duration === 'number' && isFinite(r.duration) && r.duration > 0) ? r.duration : 5,
            bytes: new Uint8Array(e.response.slice(0)),
        };
        // ordered insert; loads can complete out of order after retries
        let i = this.ring.length;
        while (i > 0 && this.ring[i - 1].t > entry.t) i--;
        // replace an entry at the same position in the same epoch (re-request)
        if (this.ring[i] && this.ring[i].epoch === entry.epoch && Math.abs(this.ring[i].t - entry.t) < 0.001) this.ring[i] = entry;
        else this.ring.splice(i, 0, entry);
        this._pump();
    }

    _bytesEqual(a, b) {
        if (a.byteLength !== b.byteLength) return false;
        for (let i = 0; i < a.byteLength; i += 16) if (a[i] !== b[i]) return false;
        for (let i = a.byteLength - 16; i < a.byteLength; i++) if (i >= 0 && a[i] !== b[i]) return false;
        return true;
    }

    // ---- WebM parsing (trim inputs only; never used for placement) ---------

    _parseTimecodeScale(bytes) {
        // Info > TimecodeScale (0x2AD7B1), default 1000000 ns per tick
        for (let i = 0; i < bytes.length - 4; i++) {
            if (bytes[i] === 0x2A && bytes[i + 1] === 0xD7 && bytes[i + 2] === 0xB1) {
                const size = bytes[i + 3] & 0x7F; // short vint sizes only
                if ((bytes[i + 3] & 0x80) && size >= 1 && size <= 4) {
                    let v = 0;
                    for (let j = 0; j < size; j++) v = v * 256 + bytes[i + 4 + j];
                    if (v > 0) return v;
                }
            }
        }
        return 1000000;
    }

    _clusterTimestampS(bytes, timecodeScale) {
        // first Cluster (0x1F43B675) > Timestamp (0xE7), big-endian uint
        for (let i = 0; i < bytes.length - 8; i++) {
            if (bytes[i] === 0x1F && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xB6 && bytes[i + 3] === 0x75) {
                // skip the cluster size vint: its length is the position of the
                // first set bit in the leading byte
                const first = bytes[i + 4];
                let l = 1, mask = 0x80;
                while (mask > 0 && !(first & mask)) { mask >>= 1; l++; }
                let p = i + 4 + l;
                if (bytes[p] === 0xE7) {
                    const sfirst = bytes[p + 1];
                    let sl = 1, smask = 0x80;
                    while (smask > 0 && !(sfirst & smask)) { smask >>= 1; sl++; }
                    if (sl <= 2) {
                        let size = sfirst & (0xFF >> sl);
                        for (let j = 1; j < sl; j++) size = size * 256 + bytes[p + 1 + j];
                        let v = 0;
                        for (let j = 0; j < size; j++) v = v * 256 + bytes[p + 1 + sl + j];
                        return v * timecodeScale / 1e9;
                    }
                }
                return null;
            }
        }
        return null;
    }

    // ---- decode ------------------------------------------------------------

    _key(epoch, t) { return epoch + ':' + Math.round(t * 1000); }

    _ensureDecoded(playhead) {
        if (this.inflight.size >= 2) return;
        const lo = playhead - 0.5, hi = playhead + HORIZON_S;
        for (let i = 0; i < this.ring.length; i++) {
            const entry = this.ring[i];
            if (entry.t + entry.dur < lo || entry.t > hi) continue;
            const key = this._key(entry.epoch, entry.t);
            if (this.decoded.has(key) || this.inflight.has(key)) continue;
            this._decodeChunk(entry, i);
            if (this.inflight.size >= 2) return;
        }
    }

    _decodeChunk(entry, ringIndex) {
        const init = this._initFor(entry.epoch);
        if (!init) return;
        const key = this._key(entry.epoch, entry.t);
        // previous contiguous segment in the same epoch warms the Opus decoder
        // so segment k's first samples come from a converged state (pair-decode)
        let prev = null;
        for (let i = ringIndex - 1; i >= 0; i--) {
            const c = this.ring[i];
            if (c.epoch !== entry.epoch) continue;
            if (Math.abs((c.t + c.dur) - entry.t) < 0.060) prev = c;
            break;
        }
        this.inflight.add(key);
        const self = this;
        let decoded;
        if (this.decodeBackend) {
            // same contract as decodeAudioData over the concatenated file;
            // the backend takes the parts unconcatenated
            decoded = this.decodeBackend.decode(this.ctx, init.bytes,
                                                prev ? prev.bytes : null, entry.bytes);
        } else {
            const parts = prev ? [init.bytes, prev.bytes, entry.bytes] : [init.bytes, entry.bytes];
            let len = 0; parts.forEach(function (p) { len += p.byteLength; });
            const buf = new Uint8Array(len);
            let o = 0; parts.forEach(function (p) { buf.set(p, o); o += p.byteLength; });
            decoded = this.ctx.decodeAudioData(buf.buffer);
        }
        decoded.then(function (ab) {
            self.inflight.delete(key);
            if (self.destroyed || self.degraded) return;
            if (entry.epoch !== self.epoch && !self._epochVisible(entry.epoch)) return;
            self.counters.decodes++;
            self._storeDecoded(entry, prev, init, ab, key);
            self._pump();
        }).catch(function (err) {
            self.inflight.delete(key);
            if (self.destroyed) return;
            self.counters.decodeFails++;
            // the first few reasons, not every retry: a decode failure's cause
            // is the whole diagnosis and was invisible here until 2026-08-25
            if (self.counters.decodeFails <= 3)
                console.warn('SegmentAudioFeed: decode failed:', (err && (err.message || err.name)) || err);
            if (!self.retried.has(key)) { self.retried.add(key); return; } // one retry on a later pump
            self._strike();
        });
    }

    _initFor(epoch) {
        let found = null;
        this.inits.forEach(function (v) { if (v.epoch === epoch) found = v; });
        if (found) return found;
        // fall back to the newest init: dash.js may not refetch the init after
        // an encoder restart when the URL is unchanged
        this.inits.forEach(function (v) { if (!found || v.epoch > found.epoch) found = v; });
        return found;
    }

    _epochVisible(epoch) {
        // an epoch is still interesting while any of its content could play
        for (let i = 0; i < this.ring.length; i++) if (this.ring[i].epoch === epoch) return true;
        return false;
    }

    _storeDecoded(entry, prev, init, ab, key) {
        // The buffer's own rate: decodeAudioData resamples to the context rate
        // so this is identical on the native path, but the WASM backend returns
        // the stream's 48 kHz and the source nodes resample on playout instead.
        const sr = ab.sampleRate || this.ctx.sampleRate;
        let offset = 0, preSmp = 0;
        let tEff = entry.t;
        let span;
        if (prev) {
            // TAIL-ANCHORED: the pair decode ends exactly at this chunk's end,
            // so the junction sits entry.dur before that end - independent of
            // how long the decoded prev actually was. The earlier form placed
            // it prevDur from the FRONT, and prev.dur understates by the
            // pre-skip for a VOD's first chunk, an error that then propagated
            // through every later junction (~6 ms of misplaced content per
            // join: the metronomic VOD click, 2026-08-25). Live was immune
            // only because a mid-stream first chunk loses nothing.
            // NOT frame-snapped: the stream-start pre-skip shifts every frame
            // boundary off the nominal 20 ms grid, so snapping the junction
            // re-introduces the exact misplacement tail-anchoring removes.
            // Copying from an arbitrary sample offset is fine - frame
            // alignment is a decoder concern and decode already happened.
            offset = Math.max(0, ab.length - Math.round(entry.dur * sr));
            span = Math.min(ab.length - offset, Math.round(entry.dur * sr));
            // keep a crossfade pre-roll of the previous chunk's tail; identical
            // content to what the previous node plays there, by construction
            preSmp = Math.min(XF_SMP, offset);
            offset -= preSmp;
            span += preSmp;
        } else {
            // chain start: account the stream-start loss (pre-skip region) so
            // the successor still lands at the true junction and this chunk is
            // placed where its surviving samples belong
            const frontLoss = Math.max(0, Math.round(entry.dur * sr) - ab.length);
            tEff = entry.t + frontLoss / sr;
            span = ab.length;
        }
        if (span <= 0) return;
        if (!this.N) {
            this.N = ab.numberOfChannels;
            this.feedBus.channelCount = this.N;
            this.feedBus.channelCountMode = 'explicit';
            this.feedBus.channelInterpretation = 'discrete';
            this.onReady(this.N);
        }
        const out = this.ctx.createBuffer(ab.numberOfChannels, span, sr);
        const tmp = new Float32Array(span);
        for (let c = 0; c < ab.numberOfChannels; c++) {
            ab.copyFromChannel(tmp, c, offset);
            out.copyToChannel(tmp, c, 0);
        }
        this.decoded.set(key, { t: tEff, dur: (span - preSmp) / sr, preS: preSmp / sr, buffer: out, lastUse: performance.now() });
    }

    _strike() {
        const now = performance.now();
        // strikes right after an epoch bump are restart debris, not a decoder
        // problem; do not let them degrade the session
        if (now - (this._lastEpochBumpAt || 0) < 10000) return;
        this.strikes.push(now);
        this.strikes = this.strikes.filter(function (t) { return now - t < STRIKE_WINDOW_S * 1000; });
        if (this.strikes.length >= STRIKE_LIMIT) this._degrade('decode-failures');
    }

    // ---- scheduling --------------------------------------------------------

    _pump() {
        if (this.destroyed || this.degraded) return;
        this.pumpCount++;
        const el = this.getElement();
        if (!el) return;

        // refresh output latency every ~5 s: a device switch shifts it by
        // 100 ms class with no other observable event
        if (this.pumpCount % 10 === 1)
            this.outputLatency = this.ctx.outputLatency || this.ctx.baseLatency || 0;

        // WATCH THE CLOCK ITSELF FOR A JUMP BACKWARDS. Every rebuild until now
        // hung off the element's 'seeking' and 'seeked' events, and the rewind
        // an element performs for its own loop attribute does not reliably fire
        // them. So at the wrap the media clock returned to zero while the feed
        // went on waiting to place audio near the end of the clip, and there was
        // silence for the whole of the second pass: reported on an iPhone Xs on
        // 2026-08-29, where the picture looped correctly and the sound did not
        // come back until the page was reloaded.
        //
        // Detected from the clock rather than from any event, so it covers the
        // loop rewind, an engine that omits the events, and anything else that
        // moves the playhead behind our back. The threshold is well above
        // ordinary jitter and below any real seek.
        const nowT = el.currentTime;
        if (this._lastPumpT !== undefined && nowT < this._lastPumpT - 0.5 && !el.seeking) {
            this.counters.resyncs++;
            console.log('SegmentAudioFeed: clock jumped back ' + (this._lastPumpT - nowT).toFixed(2)
                + 's with no seek event (loop rewind); rebuilding');
            this._flush(0);
            if (this.state === 'running') this.state = 'stalled';
            this._lastPumpT = nowT;
            if (!el.paused) this._resume();
        } else {
            this._lastPumpT = nowT;
        }

        // A paused element loads nothing on either route, so paused time must
        // not count against the no-fragments watchdog: pressing play in a tab
        // that sat idle degraded the feed instantly (2026-08-25).
        if (el.paused) this.lastFragAt = performance.now();

        // self-fetch coverage from the element clock. Fragment-completion
        // triggering alone starves on VOD, where dash.js fills its video
        // buffer within seconds and then never loads again; the clock-driven
        // sweep also covers seeks and the live edge (a 404 on a segment not
        // yet available is retried by the next sweep).
        if (this.selfFetchAudio && this._sf && this._sf.segDur && !el.paused)
            this._sfEnsure(el.currentTime);

        // watchdog: an advancing element with no audio fragments means the tap
        // is not delivering (wrong dash.js surface, changed event payload):
        // fall back to the field-tested element path rather than stay silent
        if (!this.degraded && this.state === 'running' && !this.sawAudioFrag
            && performance.now() - this.lastFragAt > WATCHDOG_S * 1000
            && el.currentTime > 0 && !el.paused) {
            this._degrade('no-audio-fragments');
            return;
        }

        if (el.paused) { if (this.state === 'running') this._enterPaused(); return; }

        // freeze detector: dynamic-stream gap handling can freeze currentTime
        // with no waiting event; a frozen master must gate the drift sampler
        // and reads as a stall
        if (this.state === 'running') {
            if (el.currentTime === this.lastSampleElT) {
                if (++this.freezeCount >= 2) { this._enterStalled(); this.freezeCount = 0; return; }
            } else this.freezeCount = 0;
        }
        if (this.state === 'stalled') {
            if (el.currentTime !== this.lastSampleElT && el.readyState >= 3) { this._resume(); return; }
        }
        this.lastSampleElT = el.currentTime;

        if (this.state === 'paused' || this.state === 'stalled') return;
        if (this.state === 'idle' || this.state === 'underrun') {
            if (el.currentTime <= 0 || el.readyState < 3) return;
            if (this.state === 'underrun') {
                // rejoin only with a real cushion, never glitch straight back
                let depth = 0;
                const ph = el.currentTime;
                this.decoded.forEach(function (rec) {
                    if (rec.t + rec.dur > ph) depth += (rec.t + rec.dur) - Math.max(rec.t, ph);
                });
                if (depth < REJOIN_DEPTH_S) { this._ensureDecoded(ph); return; }
            }
            this.state = 'running';
        }

        const playhead = this._masterTime(el);
        this._ensureDecoded(playhead);
        this._schedule(playhead);
        this._sampleDrift(el);
        this._maybeCorrect();
        this._prune(playhead);
    }

    _schedule(playhead) {
        const now = this.ctx.currentTime;

        if (this.anchor === null) {
            // run start: bind to the chunk that contains the playhead.
            // Content m must reach the SPEAKERS when the element shows m, so
            // the start point sits START_LEAD + outputLatency deeper into the
            // content than the playhead, and the anchor maps media time m to
            // ctx time (now - OL) + (m - playhead). With that, measured drift
            // is zero at the anchor by construction; anchoring at now + lead
            // instead bakes lead + OL in as permanent apparent drift and the
            // corrector fights it forever.
            const chunk = this._decodedAt(playhead);
            if (!chunk) return; // decode in flight; bounded silence, never a fight
            // never anchor onto placeholder filters (see renderReady)
            if (!this.renderReady) { this._ensureDecoded(playhead); return; }
            // wait for MIN_START_AHEAD_S of contiguous decoded content before
            // anchoring (unless the stream has nothing more to offer): Safari's
            // first seconds otherwise underrun-resync audibly while WASM and
            // the video pipeline fight for the main thread
            let covered = 0, tScan = playhead;
            for (;;) {
                const c = this._decodedAt(tScan + 0.001);
                if (!c) break;
                const adv = (c.rec.t + c.rec.dur) - tScan;
                if (adv <= 0) break;
                covered += adv; tScan += adv;
                if (covered >= MIN_START_AHEAD_S) break;
            }
            if (covered < MIN_START_AHEAD_S) {
                let ringMax = -Infinity;
                for (let i = 0; i < this.ring.length; i++)
                    ringMax = Math.max(ringMax, this.ring[i].t + this.ring[i].dur);
                if (ringMax > tScan + 0.05) return;   // more is coming: wait
            }
            const ol = this.outputLatency;
            const into = Math.max(0, playhead - chunk.rec.t) + START_LEAD_S + ol;
            this.anchor = { ctxAt: now - ol, mediaAt: playhead };
            if (into < chunk.rec.dur) {
                this._startNode(chunk.rec, into, now + START_LEAD_S, true);
                // The anchor node's endCtx works out to exactly
                // anchor.ctxAt + (nextT - anchor.mediaAt), i.e. nextCtx, so the
                // next chunk has a crossfade partner waiting and the junction
                // is seamless. Forcing a fade here instead cost an audible
                // amplitude notch at the first junction - one drop ~2 s in,
                // then silence-clean thereafter, in every engine.
            } else {
                // playhead is at the chunk tail: no anchor node, so the next
                // chunk opens the chain cold and its edge does need a fade
                this._forceFade = true;
            }
            this.nextT = chunk.rec.t + chunk.rec.dur;
            this.nextCtx = this.anchor.ctxAt + (this.nextT - this.anchor.mediaAt);
        }

        // A scheduler loop that cannot terminate must never be able to take the
        // page down again. The bound is far above any real pass: at a 12 s
        // horizon and 2 s chunks a healthy sweep runs about six times.
        let spins = 0;
        while (this.nextCtx !== null && this.nextCtx - now < HORIZON_S) {
            if (++spins > 200) {
                this.counters.scheduleSpins = (this.counters.scheduleSpins || 0) + 1;
                console.warn('SegmentAudioFeed: schedule loop hit its bound at nextT='
                    + this.nextT + '; breaking out');
                break;
            }
            const next = this._decodedNear(this.nextT);
            if (next) {
                // a pending late-correction moved nextT into the chunk: play it
                // from the matching inner offset (content skip) under a fade
                const into = Math.max(0, this.nextT - next.t);
                if (into >= next.dur) {
                    // THE ADVANCE MUST ADVANCE. This steps over a chunk the
                    // junction has already passed, which is a real case worth
                    // keeping. But a chunk SHORTER than the 30 ms join
                    // tolerance still matches after being consumed, and then
                    // next.t + next.dur is exactly where nextT already is: the
                    // assignment is a no-op, nextCtx and now are untouched, and
                    // the loop cannot terminate. Shaka ends these clips with a
                    // 7 ms audio segment (t=120.001 d=0.007 in the shipped
                    // manifests), the only chunk short enough to do it, and an
                    // iPhone Xs wedged its main thread there at the same second
                    // of every run. Nothing threw, so there was no error to
                    // find; the tab was simply killed as unresponsive while
                    // already-scheduled audio and video played on.
                    const advanced = next.t + next.dur;
                    if (!(advanced > this.nextT)) break;   // nothing further to place this pass
                    this.nextT = advanced;
                    continue;
                }
                this._startNode(next, into, this.nextCtx, into > 0 || this._forceFade);
                this._forceFade = false;
                this.nextT = next.t + next.dur;
                this.nextCtx += (next.dur - into);
                continue;
            }
            // hole handling: if a later chunk exists, jump the junction to it
            // (time-addressed silence exactly spanning the hole); never butt-
            // chain across a hole or all later audio slides off sync
            const later = this._decodedAfter(this.nextT + JOIN_TOL_S, this.nextT + HORIZON_S);
            if (later) {
                this.counters.holes++;
                const gap = later.t - this.nextT;
                this.nextCtx += gap;
                this.nextT = later.t;
                this._forceFade = true; // silence hole: fade the rejoin edge
                continue;
            }
            break;
        }

        // self-underrun: decode fell behind playback; fade out rather than
        // glitch, rejoin when a real cushion exists again
        if (this.state === 'running' && this.nextCtx !== null && this.nextCtx - now < UNDERRUN_FLOOR_S && this.nodes.length > 0) {
            this._flush(STALL_FADE_S);
            this.state = 'underrun';
        }
    }

    _decodedAt(mediaT) {
        let bestKey = null, bestRec = null;
        this.decoded.forEach(function (rec, key) {
            if (mediaT >= rec.t && mediaT < rec.t + rec.dur) { bestKey = key; bestRec = rec; }
        });
        return bestKey ? { key: bestKey, rec: bestRec } : null;
    }

    // Matches a chunk whose START is within the join tolerance of the junction.
    // The caller relies on this still matching when the junction has drifted
    // PAST the chunk, so it can step over it; see the progress guard there.
    _decodedNear(mediaT) {
        let found = null;
        this.decoded.forEach(function (rec) {
            if (Math.abs(rec.t - mediaT) <= JOIN_TOL_S) found = rec;
        });
        return found;
    }

    _decodedAfter(fromT, toT) {
        let found = null;
        this.decoded.forEach(function (rec) {
            if (rec.t > fromT && rec.t < toT && (!found || rec.t < found.t)) found = rec;
        });
        return found;
    }

    _startNode(rec, offsetS, whenCtx, rampInArg) {
        let rampIn = rampInArg;
        const src = this.ctx.createBufferSource();
        src.buffer = rec.buffer;
        const g = this.ctx.createGain();
        src.connect(g); g.connect(this.feedBus);
        const preS = rec.preS || 0;
        // CROSSFADED JOIN. When this chunk carries pre-roll (identical, by
        // pair-decode, to the previous chunk's tail), start it preS early and
        // fade the pair linearly across the overlap: identical content under
        // gains summing to 1 is an exact join, whatever the engine rounds the
        // start time to. Only for seamless chains (offsetS 0, no correction
        // fade requested, and a node actually ending at this junction).
        let xfPrev = null;
        if (!rampIn && offsetS === 0 && preS > 0 && this.nodes.length) {
            const cand = this.nodes[this.nodes.length - 1];
            if (Math.abs(cand.endCtx - whenCtx) < 0.001) xfPrev = cand;
        }
        if (xfPrev) whenCtx -= preS;
        else offsetS += preS;   // no crossfade partner: skip the pre-roll content
        let when = Math.max(whenCtx, this.ctx.currentTime + 0.005);
        // OVERLAP GUARD. A chained node must never begin before the previous
        // node's scheduled end: that plays two chunks at once (the operator
        // observed a -13225-sample overlap, 0.28 s of doubled audio, at a VOD
        // end on 2026-08-25) and the chain does not self-heal afterwards.
        // The originating path was never reproduced headlessly, so rather than
        // guess at it this makes the bad state unreachable and counts it -
        // if the counter ever moves, the log line says where from.
        if (this.nodes.length) {
            const lastEnd = this.nodes[this.nodes.length - 1].endCtx;
            const overlapS = lastEnd - (rampIn ? when : when + preS);
            if (overlapS > 0.002) {
                this.counters.overlaps = (this.counters.overlaps || 0) + 1;
                if (this.counters.overlaps <= 3)
                    console.warn('SegmentAudioFeed: junction overlap of '
                        + (overlapS * 1000).toFixed(1) + ' ms suppressed (state=' + this.state
                        + ', rampIn=' + !!rampIn + ', xf=' + !!xfPrev + ')');
                // start at the previous end instead, skipping the overlapping
                // content so placement stays truthful, and fade the edge
                if (overlapS < rec.dur * 0.5) {
                    offsetS += overlapS;
                    when = lastEnd;
                    if (xfPrev) { xfPrev = null; }   // partner content no longer aligns
                    rampIn = true;
                } else {
                    return;   // wholly covered: dropping it is the honest answer
                }
            }
        }
        // SAMPLE-ALIGN the schedule. when and offset are float seconds, and
        // 95688/48000-style values are not binary-exact, so consecutive nodes
        // can land up to half a sample apart on the context's sample grid: a
        // phase jump per junction, inaudible in noise or music and a clean
        // tick on a sine (heard on the orbit test, Safari and Brave alike,
        // 2026-08-25). Rounding both to whole samples makes the butt joint
        // exact by construction; buffers are at the context rate since the
        // 48 kHz context change, so no resampling reintroduces error.
        const SR = this.ctx.sampleRate;
        when = Math.round(when * SR) / SR;
        offsetS = Math.max(0, Math.round(offsetS * SR)) / SR;
        if (xfPrev) {
            const xfEnd = when + preS;
            g.gain.setValueAtTime(0, when);
            g.gain.linearRampToValueAtTime(1, xfEnd);
            try {
                xfPrev.gain.gain.setValueAtTime(1, when);
                xfPrev.gain.gain.linearRampToValueAtTime(0, xfEnd);
            } catch (e) { /* previous node already gone: plain fade-in remains */ }
        } else if (rampIn) {
            g.gain.setValueAtTime(0, when);
            g.gain.linearRampToValueAtTime(1, when + FADE_S);
        } else {
            g.gain.value = 1;
        }
        try { src.start(when, offsetS); } catch (e) { return; }
        rec.lastUse = performance.now();
        // endCtx is the LOGICAL junction end, from integer sample spans:
        //  crossfade: started preS early, plays preS+dur -> ends at when+preS+dur
        //  otherwise: offsetS already includes the skipped pre-roll, so the
        //             node plays (preS + dur - offsetS) from `when`
        const endCtx = xfPrev
            ? when + Math.round((preS + rec.dur) * SR) / SR
            : when + Math.round((preS + rec.dur - offsetS) * SR) / SR;
        // junction census: a healthy steady chain is all crossfades. Faded
        // joins are legitimate at a cold start, a hole rejoin or a correction,
        // so this counts them rather than warning - a climbing fadedJoins
        // against a still decodes count is the signature of a chain that has
        // stopped joining cleanly.
        if (xfPrev) this.counters.xfades++;
        else if (rampIn) {
            this.counters.fadedJoins++;
            if (this.fadedAt.length < 16)
                this.fadedAt.push(+(rec.t + offsetS).toFixed(3));
        }
        const node = { src: src, gain: g, ctxStart: when, endCtx: endCtx };
        // junction-seam audit: the gap between the previous node's scheduled
        // end and this start, in samples at the context rate. Zero is a
        // sample-exact butt joint; anything else is audible as a tick and
        // invisible to every counter. Kept at debug level, capped.
        if (this.nodes.length) {
            const prevEnd = this.nodes[this.nodes.length - 1].endCtx;
            // junction alignment: a crossfaded node starts preS EARLY by design,
            // so compare the junction it lands on, not its start time
            const gapSmp = ((xfPrev ? when + preS : when) - prevEnd) * this.ctx.sampleRate;
            this._seamLog = this._seamLog || [];
            if (this._seamLog.length < 24) {
                const tag = Math.abs(gapSmp) > 24000 ? ' (hole/restart, expected)'
                          : xfPrev ? ' (xf)' : rampIn ? ' (ramped)' : '';
                this._seamLog.push(Math.round(gapSmp * 100) / 100);
                console.debug('SegmentAudioFeed seam[' + this._seamLog.length + ']: '
                    + gapSmp.toFixed(2) + ' samples' + tag);
            }
        }
        this.nodes.push(node);
        const self = this;
        src.onended = function () {
            const i = self.nodes.indexOf(node);
            if (i >= 0) self.nodes.splice(i, 1);
            try { g.disconnect(); } catch (e) { /* already detached */ }
            self._pump(); // audio-thread wake source, immune to timer throttling
        };
    }

    // ---- drift (single mechanism: whole-buffer schedule-time correction) ---

    _sampleDrift(el) {
        if (this.anchor === null) return;
        if (el.paused || el.seeking || el.readyState < 3 || el.playbackRate !== 1) return;
        // media time currently audible at the speakers
        const audible = this.anchor.mediaAt + (this.ctx.currentTime - this.outputLatency - this.anchor.ctxAt);
        const drift = this._masterTime(el) - audible; // positive: audio late
        this.driftSamples.push(drift);
        if (this.driftSamples.length > 5) this.driftSamples.shift();
    }

    _medianDrift() {
        if (this.driftSamples.length < 3) return 0;
        const s = this.driftSamples.slice().sort(function (a, b) { return a - b; });
        return s[Math.floor(s.length / 2)];
    }

    _maybeCorrect() {
        if (this.anchor === null || this.driftSamples.length < 3) return;
        if (this.nextT === null || this.nextCtx === null) return;
        const d = this._medianDrift();
        if (Math.abs(d) <= DEADBAND_S) return;
        if (Math.abs(d) > HARD_RESYNC_S) { this._hardResync('drift ' + (d * 1000).toFixed(0) + 'ms'); return; }
        // one bounded schedule-time step, applied at the NEXT junction by the
        // scheduler; all N channels of every chunk move together by
        // construction, so inter-channel phase coherence cannot break
        const step = Math.max(-STEP_MAX_S, Math.min(STEP_MAX_S, d));
        if (step > 0) {
            // audio late: skip step of content at the junction. Moving nextT
            // into the next chunk makes _schedule play it from that inner
            // offset (trimmed head, 3 ms fade); the junction ctx time stays
            this.nextT += step;
            this.anchor.ctxAt -= step;   // future content plays step earlier
        } else {
            // audio early: edge-faded micro gap at the junction
            this.nextCtx += -step;
            this.anchor.ctxAt += -step;  // future content plays step later
            this._forceFade = true;
        }
        this.counters.steps++;
        this.driftSamples = [];
    }

    _hardResync(reason) {
        this.counters.resyncs++;
        console.debug('SegmentAudioFeed: hard resync #' + this.counters.resyncs
            + ' (' + (reason || 'drift') + ') drift=' + (this._medianDrift() * 1000).toFixed(1) + 'ms');
        this._flush(RAMP_S);
        this.state = 'running';
        this.driftSamples = [];
        this._pump();
    }

    // ---- flush / degrade / prune -------------------------------------------

    _flush(fadeS) {
        const now = this.ctx.currentTime;
        const g = this.feedBus.gain;
        try {
            g.cancelScheduledValues(now);
            g.setValueAtTime(g.value, now);
            g.linearRampToValueAtTime(0, now + fadeS);
            g.setValueAtTime(1, now + fadeS + 0.005); // re-open for the next run
        } catch (e) { /* already detached */ }
        const nodes = this.nodes;
        this.nodes = [];
        const stopAt = now + fadeS + 0.002;
        nodes.forEach(function (n) {
            n.src.onended = null;
            try { n.src.stop(stopAt); } catch (e) { /* already detached */ }
            setTimeout(function () { try { n.gain.disconnect(); } catch (e) { /* already detached */ } }, (fadeS + 0.05) * 1000);
        });
        this.anchor = null;
        this.nextT = null;
        this.nextCtx = null;
        this._pendingTrim = 0;
    }

    _degrade(reason) {
        if (this.degraded || this.destroyed) return;
        this.degraded = true;
        this.degradeReason = reason;
        console.warn('SegmentAudioFeed: degrading to element audio path (' + reason + ')');
        this._flush(RAMP_S);
        this.detach();
        clearInterval(this._pumpTimer);
        this.onDegrade(reason);
    }

    _prune(playhead) {
        // encoded ring: window around the playhead; epoch-scoped so a detected
        // restart never loses the new run's bytes (dash.js fetches once)
        const lo = playhead - RING_BACK_S, hi = playhead + RING_AHEAD_S;
        const curEpochs = {};
        curEpochs[this.epoch] = true;
        this.ring = this.ring.filter(function (c) {
            if (!curEpochs[c.epoch]) return true; // never age-prune across a discontinuity
            return (c.t + c.dur) >= lo && c.t <= hi;
        });
        // decoded chunks: behind the playhead or far ahead
        const dead = [];
        this.decoded.forEach(function (rec, key) {
            if (rec.t + rec.dur < playhead - 1 || rec.t > playhead + HORIZON_S + 10) dead.push(key);
        });
        const self = this;
        dead.forEach(function (k) { self.decoded.delete(k); self.retried.delete(k); });
    }
}
