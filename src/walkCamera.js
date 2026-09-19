/**
 * A camera that walks a pedestrian route at eye height.
 *
 * ## Why this exists
 *
 * The eye-level visual-quality assessment is defined at 1.7 m, but until now the
 * only way to see it was a single frozen frame from one position. That answers
 * "what can be seen from here" but not "what is it like to walk down this
 * street", which is the question a design reviewer actually has. This moves the
 * camera along a route at eye height so the assessment can be experienced as
 * movement.
 *
 * ## Where the route comes from
 *
 * Not a hand-drawn path. The route is a real agent footpath from the Kova export
 * (`agent_trajectories.json`), so the camera goes where pedestrians actually
 * went. The default is the longest footpath, because a longer route crosses more
 * of the scene and makes the walk worth watching; the panel lets a reader pick
 * another.
 *
 * The footpaths are in WGS84 and were transformed from the simulation's RD New
 * coordinates with a fitted affine transform, so they are already in the frame
 * the rest of the viewer draws in and need no further correction here.
 *
 * ## How the motion is built
 *
 * Three things matter for this to look like walking rather than like a drone:
 *
 * 1. **Constant ground speed, not constant parameter step.** The file stores
 *    positions per iteration, and Kova's iterations are not evenly spaced in
 *    distance. Advancing by a fixed arc length per frame is what makes the speed
 *    read as a steady walk.
 * 2. **The camera has to look where it is going, not at a fixed target.** A
 *    walker faces along the path ahead of them. The look-at point is averaged
 *    over a span a few metres down the route, which also smooths out the lattice
 *    jitter in the raw path so the view does not twitch left and right.
 * 3. **Height is flat, 1.7 m above the ellipsoid.** Deliberately not sampled from
 *    the globe: `getHeight` returns terrain-tile heights, and this globe reports
 *    about -2900 m under this street, which buried the camera. Nothing else in
 *    the scene samples terrain either -- the trajectories, avatars and street
 *    presets all use explicit heights above the ellipsoid -- so a flat 1.7 m is
 *    the same surface the pedestrians being watched are standing on.
 */

import { getViewer } from './cesiumViewer.js';
import { resolveExistingPath } from './dataRegistry.js';

const Cesium = globalThis.Cesium;

/**
 * Height of the walk camera above the ellipsoid, in metres.
 *
 * Deliberately **not** sampled from the globe. `globe.getHeight()` returns the
 * height of the terrain *tile*, and around this street it reported −2924 m:
 * the globe here carries a world terrain provider whose local values are not a
 * usable walking surface. Trusting it buried the camera, which then read as a
 * frozen view rather than as a bad height.
 *
 * This is not a compromise, because nothing else in the scene samples terrain
 * either. The trajectories, the avatars and the street-level presets all anchor
 * to the ellipsoid with explicit heights (`Cartesian3.fromDegrees(lon, lat, h)`),
 * so a flat 1.7 m above the ellipsoid is the same surface everything the camera
 * walks past is standing on. Sampling terrain here would put the camera on a
 * different surface from the people it is meant to be walking among.
 */
const EYE_HEIGHT_M = 1.7;

/**
 * How far ahead of the camera the looking point is placed, in metres.
 *
 * This is the main handle on how the walk feels. Too short and the view snaps
 * around on every lattice step in the raw path; too long and the camera stares
 * past corners instead of turning into them. Twelve metres is roughly the
 * distance a person looks ahead while walking down a street.
 */
const LOOK_AHEAD_M = 12;

/**
 * Width of the window averaged into the look-ahead point, in metres of arc
 * length. Averaging over a span rather than sampling one point is what removes
 * the left-right twitch caused by Kova's cellular lattice: consecutive stored
 * points can be a metre apart and alternate either side of the true direction.
 */
const LOOK_SMOOTHING_M = 18;

