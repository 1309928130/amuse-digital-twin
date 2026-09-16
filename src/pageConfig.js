/**
 * Page registry for the AMUSE multisensory digital twin viewer.
 *
 * Each page = one assessment (or synthesis view). A page declares:
 *  - nav label / short title shown in the left navigation panel
 *  - camera preset (default view when the page is opened)
 *  - layers to switch on / off for that page
 *  - link tooltip behaviour: 'hover' (live hover preview) or 'click' (pinned only)
 *  - parameter-panel section ids (built in index.html)
 *
 * Camera presets use either:
 *  - { rectangle: [west, south, east, north], heading?, pitch? }  -> framed view
 *  - { longitude, latitude, height, heading, pitch }              -> fixed viewpoint
 *
 * Note: `heading`/`pitch` may be given in degrees (numbers) — the controller
 * converts them. Composite values (Math.atan2(...)) can be supplied directly.
 */

/** Station square / station front block (micro-mobility scope). */
export const STATION_SQUARE_CENTER = {
    longitude: 4.872844838304281,
    latitude: 52.33886029227803,
};

export const PAGE_IDS = [
    'flow-macro',
    'flow-micro',
    'sunlight',
    'wind',
    'noise',
    'pollution',
    'heat',
    'visibility',
    'overlap',
    'cases',
    'framework',
];

/**
 * @typedef {Object} PageDef
 * @property {string} id
 * @property {string} label       Navigation button label
 * @property {string} title       Page heading shown in the right panel
 * @property {string} [group]     Section heading in the nav
 * @property {Object} camera      Camera preset
 * @property {CameraOffset} [cameraOffset] Screen-space nudge applied on top of `camera`
 * @property {boolean} [keepCamera] Leave the camera exactly where it is (no transition)
 * @property {DocPage} [doc]      Render a document instead of the 3D scene
 * @property {Object} layers      Layer toggles applied on page enter
 * @property {'hover'|'click'} linkTooltip
 * @property {string[]} sections  Parameter-panel sections to show
 * @property {boolean} [placeholder] Render 'results coming soon' notice
 */

/**
 * Camera nudge, resolved against the page's base `camera`.
 *
 * Distances are in **metres** so the numbers match how you'd describe the move
 * out loud ("200 m south"). Compass and camera-relative axes can be mixed.
 *
 * @typedef {Object} CameraOffset
 * @property {number} [south]   +ve moves the camera south, -ve north
 * @property {number} [east]    +ve moves the camera east, -ve west
 * @property {number} [up]      +ve lifts the camera, -ve lowers it (altitude, m)
 * @property {number} [forward] +ve moves along the current look direction
 * @property {number} [left]    +ve moves left of the current look direction
 * @property {number} [zoom]    <1 pulls the camera closer, >1 pushes it away
 */

/**
 * A page that renders a document instead of the 3D scene.
 *
 * @typedef {Object} DocPage
 * @property {string} source  URL of the pre-built HTML fragment
 * @property {string} [title] Caption shown in the document view bar
 */

/** @type {PageDef[]} */
export const PAGES = [];

/**
 * Register a page definition.
 * @param {PageDef} def
 */
function register(def) {
    PAGES.push(def);
    return def;
}

/**
 * Micro-mobility viewpoint: deliberately much lower and closer than the
 * overview so switching to (or from) it reads as a clear zoom + move, and the
 * station square fills the view.
 */
const STATION_SQUARE_VIEWPOINT = {
    longitude: 4.8750,
    latitude: 52.3352,
    height: 420,
    headingDeg: -22,
    pitchDeg: -42,
};

/**
 * Original viewer default: camera 2 500 m above a point southeast of the Zuidas
 * centre, looking northwest across the whole case area. This reproduces the
 * framing from cesiumViewer.js so the overview pages keep the familiar view.
 *
 * Used for the flow assessment, which covers the largest area.
 */
