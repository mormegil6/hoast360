// this file is based on ambi-sceneRotator.js from JSAmbisonics
// adapted to be used with HOAST360
//
// Thomas Deppisch, 2020

////////////////////////////////////////////////////////////////////
//  Archontis Politis
//  archontis.politis@aalto.fi
//  David Poirier-Quinot
//  davipoir@ircam.fr
////////////////////////////////////////////////////////////////////
//
//  JSAmbisonics a JavaScript library for higher-order Ambisonics
//  The library implements Web Audio blocks that perform
//  typical ambisonic processing operations on audio signals.
//
////////////////////////////////////////////////////////////////////

/////////////////
/* HOA ROTATOR */
/////////////////

import * as jshlib from 'spherical-harmonic-transform';
import * as numeric from 'numeric';

// How fast each rotation gain glides to a new value: a time constant of 1/180 s,
// so a change is 90 % done in about 13 ms, well inside one 60 Hz view update.
const GAIN_TIME_CONSTANT_S = 1 / 180;
// How long after the last update the gains are pinned to their targets (see
// settleRotMtx_): 100 ms is 18 time constants, long after the glide converged.
const GAIN_SETTLE_MS = 100;

export default class HOASTRotator {

    constructor(audioCtx, order) {

        this.ctx = audioCtx;
        this.order = order;
        this.nCh = (order + 1) * (order + 1);
        this.yaw = 0;
        this.pitch = 0;
        this.roll = 0;
        this.rotMtx = numeric.identity(this.nCh);
        this.rotMtxNodes = new Array(this.order);
        // Input and output nodes
        this.in = this.ctx.createChannelSplitter(this.nCh);
        this.out = this.ctx.createChannelMerger(this.nCh);
        
        // Initialize rotation gains to identity matrix
        for (var n = 1; n <= this.order; n++) {
            
            var gains_n = new Array(2 * n + 1);
            for (var i = 0; i < 2 * n + 1; i++) {
                gains_n[i] = new Array(2 * n + 1);
                for (var j = 0; j < 2 * n + 1; j++) {
                    gains_n[i][j] = this.ctx.createGain();
                    if (i == j) gains_n[i][j].gain.value = 1;
                    else gains_n[i][j].gain.value = 0;
                }
            }
            this.rotMtxNodes[n - 1] = gains_n;
        }
        
        // Create connections
        this.in.connect(this.out, 0, 0); // zeroth order ch. does not rotate
        
        var band_idx = 1;
        for (n = 1; n <= this.order; n++) {
            for (i = 0; i < 2 * n + 1; i++) {
                for (j = 0; j < 2 * n + 1; j++) {
                    this.in.connect(this.rotMtxNodes[n - 1][i][j], band_idx + j, 0);
                    this.rotMtxNodes[n - 1][i][j].connect(this.out, 0, band_idx + i);
                }
            }
            band_idx = band_idx + 2 * n + 1;
        }
    }

    updateRotMtx() {

        var yaw = this.yaw * Math.PI / 180;
        var pitch = this.pitch * Math.PI / 180;
        var roll = this.roll * Math.PI / 180;

        this.rotMtx = jshlib.getSHrotMtx(jshlib.yawPitchRoll2Rzyx(yaw, pitch, roll), this.order);
        // console.log('ypr');
        // console.log(this.rotMtx);

        this.applyRotMtx_();
    }

    // Each matrix entry is a GainNode. Assigning gain.value steps it at the next
    // render quantum, and with every gain stepping 30 to 60 times a second while
    // the view turns, the steps add up to a click train at the update rate.
    // setTargetAtTime glides each gain to the new value and settles on it
    // exactly, with no cancel, so overlapping updates are fine. Measured offline
    // in Chrome, it lowers the error above 6 kHz by 9 to 12 dB on noise and
    // music and by about 50 dB on a pure tone, for about 6 ms more lag behind
    // the view. Chrome and Safari start a glide from the current value even when
    // the update reaches the audio thread after its start time. Firefox follows
    // the curve from the start time instead, and its currentTime trails the
    // audio thread by up to one 256-frame block, so there one update in ten to
    // one in four, more when other work follows the writes in the same task,
    // still lands 60 to 70 % as a single step. Do not chase with
    // cancelAndHoldAtTime or setValueAtTime plus cancelScheduledValues: both
    // glitch in Chrome 156.
    applyRotMtx_() {
        const t = this.ctx.currentTime;
        var band_idx = 1;
        for (let n = 1; n < this.order + 1; n++) {
            for (let i = 0; i < 2 * n + 1; i++) {
                for (let j = 0; j < 2 * n + 1; j++) {
                    this.rotMtxNodes[n - 1][i][j].gain.setTargetAtTime(
                        this.rotMtx[band_idx + i][band_idx + j], t, GAIN_TIME_CONSTANT_S);
                }
            }
            band_idx = band_idx + 2 * n + 1;
        }
        clearTimeout(this.settleTimer_);
        this.settleTimer_ = setTimeout(() => this.settleRotMtx_(), GAIN_SETTLE_MS);
    }

    // A gain whose automation ends in a glide stays on the per-sample path for
    // good, even with the view still, which costs CPU in every browser and most
    // in Firefox. Once the glide has converged, the same target written as a
    // SetValue makes each gain a constant again, with no audible change.
    settleRotMtx_() {
        const t = this.ctx.currentTime;
        var band_idx = 1;
        for (let n = 1; n < this.order + 1; n++) {
            for (let i = 0; i < 2 * n + 1; i++) {
                for (let j = 0; j < 2 * n + 1; j++) {
                    this.rotMtxNodes[n - 1][i][j].gain.setValueAtTime(this.rotMtx[band_idx + i][band_idx + j], t);
                }
            }
            band_idx = band_idx + 2 * n + 1;
        }
    }

    updateRotationFromCamera(matrix4) {
        // console.log(matrix4);
        this.rotMtx = jshlib.getSHrotMtx([[matrix4[10], matrix4[8], matrix4[9]], 
                                          [matrix4[2], matrix4[0], matrix4[1]],
                                          [matrix4[6], matrix4[4], matrix4[5]]], this.order);

        // console.log(this.rotMtx);

        this.applyRotMtx_();
    }
}
