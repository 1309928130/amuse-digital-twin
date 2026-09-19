/**
 * Page controller: navigation between assessment pages, camera transitions,
 * and page-scoped layers / parameter-panel sections.
 */

import { getViewer } from './cesiumViewer.js';
import { PAGES, PAGE_GROUPS, DEFAULT_PAGE_ID, getPage } from './pageConfig.js';
import { resolveExistingPath, onDataRegistryChange } from './dataRegistry.js';
import { preloadSunlightMesh } from './sunlightPreload.js';
import { loadLargeModel, removeLargeModel } from './largeModelLoader.js';
import { resetHourControls, disposeHourControls } from './flowHourControls.js';
import { toggleGrasshopperHeat } from './heatmapVisualization.js';
import { toggleSunlightAnalysis } from './sunlightVisualization.js';
import {
    toggleNetworkFlow,
    togglePedestrianDemand,
    setFlowTooltipMode,
} from './pedFlowVisualization.js';
import { toggleTrajectories, getTrajectoryMeta, hasTrajectories, setAvatarMode, getAvatarLabel, getOscillatingCount } from './trajectoryVisualization.js';
import {
    showWindField,
    clearWindField,
    showPollutionField,
    clearPollutionField,
} from './cfdVisualization.js';
import { LARGE_MODEL_CONFIG } from './config.js';
import { initializeDocView, openDoc, closeDoc } from './docView.js';
import { initializeToolsView, openTools, closeTools } from './toolsView.js';
import {
    initializeCaseStudies,
    setCaseStudiesVisible,
    setActiveStudy,
    buildCaseStudiesToc,
} from './caseStudies.js';

const ACTIVE_PAGE_KEY = 'pedmodel.visualization.activePage';
/** Persisted design-proposal selection. */
const ACTIVE_STUDY_KEY = 'pedmodel.visualization.activeStudy';
/** When true the camera was moved by the user and must not be auto-overridden. */
let cameraTouchedByUser = false;

/** @type {import('./pageConfig.js').PageDef|null} */
let activePage = null;

/** Design GLB entities loaded by the page controller. */
let designEntities = [];

/**
 * The subset of `designEntities` that this module loaded itself.
 *
 * `ensureDesignModel` also *adopts* a model that `main.js` already put in the
 * scene, so `designEntities` can hold an entity the page controller does not
 * own and must not remove -- `main.js` keeps its own reference and the 3D
 * Models checkbox still controls it. Hiding the massing on a page that does not
 * want it may only touch what was created here, which is what this tracks.
 */
let ownedDesignEntities = [];

/**
 * Cesium heading for a framed rectangle view: look north, slightly rotated so
 * the street grid reads diagonally (matches the existing default view style).
 */
function headingForRectangle() {
    return Cesium.Math.toRadians(20);
}

/**
 * Merge a page's offset camera onto its base preset.
 *
 * A page may declare `camera` plus an optional `cameraOffset`. The offset is
 * expressed in **metres on the ground** so it reads the same way you would
 * describe it out loud ("move 200 m south"), and it is applied along the
 * camera's own axes rather than compass axes unless `compass: true` is set.
 *
 * @param {import('./pageConfig.js').PageDef} page
 * @returns {Object} resolved camera preset
 */
function resolveCamera(page) {
    const cam = page.camera || {};
    const offset = page.cameraOffset;
    if (!offset) return cam;

    const R = 6378137;
    const rad = (d) => (d * Math.PI) / 180;
    const mPerDegLat = (R * Math.PI) / 180;
    const mPerDegLon = (lat) => mPerDegLat * Math.cos(rad(lat));

    // Metres along the ground. `south`/`north` and `east`/`west` are compass
    // directions; `forward`/`left` are relative to where the camera looks.
    const south = Number.isFinite(offset.south) ? offset.south : 0;
    const east = Number.isFinite(offset.east) ? offset.east : 0;

    let dE = east;
    // Latitude grows northward, so a southward move subtracts.
    let dN = -south;

    const forward = Number.isFinite(offset.forward) ? offset.forward : 0;
    const left = Number.isFinite(offset.left) ? offset.left : 0;
    if (forward || left) {
        const heading = rad(cam.headingDeg ?? 0);
        const fE = Math.sin(heading);
        const fN = Math.cos(heading);
        dE += fE * forward - fN * left;
        dN += fN * forward + fE * left;
    }

    // Altitude: positive lifts the camera, negative drops it.
    const up = Number.isFinite(offset.up) ? offset.up : 0;
    const baseHeight = Number.isFinite(cam.height) ? cam.height : 1200;
    // Zoom multiplies the (already offset) height, so the two compose.
    const zoom = Number.isFinite(offset.zoom) && offset.zoom > 0 ? offset.zoom : 1;

    return {
        ...cam,
        longitude: cam.longitude + dE / mPerDegLon(cam.latitude),
        latitude: cam.latitude + dN / mPerDegLat,
        height: (baseHeight + up) * zoom,
    };
}

/**
 * Default flyTo timing, in seconds.
 *
 * A single fixed duration reads badly here because page transitions vary from
 * "no movement at all" (sunlight -> wind) to "cross the whole case area and
 * climb 2 km" (micro-mobility -> pedestrian flow). Instead the flight scales
 * with how far the camera actually has to travel, clamped to this range:
 *
 *  - the shortest hop still gets `MIN` so a small nudge stays legible
 *  - the longest gets `MAX` so a big move never drags
 *
 * Tuned so the worst case reads as a deliberate "zoom out and travel" rather
 * than a jump, while staying under the point where it feels sluggish.
 */