/**
 * Pitch while walking, in degrees below the horizon.
 *
 * Matches `EYE_LEVEL_VIEW.pitchDeg` in `pageConfig.js`. The earlier version
 * aimed the camera at a point 0.6 m below eye height a few metres ahead, which
 * produced about -26 deg of pitch once the look-ahead collapsed on a lattice
 * zig-zag -- far too much toward the ground for a standing eye. Setting pitch
 * explicitly keeps the framing level regardless of how short the ahead sample
 * momentarily is.
 */
const WALK_PITCH_DEG = -2.0;

/** Default walking speed, in metres per second. Matches the run's median. */
const DEFAULT_SPEED_MPS = 1.2;

let route = null;
let routeLength = 0;
let cumulative = null;
let travelled = 0;
let speedMps = DEFAULT_SPEED_MPS;
let playing = false;
/** True while `startWalkCamera` is awaiting data. Lets Stop cancel a start that
    has not yet set `playing`, which is the race that left the walk running after
    the button already said Stop. */
let startPending = false;
/** Bumped on every stop so a stale `preRender` callback from a previous start
    becomes a no-op even if Cesium has not yet dropped it. */
let walkGeneration = 0;
let activeGeneration = 0;
let preRenderRemove = null;
let lastTime = 0;
let loadedAgents = null;
let activeRouteIndex = -1;
let wired = false;

/** Geodetic scratch objects, reused to keep the per-frame allocation at zero. */
const scratchCarto = new Cesium.Cartographic();
/** Look-ahead window endpoints. Kept apart from the geodesic scratch below,
    because mixing them would have `distanceMetres` overwrite a point that the
    caller is still holding. */
const scratchCartoA = new Cesium.Cartographic();
const scratchCartoB = new Cesium.Cartographic();
/** Dedicated to `distanceMetres`, which is called re-entrantly from
    `listWalkRoutes` and per frame. */
const geodesicA = new Cesium.Cartographic();
const geodesicB = new Cesium.Cartographic();
const scratchGeodesic = new Cesium.EllipsoidGeodesic();

/**
 * Load and cache the trajectory payload.
 *
 * @returns {Promise<Object|null>} The parsed JSON, or null when unavailable.
 */
async function loadTrajectories() {
    if (loadedAgents) return loadedAgents;
    const url = await resolveExistingPath('trajectories');
    if (!url) return null;
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const payload = await response.json();
        loadedAgents = Array.isArray(payload.agents) ? payload.agents : [];
        return loadedAgents;
    } catch (err) {
        console.warn('[walkCamera] could not load trajectories:', err);
        return null;
    }
}

/**
 * Route lengths for every agent, for the picker.
 *
 * Measured in metres on the ellipsoid rather than in degrees, because a degree
 * of longitude is not a degree of latitude at this latitude and sorting by raw
 * coordinate distance would misorder the routes.
 *
 * @returns {Promise<Object[]>} `{ index, metres }` per agent with a usable path.
 */
export async function listWalkRoutes() {
    const agents = await loadTrajectories();
    if (!agents) return [];
    return agents
        .map((agent, index) => ({ index, metres: pathLengthMetres(agent.footpath) }))
        .filter((r) => r.metres > 0);
}

/**
 * Total ground length of a footpath, in metres.
 *
 * @param {Array<number[]>} path `[lon, lat]` pairs.
 * @returns {number} Length in metres, or 0 when the path is unusable.
 */
function pathLengthMetres(path) {
    if (!Array.isArray(path) || path.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < path.length; i++) {
        total += distanceMetres(path[i - 1], path[i]);
    }
    return total;
}

/**
 * Distance between two `[lon, lat]` points, in metres.
 *
 * Uses Cesium's geodesic so the measurement matches the globe the camera moves
 * on, rather than a flat approximation that would be wrong by a few percent at
 * this latitude. `Ellipsoid.WGS84.geodesicSurfaceDistance` does not exist in the
 * bundled build, so the geodesic object is used directly.
 *
 * The scratch geodesic is reused because this runs for every segment of every
 * route when the picker is built, and again per frame while walking.
 *
 * @param {number[]} a `[lon, lat]`.
 * @param {number[]} b `[lon, lat]`.
 * @returns {number} Metres.
 */
