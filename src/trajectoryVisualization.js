/**
 * Kova pedestrian trajectories for the Micro-mobility page.
 *
 * Draws each simulated agent's footpath as a polyline, with moving dots that can be
 * animated along the paths, plus per-agent attributes (type, height) from the Kova
 * characteristics deconstructor.
 *
 * ## Where this data comes from
 *
 * `tools/gh_export_footpaths.py` runs inside Grasshopper and writes
 * `agent_trajectories.json`. Three properties of that payload shape the code here:
 *
 *  - **Positions are WGS84 degrees already.** The export applies the projected ->
 *    WGS84 transform, because the viewer has no projection library and the
 *    alternative was embedding EPSG:28992 code on the client.
 *
 *  - **The time axis is the iteration index, not seconds.** Kova advances in
 *    discrete iterations and defines no wall-clock duration. `speed` in the payload
 *    is metres per second, derived by dividing per-iteration distances by a NOMINAL
 *    seconds-per-iteration constant recorded in `meta.nominal_seconds_per_iteration`.
 *    Those speeds are plausible, not measured -- see `meta.speed_unit_basis`.
 *    Animation timing below is a separate presentation choice in "iterations per
 *    second" and is deliberately not presented as real time.
 *
 *  - **Consecutive recorded points are far apart.** Measured on the real run, the
 *    mean step is 3.61 m and the median 2.86 m, where a cellular automaton moves
 *    about one cell (~0.5 m) per iteration. The recording therefore skips several
 *    iterations per sample, and the drawn path is a coarse trace of the route
 *    rather than a step-by-step walk.
 *
 *  - **The trace doubles back heavily.** This is the stronger effect, and it is a
 *    property of the solver rather than of the sampling: consecutive samples turn
 *    by a median of 91.6 degrees, 71% of steps turn more than 45 degrees, and the
 *    path revisits exact lattice points. Drawn literally, agents vibrate in place
 *    instead of crossing the street, which is why `trajectorySmoothing.js` runs the
 *    paths through a moving average before they reach the scene. That is a
 *    readability treatment, not a correction -- the panel says so, and the raw file
 *    keeps the original. Every measurement in this module is taken on the smoothed
 *    path, so the diagnostic and the scene cannot disagree.
 *
 * ## Oscillation is checked, but the measure is not exact
 *
 * A CA agent that cannot reach its target may bounce between a few cells, covering
 * no ground while taking normally-sized steps. Speed cannot detect that -- the
 * oscillating agents in the real run report the same median speed as the walkers --
 * so this module compares path length against net displacement instead, and draws
 * paths over `DETOUR_RATIO_LIMIT` in grey rather than in an identity colour.
 *
 * The threshold is a heuristic, and the aliasing above is its main weakness: an
 * agent that genuinely walks but is sampled so coarsely that its trace doubles back
 * can exceed the limit and be greyed out wrongly. Treat the grey as "inspect this",
 * not as a verdict. Whether the run itself transports agents is a question for the
 * Grasshopper model, where the targets and the walkable surface are visible.
 */

import { getViewer } from './cesiumViewer.js';
import { resolveExistingPath } from './dataRegistry.js';
import { createAvatars, PIXEL_SIZE } from './agentAvatar.js';
import { smoothedPath, smoothPath } from './trajectorySmoothing.js';

let enabled = false;
let data = null;
/**
 * One `Primitive` per agent's route, in agent order.
 *
 * A list rather than a single collection: `PolylineGeometry` primitives are
 * created individually so each keeps its own colour and width, and they have to
 * be removed individually too. See `buildPolylines` for why this replaced a
 * `PolylineCollection`.
 * @type {Cesium.Primitive[]}
 */
let polylinePrimitives = [];
let dotCollection = null;
let animationTimer = null;

/**
 * Whether the agent route lines are drawn.
 *
 * Separate from `enabled` because the two answer different questions: whether
 * the trajectory layer is on at all, and whether its route overlay is drawn.
 * The lines default to hidden for a reason worth recording -- Kova re-plans on
 * every iteration, so a full run traces a dense grid over the street, and on a
 * page that is read as people walking the lattice hides exactly what is being
 * looked at. The agents alone carry the information; the lines are a debugging
 * aid, so they are opt-in.
 */
let showPaths = false;

/**
 * Walking figures, when the page asks for them.
 *
 * `avatarMode` is 'dot' by default so the page renders even if the avatar path
 * fails; the micro-mobility page switches it to 'figure'.
 */
let avatarSet = null;
let avatarMode = 'dot';
let avatarLoading = false;
/** Distance travelled per agent, in metres: the avatar walk cycle's clock. */
let agentsTravelled = [];

/**
 * Playback rate as a multiple of real time, where 1.0 is the run's own pace.
 *
 * The control is a multiplier rather than a physical speed because the
 * pedestrians' speed is fixed in the exported data -- changing it would be
 * inventing a simulation result rather than replaying one. What a viewer
 * actually controls is how fast they watch, and naming it that way avoids the
 * earlier label, which read "1.2 m/s" and so looked like a property of the
 * simulation when it was a property of the playback.
 */
let playbackMultiplier = 1.0;

/**
 * The `performance.now()` reading at the previous tick.
 *
 * Used to advance the run by the time that actually passed rather than by a
 * nominal tick length, so a throttled or drifting timer does not slow playback.
 * Zero means "no previous tick", which the first tick after a play uses to skip
 * the advance instead of counting the whole pause as elapsed.
 */
let lastTickAt = 0;

/** Longest stall that is treated as elapsed playback, in seconds. */
const MAX_TICK_SECONDS = 1;
/** The speed the reader set, kept so the panel can report it in metres. */
let currentSpeedSamplesPerSecond = 4;
/** Milliseconds between animation ticks. */
let tickIntervalMs = 60;
let animationProgress = 0.0;
let animationPlaying = false;

/**
 * Distinct colours per agent.
 *
 * Deliberately not a perceptual ramp: these are identities, not magnitudes, so the
 * job is telling one agent from another. Hues are spaced to stay separable over the
 * dark massing, and the set cycles if more agents than colours appear.
 */
const AGENT_COLORS = [
    [255, 214, 102],
    [255, 138, 101],
    [129, 212, 250],
    [174, 213, 129],
    [206, 147, 216],
    [240, 98, 146],
    [128, 222, 234],
    [255, 183, 77],
];

/**
 * The identity colour for an agent, shared by its path and its figure.
 *
 * Exported so the avatars can be tinted from the same table the trajectories use.
 * They previously drew from separate palettes, which quietly broke the one thing
 * the colours are for: a coloured line and a coloured figure in the same scene
 * read as belonging together, and if they disagree the viewer concludes they are
 * different agents rather than the same one drawn twice. Matching also makes a
 * facing error legible -- a figure walking sideways is obvious when you can see
 * which path it belongs to.
 */
export function agentColorBytes(index) {
    return AGENT_COLORS[index % AGENT_COLORS.length];
}

const Cesium = globalThis.Cesium;