export const FLIGHT_DURATION = {
    min: 3.0,
    max: 6.5,
    /** Distance (m) that maps to `min`; beyond this the duration grows. */
    nearDistance: 200,
    /** Distance (m) that maps to `max`; further than this is clamped. */
    farDistance: 2500,
};

/**
 * Work out how long a camera flight to `cam` should take.
 *
 * Distance combines horizontal separation and altitude change, so climbing
 * 2 000 m feels as significant as travelling 2 000 m across the ground.
 *
 * @param {Object} cam resolved camera preset
 * @returns {number} seconds
 */
function flightDurationFor(cam) {
    const viewer = getViewer();
    if (!viewer) return FLIGHT_DURATION.min;

    const from = viewer.camera.positionCartographic;
    const to = Cesium.Cartographic.fromDegrees(cam.longitude, cam.latitude);

    const dLat = to.latitude - from.latitude;
    const dLon = to.longitude - from.longitude;
    const mPerDegLat = 111320;
    const mPerDegLon = mPerDegLat * Math.cos(from.latitude);
    const horizontal = Math.hypot(dLon * mPerDegLon, dLat * mPerDegLat);

    const targetHeight = Number.isFinite(cam.height) ? cam.height : 1200;
    const vertical = Math.abs(targetHeight - from.height);

    // Weight vertical movement a little lower than horizontal: a pure climb
    // reads as less far than the same distance across the ground.
    const distance = Math.hypot(horizontal, vertical * 0.6);

    const { min, max, nearDistance, farDistance } = FLIGHT_DURATION;
    if (distance <= nearDistance) return min;
    if (distance >= farDistance) return max;

    const t = (distance - nearDistance) / (farDistance - nearDistance);
    return min + t * (max - min);
}

/**
 * Apply a page camera preset with a transition.
 * @param {import('./pageConfig.js').PageDef} page
 * @param {{ immediate?: boolean, immediateCamera?: boolean, duration?: number }} [options]
 */
export function applyPageCamera(page, options = {}) {
    const viewer = getViewer();

    // Pages flagged `keepCamera` (information pages) never move the view, so
    // whatever the user was looking at stays put.
    if (page.keepCamera) {
        console.log(`[Pages] ${page.id}: camera kept (page is view-independent)`);
        return;
    }

    const cam = resolveCamera(page);
    // Callers pass either spelling; `gotoPage` forwards `immediateCamera`.
    const immediate = options.immediate || options.immediateCamera;
    const duration = immediate
        ? 0
        : Number.isFinite(options.duration)
          ? options.duration
          : flightDurationFor(cam);

    if (cam.rectangle) {
        const [west, south, east, north] = cam.rectangle;
        const rectangle = Cesium.Rectangle.fromDegrees(west, south, east, north);
        viewer.camera.flyTo({
            destination: rectangle,
            orientation: {
                heading: Cesium.Math.toRadians(cam.heading ?? 20),
                pitch: Cesium.Math.toRadians(cam.pitch ?? -55),
                roll: 0,
            },
            duration,
        });
        return;
    }

    if (Number.isFinite(cam.longitude) && Number.isFinite(cam.latitude)) {
        // Degrees take priority; radians are accepted for computed values.
        const heading = Number.isFinite(cam.headingDeg)
            ? Cesium.Math.toRadians(cam.headingDeg)
            : (Number.isFinite(cam.heading) ? Cesium.Math.toRadians(cam.heading) : 0);
        const pitch = Number.isFinite(cam.pitchDeg)
            ? Cesium.Math.toRadians(cam.pitchDeg)
            : (Number.isFinite(cam.pitch) ? Cesium.Math.toRadians(cam.pitch) : Cesium.Math.toRadians(-45));

        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(
                cam.longitude,
                cam.latitude,
                Number.isFinite(cam.height) ? cam.height : 1200
            ),
            orientation: { heading, pitch, roll: 0 },
            duration,
        });
        return;
    }

    console.warn('[Pages] No camera preset for page', page.id);
}

/** Ensure the design GLB is available (page layers hide/show it themselves). */
async function ensureDesignModel() {
    if (designEntities.length) return designEntities;
    // A massing the viewer already put in the scene counts. The startup path in
    // `main.js` loads the same GLB through its own call, so without this check
    // the guard above never fires for it and a second copy gets loaded on top
    // of the first -- two full-size models in the same place.
    const existing = otherPanelGeometry();
    if (existing.length) {
        designEntities = existing;
        return designEntities;
    }
    try {
        const entity = await loadLargeModel(
            LARGE_MODEL_CONFIG.modelPaths[0],
            {
                longitude: 4.866200480383374,
                latitude: 52.336492555681964,
                height: 0,
            },
            {
                name: 'Zuidas Datamodel',
                scale: LARGE_MODEL_CONFIG.scale,
                minimumPixelSize: LARGE_MODEL_CONFIG.minimumPixelSize,
                maximumScale: LARGE_MODEL_CONFIG.maximumScale,
                enableShadows: false,
                allowPicking: false,
                heightReference: Cesium.HeightReference.NONE,
                orientation: LARGE_MODEL_CONFIG.orientation,
                color: null,
                opacity: 1,
                // No loading notice: this model is the small local Rhino export
                // (~0.3 MB), so the notice only flashes on the first page that
                // needs it. The map area already shows the viewer's own startup
                // indicator for work that is genuinely slow.
                showLoadingIndicator: false,
            }
        );
        designEntities = [entity];
        ownedDesignEntities = [entity];
        console.log('[Pages] Design GLB loaded for assessment pages');
    } catch (error) {
        console.warn('[Pages] Design GLB unavailable:', error);
    }
    return designEntities;
}

