/**
 * One-time script to download static GTFS data files from OVapi
 * Run with: node download-static-data.js
 * 
 * This downloads:
 * - vehiclePositions.pb (current snapshot)
 * - Static GTFS schedule data (optional, large file)
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data', 'static-gtfs');
const OVAPI_BASE = 'https://gtfs.ovapi.nl/nl/';
const PROXY_BASE = 'http://localhost:3000/gtfs/';

// Files to download
// Required: vehiclePositions.pb (for historical vehicle positions)
// Optional: tripUpdates.pb, trainUpdates.pb (for additional real-time data)
// Optional: gtfs-nl.zip (static schedule data - large file, useful for static mode)
const FILES_TO_DOWNLOAD = [
    {
        name: 'vehiclePositions.pb',
        url: `${PROXY_BASE}vehiclePositions.pb`,
        description: 'Vehicle positions snapshot (REQUIRED for historical mode)',
        required: true
    },
    {
        name: 'tripUpdates.pb',
        url: `${PROXY_BASE}tripUpdates.pb`,
        description: 'Trip updates snapshot (optional, for real-time trip info)',
        optional: true
    },
    {
        name: 'trainUpdates.pb',
        url: `${PROXY_BASE}trainUpdates.pb`,
        description: 'Train updates snapshot (optional, for train-specific data)',
        optional: true
    },
    {
        name: 'gtfs-nl.zip',
        url: `${PROXY_BASE}gtfs-nl.zip`,
        description: 'Static GTFS schedule data (optional, ~260MB, for static mode routes/schedules)',
        optional: true,
        largeFile: true
    }
];

/**
 * Wait for a specified number of seconds
 */
function wait(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

/**
 * Download a file with retry logic for rate limiting
 */
function downloadFile(url, filepath, description, retryCount = 0, maxRetries = 3) {
    return new Promise((resolve, reject) => {
        if (retryCount === 0) {
            console.log(`Downloading ${description}...`);
            console.log(`  From: ${url}`);
            console.log(`  To: ${filepath}`);
        } else {
            console.log(`Retrying download (attempt ${retryCount + 1}/${maxRetries + 1})...`);
        }
        
        const protocol = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(filepath);
        
        const request = protocol.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                // Handle redirect
                file.close();
                if (fs.existsSync(filepath)) {
                    fs.unlinkSync(filepath);
                }
                return downloadFile(response.headers.location, filepath, description, retryCount, maxRetries)
                    .then(resolve).catch(reject);
            }
            
            // Handle rate limiting (429) with retry
            if (response.statusCode === 429) {
                file.close();
                if (fs.existsSync(filepath)) {
                    fs.unlinkSync(filepath);
                }
                
                if (retryCount < maxRetries) {
                    const waitTime = Math.pow(2, retryCount) * 5; // Exponential backoff: 5s, 10s, 20s
                    console.log(`  ⚠ Rate limited (429). Waiting ${waitTime} seconds before retry...`);
                    return wait(waitTime)
                        .then(() => downloadFile(url, filepath, description, retryCount + 1, maxRetries))
                        .then(resolve)
                        .catch(reject);
                } else {
                    reject(new Error(`HTTP 429: Too Many Requests (tried ${maxRetries + 1} times). Please wait a few minutes and try again.`));
                    return;
                }
            }
            
            if (response.statusCode !== 200) {
                file.close();
                if (fs.existsSync(filepath)) {
                    fs.unlinkSync(filepath);
                }
                const errorMsg = `HTTP ${response.statusCode}: ${response.statusMessage || 'Unknown error'}`;
                reject(new Error(errorMsg));
                return;
            }
            
            const totalSize = parseInt(response.headers['content-length'] || '0', 10);
            let downloadedSize = 0;
            
            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                if (totalSize > 0) {
                    const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
                    const sizeMB = (downloadedSize / 1024 / 1024).toFixed(2);
                    const totalMB = (totalSize / 1024 / 1024).toFixed(2);
                    process.stdout.write(`\r  Progress: ${percent}% (${sizeMB} MB / ${totalMB} MB)`);
                } else {
                    process.stdout.write(`\r  Progress: ${(downloadedSize / 1024 / 1024).toFixed(2)} MB downloaded...`);
                }
            });
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                const sizeMB = downloadedSize / 1024 / 1024;
                const sizeKB = downloadedSize / 1024;
                const sizeStr = sizeMB >= 1 ? `${sizeMB.toFixed(2)} MB` : `${sizeKB.toFixed(2)} KB`;
                console.log(`\n  ✓ Downloaded: ${sizeStr}`);
                resolve();
            });
            
            file.on('error', (err) => {
                file.close();
                if (fs.existsSync(filepath)) {
                    fs.unlinkSync(filepath);
                }
                reject(new Error(`File write error: ${err.message}`));
            });
        });
        
        request.on('error', (err) => {
            file.close();
            if (fs.existsSync(filepath)) {
                fs.unlinkSync(filepath);
            }
            let errorMsg = err.message || 'Unknown error';
            if (err.code === 'ECONNREFUSED') {
                errorMsg = 'Connection refused. Is the proxy server running? (npm run proxy)';
            } else if (err.code === 'ENOTFOUND') {
                errorMsg = `Host not found: ${err.hostname || url}`;
            }
            reject(new Error(errorMsg));
        });
        
        request.setTimeout(30000, () => {
            request.destroy();
            file.close();
            if (fs.existsSync(filepath)) {
                fs.unlinkSync(filepath);
            }
            reject(new Error('Download timeout (30 seconds)'));
        });
    });
}

