/**
 * Walking avatars for the Kova pedestrian trajectories.
 *
 * The trajectory layer can draw agents as dots, which is honest but reads as a
 * particle system: a viewer sees blobs moving and has to be told they are
 * people. At street level that is the difference between a page showing
 * "pedestrian movement" and one showing pedestrians, so this module puts a
 * figure on each agent and swings its limbs.
 *
 * ## Two sources, one interface
 *
 * A figure is either a **rigged GLB** fetched at runtime, or a **procedural
 * mannequin** built from primitives. Both are presented to
 * `trajectoryVisualization.js` behind the same calls, so that module never
 * branches on which one is in use.
 *
 * The fallback ordering is deliberate and is the opposite of what reads
 * tidiest. A fetched model looks better and needs no geometry code, but it can
 * fail for reasons outside this application's control: a CDN can rate-limit,
 * move or rewrite a file, and a locked-down network can block it outright. The
 * mannequin has none of those failure modes, so it is what the page degrades
 * to and what a deployed build is guaranteed to have. The GLB is an upgrade,
 * never a requirement.
 *
 * ## Why the walk cycle is driven by distance, not by the clock
 *
 * A cycle that advances on wall-clock time looks wrong the moment the playback
 * speed changes: run the trajectory faster and the legs keep their own tempo,
 * so the agent moonwalks. The phase here advances by **distance travelled**,
 * so stride length stays constant in world units and a slower agent takes
 * slower steps. Cesium exposes `ModelAnimation.AnimationTimeCallback` for the
 * same reason on the rigged path.
 *
 * ## What is honest about this
 *
 * - The limb swing is **procedural, not captured**. It is a travelling sine
 *   wave, not a gait study. It reads as walking; it does not model walking.
 * - Heading is derived from the **direction of travel between two samples**
 *   rather than from Kova's `heading` field. A cellular-automaton step is
 *   coarse enough that the derived direction is the steadier of the two at
 *   these speeds.
 * - Agent **height** from the export scales the figure, so the field is visible
 *   rather than decorative.
 */

import { getViewer } from './cesiumViewer.js';

const Cesium = globalThis.Cesium;

/* -------------------------------------------------------------------------- *
 * Rigged model
 * -------------------------------------------------------------------------- */

/**
 * Vendored rigged character, tried in order.
 *
 * Quaternius "Universal Animation Library" (UAL), CC0, obtained via the
 * standard pack download. This replaced the earlier "Ultimate Modular Women
 * Pack" characters, which had to be abandoned for a reason worth recording.
 *
 * That older pack was converted from FBX and carried its unit conversion as a
 * `scale: 100` on `CharacterArmature` rather than in its geometry: the mesh was
 * authored a person being 0.0185 tall, with the armature lifting it to 1.85 m.
 * It also had four skins over 62 joints each. Cesium rendered it about a hundred
 * times too large, and its reported `boundingSphere` disagreed with the drawn
 * result, so the fault was invisible to every inspection that did not actually
 * look at the screen. Attempts to bake the node scale into the vertices tore the
 * skin apart instead, because the joints and the mesh were expressed in the same
 * small space and moving only one side of that relationship stretches the limbs.
 *
 * This file has none of that. It is a native glTF 2.0 export from Blender, not a
 * conversion, and it measures clean on every count:
 *
 *   - 1.829 m tall, Y-up, feet at y ~= 0
 *   - zero nodes with a non-unit scale
 *   - one skin, one mesh, 65 joints
 *   - inverse bind matrices with real metre-scale translations (0 to 1.74 m)
 *     and unit joint scales
 *
 * `Walk_Loop` is the clip, 1.33 s over 195 channels spanning all 65 joints. The
 * other 42 clips (Idle, Jog, combat, emotes) are removed by
 * `tools/prune_glb_animations.py`, because `ModelGraphics.runAnimations` is a
 * boolean that plays every animation at once and cannot select by name.
 *
 * The pack ships two files; the `_RM` one bakes root motion into every clip. The
 * non-RM file is used, because agents are positioned from the Kova trajectory
 * data and baked root motion would fight that.
 */
export const AVATAR_MODEL_CANDIDATES = [
    { url: './models/avatars/walker.glb', label: 'Quaternius UAL', kind: 'ual' },
];

/**
 * Tint per agent type, so a crowd reads as several kinds of person.
 *
 * `ModelGraphics.color` blends against the model's own texture, so the tint is
 * applied with `MIX` at partial strength: a full replacement flattens the figure
 * into an unshaded silhouette.
 */
const AVATAR_TINTS = [
    [1.0, 0.85, 0.45],
    [0.55, 0.8, 1.0],
    [0.65, 0.92, 0.6],
    [1.0, 0.62, 0.55],
    [0.85, 0.7, 1.0],
    [0.5, 0.9, 0.9],
];

