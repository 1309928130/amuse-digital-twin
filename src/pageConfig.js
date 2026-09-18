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
 * @typedef {Object} ProposalDef
 * @property {string} id       Stable key, also the intended data folder name
 * @property {string} label    Name shown on the card and as the active study
 * @property {string} thumbnail Path to the preview image
 * @property {string} note     One-line description shown under the name
 * @property {boolean} hasData Whether assessment data exists for this proposal
 * @property {boolean} [builtIn] Ships with the viewer, with every quality
 *   present under its data folder. The Tools page reports these as already
 *   loaded and does not offer to remove them, since they are part of the site
 *   rather than something the visitor brought.
 */

/**
 * Design proposals shown on the Case studies page.
 *
 * Selecting one makes it the active study for every assessment page. Right now
 * only Proposal 1 has simulation data behind it; the others are here so the
 * comparison is legible, and are marked as having no data yet rather than
 * silently rendering Proposal 1's results under another name.
 *
 * When the remaining assessments are run, the data for each proposal belongs
 * under `simulation_data/<proposal id>/`, and `resolveStudyPath()` below is the
 * single place that decides where a page reads from.
 *
 * @type {ProposalDef[]}
 */
export const PROPOSALS = [
    {
        id: 'proposal-1',
        label: 'Default proposal example',
        thumbnail: './cases/proposal1.png',
        note: 'Current design, shipped with the viewer. All assessment pages show its results.',
        // Every quality under `simulation_data/proposal-1/` is present, so the
        // Tools page reports it as fully populated rather than asking the
        // visitor to upload results it already has.
        hasData: true,
        builtIn: true,
    },
    {
        id: 'proposal-2',
        label: 'Proposal 2',
        thumbnail: './cases/proposal2.png',
        note: 'Alternative layout. Assessment data not yet available.',
        hasData: false,
    },
    {
        id: 'proposal-3',
        label: 'Proposal 3',
        thumbnail: './cases/proposal3.png',
        note: 'Alternative layout. Assessment data not yet available.',
        hasData: false,
    },
];

/** The proposal that currently has data, and the default active study. */
export const DEFAULT_PROPOSAL_ID = 'proposal-1';

/**
 * Resolve the active study.
 *
 * Until other proposals have data, any selection falls back to the default so
 * pages keep rendering real results. This returns both the requested and the
 * effective id, so the UI can be honest about the substitution instead of
 * pretending the selection took effect.
 *
 * A study the visitor added on the Tools page is not in `PROPOSALS`, so it is
 * looked up through the registry, which also knows whether any file was
 * uploaded under it. The registry imports this module, so it is reached with a
 * dynamic import — calling it lazily breaks the cycle, and the synchronous
 * `window.__dataRegistry` handle below keeps this function synchronous for its
 * many call sites.
 *
 * @param {string} requestedId
 * @returns {{ requested: string, effective: string, substituted: boolean }}
 */
export function resolveStudy(requestedId) {
    // Known to the registry (built-in or visitor-added) and carrying data?
    const registry = typeof window !== 'undefined' ? window.__dataRegistry : null;

    let known = false;
    let hasData = false;
    if (registry) {
        const study = registry.getStudyList().find((s) => s.id === requestedId);
        if (study) {
            known = true;
            hasData = registry.studyHasData(requestedId);
        }
    } else {
        const proposal = PROPOSALS.find((p) => p.id === requestedId);
        if (proposal) {
            known = true;
            hasData = !!proposal.hasData;
        }
    }

    if (!known) {
        return { requested: DEFAULT_PROPOSAL_ID, effective: DEFAULT_PROPOSAL_ID, substituted: true };
    }
    if (hasData) {
        return { requested: requestedId, effective: requestedId, substituted: false };
    }
    return { requested: requestedId, effective: DEFAULT_PROPOSAL_ID, substituted: true };
}

