/**
 * Download a GTFS-realtime snapshot for bundling with the deployed site.
 *
 * Why this exists
 * ---------------
 * The deployed viewer has no live transit feed. OVapi sends no CORS headers, so
 * a browser on a hosting origin cannot read it, and Firebase Hosting is
 * static-only — a server-side proxy would need Cloud Functions, which needs the
 * Blaze plan. The deployed site therefore ships a snapshot and reads that
 * instead, which is why this file has to be valid.
 *
 * The three feeds previously bundled were not valid: vehiclePositions.pb and
 * tripUpdates.pb were truncated (decode failed at end-of-file) and
 * trainUpdates.pb contained an invalid wire type. All three looked plausible by
 * size, so nothing caught it until the feeds were actually decoded. The cause
 * appears to be interrupted downloads, or OVapi answering 429 with an HTML body
 * that got saved as .pb.
 *
 * A truncated feed is worse than a missing one: it decodes to an empty vehicle
 * list rather than raising, so the transit layer renders nothing and looks like
 * a styling fault. Every download here is therefore decoded and checked for
 * actual vehicle positions *before* it is allowed to replace anything on disk.
 *
 * Usage
 * -----
 *   node tools/fetch-gtfs-snapshot.mjs            # fetch and verify
 *   node tools/fetch-gtfs-snapshot.mjs --check    # verify what is on disk
 *
 * OVapi rate-limits aggressively (HTTP 429). If a fetch is refused, wait a
 * minute and try again; the script backs off and retries on its own.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import protobuf from 'protobufjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'static-gtfs');
const PROTO_PATH = path.join(__dirname, '..', 'src', 'gtfs-realtime.proto');

const FEEDS = [
    { file: 'vehiclePositions.pb', name: 'vehicle positions', expectPositions: true },
    { file: 'tripUpdates.pb', name: 'trip updates', expectPositions: false },
    { file: 'trainUpdates.pb', name: 'train updates', expectPositions: false },
];

const UPSTREAM = 'https://gtfs.ovapi.nl/nl/';
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 20000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function get(url) {
    return new Promise((resolve, reject) => {
        https
            .get(
                url,
                {
                    headers: {
                        Accept: 'application/x-protobuf, application/octet-stream',
                        // OVapi appears to treat unidentified clients less kindly.
                        'User-Agent': 'digital-twin-snapshot/1.0 (+amuse)',
                    },
                },
                (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () =>
                        resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', buf: Buffer.concat(chunks) })
                    );
                    res.on('error', reject);
                }
            )
            .on('error', reject);
    });
}

/**
 * Decode a feed and report whether it is usable.
 *
 * Returns a verdict rather than throwing so the caller can distinguish "this is
 * corrupt" from "the network failed", which need different handling.
 */
function inspectFeed(buf, FeedMessage, expectPositions) {
    if (!buf || buf.length === 0) {
        return { ok: false, reason: 'empty response' };
    }
    // An HTML body saved under a .pb name is the classic rate-limit trap.
    if (buf[0] === 0x3c) {
        return { ok: false, reason: 'body is HTML, not protobuf (rate-limit page?)' };
    }

    let message;
    try {
        message = FeedMessage.decode(buf);
    } catch (err) {
        return { ok: false, reason: `decode failed: ${err.message}` };
    }

    const entities = message.entity || [];
    if (entities.length === 0) {
        return { ok: false, reason: 'decoded, but contains no entities', entities: 0 };
    }

    // A truncated tail is the failure that matters most here: it yields a
    // non-empty entity list while silently dropping vehicles, so a count alone
    // is not enough. Re-encoding is what catches it — a message that decoded
    // from a partial buffer will not round-trip to the same length.
    const reencoded = FeedMessage.encode(message).finish();
    if (reencoded.length !== buf.length) {
        return {
            ok: false,
            reason: `suspected truncation: ${buf.length} bytes in, ${reencoded.length} bytes on re-encode`,
            entities: entities.length,
        };
    }

    let positions = 0;
    for (const entity of entities) {
        const v = entity.vehicle;
        if (v && v.position && typeof v.position.latitude === 'number') positions++;
    }

    if (expectPositions && positions === 0) {
        return { ok: false, reason: 'no entities carry a position', entities: entities.length };
    }

    return { ok: true, entities: entities.length, positions, bytes: buf.length };
}

