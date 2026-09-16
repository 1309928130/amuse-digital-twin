/**
 * Download 3DBAG tiles for Zuidas area
 * 
 * This script:
 * 1. Downloads the tile index to find tiles covering Zuidas
 * 2. Identifies which tiles intersect with Zuidas bounds
 * 3. Downloads those tiles in the requested format (CityJSON, OBJ, etc.)
 * 
 * Usage: node download-3dbag-tiles.js [format] [lod]
 *   format: cityjson, obj, or gpkg (default: cityjson)
 *   lod: lod12, lod13, or lod22 (default: lod12)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 3DBAG configuration
const VERSION = 'v20250903';
const BASE_URL = `https://data.3dbag.nl/${VERSION}`;
const TILE_INDEX_URL = `${BASE_URL}/tile_index.fgb`;

// Zuidas bounds (from config.js)
const ZUIDAS_BOUNDS = {
    north: 52.345,
    south: 52.330,
    east: 4.875,
    west: 4.850
};

// Output directory
const OUTPUT_DIR = path.join(__dirname, 'data', '3dbag');

// Parse command line arguments
const format = process.argv[2] || 'cityjson';
const lod = process.argv[3] || 'lod12';

const validFormats = ['cityjson', 'obj', 'gpkg'];
const validLods = ['lod12', 'lod13', 'lod22'];

if (!validFormats.includes(format)) {
    console.error(`Invalid format: ${format}. Must be one of: ${validFormats.join(', ')}`);
    process.exit(1);
}

if (!validLods.includes(lod)) {
    console.error(`Invalid LoD: ${lod}. Must be one of: ${validLods.join(', ')}`);
    process.exit(1);
}

/**
 * Download a file from URL
 */
function downloadFile(url, outputPath) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(outputPath);
        
        console.log(`Downloading: ${url}`);
        console.log(`Saving to: ${outputPath}`);
        
        protocol.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                // Follow redirect
                return downloadFile(response.headers.location, outputPath)
                    .then(resolve)
                    .catch(reject);
            }
            
            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(outputPath);
                reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                return;
            }
            
            const totalSize = parseInt(response.headers['content-length'], 10);
            let downloadedSize = 0;
            
            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                if (totalSize) {
                    const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
                    process.stdout.write(`\rProgress: ${percent}% (${(downloadedSize / 1024 / 1024).toFixed(2)} MB)`);
                }
            });
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                console.log('\n✓ Download complete');
                resolve();
            });
        }).on('error', (err) => {
            file.close();
            if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
            }
            reject(err);
        });
    });
}

/**
 * Check if a bounding box intersects with Zuidas bounds
 */
function intersectsZuidas(bbox) {
    // bbox format: [minX, minY, maxX, maxY] (west, south, east, north)
    const [minX, minY, maxX, maxY] = bbox;
    
    return !(
        maxX < ZUIDAS_BOUNDS.west ||
        minX > ZUIDAS_BOUNDS.east ||
        maxY < ZUIDAS_BOUNDS.south ||
        minY > ZUIDAS_BOUNDS.north
    );
}

/**
 * Parse FlatGeoBuf tile index (simplified - just download and note that you need a library)
 * For now, we'll use a workaround: query the API or use known tile IDs
 */
