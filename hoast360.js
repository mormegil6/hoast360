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
import { isMobileTabletVRDevice } from './dependencies/UserAgentChecker.js';
import './css/video-js.css';
import './css/hoast360.css';

"use strict";

// Live streams: start 30 s behind the live edge. ffmpeg writes the live MPD
// non-atomically and announces segments at the edge before they are fully on
// disk, so joining near the edge stalls and gap-jumps on startup. dash.js
// gives an explicit liveDelay precedence over the MPD's
// suggestedPresentationDelay; the setting is ignored for static (VOD) MPDs.
const LIVE_DELAY_S = 30;

// The combined-MPD path runs on videojs-contrib-dash's own inlined dash.js
// (not the dashjs package import!), reachable only through this hook. It
// fires after the MediaPlayer is created, before initialize().
videojs.Html5DashJS.hook('beforeinitialize', function (player, mediaPlayer) {
    mediaPlayer.updateSettings({ streaming: { delay: { liveDelay: LIVE_DELAY_S } } });
});

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

        var AudioContext = window.AudioContext || window.webkitAudioContext;
        this.context = new AudioContext;
        console.log(this.context);

        if (isMobileTabletVRDevice()) {
            this.zoomEnabled = false; // disable zoom on mobile and VR devices to improve efficiency
            console.log('detected mobile device: zoom disabled');
        }
            
        this.playbackEventHandler = new PlaybackEventHandler(this.context);

        // create as many audio players as we need for max order
        this.audioElement = new Audio();
        // playback runs through MSE (dash.js), so probe MSE opus support in the
        // containers we actually stream (fMP4 from shaka-packager, webm demo media)
        if (typeof MediaSource === 'undefined' ||
            !(MediaSource.isTypeSupported('audio/mp4; codecs="opus"') ||
              MediaSource.isTypeSupported('audio/webm; codecs="opus"'))) {
            this.opusSupport = false;
        }

        this.videoPlayer = videojs('hoast360-player', {
            html5: { nativeCaptions: false },
            liveui: true,
            plugins: {
                httpSourceSelector: { default: 'auto' }
            }
        });

        let scope = this;
        this.videoPlayer.on('play', function () {
            // autoplay policy: the context starts suspended; the play click is the
            // user gesture that may resume it. PlaybackEventHandler covers the
            // separate-audio path, but the combined-MPD path has no other resume.
            if (scope.context.state !== 'running')
                scope.context.resume();

            // same gesture unlocks the iOS 13+ DeviceOrientation permission
            if (scope.videoPlayer.usingPlugin('xr'))
                scope.videoPlayer.xr().enableOrientation();
        });
    }

    initialize(newMediaUrl, newIrUrl, newOrder) {
        if (!this.opusSupport) {
            this.videoPlayer.error('Error: Your browser does not support the OPUS audio codec. Please use Firefox or Chrome-based browsers.');
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

        if (this.mediaUrl.includes(".mpd")) { // in this case audio and video are inside the same mpd
            if (!this.sourceNode)
                this.sourceNode = this.context.createMediaElementSource(this.videoPlayer.tech({ IWillNotUseThisInPlugins: true }).el());
            
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
                mp.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: auto } } } });
                if (!auto) mp.setQualityFor('video', on[on.length - 1], true);
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
            mp.on('streamInitialized', populate);
            populate();   // in case the stream is already initialized
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
        this.sourceNode.disconnect();
        this.rotator.out.disconnect();
        this.multiplier.out.disconnect();
        this.decoder.out.disconnect();
        this.masterGain.disconnect();
    }

    _startSetup() {
        if (!this.audioSetupComplete && !this.videoSetupComplete) {
            this._setupAudio();
            this._setupVideo();
        }
    }

    _setupAudio() {
        let scope = this;

        // initialize ambisonic rotator
        this.rotator = new HOASTRotator(this.context, this.order);
        console.log(this.rotator);

        // initialize matrix multiplier (for now use always 4th order as zoom matrix is in 4th order format)
        this.multiplier = new MatrixMultiplier(this.context, 4);
        console.log(this.multiplier);

        this.decoder = new HOASTBinDecoder(this.context, this.order);
        console.log(this.decoder);

        var loader_filters = new HOASTloader(this.context, this.order, this.irs, (foaBuffer, hoaBuffer) => {
            this.decoder.updateFilters(foaBuffer, hoaBuffer);

            if (this.audioPlayer)
                this.playbackEventHandler.setAllBuffersLoaded(true);
        });
        loader_filters.load();

        this.masterGain = this.context.createGain();
        this.masterGain.gain.value = 1.0;

        this.videoPlayer.on("volumechange", function () {
            if (!scope.masterGain)
                return;

            if (this.muted())
                scope.masterGain.gain.value = 0;
            else
                scope.masterGain.gain.value = this.volume();
        });

        this.sourceNode.channelCount = this.numCh;

        this.sourceNode.connect(this.rotator.in);

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
                this.multiplier.updateMtx(zoomMtx[newZoomIndex]);
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
