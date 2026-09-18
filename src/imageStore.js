/**
 * Proposal profile images.
 *
 * A visitor can attach a picture to a proposal they added, which the
 * case-studies picker then shows on that proposal's card.
 *
 * ## Why the image is redrawn rather than stored as given
 *
 * The picture is kept in `localStorage` (see the note on `IMAGES_KEY` in
 * `dataRegistry.js` for why it must survive a reload), and storage is a few
 * megabytes shared with everything else on the origin. A phone photo or a
 * screenshot straight off a 4K display is several megabytes on its own, so
 * storing the file as uploaded would fail for most real inputs — and fail after
 * the visitor has already been told the image was accepted.
 *
 * So the image is downscaled and re-encoded first. That makes the common case
 * fit comfortably: a screenshot at 960px wide is typically 50-150 kB as JPEG.
 *
 * ## Why redrawn through a canvas rather than re-encoded directly
 *
 * `createImageBitmap` plus a canvas lets the browser do the resampling, which
 * handles the wide range of formats a browser accepts and produces a smaller
 * result than shipping the original bytes. The alternative — re-encoding the
 * original file through `FileReader` and `canvas.drawImage` — would keep the
 * full dimension, which is the part that does not fit.
 *
 * ## A note on what this does not protect against
 *
 * The image is drawn to a canvas and read back, which means it cannot carry a
 * script into the page the way an SVG could if it were inlined as markup. It is
 * still inserted as an `<img src>`, so it is subject to the browser's normal image
 * handling rather than being trusted as document content.
 */

/** Longest edge, in pixels, of a stored proposal image. */
const MAX_EDGE = 960;

/**
 * Quality for the JPEG re-encode.
 *
 * 0.82 is the point past which this image stops visibly improving: it is a card
 * thumbnail a few hundred pixels wide, so the difference between 0.82 and 0.95
 * is not visible at the size it is displayed, while the file is roughly twice
 * the size.
 */
const JPEG_QUALITY = 0.82;

/** Formats worth re-encoding to JPEG, where the alpha channel is not used. */
const OPAQUE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp'];

/**
 * Downscale and re-encode a picked image file.
 *
 * @param {File} file
 * @returns {Promise<{ok: true, dataUrl: string, width: number, height: number}
 *   | {ok: false, error: string}>}
 */
export async function prepareProposalImage(file) {
    if (!file) return { ok: false, error: 'No file was chosen.' };

    if (!file.type.startsWith('image/')) {
        return { ok: false, error: 'That is not an image file.' };
    }

    // SVG is refused rather than converted. An SVG is a document, not a bitmap:
    // it can reference external resources and, if it ever reached the DOM as
    // markup rather than as an `<img>`, carry script. Raster formats have no such
    // surface, and a proposal cover does not need to be vector.
    if (file.type === 'image/svg+xml') {
        return {
            ok: false,
            error: 'SVG is not supported for proposal images. A PNG or JPEG works.',
        };
    }

    if (!OPAQUE_TYPES.includes(file.type)) {
        return {
            ok: false,
            error: `Unsupported image type (${file.type || 'unknown'}). Use PNG or JPEG.`,
        };
    }

    let bitmap;
    try {
        // `createImageBitmap` rejects on a file the browser cannot decode, which
        // is the check that matters: a mislabelled extension is caught here
        // rather than producing a blank canvas.
        bitmap = await createImageBitmap(file);
    } catch (_) {
        return { ok: false, error: 'That image could not be decoded.' };
    }

    try {
        const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);
        if (!width || !height) {
            return { ok: false, error: 'That image has no usable dimensions.' };
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) return { ok: false, error: 'This browser could not process the image.' };

        // Photographs and screenshots of a 3D view can carry transparency at the
        // edges. Filling first means those areas become white rather than black,
        // which is what a JPEG encode would otherwise produce.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);

        ctx.drawImage(bitmap, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        // `toDataURL` returns "data:," when it fails rather than throwing, so the
        // result is checked instead of assumed.
        if (!dataUrl || !dataUrl.startsWith('data:image/')) {
            return { ok: false, error: 'The image could not be converted for storage.' };
        }

        return { ok: true, dataUrl, width, height };
    } finally {
        // Releases the decoded bitmap's memory promptly. A full-size photo can
        // hold tens of megabytes, and nothing below needs it once drawn.
        if (typeof bitmap.close === 'function') bitmap.close();
    }
}

/**
 * Scale a width and height to fit a square limit, preserving the ratio.
 *
 * Returns the original dimensions when they already fit, so a small image is not
 * enlarged: upscaling would not add detail and would cost storage for nothing.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} limit
 * @returns {{width: number, height: number}}
 */
function fitWithin(width, height, limit) {
    const longest = Math.max(width, height);
    if (!longest || longest <= limit) {
        return { width: Math.round(width), height: Math.round(height) };
    }
    const scale = limit / longest;
    // `max(1, ...)` guards a very wide, very short image from rounding to zero
    // height, which would make the canvas invalid.
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}
