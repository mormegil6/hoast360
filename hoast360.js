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

import * as dashjs from 'dashjs';
import { WasmOpusBackend } from './dependencies/WasmOpusBackend.js';
import videojs from 'video.js';
import 'videojs-contrib-dash'
import 'videojs-http-source-selector';
import 'videojs-contrib-quality-levels';
import './dependencies/videojs-xr/plugin.js';
import MatrixMultiplier from './dependencies/MatrixMultiplier.js';
import { zoomMtx, stepsize, minZoomfactor, maxZoomfactor } from './dependencies/HoastZoom.js';
import PlaybackEventHandler from './dependencies/PlaybackEventHandler.js';
import HOASTloader from './dependencies/HoastLoader.js';
import HOASTBinDecoder from './dependencies/HoastBinauralDecoder.js';
import HOASTRotator from './dependencies/HoastRotator.js';
import SegmentAudioFeed from './dependencies/SegmentAudioFeed.js';
import { isMobileTabletVRDevice } from './dependencies/UserAgentChecker.js';
import { probeOpusSupport, CHROME_OPUS_HELP_URL } from './dependencies/OpusProbe.js';
import './css/video-js.css';
import './css/hoast360.css';

"use strict";

// Live streams: start 30 s behind the live edge. ffmpeg writes the live MPD
// non-atomically and announces segments at the edge before they are fully on
// disk, so joining near the edge stalls and gap-jumps on startup. dash.js
// gives an explicit liveDelay precedence over the MPD's
// suggestedPresentationDelay; the setting is ignored for static (VOD) MPDs.
const LIVE_DELAY_S = 30;
const BUILD_TAG = 'rf46';  // diagnostic badge + gl.maxTextureSize. BUMP THIS on
                            // any bundle change: it is the only build marker
                            // visible in a deployed player, and 'is this the new
                            // bundle?' cost real time on 2026-08-08 without it.

// STALL WATCHDOG: how long playback may go without progress (while playing
// and the tab is visible) before the session is treated as dead and
// reloaded. See the watchdog itself, wired up in the constructor, for why
// this can't just react to dash.js's own PLAYBACK_STALLED/BUFFER_EMPTY
// events - those fire for ordinary, self-recovering rebuffering too.
const STALL_RELOAD_MS = 60000;
const STALL_CHECK_INTERVAL_MS = 15000;

// Chromium delays any Web Audio tap on an MSE-fed element by ~2 s (measured:
// invariant under liveDelay, dash.js buffer targets, captureStream, and
// element playbackRate). Only Chromium engines get the segment-audio feed;
// Firefox is already in sync on the element path and unknown engines default
// to the safe legacy wiring.
// UA-only test: Firefox and WebKit Safari never carry "Chrome/", while every
// Chromium build (Chrome, Brave, Edge, HeadlessChrome) does. window.chrome is
// deliberately NOT required: headless Chromium omits it and would silently
// fall back to the legacy path in test harnesses.
const IS_CHROMIUM = typeof navigator !== 'undefined' && /Chrome\//.test(navigator.userAgent);

// The combined-MPD path is driven through this hook, which fires after the
// MediaPlayer is created and before initialize(). It used to run on
// videojs-contrib-dash's own inlined dash.js 4.2.0 rather than the dashjs
// package import; since the webpack alias bundles contrib-dash from source
// (rf31) there is one dash.js, the patched 4.7.4, on every path. NOTE: the
// hook fires on BOTH the combined and the separate-MPD path, so feed
// attachment is gated by the flag the owning instance sets before calling
// src().
videojs.Html5DashJS.hook('beforeinitialize', function (player, mediaPlayer) {
    mediaPlayer.updateSettings({ streaming: {
        delay: { liveDelay: LIVE_DELAY_S },
        // Cap SourceBuffer depth so high-bitrate rungs stay within MSE quota. At
        // dash.js defaults, >10 min VOD uses bufferTimeAtTopQualityLongForm = 60 s;
        // 60 s of an 8K/60 Mbps rung is ~450 MB and throws QuotaExceededError, so
        // dash.js thrashes (clear/refill = visible stutter). ~8 s forward keeps 8K
        // well under quota; trades a thinner buffer for smooth top-quality playback.
        buffer: {
            bufferToKeep: 6,
            bufferTimeAtTopQuality: 8,
            bufferTimeAtTopQualityLongForm: 8
        }
    } });
    // KEEP PHONES OFF THE 4K H.264 RUNG. An iPhone Xs plays it, then raises
    // MEDIA_ERR_DECODE or freezes outright, repeatedly, on 2026-08-28. The
    // stream is not the problem: it was measured well inside H.264 level 5.1
    // (78% of MaxFS, 70% of MaxMBPS, 5 of 6 DPB frames). The device is simply
    // out of headroom decoding 3840x1920 while also running a WebGL sphere, 16
    // convolvers and a WASM Opus worker.
    //
    // Only the H.264 ladder and only the engines that have nothing but
    // ManagedMediaSource, which is iOS. An AV1-capable device never sees this
    // AdaptationSet, and the desktops that fall back to H.264 showed none of
    // this. Dropping the rung is better than leaving it selectable: ABR cannot
    // see a hard decode error (it increments no dropped-frame counter), and
    // dash.js's recovery resumes at the same rung and fails again.
    //
    // The cost is 8% of linear resolution. The camera shows a 113.8 degree
    // horizontal slice of the equirect, so at the phone's player box the 2880
    // rung still delivers about 0.92 device pixels per screen pixel against
    // 1.22 for the 4K one, and in landscape neither oversupplies.
    // DEMOTE ON A REAL FAILURE, DO NOT PRE-JUDGE THE DEVICE. An iPhone Xs (A12)
    // cannot sustain the 4K H.264 rung alongside a WebGL sphere, 16 convolvers
    // and a WASM Opus worker; it plays, then raises MEDIA_ERR_DECODE or takes
    // the tab down with it. But every iPhone from the A16 on is also on this
    // ladder, since none of them decode AV1, and those have the headroom. A
    // blanket cap by engine would take 4K away from all of them to protect the
    // oldest, so cap only after the device has actually failed at a rung.
    //
    // ABR cannot do this itself: a hard decode error increments no
    // dropped-frame counter, so DroppedFramesRule never sees it, and dash.js's
    // recovery resumes at the very same rung and fails again, which is the loop
    // this breaks. maxBitrate is computed from the rung that failed rather than
    // hardcoded, so it stays correct across re-encodes.
    if (mediaPlayer.on) {
        mediaPlayer.on('error', function (e) {
            try {
                var code = e && e.error && e.error.code;
                if (code !== 3 && !(e && e.event && e.event.code === 3)) return;   // MEDIA_ERR_DECODE
                var idx = mediaPlayer.getQualityFor('video');
                var reps = mediaPlayer.getBitrateInfoListFor('video') || [];
                var bad = reps[idx];
                if (!bad) return;
                var ceiling = Math.floor(bad.bitrate / 1000) - 1;   // kbps, just under it
                console.warn('HOAST360: decode failed at ' + bad.width + 'x' + bad.height
                    + '; keeping ABR below it until the viewer picks it again');
                mediaPlayer.updateSettings({ streaming: { abr: { maxBitrate: { video: ceiling } } } });
                // The ceiling binds AUTOMATIC selection only. Picking the rung
                // from the quality menu clears it (see _wireQualityLevels), so a
                // device that can in fact manage it is never talked out of it;
                // this only stops ABR from walking back into a rung that just
                // failed and failing again, which is a loop the viewer cannot
                // escape from the menu.
                if (player.__hoast360) player.__hoast360._abrCeilingKbps = ceiling;
            } catch (err) { /* leave the ladder alone if the shape surprises us */ }
        });
    }

    var h = player.__hoast360;
    if (h && h._useSegmentFeed) h._attachSegmentFeed(mediaPlayer);
    attachDvrSeekClamp(player);
});