/**
 * The pace at which the avatar clip plays at its authored cadence, in
 * metres/second.
 *
 * Cesium aims the model's forward axis along the heading and the clip runs on
 * the scene clock, so the clock is advanced in proportion to ground covered.
 * This is the reference point for that proportion: at this speed the gait is
 * played exactly as authored, with slower agents stepping shorter and faster
 * ones longer.
 *
 * **This is the clip's speed, not the simulation's.** `walker.glb` swings each
 * foot 0.642 m, so one 1.333 s loop covers a 1.284 m stride and the clip is
 * authored for 0.963 m/s. Using the simulation's nominal 1.2 m/s here made the
 * legs cycle 1.25x faster than the ground they were covering, which is the
 * foot sliding that was reported.
 *
 * The simulation figure is a separate quantity and is not used for the gait:
 * the export derives its speeds from a *nominal* timestep (its note: "plausible,
 * not measured"), so it describes the speed axis the data was scaled onto, not
 * how fast the animation was drawn. See `SAMPLES_PER_SECOND_AT_REAL_TIME` for
 * the full derivation, and redo the foot-swing measurement if the clip changes.
 */
const NOMINAL_WALKING_METRES_PER_SECOND = 0.963;

/**
 * Colour for an agent that oscillates rather than walks.
 *
 * Deliberately outside `AGENT_COLORS`: those hues are identities, and an
 * oscillating agent should not read as one more identity alongside the walkers.
 * A desaturated grey reads as background clutter.
 */
const OSCILLATING_COLOR = Cesium.Color.fromBytes(150, 150, 150, 230);

/**
 * The same grey as `OSCILLATING_COLOR`, as plain channels.
 *
 * The avatars are tinted from raw `[r, g, b]` rather than a `Cesium.Color`, so
 * the grey has to exist in both forms. Kept adjacent so the two cannot drift.
 */
const OSCILLATING_BYTES = [150, 150, 150];

/**
 * Bytes for the oscillating grey, for callers working in channels.
 *
 * Exported for symmetry with `agentColorBytes`, so a caller tinting something can
 * pick the right palette without reaching into this module's internals.
 */
export function oscillatingColorBytes() {
    return OSCILLATING_BYTES;
}

function colorFor(index) {
    const [r, g, b] = AGENT_COLORS[index % AGENT_COLORS.length];
    return Cesium.Color.fromBytes(r, g, b, 230);
}

/**
 * Load the trajectory payload, if this proposal has one.
 *
 * Returns null rather than throwing when the file is absent, because most proposals
 * have no Kova run: the Micro-mobility page must degrade to its placeholder text
 * instead of erroring.
 */
async function loadData() {
    if (data) return data;

    const url = await resolveExistingPath('trajectories');
    if (!url) return null;

    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        data = await response.json();
        // The spacing is derived from this run, so it must not outlive it.
        spacingCache = null;
        return data;
    } catch (err) {
        console.warn('[trajectories] could not load agent trajectories:', err);
        return null;
    }
}

/**
 * Summary of what the agents actually did.
 *
 * The point is to separate "walked a route" from "vibrated in place". Path length is
 * the sum of step distances; net displacement is start-to-end. A ratio near 1 means
 * directed travel; a large ratio means the agent doubled back repeatedly, which in
 * Kova usually means unreachable targets rather than an interesting walking pattern.
 *
 * Exposed for the console rather than rendered, because it is a data-quality check
 * for whoever produced the run, not something a viewer visitor needs.
 */
export function diagnose() {
    if (!data) return null;

    return (data.agents || []).map((agent) => {
        // Measured on the *smoothed* path -- not the raw one, and not the
        // resampled one. Raw is what the solver recorded but has the lattice
        // doubling-back that makes every agent look like it is vibrating;
        // resampled is the curve drawn on screen, which is partly this viewer's
        // construction. The smoothed path is the middle term: it removes the
        // solver's noise without adding anything of mine, so a detour ratio
        // computed from it describes the run rather than the rendering.
        const path = smoothPath(agent);
        let length = 0;
        for (let i = 1; i < path.length; i++) {
            const dx = (path[i][0] - path[i - 1][0]) * 111320 * Math.cos((52.34 * Math.PI) / 180);
            const dy = (path[i][1] - path[i - 1][1]) * 110574;
            length += Math.hypot(dx, dy);
        }
        const dx = path.length > 1 ? (path[path.length - 1][0] - path[0][0]) * 111320 * Math.cos((52.34 * Math.PI) / 180) : 0;
        const dy = path.length > 1 ? (path[path.length - 1][1] - path[0][1]) * 110574 : 0;
        const net = Math.hypot(dx, dy);
        return {
            id: agent.id,
            points: path.length,
            pathLengthMetres: Math.round(length * 10) / 10,
            netDisplacementMetres: Math.round(net * 10) / 10,
            // Infinity when the agent ends where it started: it never travelled anywhere.
            detourRatio: net > 0.5 ? Math.round((length / net) * 100) / 100 : null,
            // Reported from the file rather than recomputed, because the export's
            // nominal timestep is the only thing that makes them seconds at all.
            meanSpeedMetresPerSecond: agent.speed && agent.speed.length
                ? Math.round((agent.speed.reduce((a, b) => a + b, 0) / agent.speed.length) * 1000) / 1000
                : null,
        };
    });
}

/**
 * Height above the surface for the drawn route lines, in metres.
 *
 * Small on purpose: the routes describe where people walked, so they belong on
 * the ground. Lifting them clear by ~1 cm keeps them from z-fighting with the
 * exported surface, which is what makes a line drawn at exactly 0 flicker into
 * dashes.
 */
const ROUTE_HEIGHT_METRES = 0.01;

/**
 * Height above the surface for the per-agent dots, in metres.
 *
 * Eye height, so a dot reads as standing in the crowd rather than lying on the
 * pavement under the route line drawn along the same trace. Kept separate from
 * `ROUTE_HEIGHT_METRES` because the two layers want opposite answers and sharing
 * a default is what let a route-height change move the dots as well.
 */
const DOT_HEIGHT_METRES = 1.5;

/** Path positions for one agent at a given height above ground. */
function pathPositions(agent, heightMetres = ROUTE_HEIGHT_METRES) {
    return smoothedPath(agent)
        .map((p) => Cesium.Cartesian3.fromDegrees(p[0], p[1], heightMetres));
}

/**
 * One point of an agent's path, without converting the rest.
 *
 * `pathPositions` builds a `Cartesian3` for every point in the path on every
 * frame, but the animation only ever reads two of them -- the sample the agent is
 * between and the next one. Before the paths were resampled that waste was small
 * (25k points); afterwards it is 134k conversions and 134k short-lived objects
 * per frame, measured at about 1.4 ms of the frame budget plus the garbage
 * collection that follows.
 *
 * Reading directly keeps the per-frame work proportional to the number of agents
 * rather than to the number of stored points, which matters now that the stored
 * path is deliberately dense.
 *
 * @param {number} index  Clamped, so callers past the end get the last sample.
 */
function pathPointAt(agent, index, heightMetres) {
    const path = smoothedPath(agent);
    if (!path.length) return null;
    const clamped = Math.min(Math.max(0, index), path.length - 1);
    const p = path[clamped];
    return Cesium.Cartesian3.fromDegrees(p[0], p[1], heightMetres);
}

/** Number of stored points on an agent's displayed path. */
function pathPointCount(agent) {
    return smoothedPath(agent).length;
}

/**
 * Cumulative distance along an agent's displayed path, in metres.
 *
 * `prefix[i]` is the distance from the first point to point `i`, so the walk
 * cycle's phase for an agent between samples `idx` and `idx + 1` is
 * `prefix[idx] + step * frac`. Computing this once per agent replaces the
 * per-frame accumulation loop that dominated the animation budget once the paths
 * were resampled.
 *
 * A `WeakMap` so the sums are released with the loaded run.
 */