/**
 * One colour channel as a 0-255 byte, accepting either 0-1 or 0-255 input.
 *
 * Exists because this module is handed tint triples from two different palettes
 * in two different units -- its own `AVATAR_TINTS` in floats, the trajectory
 * module's `AGENT_COLORS` in bytes -- and a single scaling by 255 cannot serve
 * both. Anything at or below 1 is read as a fraction; anything above as a byte
 * already. The ambiguity is harmless because no real channel is between 1 and 2.
 */
function clampByte(channel) {
    const value = channel <= 1 ? channel * 255 : channel;
    return Math.max(0, Math.min(255, Math.round(value)));
}

let modelProbe = null;
let probeOutcome = null;

/**
 * Find a usable rigged model, once per session.
 *
 * The negative result is cached as deliberately as the positive one: without
 * it, every entry to the micro-mobility page would repeat a slow, blocking,
 * ultimately futile fetch. The promise itself is the cache, so concurrent
 * callers share one attempt instead of racing into several.
 */
function probeRiggedModel() {
    if (modelProbe) return modelProbe;

    modelProbe = (async () => {
        if (!Cesium || !Cesium.Model || !Cesium.Model.fromGltfAsync) return null;

        const usable = [];
        for (const candidate of AVATAR_MODEL_CANDIDATES) {
            // Verified by fetching the bytes, NOT by `Cesium.Model.fromGltfAsync`.
            //
            // That API never reaches `readyEvent` in this viewer: measured here,
            // it stalls at `ready: false` with no error for the models below, for
            // the project's own `building_block1.glb`, and even for Cesium's own
            // sample CesiumMan. It is used nowhere else in this codebase, and
            // every model that does load -- the Zuidas massing, the sunlight mesh
            // -- goes through `viewer.entities.add({ model: { uri } })` instead.
            //
            // So the probe confirms the file is served and is a glTF container,
            // and leaves the loading to the Entity API, which demonstrably works.
            try {
                const response = await fetch(candidate.url);
                if (!response.ok) {
                    console.info(
                        `[avatar] ${candidate.label} not served (${response.status}); skipping`
                    );
                    continue;
                }
                const bytes = await response.arrayBuffer();
                const magic = new DataView(bytes).getUint32(0, true);
                if (magic !== 0x46546c67) {
                    console.info(`[avatar] ${candidate.label} is not a GLB; skipping`);
                    continue;
                }

                console.info(
                    `[avatar] ${candidate.label} ready: ${(bytes.byteLength / 1024).toFixed(0)} kB`
                );
                usable.push({
                    url: candidate.url,
                    label: candidate.label,
                    kind: candidate.kind,
                    animationName: 'Walk_Loop',
                    // Read from the file rather than assumed. The phase offset
                    // wraps on a whole clip, so a wrong duration would leave
                    // figures starting mid-stride from an arbitrary point rather
                    // than at the cycle boundary the wrap depends on.
                    clipSeconds: readClipSeconds(bytes),
                });
            } catch (err) {
                console.info(
                    `[avatar] ${candidate.label} unavailable, trying next:`,
                    err?.message || err
                );
            }
        }

        if (!usable.length) {
            console.info('[avatar] no rigged model reachable; using the procedural mannequin');
            probeOutcome = null;
            return null;
        }

        probeOutcome = {
            url: usable[0].url,
            label: usable[0].label,
            animationName: usable[0].animationName,
            clipSeconds: usable[0].clipSeconds,
            variants: usable,
        };        console.info(
            `[avatar] ${usable.length} rigged character(s) available; ` +
            `agent type maps to index within that set`
        );
        return probeOutcome;
    })();

    return modelProbe;
}

/** Which figure is in use, for the legend to state it. Null until probed. */
export function avatarSource() {
    return probeOutcome;
}

/* -------------------------------------------------------------------------- *
 * Procedural mannequin
 * -------------------------------------------------------------------------- */

/**
 * Body proportions, as fractions of total height.
 *
 * The only tuning values in the figure, kept together so the build can be
 * adjusted without hunting through the pose maths.
 */
const PROPORTIONS = {
    headY: 0.905,
    headDiameter: 0.155,
    shoulderY: 0.815,
    hipY: 0.52,
    armLength: 0.36,
    legLength: 0.52,
    shoulderHalfWidth: 0.09,
    hipHalfWidth: 0.055,
    torsoDiameter: 0.20,
    limbDiameter: 0.075,
};

/**
 * Colours are built lazily rather than at module load.
 *
 * Referencing `Cesium.Color` at import time would throw wherever the Cesium
 * script has not loaded yet, turning a missing CDN into a module-load failure
 * for the whole viewer instead of a single missing layer.
 */
function torsoColor(tint) {
    // The agent's own colour, so a mannequin matches its trajectory the same way
    // the rigged figures do. This was previously a fixed grey, which meant the
    // fallback crowd had no per-agent colour at all and could not be tied to a
    // path.
    if (tint) return Cesium.Color.fromBytes(tint[0], tint[1], tint[2], 255);
    return Cesium.Color.fromBytes(226, 229, 234, 255);
}
function headColor() {
    return Cesium.Color.fromBytes(206, 180, 158, 255);
}
function limbColor() {
    return Cesium.Color.fromBytes(138, 145, 158, 255);
}

