/**
 * Smoothing of Kova pedestrian trajectories for display.
 *
 * ## Why this exists
 *
 * The Kova export is a cellular-automaton trace. Measured on the current run,
 * consecutive samples turn by a median of **91.6 degrees** and 71% of steps turn
 * more than 45 degrees. Agents re-plan every iteration, the path revisits exact
 * lattice points, and the mean detour ratio (path length over net displacement) is
 * **9.3** -- an agent walks nine metres to advance one.
 *
 * Drawn literally that reads as figures vibrating in place rather than crossing
 * a street. The paths are not wrong -- they are what the solver produced -- but
 * they are unreadable at the scale the viewer shows them.
 *
 * ## What this does, and what it does not do
 *
 * It applies a centred moving average to each agent's path, which is the
 * "soften and round the direction changes" treatment asked for. Measured across
 * all 75 agents on the real run at window 3:
 *
 * | | raw | smoothed (window 3) |
 * |---|---|---|
 * | median turn per step | 89.8 deg | 27.0 deg |
 * | steps turning > 45 deg | 69 % | 37 % |
 * | sample spacing | 2.498 m | 1.334 m |
 * | mean detour ratio | 9.34 | 4.99 |
 *
 * **This is cosmetic.** Net displacement is unchanged, so smoothing neither
 * creates nor destroys progress: it removes the back-and-forth that inflates path
 * length and leaves the endpoints exactly where they were. The underlying
 * behaviour is still in the data; what changes is how much of it a reader can see.
 * The right panel says so, because a tidy path that silently replaced a jagged one
 * would be a more misleading artifact than the jaggedness.
 *
 * ## Why not smooth in degrees
 *
 * The stored coordinates are WGS84 degrees, and a degree of longitude is 0.61 of
 * a degree of latitude at this latitude. Averaging in degrees would blur
 * east-west movement less than north-south, which would bend a straight path that
 * runs diagonally. The conversion goes to metres, averages, and comes back, so the
 * smoothing is isotropic.
 *
 * ## Cost
 *
 * 24,925 points across 75 agents smooths in **1.9 ms**, measured -- about 0.2 ms
 * per frame even if it ran every frame. It does not run every frame: the result is
 * cached per agent on first use, so it is paid once per load.
 */

/**
 * Window sizes and the trade-off each makes, measured across the current run.
 *
 * | window | median turn | steps >45 deg | detour | sample spacing |
 * |---|---|---|---|---|
 * | 1 (raw) | 89.8 deg | 69 % | 9.34 | 2.498 m |
 * | **3** | **27.0 deg** | **37 %** | **4.99** | **1.334 m** |
 * | 5 | 23.9 deg | 27 % | 3.87 | 1.036 m |
 * | 7 | 15.7 deg | 22 % | 3.33 | 0.892 m |
 *
 * 3 is the current choice: it removes the worst of the lattice doubling-back
 * while leaving enough residual wobble that the movement still reads as people
 * wandering rather than as figures on rails. A larger window smooths further but
 * also shortens the measured sample spacing, which has to be carried into
 * `SAMPLES_PER_SECOND_AT_REAL_TIME` -- see that constant before changing this.
 */
export const SMOOTHING_WINDOW = 3;

/**
 * Spacing of the resampled path, in metres.
 *
 * The renderer interpolates linearly between stored samples, so a figure walks a
 * chain of straight chords and the direction changes sharply at every stored
 * vertex. Smoothing shortens the chords (2.50 m raw to 1.33 m at window 3) but
 * does not remove the corners, which is the remaining visible jerkiness once
 * playback runs at a sane speed.
 *
 * Resampling along a curve replaces the chain of chords with points close enough
 * together that the curve is followed rather than approximated. At 0.25 m a
 * figure at walking pace passes a vertex about five times a second, and each
 * direction change is small enough to read as a curve.
 */
const RESAMPLE_SPACING_METRES = 0.25;

/** Safety valve: an agent's resampled path is never allowed past this length. */
const MAX_RESAMPLED_POINTS = 6000;

const DEGREES_TO_METRES_LAT = 110574;
const DEGREES_TO_METRES_LON = 111320;

/**
 * Cache of smoothed paths, keyed by the agent object.
 *
 * A `WeakMap` so that dropping the loaded trajectory data drops the cache with
 * it, rather than pinning 75 arrays in memory across a proposal switch.
 */
