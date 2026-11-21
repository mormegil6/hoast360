// EmptyEditProbe: measures how this browser's MSE places a video track whose
// edit list is a leading empty edit followed by a trimming edit, the shape
// ffmpeg's DASH muxer writes when the video starts after the audio.
//
// SegmentAudioFeed schedules audio against the picture the browser actually
// paints. Released Chromium and Safari ignore this edit list under MSE and
// paint the video early, so the feed places the audio earlier by the edit's net
// delay. On an engine that applies the edit list, that would shift the audio
// twice. Chromium applies it from M159 (Chromium 537235698, change 8561625),
// WebKit trunk since 316626@main, and the engines differ at the edges (WebKit
// trunk fails the wpt case in which a non-zero media_time edit follows the
// empty one). So rather than gate on browser versions, this probe appends a
// 1.7 kB clip with a known edit list to a detached MediaSource, once per page,
// and reads where the engine put it.
//
// The clip: four all-intra 64x64 frames, 0.25 s apart from media time 0, track
// timescale 16384, movie timescale 1000, edit list [ empty 1.0 s, then media
// from 0.125 s ]. The start of the buffered range tells the models apart:
//   none        0.0    edit list ignored
//   trim-only   0.125  only the trimming edit (first frame cut by the append window)
//   all         0.875  both edits (or 1.125 if the engine also drops the frame before the trim)
//   empty-only  1.0    only the empty edit
// Anything else, or no answer within the timeout, resolves model null, and the
// feed keeps its long-standing assumption ("none").
//
// A second clip measures a list that is only the trimming edit [ media from
// 0.125 s ], because an engine that skips a list with a leading empty edit can
// still apply a plain trimming edit (Chrome 157 and Safari 27.2 do, which left
// the audio late by the whole trim until the feed read this, 2026-11-21). Its
// first frame is at media time 0.25 s, past the trim point, so no frame is cut
// and an engine that keeps a partly trimmed frame (Firefox) reads the same as
// one that drops it. The buffered start tells the two apart:
//   ignored     0.25   the trimming edit is not applied
//   applied     0.125  the trimming edit is applied
//
// Measured 2026-11-15, three runs each, all identical: "none" on Chrome
// 157.0.8103.79, Brave 157, Edge 157 and Safari 27.2 (macOS 15.8); "all" on
// Chrome Canary 160.0.8163.0 and on Firefox 161 and 162. Canary with
// --disable-features=MP4ApplyEmptyEditList (the fix's killswitch) reads
// "none" again, so the probe sees exactly that change.

const INIT_B64 = 'AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAyptb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACLXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAEAAAAAAADBlZHRzAAAAKGVsc3QAAAAAAAAAAgAAA+j/////AAEAAAAAAAAAAAgAAAEAAAAAAZltZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAEAAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAFEbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABBHN0YmwAAAC4c3RzZAAAAAAAAAABAAAAqGF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAQABAAEgAAABIAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY//8AAAAuYXZjQwFCwAr/4QAWZ0LACtxCbARAAAADAEAAAAMCA8SJ4AEABWjODyyAAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAFrAAABawAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAUc3RzegAAAAAAAAAAAAAAAAAAABBzdGNvAAAAAAAAAAAAAAAobXZleAAAACB0cmV4AAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMg==';
const INIT_TRIM_B64 = 'AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAx5tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACIXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAEAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAAAAAAAgAAAEAAAAAAZltZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAEAAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAFEbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABBHN0YmwAAAC4c3RzZAAAAAAAAAABAAAAqGF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAQABAAEgAAABIAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY//8AAAAuYXZjQwFCwAr/4QAWZ0LACtxCbARAAAADAEAAAAMCA8SJ4AEABWjODyyAAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAFrAAABawAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAUc3RzegAAAAAAAAAAAAAAAAAAABBzdGNvAAAAAAAAAAAAAAAobXZleAAAACB0cmV4AAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMg==';
const MEDIA_LATE_B64 = 'AAAAGHN0eXBtc2RoAAAAAG1zZGhtc2l4AAAANHNpZHgBAAAAAAAAAQAAQAAAAAAAAAAQAAAAAAAAAAAAAAAAAQAAA1IAAEAAgAAAAAAAAHRtb29mAAAAEG1maGQAAAAAAAAAAQAAAFx0cmFmAAAAHHRmaGQAAgA4AAAAAQAAEAAAAAJ8AgAAAAAAABR0ZmR0AQAAAAAAAAAAABAAAAAAJHRydW4AAAIBAAAABAAAAHwAAAJ8AAAAHgAAAB4AAAAeAAAC3m1kYXQAAAJdBgX//1ncRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MSBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTAgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MiBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0xIGtleWludF9taW49MSBzY2VuZWN1dD0wIGludHJhX3JlZnJlc2g9MCByYz1jcmYgbWJ0cmVlPTAgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAXZYiEBLyYoAA4oycnJ1111111111114AAAAAaZYiCAX///8PRQABV58nJyddddddddddddeAAAAAaZYiEBf///w9FAAFXnycnJ1111111111114AAAAAaZYiCAX///8PRQABV58nJyddddddddddddeA=';
const MEDIA_B64 = 'AAAAGHN0eXBtc2RoAAAAAG1zZGhtc2l4AAAANHNpZHgBAAAAAAAAAQAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAA1IAAEAAgAAAAAAAAHRtb29mAAAAEG1maGQAAAAAAAAAAQAAAFx0cmFmAAAAHHRmaGQAAgA4AAAAAQAAEAAAAAJ8AgAAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAAJHRydW4AAAIBAAAABAAAAHwAAAJ8AAAAHgAAAB4AAAAeAAAC3m1kYXQAAAJdBgX//1ncRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MSBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTAgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MiBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0xIGtleWludF9taW49MSBzY2VuZWN1dD0wIGludHJhX3JlZnJlc2g9MCByYz1jcmYgbWJ0cmVlPTAgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAXZYiEBLyYoAA4oycnJ1111111111114AAAAAaZYiCAX///8PRQABV58nJyddddddddddddeAAAAAaZYiEBf///w9FAAFXnycnJ1111111111114AAAAAaZYiCAX///8PRQABV58nJyddddddddddddeA=';
const CODEC = 'video/mp4; codecs="avc1.42c00a"';
const E_S = 1.0, M_S = 0.125, FRAME_S = 0.25, TOL_S = 0.03, TIMEOUT_MS = 4000;