/**
 * Geometry that analysis layers must hide while they are on (they replace the
 * design massing). Kept in one place so pages behave consistently.
 */
function otherPanelGeometry() {
    const viewer = getViewer();
    const extra = [];
    try {
        for (const entity of viewer.entities.values) {
            const name = String(entity.name || '');
            if (!entity.model) continue;
            if (
                name.startsWith('Zuidas Datamodel') ||
                name.includes('Datamodel') ||
                name.includes('export_for_visualization') ||
                name === 'Building Block 1'
            ) {
                extra.push(entity);
            }
        }
    } catch (_) {
        /* ignore */
    }
    return extra;
}

/**
 * Fill the trajectory legend from the loaded Kova payload.
 *
 * The agent count is the number worth showing: the avatars identify individuals, so
 * there is no value ramp to label. The units line is the load-bearing part — it says
 * "per iteration" because Kova defines no wall-clock duration, and it switches to
 * seconds only when the export carries a calibrated value. Saying "per iteration" for
 * data already converted to seconds would be wrong in the other direction, so the two
 * cases are distinguished rather than collapsed into one label.
 */
function applyTrajectoryLegend(shown) {
    const countEl = document.getElementById('trajectoryAgentCount');
    const unitsEl = document.getElementById('trajectoryUnits');
    const figureEl = document.getElementById('trajectoryFigure');
    const oscillatingEl = document.getElementById('trajectoryOscillating');
    const meta = getTrajectoryMeta();

    if (!shown || !meta || !hasTrajectories()) {
        if (countEl) countEl.textContent = 'no data';
        if (unitsEl) unitsEl.textContent = 'no Kova run exported for this proposal';
        if (figureEl) figureEl.style.display = 'none';
        if (oscillatingEl) oscillatingEl.style.display = 'none';
        return;
    }
    if (countEl) countEl.textContent = `${meta.n_agents} agents`;
    if (unitsEl) {
        // The export writes `meta.nominal_seconds_per_iteration`; an earlier
        // reader looked for `meta.seconds_per_iteration`, which never matched,
        // so the panel silently claimed the speeds were per-iteration while the
        // file held metres per second. Reading the real key is what keeps the
        // legend and the payload describing the same quantity.
        const secondsPerIteration = meta.nominal_seconds_per_iteration;
        unitsEl.textContent = secondsPerIteration
            ? `speeds: m/s (nominal ${secondsPerIteration} s per iteration)`
            : 'speeds: metres per iteration (Kova defines no wall-clock time)';
    }
    // Whether any agent in this run is oscillating rather than walking.
    //
    // This matters more than any other line in the panel: an oscillating agent
    // produces normal step lengths and a normal-looking speed, so the run reads
    // as healthy while most of the paths cover no ground. Reporting the count
    // here means a reader learns it from the legend rather than from a
    // diagnostic they would have to go looking for.
    if (oscillatingEl) {
        const n = getOscillatingCount();
        if (n > 0) {
            oscillatingEl.textContent =
                `${n} of ${meta.n_agents} paths are grey: their trace returns near ` +
                'where it began, so they may not have reached a destination. Grey is ' +
                'a prompt to inspect the run, not a verdict — coarse sampling can ' +
                'grey a genuine walk.';
            oscillatingEl.style.display = '';
        } else {
            oscillatingEl.style.display = 'none';
        }
    }
    // Which figure is on screen. A fetched walking model and a procedural
    // mannequin are different claims about what the viewer shows, so the panel
    // names one rather than leaving the reader to guess. "loading" stays a
    // distinct state so the panel does not assert a mannequin mid-fetch.
    if (figureEl) {
        const label = getAvatarLabel();
        if (label) {
            figureEl.textContent = label === 'loading' ? 'figures: loading…' : `figures: ${label}`;
            figureEl.style.display = '';
        } else {
            figureEl.style.display = 'none';
        }
    }
}

/**
 * The walk-around viewpoint on the micro-mobility page.
 *
 * Everything else on that page is framed from above, which is the right way to
 * read a plan but the wrong way to read a walk: from 400 m up, a person is
 * sub-pixel and the CA's behaviour — queueing, avoiding, following — is
 * invisible. This preset drops the camera to a little above head height and
 * pulls it back to the edge of the square, so the agents are seen roughly as a
 * passer-by would see them, from enough distance to watch several at once.
 *
 * It is deliberately reached by a button rather than being the page's default.
 * The plan view is what the page is for; this is an additional reading, so the
 * camera is offered as an option and left alone until asked for.
 *
 * @type {Object}
 */
/**
 * The street-level camera preset lives in `pageConfig.js` with the other camera
 * definitions, so a reader looking for "where does this page point" finds all of
 * them in one place. Only the flight is implemented here, because the camera
 * transition is the controller's job.
 */

/**
 * Apply the layer set declared by a page. Runs sequentially so Cesium does not
 * fight over the same primitives.
 * @param {import('./pageConfig.js').PageDef} page
 */