const smoothedCache = new WeakMap();

/**
 * Cache of resampled paths, keyed by the agent object.
 *
 * Separate from `smoothedCache` because the two are wanted in different places:
 * the statistics in `trajectoryVisualization.js` that describe the run -- detection
 * of agents that oscillate -- are about the *recorded* path, and reading them off
 * the resampled one would be measuring the curve rather than the simulation.
 * The scene, by contrast, wants the resampled path.
 */
const resampledCache = new WeakMap();

/** Metres per degree of longitude at the latitude of the Zuidas model. */
function metresPerLonDegree(latitudeDegrees) {
    return DEGREES_TO_METRES_LON * Math.cos((latitudeDegrees * Math.PI) / 180);
}

/**
 * A centred moving average over a sequence of `[x, y]` pairs.
 *
 * Samples within `half` of either end are returned **unchanged**, because a full
 * window does not fit there. The alternatives were tried and both distort:
 *
 *  - Dividing by the shrunk window (only the in-range samples) gives the end
 *    points a different effective weight from the middle ones, which bends a
 *    straight line and moves the endpoints.
 *  - Duplicating the endpoint to fill the window is asymmetric even when
 *    clamped: at `i = 0` with window 5 it averages indices `[0,0,0,1,2]`, which
 *    pulls the first point a fifth of the way toward the second. A straight
 *    diagonal came back with the origin at 0.6.
 *
 * Leaving the ends alone means the smoothing only applies where it is
 * well-defined. The cost is that an agent's first and last few samples keep their
 * lattice jitter; the benefit is that the path's endpoints, and any straight
 * segment running through them, are exactly what the simulation produced.
 *
 * @param {Array<[number, number]>} points
 * @param {number} window Odd number of samples to average. 1 returns a copy.
 * @returns {Array<[number, number]>}
 */
export function movingAverage(points, window) {
    const n = points.length;
    if (window <= 1 || n < 3) return points.map((p) => [p[0], p[1]]);

    // An even window has no centre, so it would bias the average one sample
    // along the path. Rounding up to odd keeps the result symmetric.
    const size = window % 2 === 0 ? window + 1 : window;
    const half = (size - 1) / 2;
    const out = points.map((p) => [p[0], p[1]]);

    for (let i = half; i < n - half; i++) {
        let sx = 0;
        let sy = 0;
        for (let j = i - half; j <= i + half; j++) {
            sx += points[j][0];
            sy += points[j][1];
        }
        out[i] = [sx / size, sy / size];
    }
    return out;
}

/**
 * The smoothed path before resampling, as `[lon, lat]` pairs.
 *
 * Computed once per agent and cached. Returns the raw path when smoothing is
 * disabled, when the agent has too few points for a window to mean anything, or
 * when the coordinates are not finite.
 *
 * @param {object} agent  An agent from `agent_trajectories.json`.
 * @param {number} [window]  Override for the default window; 1 disables.
 */
export function smoothPath(agent, window = SMOOTHING_WINDOW) {
    const enabled = window > 1;
    if (!enabled) return validPoints(agent);

    let entry = smoothedCache.get(agent);
    if (entry && entry.window === window) return entry.points;

    const raw = validPoints(agent);
    const points = raw.length < 3 ? raw : smoothInMetres(raw, window);
    smoothedCache.set(agent, { window, points });
    return points;
}