async function findZuidasTiles() {
    console.log('\n=== Step 1: Finding tiles covering Zuidas area ===');
    console.log(`Zuidas bounds: ${ZUIDAS_BOUNDS.south},${ZUIDAS_BOUNDS.west} to ${ZUIDAS_BOUNDS.north},${ZUIDAS_BOUNDS.east}`);
    
    // Note: To properly parse FlatGeoBuf, you'd need a library like @loaders.gl/flatgeobuf
    // For now, we'll use the 3DBAG API or estimate tile IDs based on coordinates
    
    // Amsterdam area tiles are typically in the range:
    // Based on RD (Rijksdriehoeksmeting) coordinates, Amsterdam is around:
    // X: 120000-140000, Y: 480000-500000
    // 3DBAG tiles are typically 1000x1000m or 500x500m
    
    // For Zuidas specifically (around lat 52.337, lon 4.862):
    // RD coordinates: approximately X: 125000, Y: 487000
    
    // We'll try common tile IDs around Amsterdam
    // Format: {lod}_{x}_{y}.{ext}
    const estimatedTiles = [];
    
    // Try a range of tiles around Zuidas
    // Note: Actual tile IDs depend on 3DBAG's tiling scheme
    // This is an approximation - you may need to adjust based on the actual tile index
    
    console.log('\n⚠️  Note: This script uses estimated tile IDs.');
    console.log('   For accurate tile identification, you need to:');
    console.log('   1. Download tile_index.fgb');
    console.log('   2. Parse it with @loaders.gl/flatgeobuf');
    console.log('   3. Find tiles that intersect Zuidas bounds');
    console.log('\n   Alternatively, use the 3DBAG 3D Tiles directly in Cesium (recommended).');
    console.log('   See: src/threeDBagLoader.js for streaming 3D Tiles integration.\n');
    
    // For now, return empty array - user should use 3D Tiles or manually identify tiles
    return [];
}

/**
 * Download a specific tile
 */
async function downloadTile(tileId, format, lod) {
    const extension = format === 'cityjson' ? 'json' : format === 'obj' ? 'obj' : 'gpkg';
    const url = `${BASE_URL}/${format}/${lod}/${tileId}.${extension}`;
    const outputPath = path.join(OUTPUT_DIR, format, lod, `${tileId}.${extension}`);
    
    // Create directory if it doesn't exist
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    try {
        await downloadFile(url, outputPath);
        return outputPath;
    } catch (error) {
        console.error(`Failed to download tile ${tileId}:`, error.message);
        return null;
    }
}

/**
 * Main function
 */
async function main() {
    console.log('=== 3DBAG Tile Downloader for Zuidas ===');
    console.log(`Format: ${format}`);
    console.log(`LoD: ${lod}`);
    console.log(`Version: ${VERSION}\n`);
    
    // Create output directory
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    // Download tile index
    const tileIndexPath = path.join(OUTPUT_DIR, 'tile_index.fgb');
    if (!fs.existsSync(tileIndexPath)) {
        console.log('\n=== Downloading tile index ===');
        try {
            await downloadFile(TILE_INDEX_URL, tileIndexPath);
        } catch (error) {
            console.error('Failed to download tile index:', error.message);
            console.log('\n⚠️  Continuing with estimated tiles...\n');
        }
    } else {
        console.log('✓ Tile index already exists');
    }
    
    // Find tiles covering Zuidas
    const tiles = await findZuidasTiles();
    
    if (tiles.length === 0) {
        console.log('\n=== Manual Tile Selection Required ===');
        console.log('\nTo download 3DBAG tiles for Zuidas:');
        console.log('1. Visit: https://3dbag.nl/nl/download');
        console.log('2. Click "Kies een tegel" (Choose a tile)');
        console.log('3. Select tiles covering Zuidas area');
        console.log('4. Download in your preferred format');
        console.log('\nOR use 3D Tiles directly in Cesium (recommended):');
        console.log('   - No download needed');
        console.log('   - Streaming tiles');
        console.log('   - Better performance');
        console.log('   - See: src/threeDBagLoader.js\n');
        return;
    }
    
    // Download tiles
    console.log(`\n=== Downloading ${tiles.length} tiles ===`);
    const downloaded = [];
    const failed = [];
    
    for (let i = 0; i < tiles.length; i++) {
        const tileId = tiles[i];
        console.log(`\n[${i + 1}/${tiles.length}] Processing tile: ${tileId}`);
        
        const path = await downloadTile(tileId, format, lod);
        if (path) {
            downloaded.push(path);
        } else {
            failed.push(tileId);
        }
        
        // Small delay to avoid rate limiting
        if (i < tiles.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    // Summary
    console.log('\n=== Download Summary ===');
    console.log(`✓ Successfully downloaded: ${downloaded.length} tiles`);
    if (failed.length > 0) {
        console.log(`✗ Failed: ${failed.length} tiles`);
        console.log('Failed tiles:', failed.join(', '));
    }
    console.log(`\nFiles saved to: ${path.join(OUTPUT_DIR, format, lod)}`);
}

// Run
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});




