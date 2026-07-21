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
        this.counters = { decodes: 0, decodeFails: 0, resyncs: 0, steps: 0, holes: 0, epochBumps: 0 };

        this.mp = null;
        this._onFrag = this._onFrag.bind(this);
        this._listeners = [];
        this._seekTimer = null;
        this._pump = this._pump.bind(this);
        this._pumpTimer = setInterval(this._pump, PUMP_MS);
        this._bindElement();
    }

    // ---- public API --------------------------------------------------------

    attach(mediaPlayer) {
        if (this.destroyed || this.mp === mediaPlayer) return;
        this.detach();
        this.mp = mediaPlayer;
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
            degraded: this.degraded, counters: this.counters,
            // axis corroboration: the ring's media span should bracket elT
            elT: el ? Math.round(el.currentTime * 100) / 100 : null,
            ringT0: this.ring.length ? Math.round(this.ring[0].t) : null,
            ringT1: this.ring.length ? Math.round(this.ring[this.ring.length - 1].t + this.ring[this.ring.length - 1].dur) : null,
            outputLatency: Math.round(this.outputLatency * 1000),
        };
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
        // fresh anchor: drift is definitionally zero after a rebuild, so the
        // post-stall rule (never bridge stall residue with steps) holds
        this._flush(0);
        this.state = 'running';
        this.driftSamples = [];
        this._pump();
    }

    // ---- dash.js tap -------------------------------------------------------

    _onFrag(e) {
        if (this.destroyed || this.degraded) return;
        if (!e || e.error || !e.response || !e.request) return;
        const r = e.request;
        if ((r.mediaType || '') !== 'audio') return;
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
        const parts = prev ? [init.bytes, prev.bytes, entry.bytes] : [init.bytes, entry.bytes];
        let len = 0; parts.forEach(function (p) { len += p.byteLength; });
        const buf = new Uint8Array(len);
        let o = 0; parts.forEach(function (p) { buf.set(p, o); o += p.byteLength; });

        this.inflight.add(key);
        const self = this;
        this.ctx.decodeAudioData(buf.buffer).then(function (ab) {
            self.inflight.delete(key);
            if (self.destroyed || self.degraded) return;
            if (entry.epoch !== self.epoch && !self._epochVisible(entry.epoch)) return;
            self.counters.decodes++;
            self._storeDecoded(entry, prev, init, ab, key);
            self._pump();
        }).catch(function () {
            self.inflight.delete(key);
            if (self.destroyed) return;
            self.counters.decodeFails++;
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
        const sr = this.ctx.sampleRate;
        const frame = Math.round(0.020 * sr); // Opus frame grid: exact at 48k and 44.1k
        const snap = function (samples) { return Math.round(samples / frame) * frame; };
        let offset = 0;
        let tEff = entry.t;
        let span;
        if (prev) {
            // prefer measured cluster timestamps for the prev duration; the
            // constant container offset cancels in the difference
            let prevDur = prev.dur;
            const tc = init.timecodeScale;
            const cPrev = this._clusterTimestampS(prev.bytes, tc);
            const cK = this._clusterTimestampS(entry.bytes, tc);
            if (cPrev != null && cK != null && cK > cPrev) prevDur = cK - cPrev;
            const frontLoss = Math.max(0, Math.round((prevDur + entry.dur) * sr) - ab.length);
            offset = snap(Math.round(prevDur * sr) - frontLoss);
            if (offset < 0) offset = 0;
            if (offset > ab.length) offset = Math.max(0, ab.length - 1);
            span = Math.min(ab.length - offset, Math.round(entry.dur * sr));
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
        this.decoded.set(key, { t: tEff, dur: span / sr, buffer: out, lastUse: performance.now() });
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

        const playhead = el.currentTime;
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
            const ol = this.outputLatency;
            const into = Math.max(0, playhead - chunk.rec.t) + START_LEAD_S + ol;
            this.anchor = { ctxAt: now - ol, mediaAt: playhead };
            if (into < chunk.rec.dur) {
                this._startNode(chunk.rec, into, now + START_LEAD_S, true);
            } // else: playhead is at the chunk tail; the loop below starts from the next chunk
            this.nextT = chunk.rec.t + chunk.rec.dur;
            this.nextCtx = this.anchor.ctxAt + (this.nextT - this.anchor.mediaAt);
            this._forceFade = true;
        }

        while (this.nextCtx !== null && this.nextCtx - now < HORIZON_S) {
            const next = this._decodedNear(this.nextT);
            if (next) {
                // a pending late-correction moved nextT into the chunk: play it
                // from the matching inner offset (content skip) under a fade
                const into = Math.max(0, this.nextT - next.t);
                if (into >= next.dur) { this.nextT = next.t + next.dur; continue; }
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

    _startNode(rec, offsetS, whenCtx, rampIn) {
        const src = this.ctx.createBufferSource();
        src.buffer = rec.buffer;
        const g = this.ctx.createGain();
        src.connect(g); g.connect(this.feedBus);
        const when = Math.max(whenCtx, this.ctx.currentTime + 0.005);
        if (rampIn) {
            g.gain.setValueAtTime(0, when);
            g.gain.linearRampToValueAtTime(1, when + FADE_S);
        } else {
            g.gain.value = 1;
        }
        try { src.start(when, offsetS); } catch (e) { return; }
        rec.lastUse = performance.now();
        const node = { src: src, gain: g, ctxStart: when, endCtx: when + (rec.dur - offsetS) };
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
        const drift = el.currentTime - audible; // positive: audio late
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
        if (Math.abs(d) > HARD_RESYNC_S) { this._hardResync(); return; }
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

    _hardResync() {
        this.counters.resyncs++;
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