/**
 * Check if proxy server is running
 */
function checkProxyServer() {
    return new Promise((resolve) => {
        const testUrl = 'http://localhost:3000/gtfs/vehiclePositions.pb';
        http.get(testUrl, { timeout: 2000 }, (res) => {
            resolve(true);
        }).on('error', () => {
            resolve(false);
        }).on('timeout', () => {
            resolve(false);
        });
    });
}

/**
 * Main download function
 */
async function downloadStaticData() {
    console.log('='.repeat(60));
    console.log('OVapi Static GTFS Data Downloader');
    console.log('='.repeat(60));
    console.log('');
    
    // Check if proxy is running
    console.log('Checking if proxy server is running...');
    const proxyRunning = await checkProxyServer();
    
    if (!proxyRunning) {
        console.error('');
        console.error('✗ ERROR: Proxy server is not running!');
        console.error('');
        console.error('Please start the proxy server first:');
        console.error('  1. Open a new terminal');
        console.error('  2. Run: npm run proxy');
        console.error('  3. Then run this script again: npm run download-static');
        console.error('');
        process.exit(1);
    }
    
    console.log('✓ Proxy server is running');
    console.log('');
    
    // Create data directory
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log(`Created directory: ${DATA_DIR}`);
    }
    
    console.log(`Download directory: ${DATA_DIR}`);
    console.log('');
    console.log('Files to download:');
    console.log('  Required:');
    console.log('    - vehiclePositions.pb (for historical vehicle positions)');
    console.log('  Optional:');
    console.log('    - tripUpdates.pb (trip updates)');
    console.log('    - trainUpdates.pb (train updates)');
    console.log('    - gtfs-nl.zip (static schedule data, ~260MB, for static mode)');
    console.log('');
    console.log('Note: Large files like gtfs-nl.zip may take several minutes to download.');
    console.log('');
    
    let successCount = 0;
    let failCount = 0;
    
    for (const fileInfo of FILES_TO_DOWNLOAD) {
        const filepath = path.join(DATA_DIR, fileInfo.name);
        
        try {
            // Skip if file already exists
            if (fs.existsSync(filepath)) {
                const stats = fs.statSync(filepath);
                const sizeMB = stats.size / 1024 / 1024;
                const sizeKB = stats.size / 1024;
                const sizeStr = sizeMB >= 1 ? `${sizeMB.toFixed(2)} MB` : `${sizeKB.toFixed(2)} KB`;
                console.log(`⏭  Skipping ${fileInfo.name} (already exists, ${sizeStr})`);
                if (!fileInfo.optional) {
                    successCount++; // Count as success if required file exists
                }
                continue;
            }
            
            await downloadFile(fileInfo.url, filepath, fileInfo.description);
            successCount++;
            
            // Add a delay between downloads to avoid rate limiting
            // Longer delay for large files, and don't delay after the last file
            if (fileInfo !== FILES_TO_DOWNLOAD[FILES_TO_DOWNLOAD.length - 1]) {
                const delay = fileInfo.largeFile ? 5000 : 3000;
                console.log(`  Waiting ${delay/1000}s before next download...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        } catch (error) {
            if (fileInfo.optional) {
                console.log(`  ⚠ Warning: ${error.message} (optional file, continuing...)`);
            } else {
                console.error(`  ✗ Error: ${error.message}`);
                failCount++;
            }
        }
        
        console.log('');
    }
    
    console.log('='.repeat(60));
    console.log(`Download complete: ${successCount} succeeded, ${failCount} failed`);
    console.log(`Files saved to: ${DATA_DIR}`);
    console.log('');
    console.log('You can now use these files in historical mode.');
    console.log('='.repeat(60));
}

// Run the download
downloadStaticData().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});

