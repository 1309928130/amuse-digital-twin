/**
 * Simple proxy server for GTFS-realtime data
 * This bypasses CORS restrictions by fetching data server-side
 * 
 * Run with: node proxy-server.js
 * Then update config.js to use: endpoint: 'http://localhost:3000/gtfs/vehiclePositions'
 */

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 3000;
const GTFS_BASE_URL = 'https://gtfs.ovapi.nl/nl/';

// Enable CORS
function setCORSHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer((req, res) => {
    setCORSHeaders(res);
    
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // Parse URL
    const parsedUrl = url.parse(req.url, true);
    
    // Proxy GTFS endpoints
    if (parsedUrl.pathname.startsWith('/gtfs/')) {
        const gtfsFile = parsedUrl.pathname.replace('/gtfs/', '');
        const targetUrl = GTFS_BASE_URL + gtfsFile;
        
        console.log(`Proxying request to: ${targetUrl}`);
        
        https.get(targetUrl, (proxyRes) => {
            // Set CORS headers
            setCORSHeaders(res);
            
            // Copy status code
            res.writeHead(proxyRes.statusCode, {
                'Content-Type': proxyRes.headers['content-type'] || 'application/x-protobuf'
            });
            
            // Pipe the response
            proxyRes.pipe(res);
        }).on('error', (err) => {
            console.error('Proxy error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
        });
    } else {
        // 404 for other paths
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
});

server.listen(PORT, () => {
    console.log(`GTFS proxy server running on http://localhost:${PORT}`);
    console.log(`Available endpoints:`);
    console.log(`  http://localhost:${PORT}/gtfs/vehiclePositions.pb`);
    console.log(`  http://localhost:${PORT}/gtfs/tripUpdates.pb`);
    console.log(`  http://localhost:${PORT}/gtfs/trainUpdates.pb`);
});

