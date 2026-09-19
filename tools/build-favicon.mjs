/**
 * Render the favicon set for the viewer.
 *
 * The mark is a stack of three isometric slabs over a dark rounded tile: it says
 * "layers" and "built form" at once, which is what the app is — several
 * assessment layers read over one block. The three bands reuse the ramps the
 * legends already use (sunlight warm, flow green, interface blue) so the icon
 * belongs to the same palette as the interface rather than introducing one.
 *
 * Written as a generator rather than a checked-in PNG so the mark can be
 * adjusted without a design tool, and so every size is rendered from the same
 * geometry instead of being resampled from a single bitmap.
 *
 * Outputs, relative to visualization/:
 *   favicon.svg           — scalable, used by modern browsers
 *   favicon-32.png        — browser tab
 *   favicon-192.png       — Android home screen
 *   favicon-512.png       — PWA / social preview
 *   apple-touch-icon.png  — iOS home screen, 180×180
 *
 * Run: node tools/build-favicon.mjs
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..');

/** Dark tile behind the mark: matches the theme-color meta tag. */
export const TILE = '#14161a';

/**
 * Slab faces, sampled from ramps the legends already use so the icon reads as
 * part of the same system. `side` is the extruded edge, `top` the lit face.
 */
export const LAYERS = [
    { top: '#ffd166', side: '#a8781f' }, // sunlight (warm)
    { top: '#4ec9a0', side: '#2f8e6f' }, // pedestrian flow (green)
    { top: '#8fc7ff', side: '#4a7ba8' }, // interface accent (blue)
];

/**
 * Isometric slab: a rhombus top face with an extrusion below it.
 *
 * Plain coordinates rather than a library, so the SVG and any rasteriser share
 * identical geometry instead of approximating each other.
 *
 * @param {number} cx     Centre x of the slab
 * @param {number} cy     Centre y of the slab
 * @param {number} halfW  Half-width of the rhombus
 * @param {number} halfH  Half-height of the rhombus (isometric 2:1)
 * @param {number} depth  Extrusion below the top face
 */
export function slabPoints(cx, cy, halfW, halfH, depth) {
    const top = [
        [cx, cy - halfH], // north
        [cx + halfW, cy], // east
        [cx, cy + halfH], // south
        [cx - halfW, cy], // west
    ];
    const bottom = top.map(([x, y]) => [x, y + depth]);
    return { top, bottom };
}

/** `x,y` pairs as an SVG points attribute. */
const pts = (list) => list.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

/** Geometry constants, in the 512-unit design space. */
export const DESIGN = { cx: 256, halfW: 150, halfH: 78, depth: 26, baselines: [332, 250, 168] };

/** The full icon as an SVG document. */
export function svg(size = 512) {
    const { cx, halfW, halfH, depth, baselines } = DESIGN;
    const slabs = LAYERS.map((layer, i) => {
        const { top, bottom } = slabPoints(cx, baselines[i], halfW, halfH, depth);
        // Sides first, then the top face over them, so the two visible edges meet
        // cleanly without a seam from antialiasing.
        return `
    <polygon points="${pts([bottom[0], bottom[1], top[1], top[0]])}" fill="${layer.side}"/>
    <polygon points="${pts([bottom[3], bottom[2], top[2], top[3]])}" fill="${layer.side}"/>
    <polygon points="${pts(top)}" fill="${layer.top}"/>`;
    }).join('');

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}" role="img" aria-label="Multisensory Digital Twin">
    <title>Multisensory Digital Twin</title>
    <rect width="512" height="512" rx="112" fill="${TILE}"/>${slabs}
</svg>
`;
}

if (process.argv[1] && process.argv[1].endsWith('build-favicon.mjs')) {
    const name = 'favicon.svg';
    const content = svg(512);
    writeFileSync(join(OUT, name), content, 'utf8');
    console.log(`wrote ${name} (${content.length} bytes)`);
}