/** The agent's samples, dropping anything malformed. */
function validPoints(agent) {
    return (agent.footpath || []).filter(
        (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
    );
}

/**
 * Smooth `[lon, lat]` pairs through metres.
 *
 * The average runs on local metres and the result is converted back, so the
 * smoothing weight is the same in both axes. The latitude used for the
 * longitude scale is the path's own mean, which is exact enough over a street
 * and avoids threading a scene reference through this module.
 */
function smoothInMetres(points, window) {
    const meanLat = points.reduce((sum, p) => sum + p[1], 0) / points.length;
    const mLon = metresPerLonDegree(meanLat);

    const metric = points.map((p) => [p[0] * mLon, p[1] * DEGREES_TO_METRES_LAT]);
    const smoothed = movingAverage(metric, window);

    return smoothed.map((p) => [p[0] / mLon, p[1] / DEGREES_TO_METRES_LAT]);
}

/**
 * The displayed path for one agent: smoothed, then resampled along a curve.
 *
 * This is the accessor the rest of the viewer should use, for position, heading
 * and distance travelled alike. Keeping it the single source is what stops the
 * geometry, the facing and the gait from drifting apart.
 *
 * ## A note on the residual jitter
 *
 * Measured on the current Kova run, **15.6% of steps in the smoothed path reverse
 * by more than 90 degrees**, and no amount of averaging removes them -- a
 * reversal spanning several points survives a moving average. Travelling those
 * reversals, a figure turns sharply roughly twice a second.
 *
 * That is a property of the simulation, not of this module. The cellular automaton
 * re-plans every iteration and the trace doubles back on itself; smoothing and
 * resampling make the paths legible but cannot make them straight without
 * inventing a route the agent never took. Rounding the corners was tried and
 * abandoned: it is a workaround for a solver problem, it does not fix the
 * underlying behaviour, and it would have to be undone when the simulation is
 * replaced. See `docs/` for the note on this in the pedestrian-flow section.
 */
export function smoothedPath(agent, window = SMOOTHING_WINDOW) {
    let entry = resampledCache.get(agent);
    if (entry && entry.window === window) return entry.points;

    const smoothed = smoothPath(agent, window);
    const points = smoothed.length < 3 ? smoothed : resampleAlongCurve(smoothed);
    resampledCache.set(agent, { window, points });
    return points;
}

/**
 * Resample a path along a Catmull-Rom curve at a uniform arc-length spacing.
 *
 * ## Why a curve rather than more of the straight chords
 *
 * The renderer interpolates linearly between stored samples, so a figure walks a
 * chain of straight segments and the direction snaps at each stored vertex.
 * Adding more points *along the existing chords* would not help: the points would
 * lie on the same straight lines and the corners would remain. The corners have to
 * be rounded, which means the curve has to pass through the points rather than
 * merely connect them.
 *
 * Catmull-Rom is the right spline here because it **passes through every control
 * point**. These are recorded positions of a real agent, and a curve that only
 * approximates them (a B-spline, say) would pull the path away from where the
 * pedestrian actually was. Catmull-Rom rounds the corners without moving the
 * data.
 *
 * ## Why uniform arc length matters
 *
 * The samples are emitted at a constant **distance** apart rather than a constant
 * parameter step. A parameter-uniform resampling would bunch points together
 * wherever the spline moves slowly and spread them where it moves fast, which
 * would make `getMeanSampleSpacingMetres` report a number that no longer
 * describes the path -- and that number sets the playback speed and the walk
 * cycle. Uniform spacing keeps the contract intact: the resampled path means
 * "positions every `RESAMPLE_SPACING_METRES` along the route".
 *
 * The endpoints are preserved exactly, since the curve is clamped at both ends.
 *
 * @param {Array<[number, number]>} points  Smoothed `[lon, lat]` pairs.
 * @returns {Array<[number, number]>}
 */
function resampleAlongCurve(points) {
    const n = points.length;
    const meanLat = points.reduce((sum, p) => sum + p[1], 0) / n;
    const mLon = metresPerLonDegree(meanLat);
    // Work in metres for the whole construction, so the spacing and the curve are
    // isotropic. Converting back once at the end avoids compounding rounding.
    const m = points.map((p) => [p[0] * mLon, p[1] * DEGREES_TO_METRES_LAT]);

    // Clamped ends: the first and last segments are drawn as straight lines to a
    // repeated endpoint, which keeps the curve anchored on the real first and last
    // recorded positions instead of flinging a control point off toward infinity.
    const at = (i) => m[Math.min(n - 1, Math.max(0, i))];

    // Cumulative arc length along a fine sampling of the spline. The curve is
    // measured, not assumed, because a Catmull-Rom segment's length has no closed
    // form when the control points are unevenly spaced -- which these are.
    const SUBSTEPS = 12;
    const dense = [];
    const cumulative = [0];
    for (let i = 0; i < n - 1; i++) {
        const p0 = at(i - 1);
        const p1 = at(i);
        const p2 = at(i + 1);
        const p3 = at(i + 2);
        for (let s = 0; s < SUBSTEPS; s++) {
            const t = s / SUBSTEPS;
            dense.push(catmullRom(p0, p1, p2, p3, t));
        }
    }
    dense.push(at(n - 1));

    for (let i = 1; i < dense.length; i++) {
        const dx = dense[i][0] - dense[i - 1][0];
        const dy = dense[i][1] - dense[i - 1][1];
        cumulative.push(cumulative[i - 1] + Math.hypot(dx, dy));
    }

    const total = cumulative[cumulative.length - 1];
    if (!(total > 0)) return points.slice();

    // One point per `RESAMPLE_SPACING_METRES`, plus the final endpoint -- which
    // usually lands between two multiples and so has to be appended explicitly,
    // otherwise the path would stop short of where the agent actually ended.
    const count = Math.min(MAX_RESAMPLED_POINTS, Math.max(2, Math.ceil(total / RESAMPLE_SPACING_METRES) + 1));
    const out = new Array(count);
    let cursor = 0;
    for (let k = 0; k < count; k++) {
        const target = (total * k) / (count - 1);
        while (cursor < cumulative.length - 2 && cumulative[cursor + 1] < target) cursor++;
        const segStart = cumulative[cursor];
        const segEnd = cumulative[cursor + 1];
        const span = segEnd - segStart;
        const t = span > 1e-9 ? (target - segStart) / span : 0;
        const a = dense[cursor];
        const b = dense[cursor + 1];
        out[k] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }

    // The last emitted point is forced onto the true endpoint. Rounding through
    // the cumulative table can otherwise leave it a few millimetres short, and the
    // endpoint is the agent's recorded exit position -- worth keeping exact.
    out[count - 1] = [m[n - 1][0], m[n - 1][1]];

    return dedupe(out).map((p) => [p[0] / mLon, p[1] / DEGREES_TO_METRES_LAT]);
}

/**
 * Drop points that sit on top of their predecessor.
 *
 * The arc-length walk can emit two samples at nearly the same place where the
 * curve doubles back within a segment, because the cumulative table has entries
 * closer together than the resampling interval. Measured on the real run, 0.8% of
 * gaps came out under 0.1 m and the smallest was 0.0004 m.
 *
 * Those points are not harmless. The renderer derives each figure's heading from
 * the vector between consecutive points, and `headingBetweenDegrees` treats a
 * degenerate step as due north -- so a near-duplicate point makes a figure snap
 * its facing to north for one frame, which is far more visible than the sub-
 * millimetre correction that caused it.
 *
 * The threshold is a fifth of the resampling interval: large enough to remove any
 * step too short to define a stable direction, small enough that it cannot
 * meaningfully change the path's shape.
 */
function dedupe(points) {
    const minGap = RESAMPLE_SPACING_METRES * 0.2;
    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
        const prev = out[out.length - 1];
        if (Math.hypot(points[i][0] - prev[0], points[i][1] - prev[1]) >= minGap) {
            out.push(points[i]);
        }
    }
    // The endpoint must survive the filter even if the final step is short, or the
    // path would stop short of where the agent left the street.
    const last = points[points.length - 1];
    const tail = out[out.length - 1];
    if (tail[0] !== last[0] || tail[1] !== last[1]) {
        // Replacing an almost-identical predecessor keeps the count stable and
        // avoids leaving a point a fraction of a millimetre from the true end.
        if (out.length > 1 && Math.hypot(last[0] - out[out.length - 2][0], last[1] - out[out.length - 2][1]) < minGap) {
            out[out.length - 1] = last;
        } else {
            out.push(last);
        }
    }
    return out;
}

/**
 * Catmull-Rom interpolation at parameter `t` in [0, 1] between `p1` and `p2`.
 *
 * The `0.5` factor is the standard tension: it makes the curve's tangent at
 * `p1` parallel to the line from `p0` to `p2`, which is what gives Catmull-Rom
 * its smooth, overshoot-limited character. Higher tension flattens the curve
 * toward straight segments; this value is the conventional choice and needs no
 * tuning here because the resampling spacing, not the tension, controls how
 * closely the drawn path follows the curve.
 */
function catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    const out = [0, 0];
    for (let axis = 0; axis < 2; axis++) {
        out[axis] =
            0.5 *
            (2 * p1[axis] +
                (-p0[axis] + p2[axis]) * t +
                (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * t2 +
                (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * t3);
    }
    return out;
}
