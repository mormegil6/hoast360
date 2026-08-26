/* global globalThis */
// WasmOpusBackend - decode Opus-in-fMP4 DASH segments without the platform.
//
// WHY THIS EXISTS. Safari cannot decode multichannel Opus through any native
// route: decodeAudioData rejects it, WebCodecs isConfigSupported says false,
// and MSE refuses audio/mp4 opus outright (docs/IOS-SAFARI.md in the
// ambisonic-box repo carries the measurements, macOS and two iPhones). The
// SegmentAudioFeed's only platform-bound step is its decode call, so this
// backend replaces exactly that step with libopus compiled to WASM, and
// nothing else changes: same fetch tap, same ring, same scheduling, same
// drift correction.
//
// The decoder is eshaz/wasm-audio-decoders' opus-decoder, bundled from source
// because the published dist minifies away its multichannel constructor
// options (upstream issue #129) and silently decodes 16 channels as stereo.
//
// CONTRACT. decode(ctx, initBytes, prevBytes, curBytes) resolves to an
// AudioBuffer holding the decoded samples of prev+cur (prev may be null),
// with the Opus pre-skip dropped at the decode start - byte-for-byte the
// shape ctx.decodeAudioData produces for the concatenated init+prev+cur
// file, which is what SegmentAudioFeed._storeDecoded's trim math assumes.
// The buffer is at the STREAM's rate (48 kHz), not the context's; the source
// nodes resample on playout, and _storeDecoded reads ab.sampleRate.

// The decoder bundle is NOT imported through the build. It embeds its WASM
// as a yEnc-encoded string, and any re-encoding pass - babel transcoding,
// terser normalizing string escapes - corrupts the binary and every decode
// fails crc32 at init. That is the same trap that forced building it from
// source in the first place (upstream #129 was the minifier mangling option
// names; this is the minifier mangling the payload). It ships beside the app
// bundle as its own file and is loaded verbatim at runtime.
let _libPromise = null;
function loadDecoderLib() {
    if (_libPromise) return _libPromise;
    _libPromise = (async function () {
        if (typeof globalThis !== 'undefined' && globalThis.OpusDecoderLib) return globalThis.OpusDecoderLib;
        if (typeof document !== 'undefined') {
            // served from the same directory as the app bundle
            let base = null;
            const tag = document.querySelector('script[src*="hoast360.bundle"]');
            if (tag && tag.src) base = tag.src;
            const url = new URL('opus-decoder.bundle.js', base || document.baseURI).href;
            await new Promise(function (res, rej) {
                const el = document.createElement('script');
                // classic scripts inherit the PAGE's charset; on a page without
                // <meta charset> that is windows-1252, which corrupts the yEnc
                // payload's multi-byte characters and fails crc32 at init.
                // Module scripts are immune (always UTF-8), classic ones need
                // this attribute unless the server sends a charset.
                el.setAttribute('charset', 'utf-8');
                el.src = url; el.async = true;
                el.onload = res;
                el.onerror = function () { rej(new Error('cannot load ' + url)); };
                document.head.appendChild(el);
            });
        } else {
            // node harnesses: evaluate the classic script in global scope
            const fs = await import(/* webpackIgnore: true */ 'node:fs');
            const path = await import(/* webpackIgnore: true */ 'node:path');
            const here = new URL(import.meta.url).pathname;
            const src = fs.readFileSync(path.join(path.dirname(here), 'opus-decoder.bundle.js'), 'utf8');
            (0, eval)(src);   // indirect eval: global scope, sets globalThis.OpusDecoderLib
        }
        if (!globalThis.OpusDecoderLib) throw new Error('opus-decoder.bundle.js loaded but exposed no OpusDecoderLib');
        return globalThis.OpusDecoderLib;
    })();
    return _libPromise;
}

// ---- fMP4 demux, verbatim from the proven iPhone poc (scratch/ios-probe/
// wasm-poc.html, junction 1.5x on two devices) -------------------------------

function* boxes(dv, off, end) {
    end = end === undefined ? dv.byteLength : end;
    while (off + 8 <= end) {
        let sz = dv.getUint32(off), hdr = 8;
        const t = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5),
                                      dv.getUint8(off + 6), dv.getUint8(off + 7));
        if (sz === 1) { sz = Number(dv.getBigUint64(off + 8)); hdr = 16; }
        if (sz < hdr || off + sz > end) return;
        yield { t: t, s: off + hdr, e: off + sz };
        off += sz;
    }
}