function distanceMetres(a, b) {
    if (!a || !b) return 0;
    const ca = Cesium.Cartographic.fromDegrees(a[0], a[1], 0, geodesicA);
    const cb = Cesium.Cartographic.fromDegrees(b[0], b[1], 0, geodesicB);
    scratchGeodesic.setEndPoints(ca, cb);
    return scratchGeodesic.surfaceDistance;
}

/**
 * Pick the default route: the longest footpath in the run.
 *
 * @returns {Promise<number>} Agent index, or -1 when there is nothing to walk.
 */
async function pickDefaultRoute() {
    const routes = await listWalkRoutes();
    if (!routes.length) return -1;
    // Sorted rather than reduced so ties resolve to the lowest index, which keeps
    // the default stable across loads instead of depending on iteration order.
    routes.sort((a, b) => b.metres - a.metres || a.index - b.index);
    return routes[0].index;
}

/**
 * Set the active route and precompute its cumulative arc length.
 *
 * The cumulative array is what makes constant-speed motion possible: `travelled`
 * is a distance, and this maps it back to a point on the path.
 *
 * @param {number} index Agent index.
 * @returns {Promise<boolean>} Whether the route was applied.
 */
export async function setWalkRoute(index) {
    const agents = await loadTrajectories();
    if (!agents || !agents[index]) return false;
    const path = agents[index].footpath;
    if (!Array.isArray(path) || path.length < 2) return false;

    route = path;
    activeRouteIndex = index;
    cumulative = new Float64Array(path.length);
    cumulative[0] = 0;
    for (let i = 1; i < path.length; i++) {
        cumulative[i] = cumulative[i - 1] + distanceMetres(path[i - 1], path[i]);
    }
    routeLength = cumulative[path.length - 1];
    // Starting mid-route would be arbitrary; starting at the first point means
    // the walk begins where the agent began.
    travelled = 0;
    return routeLength > 0;
}

/**
 * Interpolate a position at a given arc length along the route.
 *
 * Linear interpolation between the two stored points that bracket the distance.
 * The stored spacing is around a metre, so a straight line between neighbours is
 * a good approximation of the path at the scale the camera moves.
 *
 * @param {number} distance Arc length in metres.
 * @param {Object} [out] Reused `Cartographic` to write into.
 * @returns {Object} `Cartographic` position.
 */
function pointAtDistance(distance, out) {
    const target = out || new Cesium.Cartographic();
    if (!route || !cumulative || routeLength <= 0) {
        Cesium.Cartographic.fromDegrees(0, 0, 0, target);
        return target;
    }
    // Clamped so the ends behave: past the finish the camera holds still rather
    // than extrapolating off the route.
    const d = Math.max(0, Math.min(routeLength, distance));

    // Binary search: routes are up to ~500 points and this runs every frame, so
    // a linear scan from the start would waste time on long routes.
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid] <= d) lo = mid;
        else hi = mid;
    }
    const segLen = cumulative[hi] - cumulative[lo];
    const f = segLen > 0 ? (d - cumulative[lo]) / segLen : 0;
    const a = route[lo];
    const b = route[hi];
    const lon = a[0] + (b[0] - a[0]) * f;
    const lat = a[1] + (b[1] - a[1]) * f;
    Cesium.Cartographic.fromDegrees(lon, lat, 0, target);
    return target;
}

/**
 * Average direction over a span ahead, for a stable look-at point.
 *
 * The sample is centred `LOOK_AHEAD_M` metres down the route, then averaged over
 * `LOOK_SMOOTHING_M` so lattice zig-zags cancel. The previous version averaged
 * from the *current* position, which put the midpoint only ~9 m ahead and --
 * when the path doubled back on itself -- collapsed that to ~1 m, pitching the
 * camera hard into the ground.
 *
 * @param {number} from Arc length to look from.
 * @returns {Object} `Cartographic` look-at position.
 */