/**
 * Screen-space scaling.
 *
 * A figure drawn at fixed pixel size is either invisible from across the square
 * or a blob from close up. These bounds keep it between "a person" and "a
 * marker" across the range of camera distances the page actually uses.
 */
export const PIXEL_SIZE = {
    min: 3.0,
    /**
     * Raised from 14 after measuring against the real cameras this page uses.
     *
     * The street view sits 4.2 m from an agent, where a 1.72 m figure subtends
     * a large part of the screen. A 14 px ceiling forced the head, torso and
     * limbs to the same size over the whole street-level range, which is
     * exactly the distance the page is now read from. 42 lets a head reach
     * ~2.5x a limb at 4 m, and still falls back to the floor by about 120 m,
     * where a figure should be a speck.
     */
    max: 42.0,
    /**
     * Pixels per metre of part thickness at the reference distance.
     *
     * Kept at the original 5.5. Raising it was the first thing tried and it was
     * wrong: with a higher coefficient every part sat on the ceiling instead of
     * the floor, which is the same failure with the opposite sign. The ratio
     * between parts is what makes a figure legible, and that ratio is fixed by
     * the geometry, so the ceiling was the thing to move.
     */
    perMetre: 5.5,
    referenceMetres: 60,
};

/** Metres of travel per complete walk cycle (two steps). */
const STRIDE_METRES = 1.35;

/**
 * Build one mannequin as billboarded points.
 *
 * Points rather than extruded meshes because 75 skinned or even 75 simple
 * meshes is real cost, and at the distances this page is read from a
 * billboarded figure reads as well as geometry does. The cost of that choice is
 * that the figure is flat: it rotates to face the camera, so it cannot show a
 * side profile. At 1.5–4 m height in a street view that is not visible, and
 * pretending otherwise would mean paying for geometry nobody can resolve.
 *
 * Positions are computed in a local **east-north-up frame in metres with feet
 * at z=0**, then converted once per frame per agent. Doing the pose in metres
 * keeps the walk cycle a pure function of distance, independent of latitude.
 */
function createMannequin(height, collection, phaseMetres = 0, tint = null) {
    const mk = (colour) =>
        collection.add({
            position: Cesium.Cartesian3.ZERO,
            pixelSize: 6,
            color: colour,
            outlineColor: Cesium.Color.fromBytes(20, 22, 26, 160),
            outlineWidth: 1,
        });

    const body = {
        head: mk(headColor()),
        torso: mk(torsoColor(tint)),
        armL: mk(limbColor()),
        armR: mk(limbColor()),
        legL: mk(limbColor()),
        legR: mk(limbColor()),
    };

    return {
        collection,
        /**
         * Pose and place the figure.
         *
         * @param {Cesium.Cartesian3} base   feet position, world space
         * @param {number} headingRad        direction of travel, clockwise from north
         * @param {number} distanceMetres    total distance travelled, drives the cycle
         * @param {number} pixelScale        multiplier from camera distance
         * @param {Cesium.Matrix4} enu       east-north-up frame at `base`
         */
        pose(base, headingRad, distanceMetres, pixelScale, enu) {
            const p = PROPORTIONS;
            const h = height;
            // Fractional part of the cycle, so the phase never grows unbounded.
            //
            // `phaseMetres` offsets each figure within the cycle. Without it every
            // mannequin swings its limbs in unison, which reads as a drilled
            // formation rather than a crowd. The offset is in metres travelled
            // because that is what the cycle is parameterised by, so a figure
            // given half a stride starts with the opposite leg forward.
            const phase = ((distanceMetres + phaseMetres) / STRIDE_METRES) % 1;
            const swing = Math.sin(phase * Math.PI * 2);

            // Local (east, north, up) offsets, in metres, with feet at up=0.
            // Forward is +north before heading is applied; rotating the local
            // frame by the heading puts "forward" along the direction of travel.
            const armForward = swing * 0.5 * p.armLength * h;
            const legForward = swing * 0.5 * p.legLength * h;

            const local = [
                // head
                [body.head, 0, 0, p.headY * h, p.headDiameter * h],
                // torso, centred between shoulders and hips
                [body.torso, 0, 0, ((p.shoulderY + p.hipY) / 2) * h, p.torsoDiameter * h],
                // arms swing opposite the leg on the same side
                [body.armL, p.shoulderHalfWidth * h, -armForward, (p.shoulderY - p.armLength / 2) * h, p.limbDiameter * h],
                [body.armR, -p.shoulderHalfWidth * h, armForward, (p.shoulderY - p.armLength / 2) * h, p.limbDiameter * h],
                // legs
                [body.legL, p.hipHalfWidth * h, legForward, (p.legLength / 2) * h, p.limbDiameter * h],
                [body.legR, -p.hipHalfWidth * h, -legForward, (p.legLength / 2) * h, p.limbDiameter * h],
            ];

            // Heading turns the local east/north axes. A compass heading is
            // clockwise from north, so forward = (sin, cos) in (east, north).
            const cos = Math.cos(headingRad);
            const sin = Math.sin(headingRad);

            local.forEach(([prim, east, north, up, thickness], i) => {
                // Rotate the local horizontal offset into the world frame.
                // `north` here is "forward", which the rotation maps onto the
                // heading direction; `east` is the agent's right.
                const fwd = north;
                const right = east;
                const worldEast = right * cos + fwd * sin;
                const worldNorth = -right * sin + fwd * cos;

                const offset = new Cesium.Cartesian3(worldEast, worldNorth, up);
                const out = new Cesium.Cartesian3();
                Cesium.Matrix4.multiplyByPoint(enu, offset, out);
                prim.position = out;

                prim.pixelSize = Math.min(
                    PIXEL_SIZE.max,
                    Math.max(PIXEL_SIZE.min, thickness * pixelScale)
                );
            });
        },
    };
}