const OVERVIEW_VIEWPOINT = {
    longitude: 4.8877819,
    latitude: 52.3232905,
    height: 2500,
    headingDeg: -25.70995378081025,
    pitchDeg: -55,
};

/**
 * Zoom-in viewpoint shared by the single-quality assessment pages: wind, noise,
 * pollution, urban heat and visibility, plus the sunlight page (which adds a
 * small `cameraOffset` on top).
 *
 * This is the framing confirmed on the sunlight page — closer in than the
 * overview so the site block fills the view, at a steeper, nearer-plan tilt.
 * It stays deliberately distinct from:
 *
 *  - `OVERVIEW_VIEWPOINT`   — pedestrian flow, the largest coverage
 *  - `STATION_SQUARE_VIEWPOINT` — micro-mobility, the smallest
 *
 * Keeping one shared preset means the quality pages all read as the same place,
 * so switching between them does not move the camera and the eye can compare
 * one result against another.
 */
const SITE_BLOCK_VIEWPOINT = {
    longitude: 4.867429,
    latitude: 52.3351892,
    height: 547,
    headingDeg: 0.3390086,
    pitchDeg: -73.3660291,
};

/**
 * Sunlight page viewpoint: same framing as the other quality pages
 * (`SITE_BLOCK_VIEWPOINT`), kept as a named alias because the sunlight page is
 * the reference view for the whole assessment set — when someone re-frames
 * sunlight, the other pages should be updated to match.
 *
 * @see SITE_BLOCK_VIEWPOINT
 */
const SUNLIGHT_VIEWPOINT = { ...SITE_BLOCK_VIEWPOINT };

register({
    id: 'flow-macro',
    label: 'Pedestrian flow',
    title: 'Macroscopic pedestrian flow',
    group: 'Movement',
    // Confirmed overview framing: whole Zuidas case area (largest coverage)
    camera: { ...OVERVIEW_VIEWPOINT },
    layers: { networkFlow: true, pedDemand: false, urbanHeat: false, sunlight: false, wind: false },
    linkTooltip: 'hover',
    sections: ['layers', 'flow-scope', 'legend-flow', 'legend-demand', 'meta-flow'],
});

register({
    id: 'flow-micro',
    label: 'Micro-mobility',
    title: 'Microscopic pedestrian flow (station square)',
    group: 'Movement',
    // Smallest coverage: square in front of Amsterdam Zuid — low and close
    camera: { ...STATION_SQUARE_VIEWPOINT },
    layers: { networkFlow: false, pedDemand: true, urbanHeat: false, sunlight: false, wind: false },
    linkTooltip: 'click',
    sections: ['layers', 'micro-scope', 'legend-demand'],
    placeholder:
        'SUMO microscopic trajectories for the station square are not exported to the web viewer yet. ' +
        'The daily pedestrian demand field is shown as a stand-in; run the OD matrix export to populate this page.',
});

register({
    id: 'sunlight',
    label: 'Sunlight',
    title: 'Sunlight (direct sun hours)',
    group: 'Environmental comfort',
    // Same framing as every other quality page — no offset, so switching
    // between assessments holds the camera steady for side-by-side comparison.
    camera: { ...SUNLIGHT_VIEWPOINT },
    layers: { sunlight: true, urbanHeat: false, networkFlow: false, wind: false },
    linkTooltip: 'click',
    sections: ['layers', 'legend-sunlight', 'sunlight-method'],
});

register({
    id: 'wind',
    label: 'Wind',
    title: 'Wind field and comfort',
    group: 'Environmental comfort',
    camera: { ...SITE_BLOCK_VIEWPOINT },
    layers: { sunlight: false, urbanHeat: false, networkFlow: false, wind: true },
    linkTooltip: 'click',
    sections: ['layers', 'legend-wind', 'placeholder-method'],
});