function lookAheadPoint(from) {
    const centre = from + LOOK_AHEAD_M;
    const a = pointAtDistance(centre - LOOK_SMOOTHING_M / 2, scratchCartoA);
    const b = pointAtDistance(centre + LOOK_SMOOTHING_M / 2, scratchCartoB);
    Cesium.Cartographic.fromDegrees(
        (a.longitude + b.longitude) / 2,
        (a.latitude + b.latitude) / 2,
        0,
        scratchCarto
    );
    return scratchCarto;
}

/**
 * Advance the camera by one frame's worth of travel.
 *
 * Called from Cesium's `preRender`, not a timer, so the camera is updated in the
 * same frame it is drawn and cannot judder against the render loop.
 */
function step() {
    // Generation check first: a stop bumps `walkGeneration`, so a listener that
    // Cesium has not yet dropped becomes a silent no-op rather than advancing
    // the camera after the button already said Stop.
    if (!playing || activeGeneration !== walkGeneration || !route || routeLength <= 0) return;

    const now = performance.now();
    // First frame after a start has no previous timestamp, so nothing is moved;
    // without this guard the elapsed time would be measured from the last stop
    // and the camera would jump forward by however long it had been paused.
    //
    // The upper clamp exists so a long stall -- a backgrounded tab, a slow load
    // -- cannot teleport the camera a large distance in one frame. It used to be
    // 0.1 s, which was too tight: at 5 fps (the rate this viewer reaches while
    // the detector is also running) every real frame is 0.2 s, so every frame
    // was clamped and the walk ran at roughly half its requested speed. 0.5 s
    // caps the jump at half a metre of travel while leaving normal frame times
    // alone.
    const elapsed = lastTime ? Math.min((now - lastTime) / 1000, 0.5) : 0;
    lastTime = now;
    if (elapsed <= 0) return;

    travelled += speedMps * elapsed;
    if (travelled >= routeLength) {
        // Stop at the end rather than looping: a loop would teleport the camera
        // back to the start, which reads as a glitch. The caller is told through
        // the button state, which `onWalkStateChange` pushes to the panel.
        travelled = routeLength;
        stopWalkCamera();
        return;
    }

    // `pointAtDistance` returns a shared scratch object, and `lookAheadPoint`
    // calls it internally -- so the two positions must be read out as plain
    // numbers before anything else runs. Holding both objects at once meant the
    // look-ahead overwrote the eye, the direction collapsed to zero length, and
    // `setView` fell back to looking straight down at the pavement.
    const eyeScratch = pointAtDistance(travelled, scratchCarto);
    const eyeLon = eyeScratch.longitude;
    const eyeLat = eyeScratch.latitude;
    const target = lookAheadPoint(travelled);
    const targetLon = target.longitude;
    const targetLat = target.latitude;

    const viewer = getViewer();
    const camera = viewer && viewer.camera;
    if (!camera) return;

    const eyeCartesian = Cesium.Cartesian3.fromRadians(eyeLon, eyeLat, EYE_HEIGHT_M);

    // Heading from the geodetic bearing to the look-ahead point, pitch fixed at
    // `WALK_PITCH_DEG`. Computing pitch from a look-at with a height drop made
    // the framing depend on how far ahead the sample landed; on lattice
    // zig-zags that distance collapsed and the camera pitched hard into the
    // ground (measured ~-26 deg). A fixed pitch matching the eye-level preset
    // keeps the horizon in frame regardless.
    const dLon = targetLon - eyeLon;
    const dLat = targetLat - eyeLat;
    const heading = Math.atan2(
        dLon * Math.cos(eyeLat),
        dLat
    );

    camera.setView({
        destination: eyeCartesian,
        orientation: {
            heading,
            pitch: Cesium.Math.toRadians(WALK_PITCH_DEG),
            roll: 0,
        },
    });
}