export async function applyPageLayers(page) {
    const want = page.layers || {};
    const designReady = want.sunlight ? await ensureDesignModel() : [];

    // --- Network flow (PedMac links) ---
    const flowSwitch = document.getElementById('networkFlowSwitch');
    try {
        await toggleNetworkFlow(!!want.networkFlow, { flyTo: false });
        if (flowSwitch) flowSwitch.checked = !!want.networkFlow;
        if (want.networkFlow) {
            // The layer has just been (re)built, so the hour controls start from
            // the all-day view and the chart is redrawn from the new totals.
            resetHourControls();
        } else {
            // Leaving the page must not leave a loop running against a layer that
            // no longer exists, which would tick forever with nothing to redraw.
            disposeHourControls();
        }
    } catch (error) {
        console.warn('[Pages] Network flow failed:', error);
        if (flowSwitch) flowSwitch.checked = false;
    }

    // --- Pedestrian demand (trip generation raster) ---
    const demandSwitch = document.getElementById('pedDemandSwitch');
    try {
        await togglePedestrianDemand(!!want.pedDemand);
        if (demandSwitch) demandSwitch.checked = !!want.pedDemand;
    } catch (error) {
        console.warn('[Pages] Pedestrian demand failed:', error);
        if (demandSwitch) demandSwitch.checked = false;
    }

    // --- Kova agent trajectories (micro-mobility) ---
    // Absent for every proposal without a Kova run, which is why the return value
    // is ignored: the page falls back to its placeholder text instead.
    const trajectorySwitch = document.getElementById('trajectoriesSwitch');
    try {
        // Dots or walking figures is a page-level choice, applied before the
        // layer is shown so the first render already uses the right symbol and
        // the layer does not flash dots and then swap them for figures.
        await setAvatarMode(page.avatarMode || 'dot');
        const shown = await toggleTrajectories(!!want.trajectories);
        if (trajectorySwitch) trajectorySwitch.checked = !!want.trajectories && shown;
        applyTrajectoryLegend(shown);
    } catch (error) {
        console.warn('[Pages] Agent trajectories failed:', error);
        if (trajectorySwitch) trajectorySwitch.checked = false;
    }

    // --- Urban heat (Ladybug arrow field) ---
    const heatSwitch = document.getElementById('urbanHeatSwitch');
    try {
        await toggleGrasshopperHeat(!!want.urbanHeat, { flyTo: false });
        if (heatSwitch) heatSwitch.checked = !!want.urbanHeat;
    } catch (error) {
        console.warn('[Pages] Urban heat failed:', error);
        if (heatSwitch) heatSwitch.checked = false;
    }

    // --- Sunlight (baked Ladybug mesh, hides the design massing) ---
    const sunlightSwitch = document.getElementById('sunlightSwitch');
    try {
        await toggleSunlightAnalysis(!!want.sunlight, {
            designEntities: [...designReady, ...otherPanelGeometry()],
        });
        if (sunlightSwitch) sunlightSwitch.checked = !!want.sunlight;
    } catch (error) {
        console.warn('[Pages] Sunlight failed:', error);
        if (sunlightSwitch) sunlightSwitch.checked = false;
    }

    // --- Wind (real Eddy3D / OpenFOAM probe field) ---
    const windSwitch = document.getElementById('windSwitch');
    try {
        if (want.wind) {
            await showWindField();
        } else {
            clearWindField();
        }
        if (windSwitch) windSwitch.checked = !!want.wind;
    } catch (error) {
        console.warn('[Pages] Wind failed:', error);
        if (windSwitch) windSwitch.checked = false;
    }

    // --- Pollution (passive scalar on the same CFD case) ---
    const pollutionSwitch = document.getElementById('pollutionSwitch');
    try {
        if (want.pollution) {
            await showPollutionField();
        } else {
            clearPollutionField();
        }
        if (pollutionSwitch) pollutionSwitch.checked = !!want.pollution;
    } catch (error) {
        console.warn('[Pages] Pollution failed:', error);
        if (pollutionSwitch) pollutionSwitch.checked = false;
    }

    // --- Design massing (Zuidas Datamodel) ---
    // Pages that want the buildings visible without a result layer set this.
    // `ensureDesignModel` is idempotent, so this only loads the GLB the first
    // time and never fights another page for the entity.
    //
    // The `else` matters as much as the `if`. Until it was added, a page that
    // asked for the massing kept it on screen for every page visited
    // afterwards, because nothing ever removed it -- so the buildings leaked
    // from the pollution page onto micro-mobility, where the street view was
    // then occluded by geometry the page had not asked for. Every other layer
    // here is set to an explicit true *or* false for exactly this reason.
    if (want.designMassing) {
        try {
            await ensureDesignModel();
        } catch (error) {
            console.warn('[Pages] Design massing failed:', error);
        }
    } else if (ownedDesignEntities.length) {
        // Only the entities this module loaded. A model adopted from `main.js`
        // is deliberately left alone: that one is owned by the start-up path and
        // is still controlled by the 3D Models checkbox, so removing it here
        // would make the checkbox lie.
        hideOwnedDesignEntities();
    }

    // --- Link tooltip behaviour is page-scoped ---
    setFlowTooltipMode(page.linkTooltip || 'click');
}

/**
 * Fill the parameter-panel legend ranges from the data manifests (P95 caps),
 * so the right panel always matches what is drawn on the map.
 */
