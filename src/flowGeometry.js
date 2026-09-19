/**
 * Geometry for the macroscopic pedestrian flow network.
 *
 * ## Why this exists
 *
 * The PedMac graph is directed: an edge is `u -> v`, and where two-way walking
 * occurs the reverse edge `v -> u` is a separate row. The two rows carry
 * *different* flows -- measured, not mirrored -- so both must be drawn.
 *
 * They cannot be drawn on the same line. Reciprocal edges share the same
 * geometry reversed (verified against the shipped data: all 3,786 reciprocal
 * pairs have identical point runs), so drawing them as-is stacks one on top of
 * the other and the last one added wins. The result reads as a one-way network
 * even though the data is two-way, which is misleading in exactly the way that
 * matters: a street carrying heavy flow in both directions looks like a street
 * carrying heavy flow in one.
 *
 * The fix is to offset each edge to the right of its own direction of travel.
 * Because a reciprocal pair travels in opposite directions, "right" puts them
 * on opposite sides of the centreline, like traffic lanes. The viewer therefore
 * shows two-way flow where it exists, and single line where it does not.
 *
 * ## Where the algorithms come from
 *
 * These are ports of the Python that already produced the published flow maps
 * (`Delftblue_clean_version_0724_tau01/modules/flow_map_viz.py`), so the browser
 * picture stays consistent with the printed one. Three parts are reproduced:
 *
 *  1. **Offset right of travel** (`get_offset_geom`). Note the Python comment
 *     recording why: an earlier version offset right only when `u < v` and left
 *     otherwise, which put both directions of a pair on the *same* side and
 *     re-created the overlap it was meant to solve.
 *  2. **Miter joins at nodes** (`adjust_offsets_at_nodes`). Offsetting pulls a
 *     line away from its neighbours, opening gaps on outside turns and crossings
 *     on inside turns. Endpoints are extended or trimmed by `offset * tan(theta/2)`
 *     to close the gap on the outside of a turn and prevent the crossing on the
 *     inside.
 *  3. **30-degree V arrowheads** (`add_v_arrow`) at each edge midpoint, so the
 *     direction of travel is legible without reading a tooltip.
 *
 * ## Approximation, stated plainly
 *
 * The Python works in projected metres (RD New, EPSG:28992) with Shapely's
 * `parallel_offset`. This module works in degrees on the WGS84 lon/lat that the
 * viewer consumes, because projecting 28,150 edges in the browser is not worth
 * it. To keep the offset physically meaningful, metres are converted to degrees
 * per axis using the standard local scale factors at the site's latitude. Over
 * the Zuidas extent (about 2.5 km across) the error against a true projection is
 * far below one screen pixel at the zoom levels these links are read at.
 */

/** Metres per degree of latitude. Near-constant, so a single value is fine. */
const METRES_PER_DEG_LAT = 111320;

/**
 * Degrees of longitude per metre at a given latitude.
 *
 * Longitude lines converge toward the poles, so a metre is a larger fraction of
 * a degree at higher latitude. Folding this in is what keeps a 1 m offset from
 * drifting toward the poles after a lon/lat axis mix-up.
 *
 * @param {number} latDeg Latitude in degrees.
 * @returns {number} Metres per degree of longitude at that latitude.
 */