// A media segment is one or more moof+mdat pairs. Per-sample sizes live in
// trun when present; a muxer encoding fixed-size frames (ffmpeg's dash muxer
// with libopus does this) instead writes ONE default_sample_size in tfhd and
// omits the per-sample field entirely - the poc's demuxer only ever met the
// per-sample layout and refused the other. Each pair's sizes must sum to its
// mdat exactly or the parse is refused: a truncated fetch must fail loudly
// here, never decode as garbage.
export function extractPackets(ab) {
    const dv = new DataView(ab);
    const pk = [];
    let pending = null;   // sizes[] from the moof awaiting its mdat
    for (const b of boxes(dv, 0)) {
        if (b.t === 'moof') {
            const sizes = [];
            for (const b2 of boxes(dv, b.s, b.e)) if (b2.t === 'traf') {
                let defaultSize = null;
                for (const b3 of boxes(dv, b2.s, b2.e)) {
                    if (b3.t === 'tfhd') {
                        const tf = dv.getUint32(b3.s) & 0xFFFFFF;
                        let p = b3.s + 8;                    // version/flags + track_ID
                        if (tf & 0x01) p += 8;               // base_data_offset
                        if (tf & 0x02) p += 4;               // sample_description_index
                        if (tf & 0x08) p += 4;               // default_sample_duration
                        if (tf & 0x10) defaultSize = dv.getUint32(p);
                    }
                    if (b3.t === 'trun') {
                        const flags = dv.getUint32(b3.s) & 0xFFFFFF, n = dv.getUint32(b3.s + 4);
                        let p = b3.s + 8;
                        if (flags & 1) p += 4; if (flags & 4) p += 4;
                        for (let i = 0; i < n; i++) {
                            let ss = defaultSize;
                            [0x100, 0x200, 0x400, 0x800].forEach(function (bit, k) {
                                if (flags & bit) { if (k === 1) ss = dv.getUint32(p); p += 4; }
                            });
                            if (ss == null) throw new Error('no sample size in trun or tfhd');
                            sizes.push(ss);
                        }
                    }
                }
            }
            pending = sizes;
        }
        if (b.t === 'mdat') {
            if (!pending) throw new Error('mdat before moof');
            const total = pending.reduce(function (a, x) { return a + x; }, 0);
            if (total !== b.e - b.s) throw new Error('trun/mdat mismatch');
            let o = b.s;
            for (const sz of pending) { pk.push(new Uint8Array(ab.slice(o, o + sz))); o += sz; }
            pending = null;
        }
    }
    if (!pk.length) throw new Error('no moof+mdat pairs in segment');
    return pk;
}

// The dOps box in the init segment carries the multistream layout. Found by
// signature scan rather than full stsd parsing: dOps appears exactly once.
export function parseDops(ab) {
    const u = new Uint8Array(ab);
    for (let i = 0; i < u.length - 4; i++)
        if (u[i] === 0x64 && u[i + 1] === 0x4F && u[i + 2] === 0x70 && u[i + 3] === 0x73) {
            const d = u.slice(i + 4);
            const ch = d[1], family = d[10];
            // family 0 (mono/stereo) ends AT the family byte: streams, coupled
            // and the mapping table simply are not present, and reading them
            // walks into whatever box follows. RFC 7845 gives family 0 the
            // implicit layout below.
            if (family === 0) {
                return { ch: ch, preSkip: (d[2] << 8) | d[3], family: 0,
                         streams: 1, coupled: ch === 2 ? 1 : 0,
                         map: ch === 2 ? [0, 1] : [0] };
            }
            return { ch: ch, preSkip: (d[2] << 8) | d[3], family: family,
                     streams: d[11], coupled: d[12], map: Array.from(d.slice(13, 13 + ch)) };
        }
    throw new Error('no dOps in init segment');
}

// ---- the backend -----------------------------------------------------------

export class WasmOpusBackend {
    constructor() {
        this._dec = null;       // one decoder, re-instantiated per call
        this._cfgKey = null;
        this._queue = Promise.resolve();  // decodeFrames is stateful; serialize
        this._destroyed = false;
    }

    // Never await the decoder unbounded. The vendored bundle builds `ready` as
    // a bare promise that only ever RESOLVES: a failed or hung
    // WebAssembly.instantiate leaves it pending forever, and since decodes are
    // serialized, one pending await freezes every later decode with no
    // rejection for the feed's retry/strike/degrade path to catch - silent,
    // permanent, unrecoverable without a reload. A timeout converts that into
    // an ordinary rejection.
    _withTimeout(promise, ms, what) {
        let timer = null;
        return Promise.race([
            promise,
            new Promise(function (_, rej) {
                timer = setTimeout(function () { rej(new Error(what + ' timed out after ' + ms + 'ms')); }, ms);
            }),
        ]).finally(function () { if (timer) clearTimeout(timer); });
    }

