/**
 * Download OSM building data for Zuidas area
 * Run with: node download-osm-buildings.js
 * 
 * This downloads building data from Overpass API and saves it locally
 * so you don't need to fetch it every time the app loads.
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Use node-fetch or built-in fetch (Node 18+)
let fetch;
try {
    // Try to use built-in fetch (Node 18+)
    fetch = globalThis.fetch;
    if (!fetch) {
        // Fallback: use https/http directly
        fetch = null;
    }
} catch (e) {
    fetch = null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data', 'osm');
const OSM_FILE = path.join(DATA_DIR, 'zuidas-buildings.json');

// Zuidas area bounding box (can be customized)
const ZUIDAS_BOUNDS = {
    north: 52.345,
    south: 52.330,
    east: 4.875,
    west: 4.850
};

// Overpass API endpoints to try
const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter'
];

/**
 * Build Overpass API query
 */
function buildOverpassQuery(bounds) {
    const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
    return `[out:json][timeout:180];
(
  way["building"](${bbox});
  relation["building"](${bbox});
);
out body;
>;
out skel qt;`;
}

/**
 * Download OSM data from Overpass API using Node.js http/https
 */
function downloadOSMData(bounds) {
    const query = buildOverpassQuery(bounds);
    
    return new Promise((resolve, reject) => {
        let lastError = null;
        let endpointIndex = 0;
        
        function tryNextEndpoint() {
            if (endpointIndex >= OVERPASS_ENDPOINTS.length) {
                reject(lastError || new Error('All Overpass API endpoints failed'));
                return;
            }
            
            const endpoint = OVERPASS_ENDPOINTS[endpointIndex];
            endpointIndex++;
            
            console.log(`Trying Overpass API: ${endpoint}`);
            
            const url = new URL(endpoint);
            const protocol = url.protocol === 'https:' ? https : http;
            const postData = `data=${encodeURIComponent(query)}`;
            
            const options = {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 180000 // 3 minute timeout
            };
            
            const req = protocol.request(options, (res) => {
                let data = '';
                
                if (res.statusCode === 504 || res.statusCode === 429) {
                    console.warn(`  ${endpoint} returned ${res.statusCode}, trying next...`);
                    lastError = new Error(`HTTP ${res.statusCode}`);
                    return tryNextEndpoint();
                }
                
                if (res.statusCode !== 200) {
                    lastError = new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`);
                    return tryNextEndpoint();
                }
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const jsonData = JSON.parse(data);
                        console.log(`✓ Successfully fetched OSM data from ${endpoint}`);
                        resolve(jsonData);
                    } catch (parseError) {
                        lastError = new Error(`Failed to parse response: ${parseError.message}`);
                        tryNextEndpoint();
                    }
                });
            });
            
            req.on('error', (err) => {
                console.warn(`  Error with ${endpoint}: ${err.message}`);
                lastError = err;
                tryNextEndpoint();
            });
            
            req.on('timeout', () => {
                req.destroy();
                lastError = new Error('Request timeout');
                tryNextEndpoint();
            });
            
            req.write(postData);
            req.end();
        }
        
        tryNextEndpoint();
    });
}

/**
 * Main download function
 */
async function downloadOSMBuildings() {
    console.log('='.repeat(60));
    console.log('OSM Buildings Data Downloader for Zuidas');
    console.log('='.repeat(60));
    console.log('');
    console.log(`Area bounds:`);
    console.log(`  North: ${ZUIDAS_BOUNDS.north}`);
    console.log(`  South: ${ZUIDAS_BOUNDS.south}`);
    console.log(`  East: ${ZUIDAS_BOUNDS.east}`);
    console.log(`  West: ${ZUIDAS_BOUNDS.west}`);
    console.log('');
    
    // Create data directory
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log(`Created directory: ${DATA_DIR}`);
    }
    
    // Check if file already exists
    if (fs.existsSync(OSM_FILE)) {
        const stats = fs.statSync(OSM_FILE);
        console.log(`⚠ File already exists: ${OSM_FILE}`);
        console.log(`  Size: ${(stats.size / 1024).toFixed(2)} KB`);
        console.log(`  Modified: ${stats.mtime.toLocaleString()}`);
        console.log('');
        console.log('Delete the file first if you want to re-download.');
        console.log('');
        return;
    }
    
    console.log('Downloading OSM building data...');
    console.log('This may take a few minutes depending on the area size...');
    console.log('');
    
    try {
        const osmData = await downloadOSMData(ZUIDAS_BOUNDS);
        
        // Count buildings
        const buildingCount = osmData.elements?.filter(e => 
            e.type === 'way' && e.tags && e.tags.building
        ).length || 0;
        
        console.log(`Found ${buildingCount} buildings in OSM data`);
        console.log('');
        
        // Save to file
        console.log(`Saving to: ${OSM_FILE}`);
        fs.writeFileSync(OSM_FILE, JSON.stringify(osmData, null, 2));
        
        const fileSize = fs.statSync(OSM_FILE).size;
        console.log(`✓ Saved ${(fileSize / 1024).toFixed(2)} KB`);
        console.log('');
        console.log('='.repeat(60));
        console.log('Download complete!');
        console.log(`File saved to: ${OSM_FILE}`);
        console.log('');
        console.log('You can now:');
        console.log('  1. Edit the JSON file manually if needed');
        console.log('  2. The app will load from this file instead of fetching online');
        console.log('='.repeat(60));
        
    } catch (error) {
        console.error('');
        console.error('✗ Error downloading OSM data:', error.message);
        console.error('');
        console.error('Tips:');
        console.error('  - Try again later (Overpass API may be busy)');
        console.error('  - Check your internet connection');
        console.error('  - The area might be too large (try smaller bounds)');
        console.error('');
        process.exit(1);
    }
}

// Allow custom bounds via command line arguments
// Usage: node download-osm-buildings.js --north 52.35 --south 52.33 --east 4.88 --west 4.85
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--north' && args[i + 1]) {
        ZUIDAS_BOUNDS.north = parseFloat(args[i + 1]);
    } else if (args[i] === '--south' && args[i + 1]) {
        ZUIDAS_BOUNDS.south = parseFloat(args[i + 1]);
    } else if (args[i] === '--east' && args[i + 1]) {
        ZUIDAS_BOUNDS.east = parseFloat(args[i + 1]);
    } else if (args[i] === '--west' && args[i + 1]) {
        ZUIDAS_BOUNDS.west = parseFloat(args[i + 1]);
    }
}

// Run the download
downloadOSMBuildings().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});

