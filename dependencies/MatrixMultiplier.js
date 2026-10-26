////////////////////////////////////////////////////////////////////
//  adapted by Thomas Deppisch
//  for use with HOAST360
////////////////////////////////////////////////////////////////////

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

///////////////////////
/* Matrix Multiplier */
///////////////////////
import * as numeric from 'numeric';

export default class MatrixMultiplier {

    constructor(audioCtx, order) {
        this.ctx = audioCtx;
        this.order = order;
        this.nCh = (order + 1) * (order + 1);

        this.mtx = numeric.identity(this.nCh);
        this.bypassed = false;

        // Input and output nodes
        this.in = this.ctx.createChannelSplitter(this.nCh);
        this.out = this.ctx.createChannelMerger(this.nCh);

        this.gain = new Array(this.nCh);

        for (var row = 0; row < this.nCh; row++) {
            this.gain[row] = new Array(this.nCh);

            for (var col = 0; col < this.nCh; col++) {

                this.gain[row][col] = this.ctx.createGain();
                this.gain[row][col].gain.value = this.mtx[row][col];

                this.in.connect(this.gain[row][col], col, 0);
                this.gain[row][col].connect(this.out, 0, row);
            }
        }
    }

    updateMtx(mtx) {
        if (this.bypassed)
            return;

        this.mtx = mtx;

        // glide rather than step, and settle once still, for the reasons
        // HoastRotator.applyRotMtx_ and settleRotMtx_ give
        const t = this.ctx.currentTime;
        for (var row = 0; row < this.nCh; row++) {       //outputs
            for (var col = 0; col < this.nCh; col++) {	   //inputs
                this.gain[row][col].gain.setTargetAtTime(this.mtx[row][col], t, 1 / 180); //set new gains
            }
        }
        clearTimeout(this.settleTimer_);
        this.settleTimer_ = setTimeout(() => this.settleMtx_(), 100);
    }

    settleMtx_() {
        const t = this.ctx.currentTime;
        for (var row = 0; row < this.nCh; row++) {
            for (var col = 0; col < this.nCh; col++) {
                this.gain[row][col].gain.setValueAtTime(this.mtx[row][col], t);
            }
        }
    }

    bypass(shouldBeActive) {
        if (shouldBeActive) {
            this.updateMtx(numeric.identity(this.nCh));
            this.bypassed = true;
        }
        else {
            this.bypassed = false;
        }
    }

    printGainMtx() {
        console.log(this);
    }
}