// applied(e, m): the presentation delay the engine gives a track whose edit
// list is an empty edit of e seconds followed by media from m seconds
export const MODELS = {
    'none':       { starts: [0],                              applied: function () { return 0; } },
    'trim-only':  { starts: [FRAME_S - M_S],                  applied: function (e, m) { return -m; } },
    'all':        { starts: [E_S - M_S, E_S - M_S + FRAME_S], applied: function (e, m) { return e - m; } },
    'empty-only': { starts: [E_S],                            applied: function (e) { return e; } },
};

function bytes(b64) {
    const s = atob(b64), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

export function classify(startS) {
    for (const name in MODELS)
        if (MODELS[name].starts.some(function (s) { return Math.abs(startS - s) <= TOL_S; })) return name;
    return null;
}

// applied(m): the presentation delay the engine gives a track whose edit list
// is a trimming edit alone, media from m seconds
export const TRIM_MODELS = {
    'ignored': { starts: [FRAME_S],            applied: function () { return 0; } },
    'applied': { starts: [FRAME_S - M_S],     applied: function (m) { return -m; } },
};

export function classifyTrim(startS) {
    for (const name in TRIM_MODELS)
        if (TRIM_MODELS[name].starts.some(function (s) { return Math.abs(startS - s) <= TOL_S; })) return name;
    return null;
}

let cached = null;

// One measurement: appends the clip with the given init segment and classifies
// where the engine put it. Resolves { model, startS, reason }; never rejects.
function probeOnce(initB64, mediaB64, classifyFn) {
    return new Promise(function (resolve) {
        const MS = (typeof window !== 'undefined') && (window.MediaSource || window.ManagedMediaSource);
        if (!MS || !MS.isTypeSupported || !MS.isTypeSupported(CODEC)) {
            resolve({ model: null, startS: null, reason: 'no-mse' });
            return;
        }
        let done = false, timer = null, url = null;
        const video = document.createElement('video');
        video.muted = true;
        video.disableRemotePlayback = true;   // ManagedMediaSource refuses to open without it
        const ms = new MS();
        function finish(result) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { video.removeAttribute('src'); video.load(); } catch (e) { /* already torn down */ }
            if (url) URL.revokeObjectURL(url);
            resolve(result);
        }
        timer = setTimeout(function () { finish({ model: null, startS: null, reason: 'timeout' }); }, TIMEOUT_MS);
        ms.addEventListener('sourceopen', function () {
            let sb;
            try { sb = ms.addSourceBuffer(CODEC); } catch (e) { finish({ model: null, startS: null, reason: 'addSourceBuffer' }); return; }
            const parts = [bytes(initB64), bytes(mediaB64)];
            function next() {
                if (parts.length) {
                    try { sb.appendBuffer(parts.shift()); } catch (e) { finish({ model: null, startS: null, reason: 'append' }); }
                    return;
                }
                if (!sb.buffered.length) { finish({ model: null, startS: null, reason: 'nothing-buffered' }); return; }
                const startS = +sb.buffered.start(0).toFixed(4);
                const model = classifyFn(startS);
                finish({ model: model, startS: startS, reason: model ? 'measured' : 'unrecognised' });
            }
            sb.addEventListener('updateend', next);
            sb.addEventListener('error', function () { finish({ model: null, startS: null, reason: 'sourcebuffer-error' }); });
            next();
        }, { once: true });
        url = URL.createObjectURL(ms);
        video.src = url;
    });
}

// Resolves { model, startS, reason, trimOnly: { model, startS, reason } }: the
// first three are the leading-empty-edit list, trimOnly is the trimming edit
// alone. Never rejects. One probe per page.
export function probeEmptyEdit() {
    if (cached) return cached;
    cached = Promise.all([probeOnce(INIT_B64, MEDIA_B64, classify), probeOnce(INIT_TRIM_B64, MEDIA_LATE_B64, classifyTrim)])
        .then(function (r) { r[0].trimOnly = r[1]; return r[0]; });
    return cached;
}