/**
 * @typedef {Object} Validity
 * @property {'low'|'medium'|'high'} rating  Qualitative confidence in the layer
 * @property {string} basis                  What was validated, calibrated or
 *   justified, in the reader's terms. Keep this short — it is the summary a
 *   supervising reader skims before deciding how much the result can carry.
 * @property {string[]} [refs]               Literature the rating rests on,
 *   formatted as plain text (e.g. `Author (Year) *Title*`). Rendered as a
 *   reference list; add the DOI/URL in the string if you want it clickable.
 */

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
 * @property {boolean} [cases]    Show the proposal picker instead of the 3D scene
 * @property {boolean} [tools]    Show the Tools working surface instead of the 3D scene
 * @property {string} [thumbnail] Snapshot shown as a card on the case-studies page
 * @property {Object} layers      Layer toggles applied on page enter
 * @property {'hover'|'click'} linkTooltip
 * @property {string[]} sections  Parameter-panel sections to show
 * @property {Validity} [validity] Model-validity rating + justification, shown
 *   in the right panel below the page's own legends on any page that has one.
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
    sections: ['layers', 'flow-scope', 'legend-flow', 'legend-demand', 'meta-flow', 'validity'],
    validity: {
        rating: 'medium',
        basis:
            'PedMac link flows are calibrated against counts, so link totals and their ' +
            'relative ranking across the network are the reliable output. Absolute ' +
            'pedestrian numbers carry wider bounds, and the model assumes present-day ' +
            'land use — it does not predict induced demand from the new programme.',
        refs: [
            'Hoogendoorn & Bovy (2004) *Pedestrian route-choice and activity scheduling theory and models*, Transportation Research Part B 38(2).',
            'Campanella et al. (2014) Macroscopic pedestrian flow modelling for the Amsterdam Zuidas case.',
        ],
    },
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
    sections: ['layers', 'micro-scope', 'legend-demand', 'validity'],
    validity: {
        rating: 'low',
        basis:
            'No SUMO microsimulation is exported to the viewer yet, so what is shown here ' +
            'is the daily demand field standing in for the microscopic trajectories. Treat ' +
            'it as a scope illustration, not a validated micro-scale result.',
    },
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
    sections: ['layers', 'legend-sunlight', 'sunlight-method', 'validity'],
    validity: {
        rating: 'high',
        basis:
            'Direct sun hours are computed geometrically from the building massing, so the ' +
            'result is deterministic given the geometry: no fitted parameters and no ' +
            'calibration step. The remaining uncertainty is the input, not the method — ' +
            'the sky is a typical meteorological year rather than a specific day, and ' +
            'surrounding blocks are modelled as untransparent, so reflections and ' +
            'future neighbouring development are out of scope.',
        refs: [
            'Ladybug Tools (2023) *Ladybug / Honeybee documentation*, https://www.ladybug.tools',
            'Reinhart & Herkel (2000) The simulation of annual daylight illuminance distributions — a state-of-the-art comparison of six RADIANCE-based methods, *Energy and Buildings* 32(2).',
        ],
    },
});

register({
    id: 'wind',
    label: 'Wind',
    title: 'Wind field and comfort',
    group: 'Environmental comfort',
    camera: { ...SITE_BLOCK_VIEWPOINT },
    layers: { sunlight: false, urbanHeat: false, networkFlow: false, wind: true },
    linkTooltip: 'click',
    sections: ['layers', 'legend-wind', 'placeholder-method', 'validity'],
    validity: {
        rating: 'medium',
        basis:
            'Steady-state CFD (Eddy3D on OpenFOAM, RANS k-ε) for a prevailing wind ' +
            'direction. The pattern of speed-up and shelter around the blocks is the ' +
            'usable output; absolute speeds are direction-specific and were not ' +
            'wind-tunnel validated for this geometry, so comfort ratings should be read ' +
            'as comparative between locations rather than as design guarantees.',
        refs: [
            'Blocken (2014) 50 years of computational wind engineering: past, present and future, *Journal of Wind Engineering and Industrial Aerodynamics* 129.',
            'Tominaga et al. (2008) AIJ guidelines for practical applications of CFD to pedestrian wind environment around buildings, *JWEIA* 96(10–11).',
        ],
    },
});