/** Listeners told when the walk starts or stops, e.g. to relabel the button. */
const stateListeners = [];

/**
 * Register a walk-state listener.
 *
 * @param {Function} fn Called with `{ playing, progress }`.
 * @returns {Function} Unsubscribe.
 */
export function onWalkStateChange(fn) {
    stateListeners.push(fn);
    return () => {
        const i = stateListeners.indexOf(fn);
        if (i >= 0) stateListeners.splice(i, 1);
    };
}

/** Notify listeners of the current state. */
function emitState() {
    const state = {
        playing: playing || startPending,
        progress: routeLength > 0 ? travelled / routeLength : 0,
        routeIndex: activeRouteIndex,
    };
    for (const fn of stateListeners) {
        try {
            fn(state);
        } catch (err) {
            console.warn('[walkCamera] state listener failed:', err);
        }
    }
}

/**
 * Start walking the active route.
 *
 * @returns {Promise<boolean>} Whether the walk started.
 */
export async function startWalkCamera() {
    if (playing) return true;
    startPending = true;
    // Capture the generation at the start of this attempt. A Stop clicked while
    // we are still awaiting data bumps `walkGeneration`, and the check below
    // refuses to arm the listener -- that is what made Stop actually stop when
    // the button was hit during the async load.
    const generation = walkGeneration;

    if (!route) {
        const index = activeRouteIndex >= 0 ? activeRouteIndex : await pickDefaultRoute();
        if (index < 0 || !(await setWalkRoute(index))) {
            startPending = false;
            return false;
        }
    }
    // Cancelled while loading.
    if (generation !== walkGeneration) {
        startPending = false;
        return false;
    }
    // A walk that finished, or that was stopped at the end, restarts from the
    // beginning; resuming from the end would look like the button does nothing.
    if (travelled >= routeLength) travelled = 0;

    const viewer = getViewer();
    if (!viewer) {
        startPending = false;
        return false;
    }

    // Drop any leftover listener before arming a new one. Without this a failed
    // stop (or a double-start race) could leave two `step` callbacks running.
    if (preRenderRemove) {
        try { preRenderRemove(); } catch (_) { /* ignore */ }
        preRenderRemove = null;
    }

    playing = true;
    startPending = false;
    activeGeneration = generation;
    // Cleared so the first step measures elapsed time from now, not from the
    // last time the walk ran.
    lastTime = 0;
    preRenderRemove = viewer.scene.preRender.addEventListener(step);
    emitState();
    return true;
}

/**
 * Stop walking, leaving the camera where it is.
 *
 * Deliberately does not restore the previous view: the point of the feature is
 * to look from somewhere new, so throwing that away on stop would be hostile.
 *
 * Also cancels an in-flight start: bumping `walkGeneration` makes a start that
 * is still awaiting data refuse to arm its listener when it resumes.
 */
export function stopWalkCamera() {
    startPending = false;
    walkGeneration += 1;
    playing = false;
    if (preRenderRemove) {
        try { preRenderRemove(); } catch (_) { /* ignore */ }
        preRenderRemove = null;
    }
    // Belt and braces: remove by function reference too, in case the remover
    // returned by `addEventListener` is a no-op in some Cesium builds.
    const viewer = getViewer();
    if (viewer && viewer.scene && viewer.scene.preRender.removeEventListener) {
        try { viewer.scene.preRender.removeEventListener(step); } catch (_) { /* ignore */ }
    }
    emitState();
}

/** Whether the camera is currently walking. */
export function isWalkCameraPlaying() {
    return playing;
}

/**
 * Set the walking speed.
 *
 * @param {number} mps Metres per second.
 */