    // Matches ctx.decodeAudioData(concat(init, prev?, cur)) for Opus-in-fMP4.
    decode(ctx, initBytes, prevBytes, curBytes) {
        const self = this;
        // chain unconditionally: a rejected call must not wedge the queue
        const run = this._queue.then(function () {
            return self._decodePcm(initBytes, prevBytes, curBytes);
        });
        // Chain the NEXT call on completion only - never on the value. A
        // plain `run.catch(...)` resolves WITH the pcm, pinning the last
        // decode's channelData (about 12 MB for a 4 s 16-channel pair) for as
        // long as the backend lives.
        this._queue = run.then(function () { /* drop value */ }, function () { /* next call proceeds */ });
        return run.then(function (pcm) {
            const out = ctx.createBuffer(pcm.channelData.length,
                                         pcm.channelData[0].length, pcm.sampleRate);
            for (let c = 0; c < pcm.channelData.length; c++)
                out.copyToChannel(pcm.channelData[c], c, 0);
            return out;
        });
    }

    async _decodePcm(initBytes, prevBytes, curBytes) {
        const cfg = parseDops(initBytes.buffer.slice(
            initBytes.byteOffset, initBytes.byteOffset + initBytes.byteLength));
        const key = JSON.stringify(cfg);
        if (this._destroyed) throw new Error('backend destroyed');
        if (!this._dec || this._cfgKey !== key) {
            const OpusDecoderLib = await this._withTimeout(loadDecoderLib(), 15000, 'decoder library load');
            if (this._dec) { try { this._dec.free(); } catch (e) { /* replaced */ } }
            this._dec = null; this._cfgKey = null;
            // OFF THE MAIN THREAD. The main-thread decoder competes with
            // video decode, HRIR loading and the page for the same thread,
            // which on Safari showed as choppy video and a long stretch of
            // placeholder-filter audio at startup (2026-08-25). The worker
            // variant has the identical API and moves ~40 % of a core off the
            // thread that paints. Falls back if Workers are unavailable.
            // Browser only: node harnesses have no DOM Worker, and testing the
            // decode CONTRACT does not need one - correctness is identical, the
            // worker only changes which thread pays.
            const inBrowser = typeof document !== 'undefined' && typeof Worker === 'function';
            const Ctor = (inBrowser && OpusDecoderLib.OpusDecoderWebWorker)
                || OpusDecoderLib.OpusDecoder;
            this._threaded = Ctor === OpusDecoderLib.OpusDecoderWebWorker;
            const dec = new Ctor({
                preSkip: cfg.preSkip, channels: cfg.ch, streamCount: cfg.streams,
                coupledStreamCount: cfg.coupled, channelMappingTable: cfg.map,
            });
            try {
                await this._withTimeout(dec.ready, 10000, 'decoder instantiation');
            } catch (e) {
                try { dec.free(); } catch (e2) { /* never became usable */ }
                throw e;   // rejects THIS decode; the next call rebuilds cleanly
            }
            // key set only after a decoder that actually came up: setting it
            // before the await could leave a matching key pointing at a freed
            // or half-built decoder that a later call would then reset()
            this._dec = dec; this._cfgKey = key;
        } else {
            // fresh state per call, so this decode cannot inherit the previous
            // call's convergence: that is the decodeAudioData contract the
            // feed's pair-decode warm-up is built on. NOTE this bundle's
            // reset() is free()+init - a full WASM re-instantiation - so it
            // needs the same timeout as construction.
            try {
                await this._withTimeout(this._dec.reset(), 10000, 'decoder reset');
            } catch (e) {
                try { this._dec.free(); } catch (e2) { /* already broken */ }
                this._dec = null; this._cfgKey = null;
                throw e;
            }
        }
        const parts = [];
        if (prevBytes) parts.push(extractPackets(toAb(prevBytes)));
        parts.push(extractPackets(toAb(curBytes)));
        const packets = parts.length === 2 ? parts[0].concat(parts[1]) : parts[0];
        const r = await this._dec.decodeFrames(packets);
        // NOTE: opus-decoder applies the constructor preSkip itself, dropping
        // those samples from the start of the decode - the same stream-start
        // trim decodeAudioData performs. Verified against ffmpeg in the node
        // harness (tests/wasm-backend) before this shipped.
        return { channelData: r.channelData, sampleRate: r.sampleRate };
    }

    destroy() {
        this._destroyed = true;
        const d = this._dec; this._dec = null; this._cfgKey = null;
        if (d) this._queue = this._queue.then(function () { try { d.free(); } catch (e) { /* gone */ } });
    }
}

function toAb(u8) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}