register({
    id: 'noise',
    label: 'Noise',
    title: 'Traffic noise',
    group: 'Environmental comfort',
    camera: { ...SITE_BLOCK_VIEWPOINT },
    layers: { sunlight: false, urbanHeat: false, networkFlow: false, wind: false },
    linkTooltip: 'click',
    sections: ['layers', 'legend-noise', 'placeholder-method', 'validity'],
    validity: {
        rating: 'low',
        basis:
            'Pachyderm Acoustics results are not exported to the web viewer yet, so this ' +
            'rating describes the intended workflow rather than a delivered result. Once ' +
            'exported, the standing assumption to review is the source model — road ' +
            'traffic spectra and the absorption assigned to façades.',
        refs: [
            'ISO 9613-2:1996 *Acoustics — Attenuation of sound during propagation outdoors*.',
            'Hornikx (2016) *Sound propagation in the built environment*, lecture notes, TU Eindhoven.',
        ],
    },
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
    sections: ['layers', 'legend-pollution', 'placeholder-method', 'validity'],
    validity: {
        rating: 'medium',
        basis:
            'Passive-scalar transport on the same CFD case as the wind field: the pollutant ' +
            'is carried by the flow but does not alter it, which holds for traffic ' +
            'concentrations but not for dense sources. The emission inventory is generic ' +
            'rather than measured, so use the field to compare locations and identify ' +
            'trapping zones — not to certify absolute concentrations against an air-quality ' +
            'limit. Probes exceeding the plausible speed range are excluded from the view.',
        refs: [
            'Tominaga & Stathopoulos (2013) CFD simulation of near-field pollutant dispersion in the urban environment, *Atmospheric Environment* 79.',
            'Franke et al. (2011) *The COST 732 best practice guideline for CFD simulation of flows in the urban environment*.',
        ],
    },
});

register({
    id: 'heat',
    label: 'Urban heat',
    title: 'Urban heat',
    group: 'Environmental comfort',
    camera: { ...SITE_BLOCK_VIEWPOINT },
    layers: { urbanHeat: true, sunlight: false, networkFlow: false, wind: false },
    linkTooltip: 'click',
    sections: ['layers', 'legend-heat', 'heat-method', 'validity'],
    validity: {
        rating: 'medium',
        basis:
            'Thermal comfort is derived from the CFD wind field plus climate data, so it ' +
            'inherits the wind result\u2019s direction-specificity: the map is one design ' +
            'condition, not an annual average. Material properties (albedo, emissivity) are ' +
            'catalogue values rather than measured on site, and the vegetation model is ' +
            'simplified. Relative differences between streets are more dependable than the ' +
            'absolute comfort class.',
        refs: [
            'ISO 7730:2005 *Ergonomics of the thermal environment* — PMV/PPD and local thermal comfort.',
            'Middel et al. (2014) Impact of urban form and design on mid-afternoon microclimate in Phoenix, *Landscape and Urban Planning* 122.',
        ],
    },
});

register({
    id: 'visibility',
    label: 'Visibility',
    title: 'Visibility and visual quality',
    group: 'Perception',
    camera: { ...SITE_BLOCK_VIEWPOINT },
    layers: { sunlight: false, urbanHeat: false, networkFlow: false, wind: false },
    linkTooltip: 'click',
    sections: ['layers', 'legend-visibility', 'placeholder-method', 'validity'],
    validity: {
        rating: 'high',
        basis:
            'Visibility is computed geometrically from the building massing and the ' +
            'pedestrian trajectory: an isovist is a deterministic property of the ' +
            'geometry, with no fitted parameters and no calibration step. The remaining ' +
            'uncertainty is in the interpretation rather than the measurement — how much ' +
            'a view contributes to experienced quality is a design judgement, so read ' +
            'the indicator as a reliable description of what can be seen, not as a ' +
            'prediction of how it feels.',
        refs: [
            'Benedikt (1979) To take hold of space: isovists and isovist fields, *Environment and Planning B* 6(1).',
            'Wiener et al. (2007) Isovists as a means to predict spatial experience and behavior, *Spatial Cognition V*.',
        ],
    },
    placeholder:
        'Visibility / visual-quality indicators (Rhino + Python, pedestrian trajectories) are not exported to the web viewer yet.',
});