export function setWalkSpeed(mps) {
    const v = Number(mps);
    if (!Number.isFinite(v) || v <= 0) return;
    speedMps = v;
    emitState();
}

/** The current walking speed, in metres per second. */
export function getWalkSpeed() {
    return speedMps;
}

/**
 * Where the walk currently is along its route.
 *
 * Exposed so the position can be checked without reading it back off the camera,
 * whose coordinates are affected by the up vector and frame conventions. This
 * reports the value the movement logic itself uses.
 *
 * @returns {{travelled: number, length: number, playing: boolean, routeIndex: number}}
 */
export function getWalkProgress() {
    return {
        travelled,
        length: routeLength,
        playing,
        routeIndex: activeRouteIndex,
    };
}

/**
 * Restart the active route from the beginning.
 *
 * @returns {Promise<boolean>} Whether a route was available.
 */
export async function resetWalkCamera() {
    if (!route) {
        const index = activeRouteIndex >= 0 ? activeRouteIndex : await pickDefaultRoute();
        if (index < 0 || !(await setWalkRoute(index))) return false;
    }
    travelled = 0;
    emitState();
    return true;
}

/**
 * Wire the panel controls, once.
 *
 * Called on load. The route dropdown is populated from the actual data so its
 * entries describe real routes rather than a fixed list that could go stale when
 * the simulation is re-exported.
 */
export async function initWalkCamera() {
    if (wired) return;
    const toggle = document.getElementById('walkToggle');
    if (!toggle) return;
    wired = true;

    const routeSelect = document.getElementById('walkRouteSelect');
    const speedInput = document.getElementById('walkSpeed');
    const speedValue = document.getElementById('walkSpeedValue');

    toggle.addEventListener('click', async () => {
        // Treat a pending start the same as playing: the button already reads as
        // Stop (or the user intends to cancel), and without this a click during
        // the async load would fire a *second* start instead of cancelling.
        if (playing || startPending) {
            stopWalkCamera();
            return;
        }
        // Flip the label immediately so a second click during the await is
        // clearly a Stop, and so the user sees a response before the data load
        // finishes.
        toggle.textContent = 'Stop walk-through';
        startPending = true;
        emitState();
        const started = await startWalkCamera();
        if (!started && !playing) {
            toggle.textContent = 'No route available';
            startPending = false;
            emitState();
        }
    });

    if (speedInput) {
        speedInput.value = String(speedMps);
        if (speedValue) speedValue.textContent = `${speedMps.toFixed(1)} m/s`;
        speedInput.addEventListener('input', () => {
            setWalkSpeed(speedInput.value);
            if (speedValue) speedValue.textContent = `${Number(speedInput.value).toFixed(1)} m/s`;
        });
    }

    onWalkStateChange((state) => {
        const el = document.getElementById('walkToggle');
        if (el && state.playing != null) {
            el.textContent = state.playing ? 'Stop walk-through' : 'Play walk-through';
        }
    });

    if (routeSelect) {
        const routes = await listWalkRoutes();
        if (routes.length) {
            routes.sort((a, b) => b.metres - a.metres || a.index - b.index);
            routeSelect.innerHTML = '';
            // Named by length rather than by agent id: a reader choosing a route
            // is choosing how far to walk, and the agent number means nothing
            // without the export open beside them.
            routes.forEach((r, i) => {
                const option = document.createElement('option');
                option.value = String(r.index);
                option.textContent = `Route ${i + 1} — ${Math.round(r.metres)} m`;
                routeSelect.appendChild(option);
            });
            activeRouteIndex = routes[0].index;
            routeSelect.value = String(activeRouteIndex);
        } else {
            routeSelect.innerHTML = '<option value="">No routes in this study</option>';
        }
        routeSelect.addEventListener('change', async () => {
            const wasPlaying = playing;
            stopWalkCamera();
            await setWalkRoute(Number(routeSelect.value));
            if (wasPlaying) await startWalkCamera();
        });
    }
}