/* -------------------------------------------------------------------------- *
 * Public interface
 * -------------------------------------------------------------------------- */

/**
 * The duration of a GLB's first animation, in seconds.
 *
 * Read straight out of the container: a GLB is a header followed by chunked
 * sections, the first of which is the glTF JSON. Each animation sampler points at
 * a time accessor whose `max` is that sampler's duration, so the clip length is
 * the largest `max` across the samplers. Measured 1.333 s for the vendored UAL
 * walk cycle, which matches the 1.3 s a real gait cycle takes.
 *
 * Returns `null` rather than a guess when anything is missing, so a caller can
 * choose to skip the phase offset instead of wrapping on a made-up number.
 */
function readClipSeconds(bytes) {
    try {
        const view = new DataView(bytes);
        if (view.getUint32(0, true) !== 0x46546c67) return null;

        // Walk the chunks to find the JSON one (type 0x4E4F534A, "JSON").
        let offset = 12;
        let json = null;
        while (offset + 8 <= bytes.byteLength) {
            const length = view.getUint32(offset, true);
            const type = view.getUint32(offset + 4, true);
            if (type === 0x4e4f534a) {
                const slice = new Uint8Array(bytes, offset + 8, length);
                json = JSON.parse(new TextDecoder().decode(slice));
                break;
            }
            offset += 8 + length;
        }
        if (!json || !json.animations || !json.animations.length) return null;

        let longest = 0;
        for (const animation of json.animations) {
            for (const sampler of animation.samplers || []) {
                const accessor = json.accessors && json.accessors[sampler.input];
                const max = accessor && accessor.max;
                if (max && max.length && Number.isFinite(max[0])) {
                    longest = Math.max(longest, max[0]);
                }
            }
        }
        return longest > 0 ? longest : null;
    } catch (err) {
        console.info('[avatar] could not read the clip duration:', err?.message || err);
        return null;
    }
}

/**
 * A small deterministic random generator.
 *
 * `Math.random()` would be simpler and is wrong here: the crowd is rebuilt
 * whenever the layer or the page is entered, so an unseeded stream gives every
 * figure a different height and gait phase on each visit. A viewer who steps away
 * and returns would find a visibly different crowd in the same place, which reads
 * as the scene being unreliable rather than as variety.
 *
 * This is the `mulberry32` generator -- small, fast, and good enough for
 * jittering a height by a few percent. It is not suitable for anything where
 * unpredictability matters, which is worth stating so it is not reused for that.
 */