const distancePrefixCache = new WeakMap();

function cumulativeDistances(agent) {
    let prefix = distancePrefixCache.get(agent);
    if (prefix) return prefix;

    const path = smoothedPath(agent);
    prefix = new Float64Array(path.length);
    for (let i = 1; i < path.length; i++) {
        prefix[i] = prefix[i - 1] + metresBetweenDegrees(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    }
    distancePrefixCache.set(agent, prefix);
    return prefix;
}

/**
 * Ground-level positions, for the avatars.
 *
 * The dots float at eye height so they are visible over the path; a walking
 * figure must stand **on** the ground, so its anchor is the surface itself and
 * the mannequin's own proportions put the head at the right height.
 *
 * Superseded by `pathPointAt(agent, i, 0)`, which converts only the point the
 * figure is standing on rather than the whole path. Kept commented because the
 * height convention it documents -- dots at 1.5 m, figures at 0 -- is the reason
 * the two layers do not z-fight.
 *
 * function groundPositions(agent) {
 *     return smoothedPath(agent)
 *         .map((p) => Cesium.Cartesian3.fromDegrees(p[0], p[1], 0.0));
 * }
 */

/**
 * Metres travelled between two WGS84 samples.
 *
 * Equirectangular approximation, which is exact enough over the few metres
 * between consecutive Kova iterations and far cheaper than a geodesic call
 * 75 times per frame.
 */
function metresBetweenDegrees(lon1, lat1, lon2, lat2) {
    const mPerDegLat = 111132;
    const mPerDegLon = mPerDegLat * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
    return Math.hypot((lon2 - lon1) * mPerDegLon, (lat2 - lat1) * mPerDegLat);
}

/**
 * Compass heading between two WGS84 samples, in radians.
 *
 * Clockwise from north, matching Cesium's heading convention.
 */
function headingBetweenDegrees(lon1, lat1, lon2, lat2) {
    const mPerDegLat = 111132;
    const mPerDegLon = mPerDegLat * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
    const east = (lon2 - lon1) * mPerDegLon;
    const north = (lat2 - lat1) * mPerDegLat;
    if (Math.abs(east) < 1e-6 && Math.abs(north) < 1e-6) return 0;
    return Math.atan2(east, north);
}

/**
 * How much ground an agent actually covered, relative to how far it walked.
 *
 * A cellular-automaton agent that cannot reach its targets oscillates between a
 * few cells. Every individual step is a normal walking distance, so the exported
 * `speed` array looks healthy — median speed in the real Zuidas run came out at
 * 1.20 m/s, exactly the value the nominal timestep was calibrated for, while the
 * median agent was covering 68 m of net ground for 999 m walked. **Speed cannot
 * detect this; only path length against net displacement can.**
 *
 * Measured on the real run: ratios run from 1.7 (a agent that genuinely walked
 * somewhere) to 148 (one that walked 1,095 m and ended 7 m from where it started,
 * about one grid cell).
 *
 * @returns {number} path length / net displacement, or `Infinity` when the agent
 *   ends where it began. 1.0 means perfectly straight.
 */
function detourRatio(agent) {
    // The smoothed path, for the same reason as `diagnose` above: it describes the
    // simulation without describing this viewer's curve. Classifying off the
    // resampled path would measure the spline -- a curve drawn through the points
    // is by construction less doubled-back than the points themselves -- and would
    // progressively stop detecting the oscillation it exists to detect.
    const path = smoothPath(agent);
    if (path.length < 2) return 1;

    let walked = 0;
    for (let i = 1; i < path.length; i += 1) {
        walked += metresBetweenDegrees(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    }
    const net = metresBetweenDegrees(path[0][0], path[0][1], path[path.length - 1][0], path[path.length - 1][1]);

    // Under half a metre of net movement is indistinguishable from standing
    // still, and dividing by it would report a meaningless ratio. Such an agent
    // is treated as the worst case rather than the best.
    if (net < 0.5) return walked > 0.5 ? Infinity : 1;
    return walked / net;
}

/**
 * Above this ratio an agent is drawn as oscillating rather than walking.
 *
 * Measured against the **smoothed** paths, which is what the viewer draws and
 * what `detourRatio` now reports. The smoothed population sits at a p25 of 2.0,
 * a median of 3.8 and a p75 of 8.7, so a threshold of 5 separates the agents that
 * wandered from those that crossed -- 29 of 75 in the current run.
 *
 * The earlier justification for 5 was wrong and is worth recording, because the
 * number survived while its reasoning did not. It claimed the raw ratios formed a
 * gap between 4 and 6; measured, the raw population is continuous through that
 * range with a p25 of 4.8 and a median of 9.5. The threshold was placing a line
 * through a cluster, not through a gap. Smoothing moves the whole population down,
 * which is what puts 5 in a genuinely sparse region now.
 *
 * The threshold is a readability device, not a verdict on the solver. Whether the
 * run transports agents is a question for the Grasshopper model, where the targets
 * and the walkable surface are visible.
 */
const DETOUR_RATIO_LIMIT = 5;

/** True when an agent covered almost no ground for the distance it walked. */
function isOscillating(agent) {
    return detourRatio(agent) > DETOUR_RATIO_LIMIT;
}

/** Number of agents classified as oscillating, for the legend. */
function oscillatingCount() {
    if (!data) return 0;
    return (data.agents || []).filter(isOscillating).length;
}

/**
 * Draw the static polylines, one per agent.
 *
 * Oscillating agents are drawn in a desaturated grey rather than their identity
 * colour. They are kept visible instead of being hidden, because deleting them
 * would leave a viewer looking at a sparse map with no way to tell whether the
 * simulation failed or the scenario was simply quiet. Grey says "recorded, but
 * not a route", and the legend gives the count.
 *
 * An oscillating path is also drawn thinner and more transparent — it is clutter,
 * not evidence, and the eye should go to the paths that go somewhere.
 *
 * ## On the shape of these lines: the kinks are the data
 *
 * Worth stating before anyone spends time on the renderer, because two of us
 * have now done so for nothing. The route lines have long straight legs meeting
 * at sharp corners. That is **not** a rendering fault, and no amount of
 * smoothing, resampling or antialiasing will remove it.
 *
 * It is the solver. Kova re-plans every iteration, so many agents oscillate
 * between candidate targets instead of committing to a route. Measured over the
 * 75 exported agents:
 *
 * | detour ratio (path length / net displacement) | agents |
 * |---|---|
 * | median | 5.09 |
 * | 75th percentile | 11.05 |
 * | maximum | 76.47 |
 *
 * with 51 of 75 above 3x and 66 above 2x. An agent that walks five times
 * further than it needs to, and reverses direction throughout, draws exactly
 * the tangle seen on screen. The resampler is working correctly -- it emits one
 * vertex per 0.25 m (`meanSpacing` measures 0.248 m) -- so it is faithfully
 * tracing a zig-zag, not approximating a curve badly.
 *
 * Two earlier explanations were tried and were both wrong, recorded so they are
 * not retried:
 *
 *   * **Missing line joins** in the old `PolylineCollection` (see below). Real
 *     defect, wrong symptom.
 *   * **The sunlight mesh occluding the lines**, which did break them up where
 *     its surface sat in front. A genuine effect, and turning that layer off
 *     does make the routes look more continuous, but it was masking this rather
 *     than causing it.
 *
 * The fix belongs in the simulation -- see the pedestrian-flow section in
 * `docs/` -- not here. `isOscillating` and the grey treatment exist to flag
 * these paths rather than to hide them.
 *
 * ## Why `PolylineGeometry` rather than `PolylineCollection`
 *
 * The collection used to be used here. It is Cesium's legacy polyline path,
 * built for cheap screen-space segments, and it has no line joins: each segment
 * is an independent quad, so consecutive segments meet at their corners and
 * leave the outside of a turn unfilled.
 *
 * The switch to `PolylineGeometry` is a genuine quality improvement — it is the
 * path Cesium's own entity `polyline` uses (see `sumoVisualization.js`, whose
 * roads have always looked smooth) and it does generate proper joins and caps,
 * so curves are rounder at the bends. But it is **not** the fix for the
 * reported break-up, and nothing here should be read as claiming otherwise.
 * The kinks described above will still be there, because they are in the
 * trajectory data.
 *
 * Wrapping each agent in its own `Primitive` rather than an entity keeps them
 * out of the entity collection: the avatars are entities and are re-created on
 * every layer rebuild, so a second entity per agent would put 150 more objects
 * in the path of that churn.
 */
function buildPolylines() {
    const viewer = getViewer();
    if (!viewer || !data) return;

    removePolylinePrimitives();

    (data.agents || []).forEach((agent, index) => {
        // Ground level, with a small lift.
        //
        // This used to take `pathPositions`'s 1.5 m default, which put the route
        // lines at head height -- they read as rails floating through the crowd
        // rather than as marks on the pavement. Exact zero would be truer still,
        // but a polyline lying precisely on the exported surface z-fights with it
        // and breaks up into dashes, so it is lifted a few centimetres clear.
        const positions = pathPositions(agent, ROUTE_HEIGHT_METRES);
        if (positions.length < 2) return;

        const oscillates = isOscillating(agent);
        const color = oscillates
            ? OSCILLATING_COLOR.withAlpha(0.3)
            : colorFor(index).withAlpha(0.55);

        try {
            const primitive = new Cesium.Primitive({
                geometryInstances: new Cesium.GeometryInstance({
                    geometry: new Cesium.PolylineGeometry({
                        positions,
                        width: oscillates ? 1.2 : 2.0,
                        // The line is already lifted clear of the ground, so it
                        // does not need arc-type handling beyond the default.
                        vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
                    }),
                    attributes: {
                        color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
                    },
                }),
                appearance: new Cesium.PolylineColorAppearance(),
                // Routes are static once built; keeping them out of the
                // depth-test pass they do not need avoids re-issuing them.
                asynchronous: false,
            });
            viewer.scene.primitives.add(primitive);
            polylinePrimitives.push(primitive);
        } catch (error) {
            // One malformed path must not take out the whole layer: the agents
            // and their dots are still worth showing.
            console.warn('[Trajectories] Could not draw route for agent', index, error);
        }
    });
}

/** One dot per agent, positioned at the current animation iteration. */
function buildDots() {
    const viewer = getViewer();
    if (!viewer || !data) return;

    if (dotCollection) {
        viewer.scene.primitives.remove(dotCollection);
        dotCollection = null;
    }

    dotCollection = new Cesium.PointPrimitiveCollection();
    viewer.scene.primitives.add(dotCollection);

    (data.agents || []).forEach((agent, index) => {
        // Dots stay at eye height, which is deliberate and different from the
        // routes. A dot is a marker for where the agent is, and at ground level
        // it would be swallowed by the path line drawn along the same trace. The
        // height is written out here rather than inherited from
        // `pathPositions`'s default, so that changing the default cannot silently
        // move this layer too.
        const positions = pathPositions(agent, DOT_HEIGHT_METRES);
        if (!positions.length) return;
        // Every agent gets a dot, including the ones whose paths oscillate.
        // Suppressing them made the crowd look three-quarters empty, and an
        // absent dot reads as a broken layer rather than as a failed agent.
        // Oscillating agents keep the grey treatment so the distinction is
        // still visible where it matters: on the path.
        const oscillates = isOscillating(agent);
        dotCollection.add({
            position: positions[0],
            color: oscillates ? OSCILLATING_COLOR : colorFor(index),
            pixelSize: oscillates ? 6 : 8,
            // Small enough to sit on the path without swallowing the buildings, and
            // not depth-disabled: a dot behind a block should be hidden by it.
            outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
            outlineWidth: 1,
        });
    });
}

/**
 * Move every dot, and every figure, to its position at the given iteration.
 *
 * The dot path is unchanged. When figures are on, each is placed at the same
 * iteration and given a walk phase derived from the distance **it** has
 * travelled up to that iteration — accumulated rather than recomputed, because
 * the scrubber can jump and the cycle has to stay continuous with where the
 * agent actually is.
 */
function applyProgress(iteration) {
    if (!data) return;

    // Deliberately *not* rounded to a whole iteration.
    //
    // The export samples the run coarsely -- a mean step of 3.61 m against a
    // cellular-automaton cell of about 0.5 m, so each recorded point is several
    // iterations apart. Stepping a whole sample per tick therefore teleports an
    // agent 3.6 m, and at 1 tick per second that reads as 3.6 m/s however low
    // the speed control is set: the slowest setting was still a lurch between
    // samples rather than a walk. Interpolating within the sample is what makes
    // the speed control mean anything.
    const limit = Math.max(0.0001, maxIterations() - 1);
    const clamped = Math.min(Math.max(0, iteration), limit);
    const lower = Math.floor(clamped);
    const frac = clamped - lower;

    // Dots (the default, and the fallback when figures are unavailable).
    if (dotCollection && dotCollection.show) {
        let i = 0;
        (data.agents || []).forEach((agent) => {
            const count = pathPointCount(agent);
            if (!count) return;
            const idx = Math.min(lower, count - 1);
            const next = Math.min(idx + 1, count - 1);
            const primitive = dotCollection.get(i);
            if (primitive) {
                // Only the two samples this agent is between are converted. See
                // `pathPointAt` for why the whole path is not built here.
                // Measuring the agent's position between two samples is what lets
                // a dot glide rather than jump; the alternative -- holding still
                // and then jumping -- looks more broken than it is.
                const a = pathPointAt(agent, idx, DOT_HEIGHT_METRES);
                const b = pathPointAt(agent, next, DOT_HEIGHT_METRES);
                primitive.position = idx === next || !b
                    ? a
                    : Cesium.Cartesian3.lerp(a, b, frac, new Cesium.Cartesian3());
            }
            i++;
        });
    }

    if (!avatarSet || avatarMode !== 'figure') return;

    const viewer = getViewer();
    const camera = viewer.camera;
    // Screen-space scale: a figure twice as far away is drawn half the size, so
    // it reads as the same person rather than a dot that shrinks.
    const distance = camera.positionCartographic.height;
    // The figure's apparent size, as a multiplier on its real thickness.
    //
    // `pose` sizes each part as `thickness * pixelScale`, so this must be a
    // ratio of a reference distance to the current one, not the distance
    // itself. Passing the raw height made every part compute `0.13 m * 4.2`,
    // which is under a pixel and so clamped to the 3 px floor -- the head, the
    // torso and all four limbs came out identical, and the figure read as a
    // handful of unconnected dots rather than a body.
    const pixelScale = PIXEL_SIZE.referenceMetres / Math.max(1, distance);

    (data.agents || []).forEach((agent, index) => {
        // One path for everything about this agent in this frame: position,
        // heading and distance travelled. Reading different arrays for different
        // properties put the figure on one route and pointed it along another --
        // and because the raw trace reverses on roughly half its steps, the
        // heading it produced could differ from the visible direction of travel by
        // a large angle. The figure then faced sideways or backwards while sliding
        // smoothly forward, which is the worst of both.
        const path = smoothedPath(agent);
        if (!path.length) return;

        const idx = Math.min(lower, path.length - 1);
        const next = Math.min(idx + 1, path.length - 1);
        const a = pathPointAt(agent, idx, 0);
        const b = pathPointAt(agent, next, 0);
        const point = idx === next || !b
            ? a
            : Cesium.Cartesian3.lerp(a, b, frac, new Cesium.Cartesian3());

        // Distance travelled along the path up to `idx`, plus the interpolated
        // part of the current step.
        //
        // This used to be accumulated by looping over every point up to `idx` on
        // every frame, which was tolerable when a path held a few hundred points
        // and is not now that resampling makes it a few thousand: 75 agents times
        // ~2,800 steps is over 200,000 distance calls per frame, all to produce a
        // single number per agent. The prefix sums are computed once and cached
        // instead, so the per-frame cost is a lookup and one subtraction.
        const prefix = cumulativeDistances(agent);
        let travelled = prefix[idx];
        if (idx !== next && path[idx] && path[next]) {
            travelled += metresBetweenDegrees(path[idx][0], path[idx][1], path[next][0], path[next][1]) * frac;
        }

        // Heading from the step the agent is taking, falling back to the last
        // available step at the end of a path.
        const back = idx > 0 ? idx - 1 : idx;
        const fwd = idx > 0 ? idx : next;
        const pa = path[back];
        const pb = path[fwd];
        const heading = pa && pb
            ? headingBetweenDegrees(pa[0], pa[1], pb[0], pb[1])
            : 0;

        if (avatarSet.kind === 'model') {
            avatarSet.place(index, point, heading);
        } else if (typeof avatarSet.pose === 'function') {
            // Argument order matters here and is easy to get wrong: the
            // wrapper's signature is `pose(index, base, heading, distance,
            // pixelScale, enu)`. Passing the geometry without the leading
            // index shifts everything along by one, so `pixelScale` receives
            // the distance and every limb falls back to the minimum pixel size.
            const enu = Cesium.Transforms.eastNorthUpToFixedFrame(point);
            avatarSet.pose(index, point, heading, travelled, pixelScale, enu);
        }
    });
}

/** Longest footpath across all agents, which sets the animation length. */
/**
 * Build the walking figures, if the page asks for them.
 *
 * Deliberately separate from `buildDots` and tolerant of failure. A model that
 * cannot be fetched must leave the dots in place rather than emptying the layer,
 * so any failure resets `avatarMode` to 'dot' and lets `applyProgress` keep
 * positioning the fallback.
 */
async function buildAvatars() {
    if (avatarMode !== 'figure' || !data) return;

    const agentList = data.agents || [];
    if (!agentList.length) return;

    avatarLoading = true;
    // Remove any figures already built before adding a new set.
    //
    // `buildAvatars` is reachable more than once per session -- re-entering the
    // page, or toggling the layer -- and without this each pass left its 75
    // entities in the viewer and added another 75 on top. The visible symptom is
    // a doubled crowd occupying the same positions, which is easy to mistake for
    // a colour or identity bug: the duplicates do not share their pair's tint, so
    // agents appear with the wrong trajectory colour.
    removeAvatarEntities();
    try {
        avatarSet = await createAvatars(agentList.length, {
            heights: agentList.map((a) => Number(a.height) || 1.72),
            // Each figure takes its own trajectory's colour, so a path and the
            // agent walking it are the same hue. That is what makes a facing
            // error visible at a glance: with the pairing, a figure walking
            // sideways is immediately attributable to the line beside it.
            //
            // Oscillating agents are given the grey the trajectories use for
            // them rather than their identity colour, so the "this agent did not
            // walk anywhere" caveat survives the change instead of being
            // overridden by a bright tint.
            tints: agentList.map((agent, i) =>
                isOscillating(agent) ? OSCILLATING_BYTES : agentColorBytes(i)
            ),
            // Figures are built for every agent, including those whose paths
            // oscillate. Their paths are drawn grey and their dots are grey, so
            // the caveat is carried by the colour; withholding the figure as
            // well left most of the scene unpopulated, which read as a fault in
            // the viewer rather than as a finding about the run.
        });
        if (!avatarSet) {
            // No viewer, or Cesium absent. The dots stay.
            avatarMode = 'dot';
            return;
        }
        // Figures and dots do the same job; showing both would put a coloured
        // ball inside every person.
        if (dotCollection) dotCollection.show = false;
        agentsTravelled = agentList.map(() => 0);
        console.info(`[trajectories] avatars: ${avatarSet.label} (${avatarSet.kind})`);
    } catch (err) {
        console.warn('[trajectories] avatars unavailable, keeping dots:', err);
        avatarMode = 'dot';
        // Destroy rather than just dropping the reference.
        //
        // `createAvatars` may have added entities before failing -- it awaits a
        // model probe and creates 75 entities one at a time -- so discarding the
        // reference leaves any that were already added in the viewer with nothing
        // pointing at them, where they cannot be removed by a later rebuild. That
        // is how the crowd doubled.
        destroyAvatars();
    } finally {
        avatarLoading = false;
    }
}

/** Remove the figures and hand the layer back to the dots. */
function destroyAvatars() {
    removeAvatarEntities();
    // Only this, the full teardown, restores the dots. `buildAvatars` needs to
    // clear old figures *without* flashing the dots back on for the frames
    // between the two, which is why the entity removal is separated out.
    if (dotCollection && enabled) dotCollection.show = true;
    agentsTravelled = [];
}

/**
 * Drop the figure entities, leaving dot visibility alone.
 *
 * Split from `destroyAvatars` because the two callers want different things: a
 * rebuild wants the old figures gone but the new ones arriving immediately, while
 * a real teardown wants the dots restored as the fallback.
 */
function removeAvatarEntities() {
    if (!avatarSet) return;
    try {
        avatarSet.destroy();
    } catch (_) {
        /* already gone */
    }
    avatarSet = null;
}

function maxIterations() {
    if (!data) return 0;
    return (data.agents || []).reduce(
        (max, agent) => Math.max(max, (agent.footpath || []).length),
        0
    );
}

function tick() {
    const limit = maxIterations();
    if (!limit) return;

    // The run is advanced by `renderPositions`, once per rendered frame -- not
    // here.
    //
    // It used to advance on this timer, reading `performance.now()` so the rate
    // was correct on average however much the timer drifted. That fixed a real
    // bug (a throttled `setInterval` made playback 7.6x too slow) but left the
    // motion lumpy: time arrived in whole timer intervals, so `animationProgress`
    // moved in jumps of ~1.8 samples -- about 0.45 m -- once every 4.3 rendered
    // frames. The agents were repositioned every frame and so glided *within* a
    // sample, then hopped when the timer caught up.
    //
    // Doing it in the frame loop keeps the same clock reading and the same rate
    // but samples it far more often, so each step is ~0.02 m at walking pace.
    // Nothing is lost by moving it: the frame loop runs at least as often as this
    // timer, and `MAX_TICK_SECONDS` still caps a long stall.
    if (animationProgress >= limit - 1) animationProgress = 0;

    // Drive the walk cycle through the clock's *rate*, not by setting its time.
    //
    // The clip's pose comes from the scene time alone -- the animation collection
    // reads it out of the frame state and derives a normalised position from it --
    // so something has to move that time. Nudging `currentTime` by hand was the
    // wrong way: `shouldAnimate = true` already advances the clock once per
    // rendered frame, so a manual jump on top doubled the advance, and because the
    // jump came from a `setInterval` while the advance comes from the render loop
    // the two were never in step and the legs stuttered.
    //
    // The clock defaults to `shouldAnimate: false`, so before this was set at all
    // time never moved and every clip was pinned to its first frame: figures slid
    // along perfectly rigidly, which reads as a broken model rather than a stopped
    // clock.
    //
    // The rate is computed from *distance*, not from elapsed wall time. Wall time
    // is the obvious choice and it is wrong: the agents advance by sample index, so
    // their ground speed is whatever the slider asks for, while the clip would play
    // at its authored pace regardless. At a low setting the legs then sprinted
    // while the body crawled, and at a high one the figure skated along barely
    // moving its legs. Dividing the ground speed by the speed at which the authored
    // cadence is correct gives a dimensionless rate where 1.0 means "play as
    // authored", so a stride always covers a stride's worth of ground.
    const viewer = getViewer();
    if (viewer && viewer.clock) {
        const spacing = meanSampleSpacingMetres();
        if (spacing > 0 && Number.isFinite(currentSpeedSamplesPerSecond)) {
            // Metres per *second*, not per tick. The render loop applies
            // `multiplier` once per rendered frame, so a ratio derived from the
            // 60 ms tick interval overstated the gait by `frameRate / tickRate`
            // -- about 2.8x at 60 fps, and worse on faster displays, which is
            // why the walk read as too fast at every slider setting. Seconds are
            // frame-rate independent and are what the clock's multiplier means.
            const samplesPerSecond = currentSpeedSamplesPerSecond;
            const groundMetresPerSecond = samplesPerSecond * spacing;
            // 1.0 at walking pace, less when slower, more when faster.
            const rate = groundMetresPerSecond / NOMINAL_WALKING_METRES_PER_SECOND;
            // Clamped so an absurd rate cannot make the gait a blur.
            viewer.clock.multiplier = Math.max(0.01, Math.min(rate, 8));
        }
        viewer.clock.shouldAnimate = true;
    }

    // The tick deliberately does **not** reposition the agents. See
    // `renderPositions`, which the render loop calls once per frame.
    emit();
}

/**
 * Reposition the agents from the current progress, once per rendered frame.
 *
 * This is what makes the movement continuous rather than stepped, and it is the
 * fix for the remaining "flashiness" -- which was never about how closely the path
 * points were spaced.
 *
 * Positions used to be written inside `tick`, which runs on a 60 ms
 * `setInterval`. A display refreshes every 16.7 ms, so the agents sat at one
 * position for about four frames and then jumped to the next: at x1.0 that is a
 * 0.072 m lurch, against the 0.02 m a real pedestrian covers per frame. The eye
 * reads a repeated 4-frame hold followed by a jump as stutter, however smooth the
 * path underneath it is -- and no amount of extra path detail can hide it, because
 * the discontinuity is in *time*, not in space.
 *
 * Driving the update from `preRender` ties it to the frame the display is about to
 * show. Movement per frame then equals speed divided by frame rate, which at
 * walking pace is 0.02 m -- well under the 0.2 m the viewer asked for, and under
 * the threshold at which motion reads as continuous at any slider setting up to
 * about x10.
 *
 * The cost is one `applyProgress` per frame instead of one per tick, which is
 * cheap now that it reads cached prefix sums and converts only the two points each
 * agent needs.
 */
function renderPositions() {
    if (!enabled || !data) return;

    // Advance the run here, once per frame, rather than on the timer.
    //
    // This is the fix for the "figure holds for a few frames then hops" stutter.
    // The advance used to live in the `setInterval` callback, and the timer is
    // throttled hard -- measured, `animationProgress` changed only once per 4.3
    // rendered frames, moving ~1.8 samples (about 0.45 m) each time. Positioning
    // was already per-frame, so an agent glided smoothly *within* a sample and
    // then jumped when the timer fired: the body translated continuously while
    // the gait and the step it belonged to arrived in lumps. That is what reads
    // as a still figure whose limbs swing and which is then teleported along.
    //
    // Moving the advance into `preRender` makes the motion continuous in time as
    // well as in space, and needs no change to the speed maths: the elapsed wall
    // time is the same quantity the timer was consuming, just sampled more often
    // and in smaller pieces. At walking pace the step per frame is ~0.02 m,
    // well under the ~0.2 m at which motion stops reading as continuous.
    //
    // The pause path stops calling this, so nothing advances while paused; and
    // `lastTickAt` is reset on play (see `playAnimation`) so a pause is never
    // counted as elapsed playback.
    if (animationPlaying) {
        const now = performance.now();
        if (lastTickAt > 0) {
            const elapsedSeconds = Math.min((now - lastTickAt) / 1000, MAX_TICK_SECONDS);
            animationProgress += currentSpeedSamplesPerSecond * elapsedSeconds;
        }
        lastTickAt = now;
    }

    // The scene clock drives the walk cycle and is advanced by the render loop, so
    // it must keep running even while the agents themselves are paused -- otherwise
    // a paused run would also freeze the legs mid-stride, which looks like a fault.
    applyProgress(animationProgress);
}

/**
 * Attach and detach the per-frame position update.
 *
 * Registered on `preRender` so the write happens before Cesium draws the frame,
 * which keeps the figure and its shadow on the same position for that frame.
 */
let removeRenderListener = null;

function startRenderUpdates() {
    if (removeRenderListener) return;
    const viewer = getViewer();
    if (!viewer || !viewer.scene || !viewer.scene.preRender) return;
    viewer.scene.preRender.addEventListener(renderPositions);
    removeRenderListener = () => viewer.scene.preRender.removeEventListener(renderPositions);
}

function stopRenderUpdates() {
    if (removeRenderListener) {
        removeRenderListener();
        removeRenderListener = null;
    }
}

export function playAnimation() {
    if (animationPlaying) return;
    animationPlaying = true;
    // Mark the start of this run so the first tick measures interval from now.
    // Left stale, the first tick would count the entire pause as elapsed
    // playback and jump the run forward.
    lastTickAt = 0;
    animationTimer = window.setInterval(tick, tickIntervalMs);
    // The frame listener is what advances the run *and* repositions the agents;
    // the timer above only checks for the end of the run and keeps the gait rate
    // in step with the speed slider. See `renderPositions` for why the advance
    // belongs on the frame rather than on this timer.
    startRenderUpdates();
}

export function pauseAnimation() {
    animationPlaying = false;
    lastTickAt = 0;
    if (animationTimer) {
        window.clearInterval(animationTimer);
        animationTimer = null;
    }
    // The per-frame repositioning stops with playback. `applyProgress` is called
    // once more so the figures settle at the exact position the run stopped at,
    // rather than wherever the last rendered frame happened to leave them.
    stopRenderUpdates();
    applyProgress(animationProgress);
    emit();
    // Stop the clock with the timer. It exists here only to drive the walk
    // cycle, so leaving it running would advance time for every other
    // time-dependent layer with nothing on screen to justify it.
    const viewer = getViewer();
    if (viewer && viewer.clock) viewer.clock.shouldAnimate = false;
}

export function resetAnimation() {
    pauseAnimation();
    animationProgress = 0;
    applyProgress(0);
}

/**
 * Samples per second that correspond to a playback multiplier of 1.0.
 *
 * This is anchored to the **avatar clip's own stride**, not to the nominal
 * pedestrian speed the export reports. Those two are different numbers and
 * conflating them was the cause of the persistent foot sliding, so the
 * derivation is written out here in full.
 *
 * ## The clip's stride
 *
 * `walker.glb` holds a single `Walk_Loop` clip, 1.333 s long, and it is an
 * **in-place** cycle: the `translation` channels carry only constant bone
 * offsets, and every joint's motion lives in its `rotation`. So the ground the
 * clip covers cannot be read off a root translation and has to be derived from
 * the limb geometry.
 *
 * Tracking the foot bones through the clip gives the distance each foot swings:
 *
 *     foot_l  Z range: 0.642 m
 *     foot_r  Z range: 0.632 m
 *
 * with the thighs essentially stationary (0.006 m), confirming a treadmill
 * cycle. A walk loop contains one swing and one stance per foot, so one loop
 * covers a full stride -- both feet -- of about **1.284 m**:
 *
 *     0.642 m per swing x 2 = 1.284 m per loop
 *     1.284 m / 1.333 s     = 0.963 m/s authored speed
 *
 * Cross-check on the cadence, which is what makes this the right reading rather
 * than the half-size alternative: 1 loop / 1.333 s = 0.75 loops/s = 1.5 steps/s,
 * a plausible walking cadence. Treating the loop as a single step would give
 * 0.75 steps/s and 0.48 m/s, which is a shuffle.
 *
 * ## Why the anchor is not `1.2 m/s`
 *
 * The export reports speeds on a *nominal* basis, calibrated so the median
 * walking speed is "about 1.2 m/s" -- its own note says the timestep is
 * "plausible, not measured". That figure describes the **simulation's** speed
 * axis. The clip's authored speed is 0.963 m/s.
 *
 * Driving the gait from `1.2` made the legs cycle 1.2 / 0.963 = **1.25x faster
 * than the ground they were covering**, which is exactly the sliding that was
 * reported. The clip has to be played so its feet match the ground, so the
 * authored speed is what belongs here.
 *
 * ## The constant
 *
 * The figures advance through the **resampled** path, one point per
 * `RESAMPLE_SPACING_METRES`, so the rate depends on that spacing:
 *
 *     0.963 m/s / 0.2477 m per sample = 3.887 samples/s
 *
 * | path the spacing is measured on | spacing | anchor |
 * |---|---|---|
 * | raw (as exported) | 2.498 m | 0.385 |
 * | smoothed, window 3 | 1.334 m | 0.722 |
 * | **resampled** | **0.2477 m** | **3.887** |
 *
 * Changing `SMOOTHING_WINDOW` or `RESAMPLE_SPACING_METRES` invalidates this
 * number, and so does swapping `walker.glb` for a clip with a different stride --
 * in that case the foot-swing measurement above is the thing to redo, not this
 * constant.
 *
 * The relationship is:
 *
 *     samplesPerSecond = authoredClipSpeed / RESAMPLE_SPACING_METRES
 *     clock.multiplier = groundSpeed / authoredClipSpeed
 *
 * so the clip always advances in proportion to the ground, whatever the slider
 * asks for, and the feet track the path at every setting.
 */
const SAMPLES_PER_SECOND_AT_REAL_TIME = 3.887;

/**
 * The iteration a run opens on.
 *
 * Part-way in rather than at zero: the opening samples are agents entering from
 * the edge of the model, which reads as a trickle, and the page is meant to show
 * a street in use. Clamped to the run length so a short run cannot open past its
 * end.
 */
const DEFAULT_START_ITERATION = 140;

export function setAnimationSpeed(multiplier) {
    // A multiplier, not a speed. The clamp matches the speed control's own range
    // (x0.1 to x2), so the slider cannot ask for a value the module silently
    // changes underneath it -- a mismatch there would show one number in the
    // readout and play at another.
    //
    // The ceiling is x2 rather than the x8 it once allowed because the gait is
    // clamped in `tick` for anything faster: past roughly x2 the walk cycle stops
    // keeping up with the ground, and the figures slide instead of walking. A
    // setting that only reliably looks worse is not worth offering.
    //
    // The floor stays at 0.1. Below that a 515-sample run takes over ten minutes.
    const m = Math.max(0.1, Math.min(2, multiplier));
    playbackMultiplier = m;
    // Stored as samples per *second*. The tick converts that using the time it
    // actually measured, so no per-tick figure is derived here any more -- that
    // conversion was what assumed a perfectly regular timer.
    currentSpeedSamplesPerSecond = SAMPLES_PER_SECOND_AT_REAL_TIME * m;
}

/** The playback multiplier the viewer is currently set to. */
export function getPlaybackMultiplier() {
    return playbackMultiplier;
}

/**
 * Mean metres between the recorded samples of the loaded run.
 *
 * Used to translate the playback control into a speed a reader can judge, and
 * to convert ground covered into walk-cycle time. Returns 0 when nothing is
 * loaded, which the panel treats as unknown.
 */
export function getMeanSampleSpacingMetres() {
    if (!data || !data.agents) return 0;
    let total = 0;
    let n = 0;
    for (const agent of data.agents) {
        // The **resampled** path, because this figure drives the walk cycle and the
        // walk cycle has to match the ground the figures actually cover. The
        // figures advance one resampled point at a time, so the distance between
        // resampled points -- about 0.25 m, by construction -- is the spacing the
        // gait must be calibrated against. Measuring the smoothed or raw path here
        // would report a spacing the animation never uses.
        const path = smoothedPath(agent);
        for (let i = 1; i < path.length; i += 1) {
            total += metresBetweenDegrees(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
            n += 1;
        }
    }
    return n ? total / n : 0;
}

/**
 * Cached sample spacing for the animation tick.
 *
 * The exported function walks every footpath in the run -- tens of thousands of
 * segments -- and the tick runs at 60 Hz, so calling it there would burn more
 * time measuring the data than animating it. The value cannot change while a run
 * is loaded, so it is computed once per run and invalidated with the data.
 */
let spacingCache = null;

function meanSampleSpacingMetres() {
    if (spacingCache === null) spacingCache = getMeanSampleSpacingMetres();
    return spacingCache;
}

export function isAnimationPlaying() {
    return animationPlaying;
}

/** Where playback currently sits, in iterations, and its upper bound. */
export function getAnimationState() {
    return {
        // Rounded for the scrubber, which is labelled in whole iterations.
        // `progressExact` is the unrounded value for callers that need to know
        // playback is between two samples rather than sitting on one.
        progress: Math.round(animationProgress),
        progressExact: animationProgress,
        max: Math.max(0, maxIterations() - 1),
        playing: animationPlaying,
        samplesPerSecond: currentSpeedSamplesPerSecond,
    };
}

/** Jump to an iteration. Used by the scrubber, which pauses while dragging. */
export function seekTo(iteration) {
    const limit = maxIterations();
    if (!limit) return;
    animationProgress = Math.min(Math.max(0, iteration), limit - 1);
    applyProgress(animationProgress);
}

/** Total iterations across the run, for the scrubber's range. */
export function getIterationLimit() {
    return Math.max(0, maxIterations() - 1);
}

/** Whether this proposal ships trajectory data, for the page to decide its copy. */
export function hasTrajectories() {
    return !!(data && data.agents && data.agents.length);
}

export function getTrajectoryMeta() {
    return data ? data.meta : null;
}

/**
 * How many agents in the loaded run oscillate instead of walking.
 *
 * Exported so the parameter panel can report it: the failure is invisible in
 * speed and step length, so a reader cannot infer it from the numbers already
 * on screen. Returns 0 when no run is loaded.
 */
export function getOscillatingCount() {
    return oscillatingCount();
}

/**
 * Subscribers told when the layer is shown, hidden, or playback advances.
 *
 * The playback controls need to follow state they do not own: the scrubber has to
 * track the animation as it runs, and the panel has to hide the controls when the
 * layer is switched off from elsewhere. Rather than have `main.js` poll, the module
 * pushes changes out.
 */
const listeners = [];

export function onTrajectoryChange(fn) {
    listeners.push(fn);
    return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
    };
}

function emit() {
    const state = { ...getAnimationState(), enabled };
    listeners.forEach((fn) => {
        try {
            fn(state);
        } catch (err) {
            console.warn('[trajectories] listener failed:', err);
        }
    });
}

export async function showTrajectories() {
    const viewer = getViewer();
    if (!viewer) return false;

    const payload = await loadData();
    if (!payload || !payload.agents || !payload.agents.length) {
        enabled = false;
        emit();
        return false;
    }

    // The path lines are the agent's route drawn as a line. They are useful for
    // checking a run -- a grid-like trace is the visible symptom of Kova
    // re-planning every iteration -- but the micro-mobility page is read as
    // people walking, where a lattice of lines over the street obscures the
    // thing being looked at. `showPaths` lets the lines be dropped while the
    // agents themselves stay, which is why it is separate from `enabled`: the
    // layer is on, the route overlay is not.
    if (showPaths) buildPolylines();
    buildDots();
    enabled = true;
    // Figures are built after the dots so that a slow or failed model fetch
    // still leaves a rendered layer behind. Ordering it the other way would
    // mean the layer appears only once the network resolves.
    if (avatarMode === 'figure') await buildAvatars();
    // Start the loop once the figures exist.
    //
    // The walk cycle is driven by the scene clock, and the clock is driven by
    // this tick, so figures stood still until someone pressed play. That reads
    // as a broken model rather than a paused animation: the agents appeared on
    // the street already frozen, with nothing on screen to say a control needed
    // pressing first. Only figures are auto-played; the dot mode is a static
    // overview and is left alone.
    //
    // The run opens part-way in rather than at zero, and the position is set
    // here rather than by the panel because this is the only place that knows
    // both the run's length and the moment the layer becomes visible. Letting
    // the panel seek after this returned meant the reset below and the panel's
    // seek raced, and the run opened at whichever won. The opening samples are
    // agents entering from the edge of the model, which reads as a trickle; by
    // this point the street has filled.
    resolveStartIteration();
    if (avatarMode === 'figure') {
        playAnimation();
    } else {
        // Dot mode has no playback, so nothing would reposition the dots after a
        // seek or a scrub -- they would sit at whatever iteration was last applied
        // and ignore the control. The render listener is started independently of
        // the timer so a static layer still tracks the progress it is given.
        startRenderUpdates();
    }
    emit();
    return true;
}

/**
 * Put the playhead at the page's opening position.
 *
 * Called from `showTrajectories` once the run is loaded, before playback
 * starts. Separated out because the panels do not know the run's length when
 * they are initialised.
 */
function resolveStartIteration() {
    const limit = maxIterations();
    if (!limit) return;
    animationProgress = Math.min(DEFAULT_START_ITERATION, limit - 1);
    applyProgress(animationProgress);
}

/**
 * Show or hide the agent route lines without touching the agents themselves.
 *
 * Kept independent of `showTrajectories`/`hideTrajectories` because the two
 * answer different questions: whether the layer is on at all, and whether the
 * route overlay is drawn on top of it.
 */
export function setPathsVisible(want) {
    showPaths = !!want;
    const viewer = getViewer();
    if (!viewer || !enabled) return;

    if (showPaths) {
        if (!polylinePrimitives.length) buildPolylines();
    } else {
        removePolylinePrimitives();
    }
    emit();
}

/** Whether the route lines are currently drawn. */
export function getPathsVisible() {
    return showPaths;
}

export function hideTrajectories() {
    pauseAnimation();
    const viewer = getViewer();
    if (!viewer) return;
    destroyAvatars();
    removePolylinePrimitives();
    if (dotCollection) {
        viewer.scene.primitives.remove(dotCollection);
        dotCollection = null;
    }
    enabled = false;
    emit();
}

/**
 * Remove every route primitive and clear the list.
 *
 * Each primitive owns its geometry, so they go one at a time. Guarded
 * individually because a primitive can already be detached by the time a
 * rebuild starts, and one failure must not strand the rest.
 */
function removePolylinePrimitives() {
    const viewer = getViewer();
    if (viewer && polylinePrimitives.length) {
        polylinePrimitives.forEach((primitive) => {
            try { viewer.scene.primitives.remove(primitive); } catch (_) { /* already gone */ }
        });
    }
    polylinePrimitives = [];
}

/**
 * Choose between dots and walking figures.
 *
 * Exposed rather than hard-coded because the two readings answer different
 * questions. From above, a dot is the right mark: it shows position without
 * pretending to show a person. At street level the figure is the point of the
 * view. The micro-mobility page therefore asks for figures, and every other
 * page — including the overlap view, which is read from above — keeps dots.
 *
 * Switching modes while the layer is visible rebuilds the figure set, so the
 * change takes effect without leaving the page.
 */
export async function setAvatarMode(mode) {
    const wanted = mode === 'figure' ? 'figure' : 'dot';
    if (wanted === avatarMode) return avatarMode;
    avatarMode = wanted;

    if (!enabled) return avatarMode;

    if (avatarMode === 'dot') {
        destroyAvatars();
        if (dotCollection) dotCollection.show = true;
        applyProgress(animationProgress);
    } else {
        await buildAvatars();
        applyProgress(animationProgress);
    }
    emit();
    return avatarMode;
}

/** Whether the layer is currently drawing dots or figures. */
export function getAvatarMode() {
    return avatarMode;
}

/** Which figure is on screen, for the legend: a model name or 'mannequin'. */
export function getAvatarLabel() {
    if (avatarMode !== 'figure') return null;
    return avatarSet ? avatarSet.label : 'loading';
}

export async function toggleTrajectories(want) {
    if (want) return showTrajectories();
    hideTrajectories();
    return false;
}

export function isTrajectoriesEnabled() {
    return enabled;
}
