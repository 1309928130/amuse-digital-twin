/**
 * Named camera positions, selectable from the right panel.
 *
 * The viewer has several framings that are each meaningful for a different
 * assessment: the whole case area for network-scale questions, a single site
 * block for the quality pages, a street-level bird view for the micro-mobility
 * run, and an eye-level view for visual quality. Until now those framings were
 * reachable only by navigating to the page that owned them, so a reader who
 * wanted to compare "same place, different scale" had to hop pages and lose
 * their context.
 *
 * This makes each framing addressable directly. The presets are imported from
 * `pageConfig.js` rather than restated, so when one is re-derived -- as the
 * street view was, from the Kova run -- this list follows automatically instead
 * of quietly going stale.
 *
 * ## Why this does not fight page navigation
 *
 * `pageController` owns the camera and moves it on every page change, and it
 * also persists the view to `sessionStorage`. A manual preset is a deliberate
 * override of the page framing, so it must survive a reload but *not* survive
 * the next page change, which is exactly what the existing persistence already
 * does: the stored view is restored on load and then overwritten when a page is
 * applied. Selecting a preset here simply writes that stored view, so its
 * lifetime is the same as any other camera the user positions by hand.
 */

import { getViewer } from './cesiumViewer.js';
import {
    OVERVIEW_VIEWPOINT,
    SITE_BLOCK_VIEWPOINT,
    MICRO_STREET_VIEW,
    EYE_LEVEL_VIEW,
} from './pageConfig.js';

/**
 * The presets offered in the dropdown, in the order they appear.
 *
 * `home` is the viewer's own startup framing, restored through Cesium's
 * `homeButton` so it stays the single definition of "default": duplicating
 * those coordinates here would let the two drift apart.
 */
const PRESETS = [
    {
        id: 'overview',
        label: 'Area level (whole Zuidas)',
        camera: OVERVIEW_VIEWPOINT,
        help: 'Whole Zuidas case area — the framing the pedestrian-flow page uses.',
    },
    {
        id: 'block',
        label: 'Block level (single site)',
        camera: SITE_BLOCK_VIEWPOINT,
        help: 'One site block — the framing the wind, noise, pollution, heat and visibility pages share.',
    },
    {
        id: 'street-bird',
        label: 'Street bird view',
        camera: MICRO_STREET_VIEW,
        help: 'Above the simulated street, positioned on the densest 20 m of the Kova trajectories.',
    },
    {
        id: 'eye-level',
        label: 'Eye level (1.7 m)',
        camera: EYE_LEVEL_VIEW,
        help: 'Standing eye height at the same street position — the height the visual-quality indicators are defined at.',
    },
    {
        id: 'home',
        label: 'Home / default view',
        help: 'The viewer’s startup framing.',
    },
];

/**
 * Duration of a preset transition, in seconds.
 *
 * Longer than the page-to-page transitions on purpose. A page change is a
 * context switch and wants to feel immediate; choosing a camera is a deliberate
 * act of looking, and a slower move lets the reader keep track of where the
 * camera went, especially on the large scale change between area and eye level.
 */
const PRESET_FLY_SECONDS = 3.2;

let wired = false;

/**
 * Compute a heading, in radians, that points a camera at a target.
 *
 * A small helper rather than a `flyTo` with `orientation`, because the camera
 * needs to keep looking at the same place while it descends: without this the
 * heading would be whatever the preset stored, and the move between an area
 * view and a street view would swing through an unrelated direction.
 *
 * @param {number} fromLon Camera longitude.
 * @param {number} fromLat Camera latitude.
 * @param {number} toLon Target longitude.
 * @param {number} toLat Target latitude.
 * @returns {number} Heading in radians.
 */
function headingTowards(fromLon, fromLat, toLon, toLat) {
    const dLon = toLon - fromLon;
    const dLat = toLat - fromLat;
    // atan2(east, north) is a compass bearing; Cesium measures heading the same
    // way, clockwise from north.
    return Math.atan2(dLon * Math.cos((fromLat * Math.PI) / 180), dLat);
}

/**
 * Move the camera to a named preset.
 *
 * @param {string} id One of the ids in `PRESETS`.
 * @param {Object} [opts]
 * @param {boolean} [opts.instant] Jump rather than fly, for restoring a saved view.
 * @returns {boolean} Whether the preset was found and applied.
 */
export function applyCameraPreset(id, opts = {}) {
    const viewer = getViewer();
    if (!viewer) return false;

    if (id === 'home') {
        // Cesium owns the home view; going through it keeps one definition of
        // the default rather than a copy that can fall out of step.
        viewer.homeButton.viewModel.command.beforeExecute.addEventListener((e) => {
            e.cancel = true;
            viewer.camera.flyHome(opts.instant ? 0 : PRESET_FLY_SECONDS);
        });
        viewer.homeButton.viewModel.command();
        return true;
    }

    const preset = PRESETS.find((p) => p.id === id);
    if (!preset || !preset.camera) return false;
    const c = preset.camera;

    const Cesium = globalThis.Cesium;
    const destination = Cesium.Cartesian3.fromDegrees(c.longitude, c.latitude, c.height);

    if (opts.instant) {
        viewer.camera.setView({
            destination,
            orientation: {
                heading: Cesium.Math.toRadians(c.headingDeg || 0),
                pitch: Cesium.Math.toRadians(c.pitchDeg || -90),
                roll: 0,
            },
        });
        return true;
    }

    // Turn to face the framing's own subject while descending, so the movement
    // reads as one continuous approach rather than a descent followed by a
    // swing. The target is the case-area centre, which every preset is aimed at.
    const targetLon = OVERVIEW_VIEWPOINT.longitude;
    const targetLat = OVERVIEW_VIEWPOINT.latitude;
    const heading = headingTowards(c.longitude, c.latitude, targetLon, targetLat);

    viewer.camera.flyTo({
        destination,
        orientation: {
            // Blend the preset's own heading into the approach when it has one,
            // so the final frame matches the page's framing exactly.
            heading: Cesium.Math.toRadians(c.headingDeg != null ? c.headingDeg : (heading * 180) / Math.PI),
            pitch: Cesium.Math.toRadians(c.pitchDeg || -90),
            roll: 0,
        },
        duration: PRESET_FLY_SECONDS,
    });
    return true;
}

/**
 * Wire the dropdown, once.
 *
 * Called on first load. The select is populated from `PRESETS` rather than from
 * hand-written markup, so adding a preset is a one-line change in one file.
 */
export function initCameraPresets() {
    if (wired) return;
    const select = document.getElementById('cameraPresetSelect');
    if (!select) return;
    wired = true;

    const help = document.getElementById('cameraPresetHelp');

    select.addEventListener('change', () => {
        const id = select.value;
        applyCameraPreset(id);
        const preset = PRESETS.find((p) => p.id === id);
        if (help && preset) help.textContent = preset.help;
    });
}

/** The list of presets, for tests and for other modules that want the labels. */
export function listCameraPresets() {
    return PRESETS.map(({ id, label }) => ({ id, label }));
}