register({
    id: 'visual-quality',
    label: 'Visual quality',
    title: 'Visual quality (street level)',
    group: 'Perception',
    // Deliberately the station-square framing used by micro-mobility rather
    // than the site-block view the other quality pages share: this assessment
    // is read at eye level, where the visual-quality indicators are defined,
    // and the wider site framing puts the camera too far away to judge them.
    camera: { ...STATION_SQUARE_VIEWPOINT },
    layers: { sunlight: false, urbanHeat: false, networkFlow: false, wind: false },
    linkTooltip: 'click',
    sections: ['layers', 'legend-visual-quality', 'placeholder-method', 'validity'],
    validity: {
        rating: 'low',
        basis:
            'Street-level visual-quality assessment is not exported to the web viewer yet. ' +
            'The intended indicators (façade articulation, sky view factor, greenness along ' +
            'the walking line) are descriptive measures of the design, and their link to ' +
            'experienced quality is correlational rather than a calibrated prediction.',
        refs: [
            'Ewing & Handy (2009) Measuring the unmeasurable: urban design qualities related to walkability, *Journal of Urban Design* 14(1).',
            'Yang et al. (2009) Can you see green? Assessing the visibility of urban forests in cities, *Landscape and Urban Planning* 91(2).',
        ],
    },
    placeholder:
        'Street-level visual-quality assessment (Rhino + Python view analysis) is not exported to the web viewer yet.',
});