async function hydratePanelLegends() {
    const flowBar = document.getElementById('panelledFlowBar');
    if (flowBar) {
        flowBar.style.background = `linear-gradient(to right, ${[
            '#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#b10026',
        ].join(', ')})`;
    }
    const demandBar = document.getElementById('panelledDemandBar');
    if (demandBar) {
        demandBar.style.background =
            'linear-gradient(to right, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000)';
    }

    try {
        // The manifest describes the flow and demand files, so it belongs to the
        // proposal those files came from. Resolved like any other data, which
        // means an upload can supply its own.
        const manifestUrl = (await resolveExistingPath('flow')) || '';
        const manifestPath = manifestUrl
            ? `${manifestUrl.slice(0, manifestUrl.lastIndexOf('/'))}/pedflow_manifest.json`
            : './simulation_data/pedflow_manifest.json';
        const res = await fetch(manifestPath, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const manifest = await res.json();

        const flowMax = manifest?.network_flow?.flow_p95;
        const flowEl = document.getElementById('panelledFlowMax');
        if (flowEl && Number.isFinite(flowMax)) {
            flowEl.textContent = `${Math.round(flowMax).toLocaleString()} ped/day`;
        }

        const demandMax = manifest?.pedestrian_demand?.demand_p95;
        const demandEl = document.getElementById('panelledDemandMax');
        if (demandEl && Number.isFinite(demandMax)) {
            demandEl.textContent = `${demandMax.toFixed(1)} trips/day`;
        }
    } catch (error) {
        console.warn('[Pages] Could not read pedflow manifest for legends:', error);
    }

    // Heat legend uses the colours found in the CSV, which is only known after load;
    // the page controller keeps the reserved blue→red ramp as a fallback.

    // CFD legends: fill the cap actually used by the renderer so the panel
    // numbers cannot drift away from what is drawn.
    try {
        const { getCfdMetadata } = await import('./cfdVisualization.js');
        const meta = getCfdMetadata();

        const windEl = document.getElementById('panelledWindMax');
        if (windEl && meta.wind?.stats) {
            windEl.textContent = `${meta.wind.stats.max > 15 ? 15 : meta.wind.stats.max} m/s`;
        }

        const pollutionEl = document.getElementById('panelledPollutionMax');
        if (pollutionEl && meta.pollution?.stats) {
            pollutionEl.textContent = `${meta.pollution.stats.p95.toFixed(2)} (P95, rel.)`;
        }
    } catch (error) {
        console.warn('[Pages] Could not read CFD metadata for legends:', error);
    }
}

/**
 * Fill the model-validity section for a page.
 *
 * The section is a single shared block rather than one per page: it is wired
 * through the ordinary `sections` list as `'validity'`, and the content is
 * swapped here. That keeps the justification text next to the page definition
 * in `pageConfig.js` instead of splitting it across the markup.
 *
 * The rating stays on the header row so it is readable while the evidence is
 * folded; the prose and references live in the fold. A page with no `validity`
 * entry simply does not list the section, and gets no rating rather than a
 * default one — an unearned "Medium" would be worse than saying nothing.
 *
 * @param {import('./pageConfig.js').PageDef} page
 */
function applyValiditySection(page) {
    const section = document.querySelector('[data-page-section~="validity"]')
        || document.querySelector('#paramPanel [data-section-id="validity"]');
    if (!section) return;

    const validity = page.validity;
    if (!validity) {
        section.style.display = 'none';
        return;
    }
    section.style.display = '';

    const rating = document.getElementById('validityRating');
    const level = String(validity.rating || 'medium').toLowerCase();
    if (rating) {
        rating.dataset.level = level;
        const text = document.getElementById('validityRatingText');
        if (text) text.textContent = level.charAt(0).toUpperCase() + level.slice(1);
    }

    const basis = document.getElementById('validityBasis');
    if (basis) basis.textContent = validity.basis || '';

    const refs = document.getElementById('validityRefs');
    if (refs) {
        const list = Array.isArray(validity.refs) ? validity.refs : [];
        refs.textContent = '';
        refs.style.display = list.length ? '' : 'none';
        list.forEach((entry) => {
            const li = document.createElement('li');
            // Refs are authored as `Author (Year) *Journal title*`. The only
            // markup they use is italics for the source title, so it is applied
            // here rather than by injecting HTML — the text is still set as
            // text nodes, so a stray `<` in a title can never become markup.
            const parts = String(entry).split(/\*([^*]+)\*/);
            parts.forEach((part, i) => {
                if (!part) return;
                if (i % 2 === 1) {
                    const em = document.createElement('em');
                    em.textContent = part;
                    li.appendChild(em);
                } else {
                    li.appendChild(document.createTextNode(part));
                }
            });
            refs.appendChild(li);
        });
    }

    // A page with a short justification has nothing to hide, so open it rather
    // than making the reader click for one line.
    const fold = document.getElementById('validityFold');
    const head = section.querySelector('.validity-head');
    if (fold && head) {
        const long = (validity.basis || '').length > 220 || (validity.refs || []).length > 0;
        const saved = readFoldState('validity');
        const open = saved === null ? !long : saved;
        fold.classList.toggle('open', open);
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
}

/** Read a saved accordion state, or `null` when the reader has never set one. */
function readFoldState(key) {
    try {
        const raw = sessionStorage.getItem(`pedmodel.panelFold.${key}`);
        return raw === null ? null : raw === '1';
    } catch (_) {
        return null;
    }
}

/** Show the parameter-panel sections declared by a page, hide the rest. */
function applyPanelSections(page) {
    // Document pages keep the panel, but repurposed: instead of legends it
    // carries the table of contents, on the document's own light theme so the
    // two columns read as one page.
    const panel = document.getElementById('paramPanel');
    const docPage = !!page.doc;
    if (panel) {
        panel.hidden = false;
        panel.classList.toggle('panel-light', docPage);
    }
    document.body.classList.toggle('doc-page-active', docPage);
    // The tools page is a working surface over the dark theme, matching the
    // case-studies picker, so it takes neither the document's light theme nor
    // that page's body flag.
    document.body.classList.toggle('cases-page-active', !!page.cases);
    document.body.classList.toggle('tools-page-active', !!page.tools);

    // Global legends toggle scene layers and vehicles, none of which exist on a
    // reading page, the proposal picker, or the tools view — on those the panel
    // carries only page-specific content.
    const globalBlock = document.getElementById('globalLegendsBlock');
    if (globalBlock) {
        globalBlock.style.display = docPage || page.cases || page.tools ? 'none' : '';
    }

    const sections = document.querySelectorAll('#paramPanel [data-page-section]');
    sections.forEach((el) => {
        const ids = String(el.getAttribute('data-page-section')).split(/\s+/);
        el.style.display = ids.includes(page.id) ? '' : 'none';
    });
    // Section blocks declared in the registry (allows several pages to reuse one section)
    const declared = Array.from(document.querySelectorAll('[data-section-id]'));
    const wanted = new Set(page.sections || []);
    declared.forEach((el) => {
        const id = el.getAttribute('data-section-id');
        const visible = wanted.has(id);
        el.style.display = visible ? '' : 'none';
    });

    // Order the visible sections to match `page.sections`.
    //
    // Visibility alone was not enough. The panel is a flat list in DOM order,
    // and sections are shared between pages, so a section's source position
    // decides its place on every page that uses it. That made priority
    // inexpressible: the playback controls could not be lifted above the scope
    // note without being lifted above it everywhere.
    //
    // The sections are inserted *before* the global legends block rather than
    // appended to the panel. Appending sent them past that block, which pushed
    // the global legends to the top of the panel -- the opposite of the intent,
    // since they are shared furniture and belong at the bottom, under the
    // page-specific content.
    //
    // Anything not named in `sections` keeps its document position, so a section
    // omitted from the list is still visible rather than dropped.
    const panelForOrder = document.getElementById('paramPanel');
    if (panelForOrder && page.sections && page.sections.length) {
        const anchor = document.getElementById('globalLegendsBlock');
        const byId = new Map();
        panelForOrder.querySelectorAll(':scope > .param-section').forEach((el) => {
            const id = el.getAttribute('data-section-id');
            if (id) byId.set(id, el);
        });
        // `insertBefore` moves an existing node rather than copying it. Inserting
        // each in turn against the same anchor keeps the declared order, because
        // every insert lands immediately before the anchor and so after the one
        // placed before it. With no anchor present, fall back to appending.
        page.sections.forEach((id) => {
            const el = byId.get(id);
            if (!el || el.style.display === 'none') return;
            if (anchor && anchor.parentElement === panelForOrder) {
                panelForOrder.insertBefore(el, anchor);
            } else {
                panelForOrder.appendChild(el);
            }
        });
    }

    const title = document.getElementById('paramPanelTitle');
    if (title) title.textContent = page.title;

    const placeholder = document.getElementById('paramPanelPlaceholder');
    if (placeholder) {
        if (page.placeholder) {
            placeholder.innerHTML = page.placeholder;
            placeholder.style.display = '';
        } else {
            placeholder.innerHTML = '';
            placeholder.style.display = 'none';
        }
    }

    // Runs after the generic pass above: the validity section is listed in
    // `page.sections` like any other, so it has already been hidden or shown,
    // and this only fills it in (and re-hides it for pages with no entry).
    applyValiditySection(page);
}

/**
 * Mirror the runtime values written into the hidden legend data carriers into
 * the visible right-panel legends.
 *
 * The visualisation modules (`heatmapVisualization`, `pedFlowVisualization`,
 * `sunlightVisualization`) own the colour ramps and min/max figures and write
 * them to the original floating panels. Those panels are now hidden, so the
 * right panel is the single visible copy — this function keeps it in sync.
 *
 * Each mapping is `panel id -> { bar, scaleFrom, scaleTo, ramp, text }`.
 */
const LEGEND_MIRRORS = [
    {
        source: 'urbanHeatLegend',
        bar: 'panelledHeatBar',
        // The heat ramp is computed at runtime from the loaded dataset.
        from: 'urbanHeatLegendBar',
    },
    {
        source: 'networkFlowLegend',
        bar: 'panelledFlowBar',
        to: 'panelledFlowMax',
        from: 'networkFlowLegendBar',
        toRange: null,
        rangeSource: 'networkFlowLegendRange',
    },
    {
        source: 'demandHeatLegend',
        bar: 'panelledDemandBar',
        to: 'panelledDemandMax',
        rangeSource: 'demandHeatLegendRange',
    },
];

function cssBackgroundOf(el) {
    if (!el) return '';
    const bg = el.style.background || el.style.backgroundImage || '';
    if (bg && bg !== 'none') return bg;
    // Fall back to the computed value (covers ramps set via a CSS class)
    try {
        const computed = getComputedStyle(el);
        return computed.backgroundImage !== 'none'
            ? computed.backgroundImage
            : computed.background || '';
    } catch (_) {
        return '';
    }
}

/** Pull the numeric range out of a carrier's "0 – 12,345 ped/day" label. */
function rangeOf(el) {
    if (!el) return null;
    const match = String(el.textContent || '').match(/([\d.,]+)\s*[–-]\s*([\d.,]+)/);
    if (!match) return null;
    return { min: match[1], max: match[2], unit: String(el.textContent).replace(/.*[–-]\s*[\d.,]+\s*/, '').trim() };
}

/**
 * Copy the live ramps / ranges from the hidden carriers into the right panel.
 * Safe to call repeatedly; it is a no-op when nothing has changed.
 */
export function syncPanelLegends() {
    LEGEND_MIRRORS.forEach((mirror) => {
        const source = document.getElementById(mirror.source);
        const from = document.getElementById(mirror.from);
        const target = document.getElementById(mirror.bar);
        if (!source || !target) return;

        const bg = cssBackgroundOf(from);
        if (bg && bg !== target.style.background) target.style.background = bg;

        const range = rangeOf(document.getElementById(mirror.rangeSource));
        if (range && mirror.to) {
            const el = document.getElementById(mirror.to);
            if (el) el.textContent = range.max;
        }
    });
}

/**
 * The visualisation modules write their ramps after their datasets resolve, so
 * poll briefly after a page change to catch the update.
 */
let legendSyncTimer = null;
function scheduleLegendSync() {
    if (legendSyncTimer) clearInterval(legendSyncTimer);
    let ticks = 0;
    legendSyncTimer = setInterval(() => {
        syncPanelLegends();
        ticks += 1;
        if (ticks >= 12) {
            clearInterval(legendSyncTimer);
            legendSyncTimer = null;
        }
    }, 250);
}

/** Highlight the active navigation button. */
function applyNavState(page) {
    document.querySelectorAll('.nav-btn').forEach((btn) => {
        const isActive = btn.dataset.page === page.id;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
    const navLabel = document.getElementById('paramPanelScope');
    if (navLabel) navLabel.textContent = page.group || '';
}

/**
 * Navigate to a page: camera transition + layer + panel updates.
 * @param {string} pageId
 * @param {{ immediateCamera?: boolean }} [options]
 */
export async function gotoPage(pageId, options = {}) {
    const page = getPage(pageId);
    if (!page) {
        console.warn('[Pages] Unknown page:', pageId);
        return;
    }
    if (activePage && activePage.id === page.id && !options.force) {
        // Re-entering the same page still resets the camera to its preset so a
        // lost user can always get back to the intended framing.
        applyPageCamera(page, options);
        // Re-open a reading page: the reader may have closed it to look at the
        // map and clicked the nav button again to return.
        if (page.doc) {
            await openDoc({ source: page.doc.source, title: page.doc.title || page.title });
        } else if (page.cases) {
            setCaseStudiesVisible(true);
            buildCaseStudiesToc(
                document.getElementById('casesToc'),
                document.getElementById('caseStudies')
            );
        } else if (page.tools) {
            openTools();
        }
        return;
    }

    console.log(`[Pages] → ${page.id}`);
    activePage = page;
    cameraTouchedByUser = false;

    applyNavState(page);
    applyPanelSections(page);
    try {
        sessionStorage.setItem(ACTIVE_PAGE_KEY, page.id);
    } catch (_) {
        /* ignore */
    }

    applyPageCamera(page, { immediate: options.immediateCamera });

    // Switch the viewport overlay *before* loading layers. `applyPageLayers`
    // awaits the heavy models (the sunlight GLB in particular), and hiding the
    // picker only afterwards left it sitting over the newly opened page for
    // several seconds.
    //
    // Every overlay is closed first, then the one this page wants is opened:
    // the branches are exclusive, and spelling it out this way means adding a
    // fourth takeover page cannot forget to dismiss one of the others.
    closeDoc();
    setCaseStudiesVisible(false);
    closeTools();

    if (page.doc) {
        await openDoc({ source: page.doc.source, title: page.doc.title || page.title });
    } else if (page.cases) {
        setCaseStudiesVisible(true);
        // The contents list is keyed to the proposal list, which can change on
        // the Tools page, so it is rebuilt each time this page is opened rather
        // than once at startup.
        buildCaseStudiesToc(
            document.getElementById('casesToc'),
            document.getElementById('caseStudies')
        );
    } else if (page.tools) {
        openTools();
    }

    // Start the sunlight mesh download now, before anything blocks on it.
    //
    // `applyPageLayers` below awaits the mesh, and the loader it goes through
    // cannot finish earlier than its failsafe timer, so the fetch is the only
    // part of that wait that can be shortened. Kicking it off here overlaps it
    // with the camera flight and the layer bookkeeping instead of queueing it
    // behind them. Deliberately not awaited: it is an optimisation, and the
    // page must open whether or not it succeeds.
    preloadSunlightMesh().catch(() => { /* optimisation only */ });

    await applyPageLayers(page);
    // Layers write their ramps asynchronously (dataset load), so refresh the
    // mirrored legends now and again once the data has settled.
    syncPanelLegends();
    scheduleLegendSync();

    // Opening the document itself is still awaited, so callers know when the
    // reading page is ready.
    if (page.doc) {
        await openDoc({ source: page.doc.source, title: page.doc.title || page.title });
    }
}

/**
 * Build the top navigation bar from the page registry.
 * Groups are separated by a thin divider rather than a heading block, so the
 * bar stays a single clean row of borderless buttons.
 * @param {HTMLElement} navEl
 */
export function buildNavigation(navEl) {
    if (!navEl) return;
    navEl.innerHTML = '';

    let first = true;
    PAGE_GROUPS.forEach((group) => {
        const pages = PAGES.filter((p) => p.group === group);
        if (!pages.length) return;

        if (!first) {
            const divider = document.createElement('div');
            divider.className = 'nav-divider';
            divider.setAttribute('role', 'separator');
            navEl.appendChild(divider);
        }
        first = false;

        pages.forEach((page) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'nav-btn';
            btn.dataset.page = page.id;
            btn.dataset.group = group;
            btn.textContent = page.label;
            btn.title = page.title;
            btn.addEventListener('click', () => gotoPage(page.id));
            navEl.appendChild(btn);
        });
    });
}

/**
 * Wire the "why there is no holistic model" link on the multi-layer overlap
 * page.
 *
 * The note in the panel is the one place a reader can be told, before they read
 * the legends, that the overlaid layers are not coupled. Sending them to the
 * relevant part of the documentation is the useful next step, so the link goes
 * through `gotoPage('framework')` rather than a raw URL: the documentation page
 * is a normal navigation page, and this keeps one path for opening it.
 *
 * The documentation is rendered asynchronously, so the anchor is scrolled to
 * after the page has been opened rather than before. `docView` intercepts
 * in-document anchor links; here the fragment is set directly, scrolling the
 * document body to the heading once it exists.
 */
function initializeOverlapNoteLink() {
    const link = document.getElementById('overlapNoteDocLink');
    if (!link || link.dataset.wired) return;
    link.dataset.wired = '1';

    link.addEventListener('click', (event) => {
        event.preventDefault();
        gotoPage('framework')
            .then(() => {
                const target = document.getElementById('multi-layer-overlap');
                const body = document.getElementById('docViewBody');
                if (target && body) {
                    const offset =
                        target.getBoundingClientRect().top -
                        body.getBoundingClientRect().top +
                        body.scrollTop;
                    body.scrollTo({ top: Math.max(0, offset - 16), behavior: 'smooth' });
                }
            })
            .catch((err) => console.warn('[Overlap] Could not open documentation:', err));
    });
}

/**
 * Initialise page navigation, restore the last page, and wire camera-touch
 * tracking so a manual camera move is remembered while the page stays open.
 */
export async function initializePages(navEl) {
    buildNavigation(navEl);
    await hydratePanelLegends();

    initializeDocView();
    initializeToolsView();
    initializeOverlapNoteLink();

    // Restore the last chosen design proposal before the first page applies its
    // layers, so the initial render already reflects the saved study.
    let startStudy = null;
    try {
        startStudy = sessionStorage.getItem(ACTIVE_STUDY_KEY);
    } catch (_) {
        /* ignore */
    }
    initializeCaseStudies({
        onStudyChange: (study) => {
            // Pages read the effective study when they load data; re-apply the
            // active page so a change is reflected without a manual reload.
            try {
                sessionStorage.setItem(ACTIVE_STUDY_KEY, study.requested);
            } catch (_) {
                /* ignore */
            }
            if (activePage && !activePage.doc && !activePage.cases) {
                applyPageLayers(activePage).then(scheduleLegendSync).catch(() => {
                    /* ignore */
                });
            }
        },
        onOpenPage: (pageId) => {
            // Jump straight from a proposal card into that assessment. The
            // camera preset does the framing, so no extra state is needed.
            gotoPage(pageId).catch((err) => console.warn('[Cases] Could not open page:', err));
        },
    });
    if (startStudy) setActiveStudy(startStudy);

    // A proposal added (or removed) on the Tools page has to appear in the
    // contents list, so it is rebuilt when the registry changes. Guarded on the
    // list being present: this fires for every registry change including ones
    // made before the case-studies page has ever been opened.
    onDataRegistryChange(() => {
        const tocEl = document.getElementById('casesToc');
        if (tocEl) buildCaseStudiesToc(tocEl, document.getElementById('caseStudies'));
    });

    const viewer = getViewer();
    viewer.camera.moveStart.addEventListener(() => {
        cameraTouchedByUser = true;
    });

    let startId = DEFAULT_PAGE_ID;
    try {
        const saved = sessionStorage.getItem(ACTIVE_PAGE_KEY);
        if (saved && getPage(saved)) startId = saved;
    } catch (_) {
        /* ignore */
    }

    await gotoPage(startId, { immediateCamera: true, force: true });
}

/** @returns {import('./pageConfig.js').PageDef|null} */
export function getActivePage() {
    return activePage;
}

export function isCameraTouched() {
    return cameraTouchedByUser;
}

/** Release the design GLB loaded for pages (used when leaving the viewer). */
export function clearPageModels() {
    designEntities.forEach((entity) => {
        try { removeLargeModel(entity); } catch (_) { /* ignore */ }
    });
    designEntities = [];
    ownedDesignEntities = [];
}

/**
 * Hide the design massing a page loaded, without touching a model adopted from
 * `main.js`. Used when moving to a page whose layer set does not ask for the
 * buildings, so they do not stay on screen over a view that did not request
 * them -- the street-level micro-mobility page in particular, where an
 * unexpected massing blocks the trajectory view it exists to show.
 *
 * Removing is deliberate rather than `show = false`: the model is small and
 * reloads in a frame, and a hidden entity would still be picked by
 * `otherPanelGeometry`, so a later page would adopt a massing that is not
 * visible and skip loading a real one.
 */
function hideOwnedDesignEntities() {
    ownedDesignEntities.forEach((entity) => {
        try { removeLargeModel(entity); } catch (_) { /* ignore */ }
    });
    const removed = new Set(ownedDesignEntities);
    designEntities = designEntities.filter((entity) => !removed.has(entity));
    ownedDesignEntities = [];
    const zuidasSwitch = document.getElementById('zuidasGlbSwitch');
    if (zuidasSwitch) zuidasSwitch.checked = false;
}
