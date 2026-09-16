/**
 * Page controller: navigation between assessment pages, camera transitions,
 * and page-scoped layers / parameter-panel sections.
 */

import { getViewer } from './cesiumViewer.js';
import { PAGES, PAGE_GROUPS, DEFAULT_PAGE_ID, getPage } from './pageConfig.js';
import { NETWORK_FLOW_JSON, PEDESTRIAN_DEMAND_JSON } from './pedFlowVisualization.js';
import { loadLargeModel, removeLargeModel } from './largeModelLoader.js';
import { toggleGrasshopperHeat } from './heatmapVisualization.js';
import { toggleSunlightAnalysis } from './sunlightVisualization.js';
import {
    toggleNetworkFlow,
    togglePedestrianDemand,
    setFlowTooltipMode,
} from './pedFlowVisualization.js';
import {
    showWindField,
    clearWindField,
    showPollutionField,
    clearPollutionField,
} from './cfdVisualization.js';
import { LARGE_MODEL_CONFIG } from './config.js';
import { initializeDocView, openDoc, closeDoc } from './docView.js';
import {
    initializeCaseStudies,
    setCaseStudiesVisible,
    setActiveStudy,
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
                showLoadingIndicator: true,
            }
        );
        designEntities = [entity];
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
        const res = await fetch('./simulation_data/pedflow_manifest.json', { cache: 'no-store' });
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
    void NETWORK_FLOW_JSON;
    void PEDESTRIAN_DEMAND_JSON;

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
    document.body.classList.toggle('cases-page-active', !!page.cases);

    // Global legends toggle scene layers and vehicles, none of which exist on a
    // reading page or the proposal picker — on those the panel carries only
    // page-specific controls.
    const globalBlock = document.getElementById('globalLegendsBlock');
    if (globalBlock) globalBlock.style.display = docPage || page.cases ? 'none' : '';

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
    if (page.doc) {
        setCaseStudiesVisible(false);
    } else if (page.cases) {
        closeDoc();
        setCaseStudiesVisible(true);
    } else {
        closeDoc();
        setCaseStudiesVisible(false);
    }

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
 * Initialise page navigation, restore the last page, and wire camera-touch
 * tracking so a manual camera move is remembered while the page stays open.
 */
export async function initializePages(navEl) {
    buildNavigation(navEl);
    await hydratePanelLegends();

    initializeDocView();

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
    });
    if (startStudy) setActiveStudy(startStudy);

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
}
