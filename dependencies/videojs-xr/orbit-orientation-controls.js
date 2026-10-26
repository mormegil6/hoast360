// Vendored from videojs-xr 0.1.0 (MIT, see LICENSE in this directory) for HOAST360.
// HOAST360 modifications:
//  - DeviceOrientationControls no longer auto-connects in its constructor; when no
//    permission API exists (Android, desktop) it is connected immediately, while on
//    iOS 13+ connection is deferred to enableOrientation(), which must be called
//    from a user gesture so DeviceOrientationEvent.requestPermission() succeeds.
//  - update() waits for the sensor's first real angles, and that first reading
//    sets the view's elevation to the phone's, keeping its heading; enable()
//    starts over from the next reading after an XR session

import * as THREE from 'three';
import { OrbitControls } from './OrbitControls.js';
import { DeviceOrientationControls } from './DeviceOrientationControls.js';

/**
 * Convert a quaternion to an angle
 *
 * Taken from https://stackoverflow.com/a/35448946
 * Thanks P. Ellul
 */
function Quat2Angle(x, y, z, w) {
    const test = x * y + z * w;

    // singularity at north pole
    if (test > 0.499) {
        const yaw = 2 * Math.atan2(x, w);
        const pitch = Math.PI / 2;
        const roll = 0;

        return new THREE.Vector3(pitch, roll, yaw);
    }

    // singularity at south pole
    if (test < -0.499) {
        const yaw = -2 * Math.atan2(x, w);
        const pitch = -Math.PI / 2;
        const roll = 0;

        return new THREE.Vector3(pitch, roll, yaw);
    }

    const sqx = x * x;
    const sqy = y * y;
    const sqz = z * z;
    const yaw = Math.atan2(2 * y * w - 2 * x * z, 1 - 2 * sqy - 2 * sqz);
    const pitch = Math.asin(2 * test);
    const roll = Math.atan2(2 * x * w - 2 * y * z, 1 - 2 * sqx - 2 * sqz);

    return new THREE.Vector3(pitch, roll, yaw);
}

class OrbitOrientationControls {
    constructor(options) {
        this.object = options.camera;
        this.domElement = options.canvas;
        this.orbit = new OrbitControls(this.object, this.domElement);

        this.speed = 0.5;
        this.orbit.target.set(0, 1, -1);
        this.orbit.enableZoom = true;
        this.orbit.enablePan = false;
        this.orbit.rotateSpeed = -this.speed;

        // if orientation is supported
        if (options.orientation) {
            this.orientation = new DeviceOrientationControls(this.object);

            // without a permission API the sensor can be attached right away;
            // iOS 13+ has to wait for enableOrientation() inside a user gesture
            if (!this.orientationNeedsPermission())
                this.orientation.connect();
        }

        // if projection is not full view
        // limit the rotation angle in order to not display back half view
        if (options.halfView) {
            this.orbit.minAzimuthAngle = -Math.PI / 4;
            this.orbit.maxAzimuthAngle = Math.PI / 4;
        }
    }

    orientationNeedsPermission() {
        return window.DeviceOrientationEvent !== undefined &&
            typeof window.DeviceOrientationEvent.requestPermission === 'function';
    }

    // call from a user gesture handler (click/touchend)
    enableOrientation() {
        if (this.orientation)
            this.orientation.connect();
    }

    update() {
        // orientation updates the camera using quaternions and
        // orbit updates the camera using angles. They are incompatible
        // and one update overrides the other. So before
        // orbit overrides orientation we convert our quaternion changes to
        // an angle change. Then save the angle into orbit so that
        // it will take those into account when it updates the camera and overrides
        // our changes
        if (this.orientation && this.orientation.enabled && this.hasOrientationReading_()) {
            this.orientation.update();

            const quat = this.orientation.object.quaternion;
            const currentAngle = Quat2Angle(quat.x, quat.y, quat.z, quat.w);

            // The first real reading seeds the last angle. The view keeps its
            // heading (the video's front unless a finger moved it) and takes
            // the elevation the phone actually points at, so an upright phone
            // starts at the horizon.
            if (typeof this.lastAngle_ === 'undefined') {
                this.lastAngle_ = currentAngle;
                const look = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
                const offset = this.object.position.clone().sub(this.orbit.target);
                const phi = Math.acos(THREE.MathUtils.clamp(offset.y / offset.length(), -1, 1));
                this.orbit.rotateUp(phi - (Math.PI / 2 + Math.asin(THREE.MathUtils.clamp(look.y, -1, 1))));
            }

            this.orbit.rotateLeft((this.lastAngle_.z - currentAngle.z) * (1 + this.speed));
            this.orbit.rotateUp((this.lastAngle_.y - currentAngle.y) * (1 + this.speed));
            this.lastAngle_ = currentAngle;
        }

        this.orbit.update();
    }

    // Until an event with real angles arrives, DeviceOrientationControls poses
    // the camera from alpha = beta = gamma = 0, which is straight down. The
    // sensor starts after the listener is attached, so frames run in that
    // state, and seeding the last angle from it made the first real event hand
    // the orbit the phone's whole tilt as one step (90 degrees for an upright
    // phone, x1.5 = 135), which pinned the view at the zenith. Where the browser
    // has no sensor data it sends one event with all three angles null.
    hasOrientationReading_() {
        const d = this.orientation.deviceOrientation;
        return !!d && (d.alpha != null || d.beta != null || d.gamma != null);
    }

    dispose() {
        this.orbit.dispose();

        if (this.orientation) {
            this.orientation.dispose();
        }
    }

    enable() {
        this.orbit.enabled = true;

        if (this.orientation) {
            this.orientation.enabled = this.orientation.connected;
            // Seed again from the next reading: the phone moved while the
            // controls were off (during an XR session), and the old last angle
            // would hand the whole difference to the view as one jump.
            this.lastAngle_ = undefined;
        }
    }

    disable() {
        this.orbit.enabled = false;

        if (this.orientation)
            this.orientation.enabled = false;
    }

}

export default OrbitOrientationControls;