register({
    id: 'overlap',
    label: 'Multi-layer overlap',
    title: 'Multi-layer overlapping analysis',
    group: 'Synthesis',
    // Same site-block framing as every quality page, so switching into the
    // overlay holds the camera steady and the layers land on the same view the
    // individual assessments used.
    camera: { ...SITE_BLOCK_VIEWPOINT },
    // Every layer on at once: this page exists to read how the criteria
    // coincide, so any layer left off made the reader turn it on by hand before
    // the comparison meant anything.
    //
    // Two of them need a caveat:
    //
    //  - `sunlight` and the design massing are mutually exclusive. The sunlight
    //    mesh covers the blocks, and switching it on calls `hideDesignGlbs()`,
    //    so the buildings are absent while it is on. That is accepted here —
    //    the sunlight result is one of the layers this page exists to compare —
    //    and the massing returns as soon as sunlight is switched off.
    //  - `pedDemand` is a coarse trip-generation stand-in rather than an
    //    exported result, so it reads as a broad wash under the site-block grid.
    layers: {
        networkFlow: true,
        pedDemand: true,
        urbanHeat: true,
        sunlight: true,
        wind: true,
        pollution: true,
    },
    // In the synthesis view links are read-only: click to inspect, never hover.
    linkTooltip: 'click',
    sections: [
        'layers',
        'legend-flow',
        'legend-demand',
        'legend-heat',
        'legend-sunlight',
        'legend-wind',
        'legend-pollution',
        'validity',
    ],
    validity: {
        rating: 'low',
        basis:
            'This view overlays independent model runs, so its validity is bounded by the ' +
            'weakest layer rather than the strongest, and each layer carries its own rating ' +
            'on its own page. The overlays also share no common calibration, so where two ' +
            'fields disagree the picture shows a disagreement between model assumptions, ' +
            'not a measured conflict. Read agreement as a prompt to investigate, not as ' +
            'confirmation.',
        refs: [
            'Robinson et al. (2015) *Urban design and the multisensory city* — on combining heterogeneous environmental assessments.',
            'Fotheringham & Wong (1991) The modifiable areal unit problem in multivariate statistical analysis, *Environment and Planning A* 23(7).',
        ],
    },
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
    // A choice between studies rather than a place: the proposal picker takes
    // over the viewport, the same way a document page does.
    cases: true,
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

register({
    id: 'tools',
    label: 'Tools',
    title: 'Tools — bring your own data',
    group: 'About',
    // Like the framework page, this is not a place on the map but a working
    // surface, so it takes over the viewport and leaves the camera where it was.
    keepCamera: true,
    tools: true,
    layers: { networkFlow: false, pedDemand: false, urbanHeat: false, sunlight: false, wind: false },
    linkTooltip: 'click',
    // Only the contents list. The page explains its own blocks, so an explainer
    // in the panel would repeat it.
    sections: ['tools-toc'],
});

/**
 * @param {string} id
 * @returns {PageDef|undefined}
 */
export function getPage(id) {
    return PAGES.find((p) => p.id === id);
}

/**
 * Pages offered as snapshot buttons on the case-studies page.
 *
 * Excludes the reading/synthesis pages (framework, case studies itself), which
 * are not assessments of a proposal, and is ordered the way the nav groups
 * them so the grid reads the same way as the top bar.
 *
 * `thumbnail` points at a snapshot captured from the running app by
 * `tools/capture-page-thumbnails.mjs`; the files live in `cases/thumbs/`.
 */
const CASE_STUDY_PAGE_IDS = [
    'flow-macro',
    'flow-micro',
    'sunlight',
    'wind',
    'noise',
    'pollution',
    'heat',
    'visibility',
    'visual-quality',
    'overlap',
];

/**
 * Assessment pages a visitor can jump into from a proposal, each with the
 * snapshot and caption the card needs.
 *
 * Snapshots are per proposal: the capture script drives the viewer once per
 * proposal and writes to `cases/thumbs/<proposal id>/<page id>.png`. Pages
 * that carry no exported results resolve to no snapshot at all, so the grid
 * shows an empty slot rather than another proposal's picture — a reader must
 * never be shown Proposal 1's sunlight under a Proposal 2 label.
 *
 * @param {string} [studyId] Proposal whose snapshots to resolve; defaults to
 *   the active study.
 * @returns {Array<{id: string, label: string, title: string, group: string, thumbnail: string|null, placeholder: boolean}>}
 */
export function getCaseStudyPages(studyId = getActiveStudyIdOrDefault()) {
    return CASE_STUDY_PAGE_IDS.map((id) => getPage(id))
        .filter(Boolean)
        .map((page) => ({
            id: page.id,
            label: page.label,
            title: page.title,
            group: page.group,
            thumbnail: thumbnailFor(page, studyId),
            // Pages with no exported results still appear, but are labelled so
            // the blank view is not mistaken for a failed load.
            placeholder: lineHasPlaceholder(page),
        }));
}

/**
 * Resolve the study to use when the caller does not name one.
 *
 * Reads the DOM element the case-studies picker writes to, rather than holding
 * its own copy of the selection, so there is a single source of truth for which
 * proposal is active. Imported by `dataRegistry.js`, which is why it is exported.
 */
export function getActiveStudyIdOrDefault() {
    const state = typeof document !== 'undefined' ? document.getElementById('caseStudyState') : null;
    return state ? state.dataset.requested || DEFAULT_PROPOSAL_ID : DEFAULT_PROPOSAL_ID;
}

/**
 * The snapshot path for one page under one proposal, or `null` when there is
 * no picture to show.
 *
 * Returns `null` for a page with no exported results. Such a page has no
 * indicators to read, so its capture would only show a blank scene, and a card
 * carrying that image reads as if there were something to see. Showing an
 * empty, labelled slot instead keeps it honest, and keeps the four data-less
 * pages (micro-mobility, noise, visibility, visual quality) looking the same
 * under every proposal rather than only under the ones with no results at all.
 *
 * @param {PageDef} page
 * @param {string} studyId
 * @returns {string|null}
 */
function thumbnailFor(page, studyId) {
    if (lineHasPlaceholder(page)) return null;
    return `./cases/thumbs/${studyId}/${page.id}.png`;
}

/** True when a page carries a "not exported yet" note. */
function lineHasPlaceholder(page) {
    return typeof page.placeholder === 'string' && page.placeholder.length > 0;
}

export const DEFAULT_PAGE_ID = 'flow-macro';

/** Order of navigation groups. */
export const PAGE_GROUPS = ['Movement', 'Environmental comfort', 'Perception', 'Synthesis', 'About'];