// FAILSAFE, not the fix - the fix is -seg_duration 2 at the earshot muxer
// (docker-compose.yml, 2026-08-09). The muxer still rounds video up to the
// next contribution keyframe, so any publisher whose GOP does not divide the
// segment target reopens the trap this guards: a 3 s guest GOP makes 3 s video
// segments against 2 s audio, -window_size counts SEGMENTS, so the video DVR
// window outgrows audio's by ~100 s and dash.js advertises seekable time whose
// audio is pruned. Seeking there wedges playback with NO error: readyState 1,
// buffered empty, video.error null (measured 2026-08-08). With a public guest
// port planned, "our own GOP is correct" is not a property we control.
//
// The clamp: read BOTH SegmentTimelines from the live manifest and bump any
// seek below the later timeline's start up to it (+margin for the segment
// being pruned right now). A mismatched publisher then degrades to a shorter
// usable DVR instead of a silent hang.
//
// From the MANIFEST, not from dash.js's accounting, and that is a measured
// decision: the first version asked getCurrentDVRInfo('audio')/('video') and
// the inlined dash.js 4.2 build returned nothing for audio, so the clamp saw
// only the video start and bumped a doomed seek to a different doomed time
// (t=5 -> t=80.79, still ~90 s inside the dead zone, still readyState 1).
// The manifest is ground truth: both <SegmentTimeline> starts share one media
// timeline origin in ffmpeg's live MPD, so (audioStart - videoStart) is the
// dead-zone width, offset-free, and element seekable.start() is video-derived
// (that asymmetry IS the bug), so safe = seekable.start + delta + margin.
//
// The fetch is same-origin, ~2 KB, cached for 3 s, and asynchronous: the first
// application uses the cached delta, the refreshed one re-applies. A second
// 'seeking' event fired by our own correction lands at/above the safe point,
// so it cannot loop, and every failure path leaves the seek untouched.
function attachDvrSeekClamp(player) {
    if (player.__dvrClampAttached) return;   // hook can re-fire on src changes
    player.__dvrClampAttached = true;
    var el = player.el() && player.el().querySelector('video');
    if (!el) return;
    var MARGIN_S = 4;            // two audio segments: clear of the pruning edge
    var cachedDelta = null;      // audioStart - videoStart, seconds; null = unknown
    var lastFetch = 0;

    function parseDelta(mpd) {
        if (!/type="dynamic"/.test(mpd)) return null;      // live manifests only
        var starts = {};
        mpd.split(/(?=<AdaptationSet)/).forEach(function (blk) {
            var mime = /mimeType="(audio|video)/.exec(blk);
            var ts = /timescale="(\d+)"/.exec(blk);
            var s = /<S t="(\d+)"/.exec(blk);              // first S carries the window start
            if (!mime || !ts || !s) return;
            var t0 = parseInt(s[1], 10) / parseInt(ts[1], 10);
            // Two audio AdaptationSets since the keep-alive track, and the
            // engines do not select the same one (WebKit takes the AAC set,
            // Chromium the Opus set). Clamp to the LATER start, which is inside
            // both DVR windows; last-one-parsed would depend on muxer order.
            if (!(mime[1] in starts) || t0 > starts[mime[1]]) starts[mime[1]] = t0;
        });
        if (!('audio' in starts) || !('video' in starts)) return null;
        return starts.audio - starts.video;
    }

    function applyClamp() {
        try {
            if (cachedDelta === null || cachedDelta <= 0) return;   // audio covers video: nothing to guard
            if (!el.seekable.length) return;
            var safe = el.seekable.start(0) + cachedDelta + MARGIN_S;
            if (el.currentTime < safe && isFinite(safe)) el.currentTime = safe;
        } catch (e) { /* a failed clamp must never break a working seek */ }
    }

    el.addEventListener('seeking', function () {
        if (el.duration !== Infinity) return;              // live only; VOD durations are finite
        applyClamp();                                      // immediate, from the cached delta
        var now = Date.now();
        if (now - lastFetch < 3000) return;
        lastFetch = now;
        try {
            fetch(player.currentSrc(), { cache: 'no-store' })
                .then(function (r) { return r.text(); })
                .then(function (x) { cachedDelta = parseDelta(x); applyClamp(); })
                .catch(function () { /* keep the previous delta */ });
        } catch (e) { /* no fetch, no clamp - never break the seek */ }
    });
}

/* global __HOAST_BUILD__ */
const HOAST_BUILD = typeof __HOAST_BUILD__ !== 'undefined' ? __HOAST_BUILD__ : 'dev';
if (typeof window !== 'undefined') window.HOAST360_BUILD = HOAST_BUILD;