async function checkExisting(FeedMessage) {
    console.log('Checking the snapshots currently on disk…\n');
    let allGood = true;

    for (const feed of FEEDS) {
        const target = path.join(OUT_DIR, feed.file);
        if (!fs.existsSync(target)) {
            console.log(`  ${feed.file.padEnd(22)} MISSING`);
            allGood = false;
            continue;
        }
        const buf = fs.readFileSync(target);
        const verdict = inspectFeed(buf, FeedMessage, feed.expectPositions);
        if (verdict.ok) {
            console.log(
                `  ${feed.file.padEnd(22)} OK    ${verdict.bytes.toLocaleString()} bytes, ` +
                    `${verdict.entities.toLocaleString()} entities, ${verdict.positions.toLocaleString()} positions`
            );
        } else {
            console.log(`  ${feed.file.padEnd(22)} BAD   ${verdict.reason}`);
            allGood = false;
        }
    }

    console.log();
    console.log(allGood ? 'All snapshots decode and are usable.' : 'At least one snapshot is unusable — re-run without --check to refetch.');
    return allGood;
}

async function fetchAndVerify(FeedMessage) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    let failures = 0;

    for (const feed of FEEDS) {
        const url = UPSTREAM + feed.file;
        console.log(`\n${feed.name} — ${url}`);

        let saved = false;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !saved; attempt++) {
            let res;
            try {
                res = await get(url);
            } catch (err) {
                console.log(`  attempt ${attempt}: network error — ${err.message}`);
                await sleep(BASE_BACKOFF_MS * attempt);
                continue;
            }

            if (res.status !== 200) {
                console.log(`  attempt ${attempt}: HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`);
                // 429 means back off; other errors are unlikely to improve by waiting.
                if (res.status === 429) await sleep(BASE_BACKOFF_MS * attempt);
                continue;
            }

            const verdict = inspectFeed(res.buf, FeedMessage, feed.expectPositions);
            if (!verdict.ok) {
                // Visible, and deliberately not written. Keeping a bad file would
                // recreate exactly the silent-failure this script exists to prevent.
                console.log(`  attempt ${attempt}: rejected — ${verdict.reason}`);
                await sleep(BASE_BACKOFF_MS * attempt);
                continue;
            }

            const target = path.join(OUT_DIR, feed.file);
            fs.writeFileSync(target, res.buf);
            console.log(
                `  saved ${verdict.bytes.toLocaleString()} bytes — ${verdict.entities.toLocaleString()} entities, ` +
                    `${verdict.positions.toLocaleString()} positions with coordinates`
            );
            saved = true;
        }

        if (!saved) {
            failures++;
            console.log(`  gave up after ${MAX_ATTEMPTS} attempts — existing file left untouched`);
        }
    }

    console.log();
    if (failures > 0) {
        console.log(
            `${failures} feed(s) could not be refreshed. OVapi rate-limits; wait a minute and run again. ` +
                'Nothing was overwritten, so a previously good snapshot is still in place.'
        );
        process.exitCode = 1;
    } else {
        console.log('All feeds refreshed. Rebuild and deploy to publish them: npm run deploy');
    }
}

(async () => {
    if (!fs.existsSync(PROTO_PATH)) {
        console.error(`Cannot find the protobuf schema at ${PROTO_PATH}`);
        process.exitCode = 1;
        return;
    }
    const root = await protobuf.load(PROTO_PATH);
    const FeedMessage = root.lookupType('transit_realtime.FeedMessage');

    if (process.argv.includes('--check')) {
        const ok = await checkExisting(FeedMessage);
        if (!ok) process.exitCode = 1;
        return;
    }

    await fetchAndVerify(FeedMessage);
})();
