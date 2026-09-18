/**
 * Start both the web server and proxy server together
 * Run with: node start-all.js
 *
 * GTFS proxy caches vehiclePositions for CACHE_TTL_MS to avoid OVapi 429 rate limits.
 */

import { spawn } from 'child_process';
import http from 'http';
import https from 'https';
import url from 'url';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('Starting GTFS proxy server on port 3000...');
const PORT = 3000;
const GTFS_BASE_URL = 'https://gtfs.ovapi.nl/nl/';
const CACHE_TTL_MS = 25000; // OVapi updates ~10s; refresh a bit slower than UI interval
const STATIC_FALLBACK = path.join(__dirname, 'data', 'static-gtfs', 'vehiclePositions.pb');

/** @type {Map<string, { buf: Buffer, contentType: string, fetchedAt: number }>} */
const cache = new Map();

function setCORSHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendBuffer(res, status, contentType, buf, extraHeaders = {}) {
    setCORSHeaders(res);
    res.writeHead(status, {
        'Content-Type': contentType,
        'Content-Length': buf.length,
        ...extraHeaders,
    });
    res.end(buf);
}

function looksLikeProtobuf(buf) {
    if (!buf || buf.length < 2) return false;
    // HTML error pages start with '<'
    return buf[0] !== 0x3c;
}

function fetchUpstream(gtfsFile) {
    const targetUrl = GTFS_BASE_URL + gtfsFile;
    return new Promise((resolve, reject) => {
        https.get(targetUrl, (proxyRes) => {
            const chunks = [];
            proxyRes.on('data', (c) => chunks.push(c));
            proxyRes.on('end', () => {
                resolve({
                    status: proxyRes.statusCode || 502,
                    contentType: proxyRes.headers['content-type'] || 'application/x-protobuf',
                    buf: Buffer.concat(chunks),
                });
            });
            proxyRes.on('error', reject);
        }).on('error', reject);
    });
}

const proxyServer = http.createServer(async (req, res) => {
    setCORSHeaders(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);

    if (!parsedUrl.pathname.startsWith('/gtfs/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
    }

    const gtfsFile = parsedUrl.pathname.replace('/gtfs/', '');
    const now = Date.now();
    const cached = cache.get(gtfsFile);

    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
        console.log(`[Proxy] ${new Date().toLocaleTimeString()} - CACHE hit: ${gtfsFile} (${cached.buf.length} B)`);
        sendBuffer(res, 200, cached.contentType, cached.buf, { 'X-GTFS-Cache': 'HIT' });
        return;
    }

    console.log(`[Proxy] ${new Date().toLocaleTimeString()} - Fetching: ${gtfsFile}`);
    try {
        const upstream = await fetchUpstream(gtfsFile);
        if (upstream.status === 200 && looksLikeProtobuf(upstream.buf)) {
            cache.set(gtfsFile, {
                buf: upstream.buf,
                contentType: upstream.contentType,
                fetchedAt: now,
            });
            console.log(`[Proxy] OK ${gtfsFile} (${upstream.buf.length} B) — cached ${CACHE_TTL_MS / 1000}s`);
            sendBuffer(res, 200, upstream.contentType, upstream.buf, { 'X-GTFS-Cache': 'MISS' });
            return;
        }

        // Rate limit / bad body → serve last good cache or static fallback
        console.warn(`[Proxy] Upstream ${upstream.status} for ${gtfsFile}; trying fallback`);
        if (cached && looksLikeProtobuf(cached.buf)) {
            sendBuffer(res, 200, cached.contentType, cached.buf, { 'X-GTFS-Cache': 'STALE' });
            return;
        }
        if (gtfsFile === 'vehiclePositions.pb' && fs.existsSync(STATIC_FALLBACK)) {
            const buf = fs.readFileSync(STATIC_FALLBACK);
            console.warn(`[Proxy] Serving static fallback ${STATIC_FALLBACK} (${buf.length} B)`);
            sendBuffer(res, 200, 'application/x-protobuf', buf, { 'X-GTFS-Cache': 'STATIC' });
            return;
        }

        sendBuffer(
            res,
            upstream.status || 502,
            'application/json',
            Buffer.from(JSON.stringify({
                error: 'GTFS upstream failed',
                status: upstream.status,
                hint: 'OVapi may be rate-limiting (429). Wait ~1 min or use cached/static data.',
            }))
        );
    } catch (err) {
        console.error('[Proxy] Error:', err.message);
        if (cached && looksLikeProtobuf(cached.buf)) {
            sendBuffer(res, 200, cached.contentType, cached.buf, { 'X-GTFS-Cache': 'STALE' });
            return;
        }
        if (gtfsFile === 'vehiclePositions.pb' && fs.existsSync(STATIC_FALLBACK)) {
            const buf = fs.readFileSync(STATIC_FALLBACK);
            sendBuffer(res, 200, 'application/x-protobuf', buf, { 'X-GTFS-Cache': 'STATIC' });
            return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
    }
});

proxyServer.listen(PORT, () => {
    console.log(`✓ GTFS proxy server running on http://localhost:${PORT}`);
    console.log(`  Cache TTL: ${CACHE_TTL_MS / 1000}s | fallback: ${STATIC_FALLBACK}`);
    console.log(`  Available: http://localhost:${PORT}/gtfs/vehiclePositions.pb\n`);

    // The web port is configurable because the default collided with other
    // projects on this machine, and because a port that has to be remembered is
    // a port that gets got wrong. `npm start` is the single entry point; it
    // starts both servers so the transit layer has its proxy and nothing has to
    // be started in a particular order.
    const WEB_PORT = process.env.PORT || process.argv[2] || '8080';

    console.log(`Starting web server on port ${WEB_PORT}...`);
    const webServer = spawn('npx', ['http-server', '.', '-p', WEB_PORT, '-c-1'], {
        stdio: 'inherit',
        shell: true,
    });

    webServer.on('error', (err) => {
        console.error('Failed to start web server:', err);
        process.exit(1);
    });

    console.log(`✓ Web server starting on http://localhost:${WEB_PORT}`);
    console.log('\nBoth servers are running!');
    console.log(`Open http://localhost:${WEB_PORT} in your browser\n`);
    console.log('Press Ctrl+C to stop both servers');

    process.on('SIGINT', () => {
        console.log('\n\nShutting down servers...');
        proxyServer.close();
        webServer.kill();
        process.exit(0);
    });
});