export class HOAST360 {
    constructor() {
        this.order = 0;
        this.irs = '';
        this.mediaUrl = '';
        this.irUrl = '';
        this.audioPlayer = null;
        this.sourceNode = null;
        this.audioSetupComplete = false;
        this.videoSetupComplete = false;
        this.xrActive = false;
        this.context = null;
        this.rotator = null;
        this.multiplier = null;
        this.decoder = null;
        this.masterGain = 0;
        this.numCh = 0;
        this.videoPlayer = null;
        this.maxOrder = 4;
        this.opusSupport = true;
        this.zoomIndex = 1;
        this.zoomEnabled = true;

        console.log('HOAST360 build ' + HOAST_BUILD);
        var AudioContext = window.AudioContext || window.webkitAudioContext;
        // At the stream's 48 kHz, explicitly. On a 44.1 kHz output device the
        // context otherwise comes up at 44.1, every scheduled AudioBufferSource
        // resamples its 48 kHz buffer INDEPENDENTLY, and resampler state does
        // not carry across node boundaries - which clicks at every segment
        // junction on the WASM feed (heard on Safari, 2026-08-25). One
        // context-level resample to the device is continuous and silent.
        try { this.context = new AudioContext({ sampleRate: 48000 }); }
        catch (e) { this.context = new AudioContext(); }
        console.log(this.context);

        if (isMobileTabletVRDevice()) {
            this.zoomEnabled = false; // disable zoom on mobile and VR devices to improve efficiency
            console.log('detected mobile device: zoom disabled');
        }
            
        this.playbackEventHandler = new PlaybackEventHandler(this.context);

        // create as many audio players as we need for max order
        this.audioElement = new Audio();
        // Real decode capability, not MediaSource.isTypeSupported(): WebKit has
        // a long history of isTypeSupported answering true for WebM+Opus while
        // actual decode still fails (see the comment in OpusProbe.js), so an
        // advisory-only check lets some browsers through the gate only to fail
        // deep inside DASH/MSE with no clean error. Started here, memoized, and
        // awaited in initialize() so the probe overlaps with page load instead
        // of adding to it.
        this._opusProbe = probeOpusSupport();

        this.videoPlayer = videojs('hoast360-player', {
            html5: { nativeCaptions: false },
            liveui: true,
            plugins: {
                httpSourceSelector: { default: 'auto' }
            }
        });
        // lets the static beforeinitialize hook find the owning instance
        this.videoPlayer.__hoast360 = this;

        let scope = this;
        // THE PLAY EVENT IS NOT A USER GESTURE. iOS 13+ grants
        // DeviceOrientationEvent.requestPermission() only from inside a handler
        // for a real user interaction, and the 'play' event fires later, on the
        // engine's own schedule, by which time the gesture is spent. Every
        // iPhone run on 2026-08-28 logged "Requesting device orientation access
        // requires a user gesture" and no sensor ever worked, in any mode.
        // Hook the raw interaction instead, once, and keep the play handler for
        // engines that need no prompt.
        const askOrientation = function () {
            try {
                if (scope.videoPlayer.usingPlugin('xr')) scope.videoPlayer.xr().enableOrientation();
            } catch (e) { /* plugin not ready; the next tap tries again */ }
        };
        try {
            const rootEl = this.videoPlayer.el();
            const once = function () {
                rootEl.removeEventListener('touchend', once, true);
                rootEl.removeEventListener('click', once, true);
                askOrientation();
            };
            rootEl.addEventListener('touchend', once, true);
            rootEl.addEventListener('click', once, true);
        } catch (e) { /* no element yet */ }

        // Intent, not state. A 'pause' EVENT only fires when something asked for
        // a pause; the silent pause dash.js induces while resetting the media
        // source fires nothing, which is what makes this a reliable
        // discriminator between the two.
        // KEEP THE SCREEN ON WHILE PLAYING. iOS keeps the display awake for a
        // video that is playing audio, and this element is muted by design
        // because the real audio comes from Web Audio, so the phone treats a
        // 360 session as an idle page and locks the screen under the viewer.
        // Reported from an iPhone Xs on 2026-08-28, where it also corrupted
        // every stability measurement: a locked screen suspends media, so the
        // clock stops for reasons that have nothing to do with the player.
        // The lock is dropped whenever the page hides, so it has to be taken
        // again on the way back.
        const wake = { lock: null };
        const takeWakeLock = function () {
            try {
                if (!navigator.wakeLock || wake.lock || document.hidden) return;
                navigator.wakeLock.request('screen').then(function (l) {
                    wake.lock = l;
                    l.addEventListener('release', function () { wake.lock = null; });
                }, function (e) {
                    console.log('HOAST360: screen wake lock refused (' + (e && e.name) + ')');
                });
            } catch (e) { /* not supported; the screen will sleep as before */ }
        };
        const dropWakeLock = function () {
            try { if (wake.lock) { wake.lock.release(); wake.lock = null; } } catch (e) { /* already gone */ }
        };
        this.videoPlayer.on('playing', takeWakeLock);
        this.videoPlayer.on('pause', dropWakeLock);
        this.videoPlayer.on('ended', dropWakeLock);
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) return;
            if (scope.videoPlayer && !scope.videoPlayer.paused()) takeWakeLock();
        });

        this.videoPlayer.on('pause', function () { scope._userPaused = true; });
        // RESUME AFTER A DECODE-ERROR RESET. dash.js answers MEDIA_ERR_DECODE by
        // detaching and re-attaching the same MediaSource, and then nothing ever
        // calls play() again: contrib-dash sets autoplay off, there is no
        // autoplay attribute, and the reset's own pause fires no event. The
        // element sits paused at the right time with a full buffer, video.js
        // sees paused() and hides the control bar behind vjs-has-started, and
        // the audio feed waits for a 'play' that never comes. That is the
        // "stuck, no controls, reload fixes it" an iPhone Xs reported on
        // 2026-08-28. One play() restores all three.
        this.videoPlayer.on('loadstart', function () {
            if (!scope._playbackStarted || scope._userPaused) return;
            if (!scope.videoPlayer.paused()) return;
            console.warn('HOAST360: source reattached while playing (decode-error '
                + 'recovery); resuming');
            const p = scope.videoPlayer.play();
            // If the engine re-arms the gesture requirement after load(), leave
            // it to the watchdog rather than trapping the viewer behind a
            // control bar that is not there.
            if (p && p.catch) p.catch(function (e) {
                console.warn('HOAST360: resume after reattach refused: ' + (e && e.name));
            });
        });
        this.videoPlayer.on('play', function () {
            scope._userPaused = false;
            scope._playbackStarted = true;
            // autoplay policy: the context starts suspended; the play click is the
            // user gesture that may resume it. PlaybackEventHandler covers the
            // separate-audio path, but the combined-MPD path has no other resume.
            // TELL iOS THIS IS PLAYBACK, NOT AMBIENT SOUND. On this player the
            // video element is muted and every sample comes from Web Audio, and
            // iOS then treats the page as ambient: the audio session follows the
            // ringer switch, so a phone on silent renders a running context with
            // a full gain chain completely inaudible. Measured on an iPhone Xs
            // on 2026-08-28: masterGain 1.0, context running, the feed
            // scheduling nodes, and no sound at all in the page, while the same
            // graph WAS audible inside an immersive session, which iOS gives a
            // playback session of its own. Safari 16.4 and later expose
            // navigator.audioSession for exactly this.
            try {
                if (navigator.audioSession && navigator.audioSession.type !== 'playback')
                    navigator.audioSession.type = 'playback';
            } catch (e) { /* not supported; nothing lost */ }
            if (scope.context.state !== 'running')
                scope.context.resume();
            scope._watchAudioContextState();

            // Kept for engines that need no permission prompt at all.
            if (scope.videoPlayer.usingPlugin('xr'))
                scope.videoPlayer.xr().enableOrientation();
        });

        // dash.js's own manifest-refresh timer runs on a schedule
        // independent of buffer/decode health, so a session whose actual
        // segment fetching has silently died - a decode error, a
        // SourceBuffer append failure, a backgrounded tab whose media
        // pipeline the browser suspended - keeps refreshing the live
        // manifest forever with no visible symptom: the page looks alive,
        // nothing plays, and neither this player nor dash.js itself
        // surfaces or recovers from that state on its own. Confirmed live
        // 2026-08-19: a real viewer's segment requests (chunk-stream0
        // .m4s/chunk-stream1 .webm) stopped outright while manifest polling
        // continued unchanged for 2h23m+, indistinguishable server-side
        // from an active viewer. Watching actual playback progress
        // (currentTime advancing) is the only signal that distinguishes
        // that from ordinary, self-recovering rebuffering, which is why
        // this watches timeupdate rather than dash.js's own
        // PLAYBACK_STALLED/BUFFER_EMPTY events - those fire, and clear,
        // constantly under normal network jitter.
        this._lastProgressAt = Date.now();
        this.videoPlayer.on('timeupdate', function () {
            scope._lastProgressAt = Date.now();
        });
        setInterval(function () {
            // A hidden tab is expected to stall - browsers throttle or
            // suspend background media decode on purpose, and reloading
            // behind the user's back would fight that rather than help.
            // The watchdog simply picks back up once the tab is visible.
            if (document.hidden) return;
            // Only a pause the VIEWER asked for silences the watchdog. dash.js
            // recovers a decode error by detaching and re-attaching the media
            // source, and the HTML load algorithm that runs inside that sets
            // paused=true WITHOUT firing a 'pause' event. So the element ends up
            // paused with nobody having asked, and the plain paused() guard
            // switched off the one mechanism built to catch exactly this.
            if (scope._userPaused) return;
            if (scope.videoPlayer.paused() && !scope._playbackStarted) return;
            if (Date.now() - scope._lastProgressAt > STALL_RELOAD_MS) {
                console.warn('HOAST360: no playback progress for ' + STALL_RELOAD_MS
                    + 'ms while playing and visible - reloading to recover');
                window.location.reload();
            }
        }, STALL_CHECK_INTERVAL_MS);
    }

    // The shipped zoom matrices are 25x25 (fourth order). Take the leading
    // block for the order actually being rendered; see the multiplier
    // construction for why that is exact rather than a truncation.
    _sliceZoomMtx(mtx) {
        const n = (this.order + 1) * (this.order + 1);
        if (!mtx || mtx.length === n) return mtx;
        const out = new Array(n);
        for (let r = 0; r < n; r++) out[r] = mtx[r].slice(0, n);
        return out;
    }

    // FULLSCREEN ON IPHONE UNWRAPS THE SPHERE, so replace it with a CSS one.
    // Safari on iPhone exposes fullscreen only on a video element (iPad does
    // support Element.requestFullscreen, hence the capability test rather than
    // a user-agent one), and video.js therefore falls back to the element's
    // native fullscreen. That is the system player: it plays the equirect frame
    // flat and never paints the WebGL canvas the sphere lives on, which is what
    // an iPhone Xs showed on 2026-08-28. Expanding the player container instead
    // keeps the canvas, the projection and the controls, at the cost of the
    // browser chrome staying on screen.
    _installPseudoFullscreen() {
        if (this._pseudoFsInstalled) return;
        const canElementFullscreen = !!(document.fullscreenEnabled
            || document.webkitFullscreenEnabled || document.mozFullScreenEnabled);
        if (canElementFullscreen) return;      // real fullscreen works here
        const player = this.videoPlayer;
        const root = player.el && player.el();
        if (!root) return;
        this._pseudoFsInstalled = true;
        const settle = function () {
            // The XR plugin resizes its renderer from a window resize event and
            // reads the player's box, so the class has to be applied first.
            try { window.dispatchEvent(new Event('resize')); } catch (e) { /* older engines */ }
            setTimeout(function () {
                try { window.dispatchEvent(new Event('resize')); } catch (e) { /* ignore */ }
            }, 120);
        };
        // Read the state back off the DOM rather than video.js's own flag.
        // The flag is authoritative about the BROWSER's fullscreen, which we are
        // deliberately not using, and setting it did not survive: the toggle
        // then read false while the player was expanded, so a second tap
        // re-entered instead of exiting. The class is the truth here.
        const origIsFullscreen = player.isFullscreen.bind(player);
        player.isFullscreen = function (value) {
            if (value === undefined) return root.classList.contains('hoast-pseudo-fs');
            return origIsFullscreen(value);
        };
        player.requestFullscreen = function () {
            root.classList.add('hoast-pseudo-fs');
            // vjs-fullscreen is what video.js's own stylesheet keys the exit
            // icon and the fullscreen layout off, so the control looks right.
            player.addClass('vjs-fullscreen');
            document.documentElement.classList.add('hoast-pseudo-fs-lock');
            player.trigger('fullscreenchange');
            settle();
            return Promise.resolve();
        };
        player.exitFullscreen = function () {
            root.classList.remove('hoast-pseudo-fs');
            player.removeClass('vjs-fullscreen');
            document.documentElement.classList.remove('hoast-pseudo-fs-lock');
            player.trigger('fullscreenchange');
            settle();
            return Promise.resolve();
        };
        console.log('HOAST360: element fullscreen unavailable; using the CSS '
            + 'fullscreen that keeps the 360 view');
    }

    // iOS HAS A THIRD AudioContext STATE, AND IT IS NOT 'suspended'.
    // WebKit parks a context at 'interrupted' when the system takes audio away
    // (a call, another app, screen lock) and, as measured on an iPhone Xs on
    // 2026-08-28, after a pause: beacon run to3fjf reported state 'interrupted'
    // while the element sat paused. Nothing in the player watched for that, so
    // audio came back only when the next 'play' happened to run the resume in
    // the play handler, which is the few seconds of silence after resuming.
    //
    // An interruption also invalidates what the feed has already scheduled:
    // its AudioBufferSourceNodes are anchored to a context clock that stopped.
    // Resuming the context alone would leave the graph running against a dead
    // anchor, so the feed is pushed back through its stalled path, which is the
    // one route that rebuilds and re-anchors from scratch.
    _watchAudioContextState() {
        if (this._ctxWatch || !this.context || !this.context.addEventListener) return;
        this._ctxWatch = true;
        const scope = this;
        this.context.addEventListener('statechange', function () {
            const st = scope.context.state;
            if (st === 'running') return;
            const el = scope.videoPlayer && scope.videoPlayer.el
                ? scope.videoPlayer.el().querySelector('video') : null;
            // Only fight for the context while the viewer expects sound. A
            // deliberate pause should stay quiet, and resuming a context the
            // system suspended on purpose can be refused anyway.
            if (!el || el.paused) return;
            console.log('HOAST360: AudioContext went ' + st + ' during playback; resuming');
            const p = scope.context.resume();
            const after = function () {
                const f = scope.audioFeed;
                if (!f) return;
                // Force the rebuild path rather than the idempotent one: the
                // chain that was scheduled before the interruption is anchored
                // to a clock that no longer advances.
                if (f.state === 'running') f.state = 'stalled';
                if (typeof f._resume === 'function') f._resume();
            };
            if (p && p.then) p.then(after, function () { /* refused; next play retries */ }); else after();
        });
    }

    async initialize(newMediaUrl, newIrUrl, newOrder) {
        const opus = await this._opusProbe;
        this.opusSupport = opus.ok;
        // The probe judges the PLATFORM decoder, but on the WASM feed the
        // platform never decodes Opus: video is avc1 through MSE and audio is
        // libopus-in-WASM. Safari fails the multichannel probe by design
        // (docs/IOS-SAFARI.md) and must not be bounced to "use Chrome" for a
        // codec path this player no longer needs there.
        const qpEarly = new URLSearchParams(window.location.search);
        // Safari (macOS and iOS alike) cannot decode multichannel Opus through
        // ANY native route - decodeAudioData, WebCodecs, MSE - measured in
        // docs/IOS-SAFARI.md. Its MSE/ManagedMediaSource also refuses the
        // audio/mp4 opus type outright, so dash.js will drop the audio
        // AdaptationSet there on its own and drive video only. The feed then
        // carries the audio, decoding through libopus-in-WASM instead of
        // decodeAudioData. Probed by capability, not user agent, so any other
        // browser with the same gap gets the same treatment; ?wasmaudio forces
        // the WASM backend anywhere for A/B measurement.
        const MSEarly = window.MediaSource || window.ManagedMediaSource;
        let mseOpus = false;
        try { mseOpus = !!MSEarly && MSEarly.isTypeSupported('audio/mp4; codecs="opus"'); } catch (e) { /* absent */ }
        this._feedBackend = (qpEarly.has('wasmaudio') || (!IS_CHROMIUM && !mseOpus)) ? 'wasm' : 'native';
        // THE TYPE CHECK LIES ON iOS. iOS 26.6 answers isTypeSupported
        // ('audio/mp4; codecs="opus"') TRUE (probe run kc5du0), where macOS
        // Safari says false, so the type check alone would land iPhone on
        // native audio and hand the 16-channel set to a decoder that has never
        // demonstrated multichannel. The REAL decode probe outranks the type
        // check: a non-Chromium browser that failed multichannel gets the WASM
        // feed no matter what isTypeSupported claims.
        if (!IS_CHROMIUM && this._feedBackend === 'native' && !opus.ok) {
            console.log('HOAST360: MSE claims Opus-in-MP4 but the multichannel '
                + 'decode probe failed; taking the WASM feed instead');
            this._feedBackend = 'wasm';
        }
        this._useSegmentFeed = String(newMediaUrl).includes('.mpd')
            && !qpEarly.has('legacyaudio')
            && (IS_CHROMIUM || this._feedBackend === 'wasm');
        const wasmFeedPlanned = this._useSegmentFeed && this._feedBackend === 'wasm';
        if (!this.opusSupport && wasmFeedPlanned) {
            console.log('HOAST360: native Opus probe failed (' + (opus.diagnosis || 'no decode')
                + '), continuing on the WASM audio feed, which does not use the platform decoder');
        }
        if (!this.opusSupport && !wasmFeedPlanned) {
            // Two different failures need two different answers. A browser that
            // cannot decode Opus at all is a dead end here; one that decodes
            // stereo but not multichannel is almost certainly a fixable Chrome
            // field trial, and telling that user "your browser does not support
            // Opus" would be both wrong and useless, since their browser
            // supports it right up until the channel count goes above 2.
            if (opus.diagnosis === 'multichannel-only-failure') {
                this.videoPlayer.error(
                    'Error: This browser decodes stereo Opus but fails on multichannel, which this '
                    + 'player needs. Firefox or Brave will work. If you are on recent Chrome there is '
                    + 'a one-flag fix, with the exact command for each OS: ' + CHROME_OPUS_HELP_URL);
                // The message is rendered as plain text by video.js, so repeat
                // it where a link is clickable and the detail can be longer.
                console.error(
                    'Multichannel Opus decode failed while stereo Opus decoded successfully.\n'
                    + 'Check chrome://version before concluding a cause: the field trial below\n'
                    + 'exists only in recent Chrome, so on an older embedded Chromium the cause\n'
                    + 'is a decoder that never supported multichannel Opus, not this trial.\n'
                    + 'Known cause on recent Chrome: the DirectOpusAudioDecoding field trial, which is\n'
                    + 'server-delivered, does not appear in chrome://flags, and is NOT cleared by\n'
                    + 'incognito, a guest profile, or restarting the browser.\n'
                    + 'Workaround: relaunch Chrome with --disable-features=DirectOpusAudioDecoding\n'
                    + 'Background and evidence: ' + CHROME_OPUS_HELP_URL);
            } else {
                this.videoPlayer.error('Error: Your browser does not support the OPUS audio codec. Please use Firefox or Chrome-based browsers.');
            }
            return;
        }

        this.videoPlayer.xr();
        console.log(this.videoPlayer);
        console.log(this.videoPlayer.xr());

        this.audioSetupComplete = false;
        this.videoSetupComplete = false;

        if (this.order > this.maxOrder)
            console.error('Ambisonic orders greater than 4 not supported!');

        this.order = newOrder;
        this.mediaUrl = newMediaUrl;
        this.irUrl = newIrUrl;
        this._setOrderDependentVariables();

        // Segment-audio feed (combined-MPD path): bypasses the MSE element
        // tap and its fixed ~2 s delay. Decided at the top of initialize()
        // (before src() below, because the beforeinitialize hook reads the
        // flag), where the opus error gates already need the answer.
        // ?legacyaudio forces the old wiring for A/B measurements.
        this._xrReady = false;
        this._feedN = 0;
        this._feedDegraded = false;
        // All Chromium, mobile included: gate G6 (per-segment 16-ch Opus
        // pair-decode on a real phone, via ?audiofeed) passed 2026-07-21 with
        // no dropouts, and the degrade path covers weaker devices. ?legacyaudio
        // still forces the old element-audio wiring anywhere.
        // Backend and feed mode were decided at the top of initialize(), where
        // the error gates need them; nothing here may redecide them, or the
        // probe-outranks-typecheck override above would be silently undone.
        const qp = qpEarly;

        // RENDER AT THE DISPLAY'S REAL PIXEL RATIO. Default since 2026-08-17.
        //
        // videojs-xr constructs THREE.WebGLRenderer with a devicePixelRatio
        // option, which is NOT a WebGLRenderer option: three.js reads the ratio
        // only through setPixelRatio(), and nothing ever calls it. The renderer
        // therefore sits at its default ratio of 1, the WebGL canvas is
        // allocated at CSS size, and the browser upscales it to the physical
        // pixels - a 2x softening in each direction on a 2x display.
        //
        // Measured 2026-08-12 on the concert master: at a 100 deg viewport a
        // 4096-wide equirect supplies ~1138 real pixels, so an ~800 px canvas
        // sits BELOW the source's detail and discards some of it. Rendering at
        // 1600 scores 47.5 dB PSNR against that native detail versus 40.2 dB
        // for the 800 px canvas upscaled: a 7.3 dB gain. Above ~1138 px there
        // is nothing further to recover, so this saturates rather than
        // improving without limit.
        //
        // Was gated behind ?beta until the two devices that mattered were
        // measured. Quest 3, 2026-08-16, controlled A/B against the same build
        // with DPR off: worst 81 fps -> 82 fps, sustained 90 fps -> 90 fps.
        // Sustained framerate is IDENTICAL; DPR costs nothing measurable
        // against the 16-convolver ambisonic graph running beside it. The Mac
        // Mini never got its half of the measurement and now cannot: it has
        // been repurposed to a headless Ubuntu server with no browser at all,
        // so it drops out of this decision rather than having passed it.
        // ?legacydpr forces the old DPR-1 rendering, same escape-hatch pattern
        // as ?legacyaudio above, kept for A/B measurement on any future device
        // this has not been checked on.
        // The flag only. An earlier version of this called setPixelRatio here
        // and it did NOTHING: videojs-xr creates the renderer later, so
        // videoPlayer.xr().renderer is still undefined at this point and the
        // call went into a catch. That is the very bug being fixed - a
        // pixel-ratio call that looks right and has no effect - so the real
        // work happens where the renderer is constructed, in the xr plugin.
        this._dprCorrectRendering = !qp.has('legacydpr');
        window.__hoastDprCorrect = this._dprCorrectRendering;

        // Debug badge so a screen recording self-documents which build it is:
        // an A/V-sync experiment is worthless if you cannot tell which liveDelay
        // was actually loaded (cache makes that ambiguous).
        try {
            // Only with ?dbg in the URL: a badge showing the build plus the live
            // renderer/video state, so a mobile screenshot pinpoints why the
            // sphere is black or warped (element size vs drawing-buffer size vs
            // camera aspect vs whether the video is actually playing). Hidden for
            // visitors.
            if (qp.has('dbg')) {
                var badge = document.getElementById('ld-badge') || document.createElement('div');
                badge.id = 'ld-badge';
                badge.style.cssText = 'position:absolute;top:8px;left:8px;z-index:9999;white-space:pre;'
                    + 'background:rgba(0,0,0,.72);color:#0f0;font:11px monospace;line-height:1.35;'
                    + 'padding:4px 7px;border-radius:4px;pointer-events:none';
                var host = document.querySelector('.player') || document.body;
                if (host && badge.parentNode !== host) host.appendChild(badge);
                var badgeScope = this;
                // deviceorientation delivery counter: ev grows only if the OS/
                // browser actually hands sensor events to the page, which is the
                // one link the emulated-sensor harness cannot test. ev0 with the
                // gate on means delivery is blocked (e.g. Chrome's Motion
                // sensors site setting), not a player bug.
                if (!window.__oriProbe) {
                    window.__oriProbe = { n: 0, a: null, pa: '?', pg: '?' };
                    window.addEventListener('deviceorientation', function (e) {
                        window.__oriProbe.n++; window.__oriProbe.a = e.alpha;
                    });
                    // Chromium exposes the Motion-sensors site setting through the
                    // Permissions API: denied here = the browser setting blocks
                    // delivery, and no player code can see a single event.
                    try {
                        navigator.permissions.query({ name: 'accelerometer' })
                            .then(function (s) { window.__oriProbe.pa = s.state; }, function () {});
                        navigator.permissions.query({ name: 'gyroscope' })
                            .then(function (s) { window.__oriProbe.pg = s.state; }, function () {});
                    } catch (e) { /* non-Chromium: keep '?' */ }
                }
                // FRAME RATE, sampled from rAF. On a headset there is no
                // console to read, so the number has to be on screen and has to
                // survive a screenshot: show the current rate plus the WORST
                // one-second bucket since load, because a mean hides exactly the
                // stutter that would make DPR 2 unusable.
                if (!window.__fpsProbe) {
                    window.__fpsProbe = { n: 0, fps: 0, min: 999, t0: performance.now(),
                                          skip: true, hid: 0 };
                    // A HIDDEN TAB MUST NOT COUNT. Browsers throttle rAF to about
                    // 1 Hz in a background tab, so a single tab-away would pin
                    // `worst` at a single digit for the rest of the session and
                    // destroy exactly the long unattended watch this number is
                    // for. Buckets that touch a hidden period are discarded, and
                    // the first bucket after returning is skipped too because it
                    // straddles the transition. hid counts how many times that
                    // happened, so the reading stays honest about what it missed.
                    document.addEventListener('visibilitychange', function () {
                        var f = window.__fpsProbe;
                        if (document.hidden) { f.hid++; }
                        f.skip = true; f.n = 0; f.t0 = performance.now();
                    });
                    (function tick() {
                        var f = window.__fpsProbe;
                        f.n++;
                        var now = performance.now(), dt = now - f.t0;
                        if (dt >= 1000) {
                            f.fps = Math.round(f.n * 1000 / dt);
                            if (f.skip || document.hidden) {
                                f.skip = false;          // discard this bucket only
                            } else {
                                f.min = Math.min(f.min, f.fps);
                            }
                            f.n = 0; f.t0 = now;
                        }
                        requestAnimationFrame(tick);
                    })();
                }
                if (!window.__ldBadgeTimer) window.__ldBadgeTimer = setInterval(function () {
                    try {
                        var p = badgeScope.videoPlayer;
                        var xr = (p && p.xr) ? p.xr() : null;
                        var r = xr && xr.renderer, cam = xr && xr.camera;
                        var v = (host && host.querySelector('video')) || document.querySelector('video');
                        var o = xr && xr.controls3d && xr.controls3d.orientation;
                        var fp = window.__fpsProbe || { fps: '?', min: '?' };
                        badge.textContent = BUILD_TAG + ' · ld' + LIVE_DELAY_S + 's'
                            + (badgeScope._dprCorrectRendering ? '' : ' · LEGACYDPR')
                            + '\nfps   ' + fp.fps + ' (worst ' + (fp.min === 999 ? '-' : fp.min) + ')'
                            + (fp.hid ? ' bg' + fp.hid : '')
                            + '\ndpr   ' + (r && typeof r.getPixelRatio === 'function'
                                    ? r.getPixelRatio() : '?')
                                + ' / dev ' + (window.devicePixelRatio || '?')
                            + '\nelem  ' + (p ? p.currentWidth() + 'x' + p.currentHeight() : '?')
                            + '\nbuf   ' + (r && r.domElement ? r.domElement.width + 'x' + r.domElement.height : '?')
                            + '\naspect ' + (cam ? cam.aspect.toFixed(3) : '?')
                            + '\nvideo ' + (v ? v.videoWidth + 'x' + v.videoHeight + ' pause' + (v.paused ? 1 : 0) + ' rs' + v.readyState : '?')
                            + '\ngl.max ' + (r && r.capabilities ? r.capabilities.maxTextureSize : '?')
                            + '\nori   ' + (!xr || !xr.controls3d ? 'noctl'
                                : (o ? ((o.connected ? 'conn' : 'NOCONN') + (o.enabled ? '' : ' DISABLED')) : 'off(gate)'))
                            + ' ev' + window.__oriProbe.n
                            + (window.__oriProbe.a != null ? ' a' + window.__oriProbe.a.toFixed(0) : '')
                            + '\nperm  acc:' + window.__oriProbe.pa + ' gyr:' + window.__oriProbe.pg;
                    } catch (e) { badge.textContent = BUILD_TAG + ' dbg:' + (e && e.message); }
                }, 1000);
            }
        } catch (e) { /* badge is best-effort, never block playback */ }

        if (this.mediaUrl.includes(".mpd")) { // in this case audio and video are inside the same mpd
            // Feed mode must not create a MediaElementSource AT ALL: an
            // MSE-captured element connected anywhere in the graph flips the
            // whole AudioContext output into Chromium's high-latency path
            // (measured at the speakers: +1.65 s while the graph-level signal
            // is in sync), and an unconnected capture freezes the element
            // clock outright. So in feed mode the element is silenced by
            // pinning muted instead, re-asserted against UI writes; the feed
            // audio level follows the volume slider via masterGain.
            // ?capture restores the captured variant for A/B measurement.
            this._noCapture = this._useSegmentFeed
                && !new URLSearchParams(window.location.search).has('capture');

            if (!this._noCapture) {
                if (!this.sourceNode)
                    this.sourceNode = this.context.createMediaElementSource(this.videoPlayer.tech({ IWillNotUseThisInPlugins: true }).el());

                if (this._useSegmentFeed && !this._elementSink) {
                    // captured variant: keep the capture pulled through zero
                    // gain so the element clock advances while staying silent
                    this._elementSink = this.context.createGain();
                    this._elementSink.gain.value = 0;
                    this.sourceNode.connect(this._elementSink);
                    this._elementSink.connect(this.context.destination);
                }
            } else {
                let scope2 = this;
                // KEEP-ALIVE. WebKit suspends a backgrounded <video> unless it
                // has a decodable audio track AND is unmuted - measured three
                // times over: muted-with-no-track and unmuted-with-no-track both
                // froze the instant the page hid, while unmuted-with-a-silent-
                // track kept decoding. Our audio is slaved to the element clock,
                // so a suspended element silences the feed within ~2 s of the
                // operator switching Spaces.
                // Unmuting is safe on the WASM path specifically: Safari's
                // CapabilitiesFilter always drops the 16-channel Opus set, so
                // the element carries either the silent stereo AAC keep-alive
                // track or no audio track at all. Both are silent. On Chromium
                // the Opus set IS decodable and unmuting would double the audio,
                // so the mute pin stands there.
                // ?keepalive=0 opts out. Headless WebKit refuses unmuted
                // playback outright (it has no real output device), so a harness
                // that leaves this on measures a paused element rather than the
                // pipeline it meant to test. The keep-alive is verified in real
                // Safari by hand; harnesses turn it off and test everything else.
                let keepAlive = scope2._feedBackend === 'wasm'
                    && new URLSearchParams(window.location.search).get('keepalive') !== '0';
                // GATED ON A REAL GESTURE. WebKit pauses an unmuted element that
                // began playing without one, so unmuting unconditionally breaks
                // muted autoplay outright - it stopped playback dead in every
                // headless harness. A user pressing play is a gesture, so the
                // keep-alive still applies exactly when a person is watching;
                // an autoplaying muted page keeps working and simply forgoes it.
                let sawGesture = false;
                ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
                    document.addEventListener(ev, function () { sawGesture = true; },
                        { capture: true, passive: true });
                });
                let pin = function () {
                    try {
                        let el = scope2.videoPlayer.tech({ IWillNotUseThisInPlugins: true }).el();
                        if (!el) return;
                        if (keepAlive && sawGesture) { if (el.muted) el.muted = false; }
                        else if (!el.muted) el.muted = true;
                    } catch (e) { /* tech not ready yet */ }
                };
                pin();
                this._mutePin = setInterval(pin, 500);
                this.videoPlayer.on('volumechange', pin);

                // videojs mirrors el.muted, which the pin holds true forever,
                // so the mute button would show muted and do nothing. Reroute
                // the player's muted() to a UI-intent flag driving masterGain:
                // the button works again, the element stays silent.
                if (!this._origMuted) {
                    this._origMuted = this.videoPlayer.muted.bind(this.videoPlayer);
                    this._uiMuted = false;
                    this.videoPlayer.muted = function (m) {
                        if (m === undefined) return scope2._uiMuted;
                        scope2._uiMuted = !!m;
                        if (scope2.masterGain && scope2.masterGain.gain)
                            scope2._setMasterGain(scope2._uiMuted ? 0 : scope2.videoPlayer.volume());
                        scope2.videoPlayer.trigger('volumechange');
                        return scope2.videoPlayer;
                    };
                }
            }

            // iOS Safari has no MediaSource, only ManagedMediaSource, and WebKit
            // only activates MMS when remote playback is disabled (or an AirPlay
            // source alternative exists) - without this, sourceopen never fires
            // and playback silently never starts. Harmless everywhere else.
            try {
                const vel = this.videoPlayer.tech({ IWillNotUseThisInPlugins: true }).el();
                if (!window.MediaSource && window.ManagedMediaSource) {
                    if (vel) vel.disableRemotePlayback = true;
                }
                // playsinline, unconditionally: without it iPhone enters the
                // native fullscreen player on play(), which blacks out the
                // WebGL sphere that paints from this element. Harmless
                // everywhere else. Probe run kc5du0 verified inline 4K
                // playback with the attribute present.
                if (vel) {
                    vel.setAttribute('playsinline', '');
                    vel.setAttribute('webkit-playsinline', '');
                }
                // THE VOLUME CONTROL ASKS THE WRONG ELEMENT ON iOS. video.js
                // decides whether to show it from Html5.canControlVolume(),
                // which probes whether setting a video element's .volume
                // sticks. On iOS it does not, so the panel is hidden and the
                // iPhone Xs run on 2026-08-28 had a control that could not be
                // tapped. That probe is correct about the element and
                // irrelevant here: on the WASM feed the element is muted and
                // every audible sample comes from masterGain in Web Audio,
                // which the existing volumechange handler already drives. So
                // re-enable the control on the feed path only, where our own
                // gain node is what the slider actually moves.
                if (this._feedBackend === 'wasm') {
                    const tech = this.videoPlayer.tech({ IWillNotUseThisInPlugins: true });
                    if (tech) tech.featuresVolumeControl = true;
                    // The PANEL and the CONTROL inside it are hidden by two
                    // separate checkVolumeSupport calls, so unhiding the panel
                    // alone left a slider that opened and did nothing, reported
                    // from the iPhone Xs on rf34.
                    const cb = this.videoPlayer.controlBar;
                    const vp = cb && cb.volumePanel;
                    if (vp && vp.removeClass) vp.removeClass('vjs-hidden');
                    const vc = vp && vp.volumeControl;
                    if (vc && vc.removeClass) vc.removeClass('vjs-hidden');
                    // AND THE EVENT NEVER ARRIVES ON iOS. video.js relays
                    // 'volumechange' from the media element, and setting
                    // element.volume is a no-op there, so the element never
                    // fires it and the masterGain handler below never runs: the
                    // slider moved and nothing got louder. Drive the gain from
                    // the setter instead, which is the call the slider actually
                    // makes. The event handler stays for engines that do fire.
                    // VIRTUALISE THE LEVEL, do not just mirror it. Reading it
                    // back from the element is what broke rf35 on the iPhone Xs:
                    // a tap on the slider set volume 0, iOS ignored the write so
                    // the element still reported 1, the bar never moved, and the
                    // gain went to 0 and stayed there. The result was a control
                    // that felt dead and a player with no sound at all, with the
                    // UI insisting the volume was full. Keeping the value here
                    // makes the bar, the getter and the gain the same number, so
                    // a slider move is visible and reversible.
                    const scopeV = this;
                    if (typeof scopeV._uiVolume !== 'number') scopeV._uiVolume = 1;
                    const origVolume = this.videoPlayer.volume.bind(this.videoPlayer);
                    this.videoPlayer.volume = function (value) {
                        if (value === undefined) return scopeV._uiVolume;
                        let v = Number(value);
                        if (!isFinite(v)) return scopeV._uiVolume;
                        v = Math.max(0, Math.min(1, v));
                        scopeV._uiVolume = v;
                        try { origVolume(v); } catch (e) { /* iOS ignores the element */ }
                        if (scopeV.masterGain && typeof scopeV._setMasterGain === 'function')
                            scopeV._setMasterGain(scopeV._uiMuted ? 0 : v);
                        // iOS fires no volumechange of its own, because the
                        // element's volume never actually moved, so the control
                        // bar would never redraw without this.
                        scopeV.videoPlayer.trigger('volumechange');
                        return scopeV.videoPlayer;
                    };
                }
                this._installPseudoFullscreen();
            } catch (e) { /* tech not ready; dash.js will surface the failure */ }
            this.videoPlayer.src({ type: 'application/dash+xml', src: this.mediaUrl });
            this._wireQualityLevels();
            this.audioPlayer = null;
        } else { // load audio and video from separate mpds
            this.audioPlayer = dashjs.MediaPlayer().create();
            // keep the audio delay identical to the video player's (hook above)
            this.audioPlayer.updateSettings({ streaming: { delay: { liveDelay: LIVE_DELAY_S } } });
            if (!this.sourceNode)
                this.sourceNode = this.context.createMediaElementSource(this.audioElement);
                
            this.videoPlayer.src({ type: 'application/dash+xml', src: this.mediaUrl + 'video.mpd' });
            this.audioPlayer.initialize(this.audioElement);
            this.audioPlayer.setAutoPlay(false);
            this.audioPlayer.attachSource(this.mediaUrl + "audio.mpd");
        }

        let scope = this;

        this.videoPlayer.xr().on("initialized", function () {
            console.log("xr initialized");
            scope._xrReady = true;
            scope._startSetup();

            // playback event handler is only needed if we have separate audio and video players
            if (scope.audioPlayer)
                scope.playbackEventHandler.initialize(scope.videoPlayer, scope.audioPlayer);
        });
    }

    // Bridge dash.js video renditions into video.js's qualityLevels() list, so the
    // httpSourceSelector menu (auto / 1920p / ... / 360p) populates for DASH (which
    // videojs-contrib-dash does not do on its own). Picking a rung pins dash.js to
    // it; "auto" re-enables dash.js ABR.
    _wireQualityLevels() {
        let scope = this;
        let player = this.videoPlayer;
        let qualityLevels = player.qualityLevels();
        let wired = false;
        let attach = function () {
            if (wired) return;
            let mp = player.dash && player.dash.mediaPlayer;
            if (!mp || !mp.getBitrateInfoListFor) return;
            wired = true;
            let reconcileTimer = null;
            let reconcile = function () {
                let on = [];
                for (let i = 0; i < qualityLevels.length; i++)
                    if (qualityLevels[i].enabled) on.push(i);
                // all (or none) enabled -> dash.js ABR ("auto"); exactly one -> pin it
                let auto = (on.length === 0 || on.length === qualityLevels.length);
                // AN EXPLICIT PICK OUTRANKS THE AUTOMATIC CEILING. If a decode
                // error lowered the ABR ceiling and the viewer then chooses that
                // rung anyway, honour it: the ceiling exists to stop ABR
                // looping through a failure, not to overrule a person who can
                // see the picture and decide for themselves.
                if (!auto && scope._abrCeilingKbps) {
                    mp.updateSettings({ streaming: { abr: { maxBitrate: { video: -1 } } } });
                    scope._abrCeilingKbps = 0;
                }
                mp.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: auto } } } });
                if (!auto) {
                    mp.setQualityFor('video', on[on.length - 1], true);
                } else if (mp.getQualityFor) {
                    // Back to adaptive. Re-report the current rendition even
                    // though it has not changed, so the menu rebuilds and stops
                    // showing Auto and the old rung ticked at the same time.
                    reportSelection(mp.getQualityFor('video'), true);
                }
            };
            let schedule = function () {
                if (reconcileTimer) clearTimeout(reconcileTimer);
                reconcileTimer = setTimeout(reconcile, 0);   // coalesce the menu's per-level sets
            };
            let populate = function () {
                if (qualityLevels.length) return;   // add the rungs once
                let reps = mp.getBitrateInfoListFor('video') || [];
                reps.forEach(function (rep) {
                    qualityLevels.addQualityLevel({
                        id: 'v' + rep.qualityIndex,
                        width: rep.width,
                        height: rep.height,
                        bandwidth: rep.bitrate,   // the lib reads .bandwidth, not .bitrate
                        enabled: function (enable) {
                            if (enable === undefined) return this.__on !== false;
                            this.__on = enable;
                            schedule();           // menu selection -> drive dash.js directly
                            return enable;
                        }
                    });
                });
            };
            // The OTHER half of the tech's contract, and the reason the quality
            // menu used to misbehave here. videojs-contrib-quality-levels keeps
            // the active rendition in selectedIndex_, and the menu plugin
            // rebuilds itself on the list's 'change' event; VHS does this for
            // HLS, so the plugin is correct there. Populating the list without
            // ever reporting the selection left selectedIndex at -1 forever, so
            // no rung matched, nothing was ticked at startup, and clicks never
            // cleared the previous highlight because no rebuild was ever
            // triggered. That is our omission, not the plugin's bug.
            // force = report even when the index has not moved. Needed when the
            // user picks Auto: adaptive mode resumes but dash.js often keeps the
            // same rendition, so no qualityChangeRendered follows, no rebuild
            // happens, and the menu is left showing both Auto (marked by the
            // click) and the previously active rung.
            let reportSelection = function (index, force) {
                if (typeof index !== 'number' || index < 0) return;
                if (qualityLevels.selectedIndex === index && !force) return;
                qualityLevels.selectedIndex_ = index;
                qualityLevels.trigger({ type: 'change', selectedIndex: index });
            };
            // dash.js reports the rendition it has actually rendered. Our rungs
            // are added in getBitrateInfoListFor order, so list index and
            // dash.js quality index line up.
            mp.on('qualityChangeRendered', function (e) {
                if (e && e.mediaType === 'video') reportSelection(e.newQuality);
            });
            // A pick made while PAUSED renders nothing, so the event above never
            // arrives and the menu keeps its previous tick until playback
            // resumes: the switch has happened, only the highlight lies. Same
            // shape as the Auto case that force exists for, one step further
            // out. dash.js announces the switch it is about to make separately,
            // and that does fire while paused, so report it too. force, because
            // picking the rendition dash.js already holds is exactly the case
            // that otherwise reports nothing. The rendered event still follows
            // and agrees; this only makes the menu honest sooner.
            mp.on('qualityChangeRequested', function (e) {
                if (e && e.mediaType === 'video') reportSelection(e.newQuality, true);
            });
            mp.on('streamInitialized', function () {
                populate();
                // Whatever dash.js already chose, before any switch happens.
                if (mp.getQualityFor) reportSelection(mp.getQualityFor('video'));
            });
            populate();   // in case the stream is already initialized
            if (mp.getQualityFor) reportSelection(mp.getQualityFor('video'));
        };
        attach();
        player.one('loadstart', attach);
        player.one('loadedmetadata', attach);
    }

    reset() {
        if (!this.opusSupport) {
            this.videoPlayer.reset();
            return;
        }

        if (this.audioPlayer)
            this.playbackEventHandler.reset();

        this.videoPlayer.pause();
        this._disconnectAudio();
        this.videoPlayer.xr().reset();
        this.videoPlayer.dash.mediaPlayer.reset();
        this.videoPlayer.reset(); // this triggers an error "failed to remove source buffer from media source", but seems to work anyway
        if (this.audioPlayer)
            this.audioPlayer.reset();
    }

    _disconnectAudio() {
        // feed teardown must run before dash.mediaPlayer.reset() so no
        // listener remains on a dead MediaPlayer
        if (this.audioFeed) { this.audioFeed.destroy(); this.audioFeed = null; }
        // null-guards: with graph construction deferred to the first decode, a
        // reset() can arrive before _setupAudio ever ran (masterGain is still
        // the number 0 then), and an unguarded dereference wedges reset()
        if (this.sourceNode) try { this.sourceNode.disconnect(); } catch (e) { /* already disconnected */ }
        if (this._elementSink) { try { this._elementSink.disconnect(); } catch (e) { /* already disconnected */ } this._elementSink = null; }
        if (this._mutePin) { clearInterval(this._mutePin); this._mutePin = null; }
        if (this._origMuted) { this.videoPlayer.muted = this._origMuted; this._origMuted = null; }
        if (this.rotator && this.rotator.out) this.rotator.out.disconnect();
        if (this.multiplier && this.multiplier.out) this.multiplier.out.disconnect();
        if (this.decoder && this.decoder.out) this.decoder.out.disconnect();
        if (this.masterGain && this.masterGain.disconnect) this.masterGain.disconnect();
    }

    _startSetup() {
        if (this.audioSetupComplete || this.videoSetupComplete) return;
        if (!this._xrReady) return;
        // Combined-path feed: wait for the first decoded segment so the graph
        // is built with the stream's channel count (16 or 25), not the page's
        // guess. With the 30 s live delay the first decode lands well before
        // playout. If the feed degrades instead, build on the legacy path.
        if (this._useSegmentFeed && !this._feedDegraded && !this._feedN) return;
        this._setupAudio();
        this._setupVideo();
    }

    _attachSegmentFeed(mediaPlayer) {
        if (!this.audioFeed) {
            let scope = this;
            this.audioFeed = new SegmentAudioFeed({
                context: this.context,
                decodeBackend: this._feedBackend === 'wasm' ? new WasmOpusBackend() : null,
                selfFetchAudio: this._feedBackend === 'wasm',
                renderReady: !!this._irsReady,
                getElement: function () {
                    try { return scope.videoPlayer.tech({ IWillNotUseThisInPlugins: true }).el(); }
                    catch (e) { return document.querySelector('#hoast360-player video, .video-js video'); }
                },
                onReady: function (n) { scope._onFeedReady(n); },
                onDegrade: function (why) { scope._onFeedDegrade(why); }
            });
            // read-only debug surface for measurement harnesses
            window.__hoastAudioFeed = function () { return scope.audioFeed ? scope.audioFeed.stats() : null; };
        }
        this.audioFeed.attach(mediaPlayer);
    }

    _onFeedReady(n) {
        let order = Math.round(Math.sqrt(n)) - 1;
        if ((order + 1) * (order + 1) !== n || order < 1 || order > this.maxOrder) {
            console.error('HOAST360: stream has ' + n + ' audio channels, which is not a supported ambisonic layout; using element audio');
            if (this.audioFeed) this.audioFeed.forceDegrade('unsupported-channel-count');
            return;
        }
        if (order !== this.order) {
            console.warn('HOAST360: stream is order ' + order + ' (' + n + ' ch); page requested order '
                + this.order + '. Using the stream order.');
            this.order = order;
            this._setOrderDependentVariables();
        }
        this._feedN = n;
        this._startSetup();
    }

    _onFeedDegrade(reason) {
        console.warn('HOAST360: element audio path takes over (' + reason + ')');
        this._feedDegraded = true;
        if (this._noCapture) {
            // no capture exists in this mode; emergency fallback is the raw
            // element audio (non-spatial, with the Chromium skew): unpin mute
            // and restore the player's native muted() so the UI drives the
            // element again
            if (this._mutePin) { clearInterval(this._mutePin); this._mutePin = null; }
            if (this._origMuted) { this.videoPlayer.muted = this._origMuted; this._origMuted = null; }
            try {
                let el = this.videoPlayer.tech({ IWillNotUseThisInPlugins: true }).el();
                if (el) el.muted = !!this._uiMuted;
            } catch (e) { /* tech gone */ }
            return;
        }
        if (this.rotator && this.sourceNode) {
            // graph already built: reconnect the field-tested legacy tap
            this.sourceNode.channelCount = this.numCh;
            this.sourceNode.connect(this.rotator.in);
        } else {
            this._startSetup();
        }
    }

    _setupAudio() {
        let scope = this;

        // initialize ambisonic rotator
        this.rotator = new HOASTRotator(this.context, this.order);
        console.log(this.rotator);

        // BUILD THE ZOOM MATRIX AT THE STREAM'S ORDER, NOT ALWAYS THE FOURTH.
        // MatrixMultiplier allocates a GainNode per matrix cell, so order 4 is
        // 625 live nodes plus a 25-way splitter and merger. On a third-order
        // stream, which is everything this project serves, 369 of those nodes
        // multiply inputs that do not exist, and every one of them still runs
        // in the audio graph on every render quantum. That is real work on a
        // phone already near its limit; an iPhone Xs was crashing its tab on
        // 2026-08-28.
        //
        // Slicing the zoom matrix to the stream's channel count is exact, not
        // an approximation: the discarded columns multiply absent inputs, and
        // the discarded rows produce components the decoder never reads.
        this.multiplier = new MatrixMultiplier(this.context, this.order);
        console.log(this.multiplier);

        this.decoder = new HOASTBinDecoder(this.context, this.order);
        console.log(this.decoder);

        var loader_filters = new HOASTloader(this.context, this.order, this.irs, (foaBuffer, hoaBuffer) => {
            this.decoder.updateFilters(foaBuffer, hoaBuffer);
            // Until this fires, HoastBinauralDecoder runs resetFilters()'s
            // cardioid placeholders: quiet, essentially non-spatial. On the
            // element-audio path that window is short and masked by startup;
            // on the WASM feed it lasted seconds and was heard as "a quiet
            // tone that suddenly gets louder" (2026-08-25). Let the feed hold
            // its audio until the real HRIRs are in, so the first thing heard
            // is the actual render.
            this._irsReady = true;
            if (this.audioFeed) this.audioFeed.setRenderReady(true);

            if (this.audioPlayer)
                this.playbackEventHandler.setAllBuffersLoaded(true);
        });
        loader_filters.load();

        this.masterGain = this.context.createGain();
        this.masterGain.gain.value = 1.0;
        // RAMPED, never assigned. Writing .gain.value steps the gain within a
        // single sample, which is a click whenever audio is already flowing -
        // audible at startup as a pop just before playback, because the UI-mute
        // flag clears and the gain jumps 0 -> volume in one sample. 15 ms is
        // short enough to feel instant on a slider and long enough to be
        // inaudible as a transient.
        this._setMasterGain = function (v) {
            var g = scope.masterGain;
            if (!g || !g.gain) return;
            var t = scope.context.currentTime;
            try {
                g.gain.cancelScheduledValues(t);
                g.gain.setValueAtTime(g.gain.value, t);
                g.gain.linearRampToValueAtTime(v, t + 0.015);
            } catch (e) { g.gain.value = v; }   // pre-Web-Audio-1.1 fallback
        };

        this.videoPlayer.on("volumechange", function () {
            if (!scope.masterGain)
                return;

            // In no-capture feed mode the element itself is pinned muted and
            // the player's muted() is rerouted to the UI-intent flag, which
            // together with the volume slider drives the feed audio level.
            if (scope._noCapture && scope._useSegmentFeed && !scope._feedDegraded) {
                scope._setMasterGain(scope._uiMuted ? 0 : this.volume());
                return;
            }

            if (this.muted())
                scope._setMasterGain(0);
            else
                scope._setMasterGain(this.volume());
        });

        if (this._useSegmentFeed && this.audioFeed && this._feedN && !this._feedDegraded) {
            // The element's audio stays captured by the deliberately
            // UNCONNECTED sourceNode (an unconnected MediaElementSource is a
            // silent sink, so the element can never sound and user unmute
            // cannot cause double audio). Decoded segment audio drives the
            // graph instead, bypassing Chromium's fixed MSE tap delay.
            this.audioFeed.connectTo(this.rotator.in);
        } else if (!this._noCapture) {
            this.sourceNode.channelCount = this.numCh;
            this.sourceNode.connect(this.rotator.in);
        }
        // else: no-capture mode with the feed already degraded, and there is
        // deliberately nothing to wire.
        //
        // _onFeedDegrade handles a degrade that happens mid-session, but the
        // feed can also fail during SETUP, before this graph is built: an
        // on-demand manifest addresses audio with SegmentBase, self-fetch only
        // understands SegmentTemplate, and it gives up immediately because a
        // manifest shape is not a transient error. Arriving here with
        // _feedDegraded already true is therefore normal, not exceptional.
        //
        // In no-capture mode no MediaElementSource was ever created: the
        // element is silenced by a mute pin rather than by capture, and
        // _onFeedDegrade has already released that pin so the element carries
        // its own audio. This branch used to run anyway and threw on
        // `null.channelCount`, killing playback outright, which is how a VOD
        // clip in Safari became a spinner that never resolved.
        //
        // Creating the node here instead would be worse than the crash:
        // createMediaElementSource reroutes the element into the graph, so an
        // element that was about to play its own audio would go silent.

        if (this.zoomEnabled) {
            this.rotator.out.connect(this.multiplier.in);
            this.multiplier.out.connect(this.decoder.in);
        }
        else {
            this.rotator.out.connect(this.decoder.in);
        }
        
        this.decoder.out.connect(this.masterGain);
        this.masterGain.connect(this.context.destination);

        this.audioSetupComplete = true;
    }

    _setupVideo() {
        this.videoPlayer.xr().camera.rotation.order = 'YZX'; // in THREE Y is vertical axis! -> set to yaw-pitch-roll
        let vidControls = this.videoPlayer.xr().controls3d;
        vidControls.orbit.minDistance = -700;
        vidControls.orbit.maxDistance = 200;

        let scope = this;
        // this.controls3d.orbit.on( .. ) does not work for custom events!
        // view change
        vidControls.orbit.addEventListener("change", function () {
            if (scope.xrActive)
                return;

            scope.rotator.updateRotationFromCamera(scope.videoPlayer.xr().camera.matrixWorld.elements);
        });

        // view change if HMD is used
        this.videoPlayer.xr().on("xrCameraUpdate", function () {
            if (!scope.xrActive)
                return;

            scope.rotator.updateRotationFromCamera(this.xrPose.views[0].transform.matrix);
        });

        if (this.zoomEnabled) {
            vidControls.orbit.addEventListener("zoom", function () { // zoom change
                scope._updateZoom();
            });
        }

        this.videoPlayer.xr().on("xrSessionActivated", function () {
            scope.xrActive = true;
            scope.multiplier.bypass(true);
        });

        this.videoPlayer.xr().on("xrSessionDeactivated", function () {
            scope.xrActive = false;
            scope.multiplier.bypass(false);
            if (scope.zoomEnabled)
                scope._updateZoom();

            scope.rotator.updateRotationFromCamera(this.camera.matrixWorld.elements);
        });

        this.videoSetupComplete = true;
    }

    _updateZoom() {
        let currentDistance = this.videoPlayer.xr().controls3d.orbit.currentDistance;
        let minDistance = this.videoPlayer.xr().controls3d.orbit.minDistance;

        let zoomFactor = (minDistance + currentDistance) / minDistance;
        if (zoomFactor >= minZoomfactor && zoomFactor <= maxZoomfactor) {
            let newZoomIndex = Math.round((zoomFactor - minZoomfactor) / stepsize);
            if (newZoomIndex != this.zoomIndex) {
                this.multiplier.updateMtx(this._sliceZoomMtx(zoomMtx[newZoomIndex]));
                this.zoomIndex = newZoomIndex;
            }
        }
    }

    _setOrderDependentVariables() {
        let getUrl = window.location;
        let base_url = getUrl.protocol + "//" + getUrl.host + "/"
        this.numCh = (this.order + 1) * (this.order + 1);
        
        if (this.irUrl.includes("://")) // protocol already included
            this.irs = this.irUrl + 'hoast_o' + this.order + '.wav';
        else
            this.irs = base_url + this.irUrl + 'hoast_o' + this.order + '.wav';            
    }
}