register({
    id: 'noise',
    label: 'Noise',
    title: 'Traffic noise',
    group: 'Environmental comfort',
    camera: { ...SITE_BLOCK_VIEWPOINT },
    layers: { sunlight: false, urbanHeat: false, networkFlow: false, wind: false },
    linkTooltip: 'click',
    sections: ['layers', 'legend-noise', 'placeholder-method'],
    placeholder:
        'Pachyderm Acoustics traffic noise results are not exported to the web viewer yet.',
});

register({
    id: 'pollution',
    label: 'Pollution',
    title: 'Traffic pollution',
    group: 'Environmental comfort',
    camera: { ...SITE_BLOCK_VIEWPOINT },
    layers: { sunlight: false, urbanHeat: false, networkFlow: false, wind: false, pollution: true },
    linkTooltip: 'click',
    sections: ['layers', 'legend-pollution', 'placeholder-method'],
});

register({
    id: 'heat',
    label: 'Urban heat',
    title: 'Urban heat',
    group: 'Environmental comfort',
    camera: { ...SITE_BLOCK_VIEWPOINT },
    layers: { urbanHeat: true, sunlight: false, networkFlow: false, wind: false },
    linkTooltip: 'click',
    sections: ['layers', 'legend-heat', 'heat-method'],
});

register({
    id: 'visibility',
    label: 'Visibility',
    title: 'Visibility and visual quality',
    group: 'Perception',
    camera: { ...SITE_BLOCK_VIEWPOINT },
    layers: { sunlight: false, urbanHeat: false, networkFlow: false, wind: false },
    linkTooltip: 'click',
    sections: ['layers', 'legend-visibility', 'placeholder-method'],
    placeholder:
        'Visibility / visual-quality indicators (Rhino + Python, pedestrian trajectories) are not exported to the web viewer yet.',
});

register({
    id: 'overlap',
    label: 'Multi-layer overlap',
    title: 'Multi-layer overlapping analysis',
    group: 'Synthesis',
    // Same overview framing as the flow page, tilted to read the overlay
    camera: { ...OVERVIEW_VIEWPOINT, pitchDeg: -65 },
    layers: { networkFlow: true, pedDemand: false, urbanHeat: true, sunlight: false, wind: false },
    // In the synthesis view links are read-only: click to inspect, never hover.
    linkTooltip: 'click',
    sections: ['layers', 'overlap-opacity', 'legend-flow', 'legend-heat'],
});

register({
    id: 'cases',
    label: 'Case studies',
    title: 'Case studies',
    group: 'Synthesis',
    camera: { ...OVERVIEW_VIEWPOINT },
    layers: { networkFlow: false, pedDemand: false, urbanHeat: false, sunlight: false, wind: false },
    linkTooltip: 'click',
    sections: ['cases-list'],
    placeholder:
        'Three proposal studies will be demonstrated here. Each study will reuse the assessment pages ' +
        'with its own prepared datasets. Add proposals as <code>cases/&lt;study-id&gt;/</code> data folders.',
});

register({
    id: 'framework',
    label: 'The framework',
    title: 'AMUSE — Assessing Multisensory User Experience',
    group: 'About',
    // A reading page, not a place: it takes over the viewport with the user
    // documentation instead of showing the globe. The camera is left untouched
    // so returning to the map lands wherever the reader was.
    keepCamera: true,
    doc: {
        source: './framework/README.md',
        title: 'AMUSE — user documentation',
    },
    layers: { networkFlow: false, pedDemand: false, urbanHeat: false, sunlight: false, wind: false },
    linkTooltip: 'click',
    sections: ['toc'],
});

/**
 * @param {string} id
 * @returns {PageDef|undefined}
 */
export function getPage(id) {
    return PAGES.find((p) => p.id === id);
}

export const DEFAULT_PAGE_ID = 'flow-macro';

/** Order of navigation groups. */
export const PAGE_GROUPS = ['Movement', 'Environmental comfort', 'Perception', 'Synthesis', 'About'];