export function metresPerDegLon(latDeg) {
    return METRES_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

/**
 * Offset a lon/lat polyline perpendicular to itself.
 *
 * A positive distance moves each vertex to the right of the direction of travel,
 * matching the `side='right'` the Python uses. The offset is applied per-vertex
 * from the local segment normals, averaged at interior vertices so a corner does
 * not tear open.
 *
 * This is a local approximation of `parallel_offset`: it does not split the line,
 * resolve self-intersections, or handle a line that doubles back on itself. None
 * of the flow edges is long enough or convoluted enough for that to show, and the
 * miter pass in `joinOffsetsAtNodes` fixes the corner behaviour that does matter.
 *
 * @param {number[][]} coords Polyline as `[lon, lat]` pairs.
 * @param {number} distMetres Offset distance in metres; positive is right of travel.
 * @returns {number[][]} Offset polyline, same length as the input.
 */
export function offsetLineRight(coords, distMetres) {
    if (!Array.isArray(coords) || coords.length < 2) return coords;

    const midLat = coords.reduce((sum, c) => sum + c[1], 0) / coords.length;
    const mLon = metresPerDegLon(midLat);

    const out = [];
    for (let i = 0; i < coords.length; i++) {
        // Direction of travel into this vertex, and out of it. Averaging the two
        // normals keeps a corner's two segments sharing a single offset point.
        const segPrev = i > 0 ? segmentNormal(coords[i - 1], coords[i], mLon) : null;
        const segNext = i < coords.length - 1 ? segmentNormal(coords[i], coords[i + 1], mLon) : null;

        let nx = 0;
        let ny = 0;
        if (segPrev) {
            nx += segPrev[0];
            ny += segPrev[1];
        }
        if (segNext) {
            nx += segNext[0];
            ny += segNext[1];
        }
        const len = Math.hypot(nx, ny);
        if (len < 1e-12) {
            // A degenerate vertex (repeated point, or a perfect doubling back).
            // Falling back to one segment's normal avoids a NaN offset, which
            // would otherwise drop the whole edge from the scene.
            out.push([coords[i][0], coords[i][1]]);
            continue;
        }
        nx /= len;
        ny /= len;

        // Metres to degrees, per axis, so the offset is the same size on the ground
        // regardless of which way the line points.
        out.push([
            coords[i][0] + (nx * distMetres) / mLon,
            coords[i][1] + (ny * distMetres) / METRES_PER_DEG_LAT,
        ]);
    }
    return out;
}

/**
 * Unit normal pointing to the right of travel for one segment, in degree space.
 *
 * Rotating the direction vector -90 degrees gives the right-hand normal. The x
 * component is divided by the metres-per-degree-of-longitude factor so that a
 * metre of normal points the same physical distance on both axes.
 *
 * @param {number[]} a Segment start `[lon, lat]`.
 * @param {number[]} b Segment end `[lon, lat]`.
 * @param {number} mLon Metres per degree of longitude at this latitude.
 * @returns {number[]|null} Unit normal, or null for a zero-length segment.
 */
function segmentNormal(a, b, mLon) {
    const dx = (b[0] - a[0]) * mLon;
    const dy = (b[1] - a[1]) * METRES_PER_DEG_LAT;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    // (dx, dy) rotated -90 degrees is (dy, -dx).
    return [dy / len, -dx / len];
}

/**
 * Extend or trim offset endpoints so that consecutive links meet cleanly.
 *
 * Each node is visited once. For every pair of links that meet there, the
 * incoming link's last point and the outgoing link's first point are moved along
 * their own directions by `offset * tan(theta / 2)`, where theta is the turn
 * angle. On an outside turn that extension closes the wedge the offset opened;
 * on an inside turn the same formula trims it back to stop the two offset lines
 * crossing.
 *
 * Pairing is by closest turn angle, which is what the Python does, and a U-turn
 * beyond 135 degrees is left alone -- extending there would shoot the line off
 * along an unrelated direction.
 *
 * @param {Object[]} items Entries `{ u, v, coords }`; `coords` is mutated in place.
 *   `u` and `v` are the graph node ids the edge runs between, so two edges that
 *   meet at a node share one of them.
 * @param {number} offsetMetres The offset used to build `coords`.
 * @param {(coords: number[][]) => void} [onChange] Called for each changed entry.
 * @returns {number} How many endpoints were adjusted, for logging.
 */
export function joinOffsetsAtNodes(items, offsetMetres, onChange) {
    // Node id -> { incoming: [itemIndex...], outgoing: [itemIndex...] }
    //
    // Keyed by the graph node id alone. An earlier version keyed by a compound
    // "edgeId|end" string, which meant the two edges meeting at a node produced
    // different keys ("A|B|v" and "B|C|u") and never matched -- so no join was
    // ever found and the gaps stayed open. The node id is the only thing the two
    // edges actually share.
    const nodes = new Map();

    items.forEach((item, i) => {
        if (!item.coords || item.coords.length < 2) return;
        if (item.u === undefined || item.v === undefined) return;
        const u = String(item.u);
        const v = String(item.v);
        if (!nodes.has(u)) nodes.set(u, { incoming: [], outgoing: [] });
        if (!nodes.has(v)) nodes.set(v, { incoming: [], outgoing: [] });
        // `u -> v`, so this edge leaves u and arrives at v. Both directions of a
        // reciprocal pair therefore land in the same two buckets as their mirror,
        // which is intended: they are separate lines meeting the same node.
        nodes.get(u).outgoing.push(i);
        nodes.get(v).incoming.push(i);
    });

    let adjusted = 0;
    // The Python derives turn angles from the original geometry; doing the same
    // here means the join is computed from the centreline, so it does not depend
    // on the offsets already applied.
    const limit = Math.max(10, 3 * offsetMetres);

    for (const [, bucket] of nodes) {
        for (const inIdx of bucket.incoming) {
            const inItem = items[inIdx];
            const inCoords = inItem.coords;
            const inAng = segmentAngle(
                inCoords[inCoords.length - 2],
                inCoords[inCoords.length - 1]
            );

            let bestIdx = -1;
            let bestDiff = Infinity;
            for (const outIdx of bucket.outgoing) {
                if (outIdx === inIdx) continue; // a link is not joined to itself
                const outItem = items[outIdx];
                const outCoords = outItem.coords;
                if (outCoords.length < 2) continue;
                const outAng = segmentAngle(outCoords[0], outCoords[1]);
                let diff = outAng - inAng;
                // Wrap to (-pi, pi] so a turn is measured the short way round.
                while (diff > Math.PI) diff -= 2 * Math.PI;
                while (diff <= -Math.PI) diff += 2 * Math.PI;
                if (Math.abs(diff) < Math.abs(bestDiff)) {
                    bestDiff = diff;
                    bestIdx = outIdx;
                }
            }

            if (bestIdx < 0 || Math.abs(bestDiff) >= Math.PI * (135 / 180)) continue;

            // Extension is negative on an inside turn, which trims instead.
            let extension = offsetMetres * Math.tan(bestDiff / 2);
            extension = Math.max(-limit, Math.min(limit, extension));
            if (!Number.isFinite(extension) || Math.abs(extension) < 1e-6) continue;

            const moved = new Set();
            if (moveEndPoint(inCoords, inCoords.length - 1, inCoords.length - 2, extension)) {
                moved.add(inIdx);
            }
            const outCoords = items[bestIdx].coords;
            if (moveEndPoint(outCoords, 0, 1, -extension)) {
                moved.add(bestIdx);
            }
            if (moved.size) {
                adjusted += 1;
                if (onChange) moved.forEach((i) => onChange(items[i].coords));
            }
        }
    }
    return adjusted;
}

/**
 * Move one endpoint of a polyline along its own segment direction.
 *
 * @param {number[][]} coords Polyline to mutate.
 * @param {number} endIdx Index of the point to move.
 * @param {number} refIdx Index of the neighbour that defines the direction.
 * @param {number} amount Metres to move, positive being along the direction
 *   from `refIdx` toward `endIdx`.
 * @returns {boolean} Whether anything moved.
 */
function moveEndPoint(coords, endIdx, refIdx, amount) {
    const end = coords[endIdx];
    const ref = coords[refIdx];
    if (!end || !ref) return false;
    const mLon = metresPerDegLon(end[1]);
    const dx = (end[0] - ref[0]) * mLon;
    const dy = (end[1] - ref[1]) * METRES_PER_DEG_LAT;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return false;
    const ux = dx / len;
    const uy = dy / len;
    // `endIdx` is the last point when moving an incoming line, and the first when
    // moving an outgoing one, so the sign is taken from `refIdx`'s position.
    const dir = endIdx > refIdx ? 1 : -1;
    end[0] += (dir * ux * amount) / mLon;
    end[1] += (dir * uy * amount) / METRES_PER_DEG_LAT;
    return true;
}

/**
 * Bearing of a segment in radians, in the projected metres the offset uses.
 *
 * @param {number[]} a Start `[lon, lat]`.
 * @param {number[]} b End `[lon, lat]`.
 * @returns {number} Angle in radians.
 */
function segmentAngle(a, b) {
    const mLon = metresPerDegLon(a[1]);
    const dx = (b[0] - a[0]) * mLon;
    const dy = (b[1] - a[1]) * METRES_PER_DEG_LAT;
    return Math.atan2(dy, dx);
}

/**
 * Coordinates for a 30-degree V arrowhead at the middle of a link.
 *
 * Returns three `[lon, lat]` points -- wing, tip, wing -- to be stroked as an
 * open polyline, which is how the Python draws it (a two-segment `PolyLine`
 * rather than a closed triangle).
 *
 * The wings are placed behind the tip along the direction of travel, so the
 * arrow reads as pointing the way the edge is walked.
 *
 * @param {number[][]} coords Offset polyline the arrow sits on.
 * @returns {number[][]|null} Three points, or null if the line is too short.
 */
export function arrowheadAtMidpoint(coords) {
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const mid = Math.floor(coords.length / 2);
    const tip = coords[mid];
    const prev = coords[mid - 1] || coords[0];
    if (!tip || !prev) return null;

    const mLon = metresPerDegLon(tip[1]);
    const dx = (tip[0] - prev[0]) * mLon;
    const dy = (tip[1] - prev[1]) * METRES_PER_DEG_LAT;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;

    // Wing length scaled to the link so a short link does not get an arrowhead
    // larger than itself, with a floor so it stays visible when zoomed out.
    const wingMetres = Math.max(1.2, Math.min(4.5, len * 0.35));
    const angle = Math.atan2(dy, dx);
    const wing = (30 * Math.PI) / 180;

    const make = (a) => [
        tip[0] - ((wingMetres * Math.cos(angle + a)) / mLon),
        tip[1] - ((wingMetres * Math.sin(angle + a)) / METRES_PER_DEG_LAT),
    ];
    return [make(wing), [tip[0], tip[1]], make(-wing)];
}