function makeSeededRandom(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Start a figure's walk cycle part-way through, so a crowd is not in lockstep.
 *
 * ## What does not work, and why
 *
 * Cesium derives a clip's pose from the scene time. There is no supported way to
 * set a per-animation time directly: `ModelAnimation.animationTime` is a
 * read-only getter, and the `startTime` / `multiplier` documented on that class do
 * not exist on the animation objects Cesium's **Entity** API actually builds.
 *
 * That last point is the trap, and it is worth recording. Reading
 * `animation.startTime` returns `undefined`, and *assigning* to it succeeds
 * silently while changing nothing -- so a phase offset written that way looks
 * correct in code review and does nothing at runtime. The real timing lives in
 * private fields (`_computedStartTime`, `_multiplier`, `_animationTime`), and the
 * animation objects are not reachable from `entity.model` at all: the Entity API
 * builds its own `Model` primitive and holds it in `scene.primitives`, one per
 * figure, each carrying exactly one active animation.
 *
 * ## What this does instead
 *
 * Each figure's model primitive is located in the scene and its
 * `_computedStartTime` is moved back by the figure's phase. That is the field the
 * animation's own `animate()` reads to derive the clip position, and unlike
 * `startTime` it accepts a write and keeps it -- verified holding for several
 * seconds of running render loop rather than being recomputed each frame.
 *
 * A private field is a real dependency on Cesium's internals, so every step is
 * guarded: if the primitive is not found, or the field is absent, or its shape
 * changes in a future release, this quietly leaves the crowd in lockstep rather
 * than touching anything else. The walk cycle keeps working; only the variety is
 * lost. `_animationTime` is deliberately not touched -- an earlier attempt to
 * write it stopped the render loop outright.
 *
 * ## Why the gait is not set here
 *
 * A walk cycle has to advance at the rate the figure covers ground, or its feet
 * slide. `_multiplier` looks like the obvious lever for that and it does accept
 * a write, but the gait is **not** driven from this file, and adding a second
 * mechanism here caused exactly the sliding it was meant to cure.
 *
 * The clip is advanced by the scene clock, and `setAnimationSpeed` in
 * `trajectoryVisualization.js` already sets `viewer.clock.multiplier` from the
 * run's mean sample spacing. Two writers then disagreed every frame: the clock
 * used a run-wide average, while a per-frame `_multiplier` write used the step
 * the agent happened to be on. Since the simulation's steps vary in length, that
 * per-frame value jumped, and the clip rate was re-stomped before it could hold
 * a cadence -- which reads as sliding rather than as walking.
 *
 * So the phase offset below is the only thing this file sets. Gait rate belongs
 * to the clock, in one place, driven by one number.
 */
function applyPhaseOffset(viewer, entity, phaseSeconds, modelIndex) {
    if (!(phaseSeconds > 0)) return;

    let frameHandle = null;
    let preRenderHandle = null;

    const detach = () => {
        if (frameHandle) {
            window.cancelAnimationFrame(frameHandle);
            frameHandle = null;
        }
        if (preRenderHandle) {
            preRenderHandle();
            preRenderHandle = null;
        }
    };

    // The primitive is created on the frame after the entity is added, so the
    // lookup has to wait for a render. One frame is enough and a poll is not
    // needed; `preRender` fires after the Entity API has built its primitives.
    let attempts = 0;
    const maxAttempts = 240; // ~4 s at 60 fps, then give up quietly

    const attach = () => {
        if (viewer.isDestroyed() || !entity.isShowing) return detach();

        const animations = findActiveAnimations(viewer, modelIndex);
        if (animations) {
            for (let i = 0; i < animations.length; i++) {
                const animation = animations.get(i);
                // Read the current value and shift it, rather than assigning an
                // absolute time: Cesium sets this from the model's own load time,
                // and overwriting it with `now` would snap every figure to the
                // same instant on the first frame.
                if (!animation || !animation._computedStartTime) continue;
                animation._computedStartTime = Cesium.JulianDate.addSeconds(
                    animation._computedStartTime,
                    -phaseSeconds,
                    new Cesium.JulianDate()
                );
            }
            return detach();
        }

        // Keep waiting, but not forever: a model that never appears -- a failed
        // fetch, a layer switched away -- must not leave a listener running for
        // the life of the page.
        if (++attempts > maxAttempts) return detach();
        frameHandle = window.requestAnimationFrame(attach);
    };

    // Hook the render loop rather than a timer: the primitives are built during
    // Cesium's own update pass, so a `setTimeout` can fire before or after it
    // without any guarantee, while `preRender` is ordered against it.
    preRenderHandle = viewer.scene.preRender.addEventListener(attach);
    entity.__phaseCleanup = detach;
}

/**
 * The active animations on the model primitive that belongs to an agent.
 *
 * The Entity API gives each figure its own `Model` primitive in
 * `scene.primitives`, and the primitives carry no reference back to the entity --
 * `primitive.entity` is undefined and the id is an opaque object, not the
 * entity's name. The only stable correspondence is the order in which they were
 * added, which is the order the figures were created in, so the primitive is
 * taken by its position among the *animated* model primitives.
 *
 * Filtering to animated primitives is what makes the index correct, and it is not
 * the same as filtering to model primitives: the scene also holds the Zuidas
 * massing and the sunlight mesh, which are `Model` primitives with an
 * `activeAnimations` collection that is present but **empty**. Those sit ahead of
 * the crowd in the list, so counting them would offset every lookup by two --
 * figures would take each other's phases, and the last two would quietly get
 * none. The crowd is the only thing in the scene with loaded clips.
 *
 * Returns the animation collection, or `null` if it is not there yet.
 */
function findActiveAnimations(viewer, modelIndex) {
    const primitives = viewer.scene.primitives;
    const animated = [];
    for (let i = 0; i < primitives.length; i++) {
        const primitive = primitives.get(i);
        if (primitive && primitive.activeAnimations && primitive.activeAnimations.length) {
            animated.push(primitive);
        }
    }

    // Guard against stale primitives, which would shift every index.
    //
    // `modelIndex` is a position in this list, so the list has to contain
    // exactly one entry per figure and nothing else. Cesium reaps an entity's
    // model primitive on a later update pass than the frame that removed the
    // entity, so a rebuild that happens quickly -- re-entering the page, or
    // toggling the layer -- can add its new figures while the old primitives are
    // still in `scene.primitives`. Measured during development, the count grew
    // from 75 to 150 to 225 across repeated rebuilds.
    //
    // With extra entries present the indices no longer line up: a figure would
    // take the gait rate meant for a different agent, and the last few would get
    // none. Rather than index blindly, refuse to answer when the list is the
    // wrong size. The caller treats that as "not ready yet" and skips this frame,
    // which is invisible for the one or two frames it lasts and is far better
    // than writing another figure's speed onto this one.
    if (animated.length !== viewer.entities.values.filter(
        (e) => e.model && /agent-avatar/.test(String(e.name || ''))
    ).length) {
        return null;
    }

    const model = animated[modelIndex];
    return model ? model.activeAnimations : null;
}

/**
 * A yaw correction applied to every figure, in radians.
 *
 * Computed from what Cesium's transform does, not guessed: local **+Y** is what
 * `headingPitchRollQuaternion` aims along the compass heading, and the model's
 * own forward is **+Z** (measured from the toe-to-ankle offset in `walker.glb`,
 * which is (0, -0.089, +0.228) -- dominated by Z). Mapping +Z onto +Y needs a
 * quarter turn, and the sign is negative because the rotation runs from the
 * model's frame into Cesium's, which is the direction that puts +Z on the
 * heading rather than 180 degrees away from it.
 *
 * **Confirmed visually.** With this set to zero the figures walked 90 degrees
 * clockwise of their paths; at `-Math.PI / 2` they face the direction of travel.
 * The value was checked by eye rather than only derived, because the model's
 * rest pose and its posed, root-transformed geometry are not the same frame and
 * earlier reasoning from the rest pose alone gave the wrong axis.
 *
 * If a model is swapped in, this is the number to re-derive, and the
 * toe-to-ankle vector is the measurement that does it.
 */
const AVATAR_YAW_OFFSET = -Math.PI / 2;

/**
 * Create a set of walking figures, one per agent.
 *
 * Resolves to `null` only when there is no viewer, so callers can fall back to
 * the existing dots. Any failure of the remote model degrades to the mannequin
 * rather than to nothing.
 *
 * @param {number} count            agents to represent
 * @param {Object} [options]
 * @param {number[]} [options.heights] per-agent height in metres
 */
export async function createAvatars(count, options = {}) {
    const viewer = getViewer();
    if (!viewer || !Cesium || !count) return null;

    const rigged = await probeRiggedModel();
    const heights = options.heights || [];
    // Per-agent colours, as `[r, g, b]`. Supplied by the caller so the figures can
    // match the trajectory palette without this module importing the trajectory
    // module, which imports this one.
    const tints = options.tints || [];

    if (rigged) {
        // One Entity per agent. This is how Cesium 1.110 instances a glTF
        // across many placements; a bare `Model` can only occupy one position,
        // and `ModelInstanceCollection` was removed in Cesium 1.96.
        const variants = rigged.variants || [{ url: rigged.url, label: rigged.label }];

        // A stable per-agent random stream.
        //
        // Stable matters more than random here. The crowd is rebuilt every time
        // the page or the layer is entered, and a fresh `Math.random()` per build
        // would reshuffle every figure's height and gait phase on each entry --
        // so a viewer stepping away and back would find the same street populated
        // by visibly different people. Seeding from the agent index makes the
        // crowd look arbitrary while staying the same crowd.
        const rand = makeSeededRandom(0x5eed1a);

        const entities = [];
        for (let i = 0; i < count; i++) {
            // Which character, and which tint. Distributing both by index keeps
            // the crowd from looking like one person repeated, which is what the
            // reference image shows: several kinds of person, distinguishable at
            // a glance.
            const variant = variants[i % variants.length];
            // The caller's colour for this agent when it supplies one, so a
            // figure matches its own trajectory. `AVATAR_TINTS` remains the
            // fallback for any caller that does not, which keeps this module
            // usable on its own.
            const tint = tints[i] || AVATAR_TINTS[i % AVATAR_TINTS.length];

            // Per-agent height.
            //
            // The Kova export carries a `height` field, but it is null for every
            // agent in the current run, so every figure was falling back to the
            // same 1.72 m and the crowd was a row of identical people. Where the
            // data does supply a height it is used as the mean and jittered
            // slightly, so a real measurement is respected while the crowd still
            // varies.
            const reported = Number(heights[i]);
            const baseHeight = Number.isFinite(reported) && reported > 0 ? reported : 1.72;
            const height = baseHeight * (0.92 + rand() * 0.16);

            // Per-agent gait phase, in seconds within the clip.
            //
            // Every figure otherwise starts the walk cycle on the same frame, so
            // seventy-five people step in lockstep -- an effect the eye picks up
            // immediately as artificial. Cesium derives the clip's pose from
            // scene time alone, and `animationTime` is a read-only getter, so the
            // phase cannot be set directly. It can be *shifted* by moving the
            // animation's start time, which is what the `startTime` offset below
            // does: the clip is evaluated at `sceneTime - startTime`, so starting
            // it later in the past advances it further into its cycle.
            const phaseSeconds = rand() * (rigged.clipSeconds || 1.3);

            const entity = viewer.entities.add({
                name: `agent-avatar-${i}`,
                model: {
                    uri: variant.url,
                    // The walk cycle is authored, so let Cesium advance it.
                    // Only one clip survives in each vendored file, because
                    // `runAnimations` cannot select among several -- see
                    // `tools/prune_glb_animations.py`.
                    runAnimations: true,
                    clampAnimations: false,
                    shadows: Cesium.ShadowMode.DISABLED,
                    allowPicking: false,
                    // Explicitly NONE. These agents walk on a flat exported
                    // surface, not on the globe's terrain, so asking Cesium to
                    // re-derive a ground height per frame would be both wrong
                    // and expensive across 75 skinned models. The export gives
                    // each agent a ground position and the model's own feet sit
                    // at y ~= 0, so the position is all that is needed.
                    heightReference: Cesium.HeightReference.NONE,
                    // No floor. The figures must not be inflated: `scale` below
                    // is already the true size, and a `minimumPixelSize` would
                    // override it and reintroduce the city-sized avatars.
                    minimumPixelSize: 0,
                    // The vendored UAL model stands 1.829 m tall natively, in
                    // metres, with no node-scale trickery, so this normalises
                    // the agent's own height against that figure.
                    scale: height / 1.829,
                    // A per-agent tint so a crowd reads as several people, and so
                    // each figure can be matched to its own trajectory.
                    // MIX keeps the character's own shading rather than
                    // flattening it to a silhouette, which HIGHLIGHT would do.
                    //
                    // `tint` is normalised to 0-1 here because the two palettes
                    // this can be fed are not in the same units: `AVATAR_TINTS` is
                    // already 0-1 floats while `AGENT_COLORS` is 0-255 bytes.
                    // Scaling a byte triple by 255 overflows every channel, which
                    // `fromBytes` clamps to 255 -- every figure would come out
                    // white and the colour would be lost entirely. The divisor is
                    // derived from the value rather than assumed, so either
                    // palette works.
                    color: Cesium.Color.fromBytes(
                        clampByte(tint[0]),
                        clampByte(tint[1]),
                        clampByte(tint[2])
                    ),
                    colorBlendMode: Cesium.ColorBlendMode.MIX,
                    // Higher than the 0.55 this used to be. The point of the tint
                    // is now identification against a path rather than decoration,
                    // and a half-strength blend over a darkly lit model leaves the
                    // hue too close to its neighbours to tell which path a figure
                    // belongs to.
                    colorBlendAmount: 0.8,
                },
            });

            // Shift this figure's walk cycle to its own phase.
            //
            // Indexed by the agent, which equals the position among the model
            // primitives because the figures are created in one pass and nothing
            // else in the scene contributes a model primitive while this loop
            // runs.
            applyPhaseOffset(viewer, entity, phaseSeconds, i);

            entities.push(entity);
        }
        return {
            kind: 'model',
            label: `${rigged.label} (${variants.length} characters)`,
            animationName: rigged.animationName,
            entities,
            place(index, position, headingRad) {
                const entity = entities[index];
                if (!entity) return;
                // Orientation belongs on the entity, not on the model's node
                // graph.
                //
                // An earlier version set `entity.model.nodeTransformations.root`,
                // which silently did nothing useful: there is no node named
                // `root` in these models (the hierarchy starts at `RootNode`,
                // then `CharacterArmature`), and overriding a skinned model's
                // root transform is a good way to collapse the mesh entirely.
                //
                // The heading is a compass bearing, clockwise from north, which
                // is exactly what `HeadingPitchRoll` expects, so the bearing
                // needs no conversion. `headingPitchRollQuaternion` also puts the
                // model's up axis along the local normal, which is why the
                // figures stand upright on the ground rather than at a tangent
                // to the ellipsoid.
                //
                // The yaw needs a correction, applied as `AVATAR_YAW_OFFSET`.
                //
                // Cesium aims the frame's local **+Y** along the heading -- that
                // is what sets the model's facing -- while the model's own
                // forward is **+Z**. The two frames are a quarter turn apart, and
                // without the offset the figures walk 90 degrees clockwise of
                // their paths.
                //
                // The +Y convention was measured on a live entity rather than
                // taken from the documentation: at heading h, local +X lands on
                // bearing h-90, +Y on h and +Z on vertical up, which makes +Y the
                // axis that carries the heading.
                //
                // The model's +Z forward comes from the rest pose in the file,
                // where the toe sits at (0, -0.089, +0.228) relative to the
                // ankle. That rest pose is *not* the posed geometry Cesium
                // renders -- the glTF root carries a -90 degree rotation about X
                // -- which is why the derivation here is backed by a visual check
                // rather than trusted on its own. See `AVATAR_YAW_OFFSET`.
                //
                // ## A roll will not do this
                //
                // An earlier attempt corrected the same mismatch with a **roll**,
                // and it buried the figures in the pavement -- correctly, because
                // roll turns a body about its own forward axis, so a facing error
                // banks the figure onto its side. Yaw is the axis that turns a
                // figure to face elsewhere.
                entity.position = position;
                entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(
                    position,
                    new Cesium.HeadingPitchRoll(headingRad + AVATAR_YAW_OFFSET, 0, 0)
                );
            },
            destroy() {
                entities.forEach((e) => {
                    // Run the phase-offset teardown first. It cancels the
                    // pending frame and detaches the `preRender` listener;
                    // leaving either in place means the callback keeps firing
                    // against a primitive that has been removed from the scene,
                    // and the listener holds the entity alive.
                    if (e.__phaseCleanup) {
                        try {
                            e.__phaseCleanup();
                        } catch (_) {
                            /* already detached */
                        }
                        e.__phaseCleanup = null;
                    }
                    try {
                        viewer.entities.remove(e);
                    } catch (_) {
                        /* already gone */
                    }
                });
            },
            /**
             * Advance every agent's walk cycle by a number of seconds.
             *
             * This is manual on purpose, and it is the fix for figures that slid
             * along rigidly while reporting an active animation.
             *
             * Cesium's `ModelAnimation` advances off the scene clock, so it only
             * moves if `viewer.clock.shouldAnimate` is true. That flag defaults
             * to false, and nothing in this viewer ever set it, because the
             * clock is not what drives these agents: they are positioned from
             * the Kova trajectory data by the viewer's own `setInterval` tick.
             *
             * Simply enabling the clock is the wrong fix here. It would run the
             * walk cycle on a timeline unrelated to the trajectory, so a stride
             * would not correspond to the ground covered, and it would also spin
             * up Cesium's clock for every other time-dependent layer. Driving
             * the clips from the same tick that moves the agents keeps the two in
             * step and leaves the scene clock alone.
             *
             * The delta is clamped so that a background tab, whose timers are
             * throttled, does not resume with a huge jump that races the legs.
             */
            /**
             * Removed. The walk cycle is not driven from here.
             *
             * An earlier version tried to advance each clip by hand from the
             * viewer's own tick, on the reasoning that the scene clock is
             * stopped and the agents are moved by `setInterval` rather than by
             * scene time. It was wrong twice over, and both reasons are worth
             * recording so it is not attempted again.
             *
             * It did not work. `ModelAnimation.animationTime` is a read-only
             * getter, so assigning to it changed nothing, and writing the
             * private `_animationTime` behind it did not move the skeleton.
             *
             * It also crashed the renderer, which is worse than doing nothing.
             * `activeAnimations.get(k)` does not return an animation, so the
             * first property read off it became
             * `TypeError: a._animationTime is not a function`, and Cesium's
             * render loop stopped with an error over the scene.
             *
             * The clip itself is fine: it loads, reports as active, and builds
             * 195 runtime channels over 65 joints. What is unresolved is why the
             * model's animation update never advances it. Leaving the hook out
             * keeps the renderer alive while that is settled.
             */
        };
    }

    // Mannequin path: one PointPrimitiveCollection holds every limb of every
    // agent and is added to the scene once. A collection per agent would
    // rebuild the scene's primitive list 75 times on entry.
    const collection = new Cesium.PointPrimitiveCollection();
    viewer.scene.primitives.add(collection);

    const figures = [];
    // Same stable jitter as the rigged path, so the fallback crowd varies too
    // rather than being a row of identical figures.
    const rand = makeSeededRandom(0x5eed1a);
    for (let i = 0; i < count; i++) {
        const reported = Number(heights[i]);
        const baseHeight = Number.isFinite(reported) && reported > 0 ? reported : 1.72;
        const height = baseHeight * (0.92 + rand() * 0.16);
        // A per-figure stride phase in metres travelled, which is the unit the
        // mannequin's limb swing is parameterised by. Without it every mannequin
        // steps in unison.
        const phaseMetres = rand() * 1.6;
        figures.push(createMannequin(height, collection, phaseMetres, tints[i] || null));
    }

    return {
        kind: 'mannequin',
        label: 'procedural mannequin',
        figures,
        pose(index, base, headingRad, distanceMetres, pixelScale, enu) {
            const figure = figures[index];
            if (figure) figure.pose(base, headingRad, distanceMetres, pixelScale, enu);
        },
        destroy() {
            try {
                viewer.scene.primitives.remove(collection);
            } catch (_) {
                /* already gone */
            }
        },
    };
}
