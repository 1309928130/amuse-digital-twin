/**
 * Download multiple historical GTFS vehicle position snapshots
 * Downloads snapshots at regular intervals over a specified time period
 * 
 * Usage:
 *   node download-historical-snapshots.js --start 2025-11-01 --end 2025-12-01 --interval 3600
 * 
 * Options:
 *   --start: Start date (YYYY-MM-DD)
 *   --end: End date (YYYY-MM-DD)
 *   --interval: Interval in seconds (default: 3600 = 1 hour)
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data', 'static-gtfs', 'snapshots');
const PROXY_BASE = 'http://localhost:3000/gtfs/';

/**
 * Wait for a specified number of seconds
 */
function wait(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

/**
 * Download a file with retry logic
 */
function downloadFile(url, filepath, description, retryCount = 0, maxRetries = 3) {
    return new Promise((resolve, reject) => {
        if (retryCount === 0) {
            console.log(`Downloading ${description}...`);
        } else {
            console.log(`  Retrying (attempt ${retryCount + 1}/${maxRetries + 1})...`);
        }
        
        const protocol = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(filepath);
        
        const request = protocol.get(url, (response) => {
            if (response.statusCode === 429) {
                file.close();
                if (fs.existsSync(filepath)) {
                    fs.unlinkSync(filepath);
                }
                
                if (retryCount < maxRetries) {
                    const waitTime = Math.pow(2, retryCount) * 10; // 10s, 20s, 40s
                    console.log(`  ⚠ Rate limited. Waiting ${waitTime}s...`);
                    return wait(waitTime)
                        .then(() => downloadFile(url, filepath, description, retryCount + 1, maxRetries))
                        .then(resolve)
                        .catch(reject);
                } else {
                    reject(new Error(`HTTP 429: Too Many Requests (tried ${maxRetries + 1} times)`));
                    return;
                }
            }
            
            if (response.statusCode !== 200) {
                file.close();
                if (fs.existsSync(filepath)) {
                    fs.unlinkSync(filepath);
                }
                reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage || 'Unknown error'}`));
                return;
            }
            
            const totalSize = parseInt(response.headers['content-length'] || '0', 10);
            let downloadedSize = 0;
            
            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                if (totalSize > 0) {
                    const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
                    process.stdout.write(`\r  Progress: ${percent}%`);
                }
            });
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                const sizeKB = (downloadedSize / 1024).toFixed(2);
                console.log(`\n  ✓ Downloaded: ${sizeKB} KB`);
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
            reject(new Error(err.message || 'Unknown error'));
        });
        
        request.setTimeout(30000, () => {
            request.destroy();
            file.close();
            if (fs.existsSync(filepath)) {
                fs.unlinkSync(filepath);
            }
            reject(new Error('Download timeout'));
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
 * Generate snapshot filename from timestamp
 */
function getSnapshotFilename(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `vehiclePositions-${year}-${month}-${day}-${hour}${minute}.pb`;
}

/**
 * Generate timestamps for the period
 */
function generateTimestamps(startDate, endDate, intervalSeconds) {
    const timestamps = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    const interval = intervalSeconds * 1000; // Convert to milliseconds
    
    let current = new Date(start);
    while (current <= end) {
        timestamps.push(new Date(current));
        current = new Date(current.getTime() + interval);
    }
    
    return timestamps;
}

/**
 * Main download function
 */
async function downloadHistoricalSnapshots() {
    // Parse command line arguments
    const args = process.argv.slice(2);
    let startDate = null;
    let endDate = null;
    let intervalSeconds = 3600; // Default: 1 hour
    
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--start' && args[i + 1]) {
            startDate = new Date(args[i + 1] + 'T00:00:00');
        } else if (args[i] === '--end' && args[i + 1]) {
            endDate = new Date(args[i + 1] + 'T23:59:59');
        } else if (args[i] === '--interval' && args[i + 1]) {
            intervalSeconds = parseInt(args[i + 1], 10);
        }
    }
    
    if (!startDate || !endDate) {
        console.error('');
        console.error('Usage: node download-historical-snapshots.js --start YYYY-MM-DD --end YYYY-MM-DD [--interval SECONDS]');
        console.error('');
        console.error('Example:');
        console.error('  node download-historical-snapshots.js --start 2025-11-01 --end 2025-12-01 --interval 3600');
        console.error('  (Downloads snapshots every hour from Nov 1 to Dec 1, 2025)');
        console.error('');
        process.exit(1);
    }
    
    console.log('='.repeat(60));
    console.log('Historical GTFS Snapshots Downloader');
    console.log('='.repeat(60));
    console.log('');
    console.log(`Period: ${startDate.toLocaleDateString()} to ${endDate.toLocaleDateString()}`);
    console.log(`Interval: ${intervalSeconds} seconds (${intervalSeconds / 60} minutes)`);
    console.log('');
    
    // Check proxy
    console.log('Checking if proxy server is running...');
    const proxyRunning = await checkProxyServer();
    
    if (!proxyRunning) {
        console.error('');
        console.error('✗ ERROR: Proxy server is not running!');
        console.error('');
        console.error('Please start the proxy server first:');
        console.error('  1. Open a new terminal');
        console.error('  2. Run: npm run proxy');
        console.error('  3. Then run this script again');
        console.error('');
        process.exit(1);
    }
    
    console.log('✓ Proxy server is running');
    console.log('');
    
    // Create directory
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log(`Created directory: ${DATA_DIR}`);
    }
    
    // Generate timestamps
    const timestamps = generateTimestamps(startDate, endDate, intervalSeconds);
    console.log(`Will download ${timestamps.length} snapshots`);
    console.log('');
    
    let successCount = 0;
    let failCount = 0;
    let skipCount = 0;
    
    for (let i = 0; i < timestamps.length; i++) {
        const timestamp = timestamps[i];
        const filename = getSnapshotFilename(timestamp);
        const filepath = path.join(DATA_DIR, filename);
        
        // Skip if already exists
        if (fs.existsSync(filepath)) {
            console.log(`[${i + 1}/${timestamps.length}] ⏭ Skipping ${filename} (already exists)`);
            skipCount++;
            continue;
        }
        
        try {
            console.log(`[${i + 1}/${timestamps.length}] ${timestamp.toLocaleString()}`);
            await downloadFile(
                `${PROXY_BASE}vehiclePositions.pb`,
                filepath,
                filename
            );
            successCount++;
            
            // Wait between downloads to avoid rate limiting
            if (i < timestamps.length - 1) {
                const delay = 5; // 5 seconds between downloads
                await wait(delay);
            }
        } catch (error) {
            console.error(`  ✗ Error: ${error.message}`);
            failCount++;
            
            // If rate limited, wait longer before continuing
            if (error.message.includes('429')) {
                console.log('  Waiting 60 seconds before continuing...');
                await wait(60);
            }
        }
        
        console.log('');
    }
    
    console.log('='.repeat(60));
    console.log('Download complete!');
    console.log(`  Success: ${successCount}`);
    console.log(`  Skipped: ${skipCount}`);
    console.log(`  Failed: ${failCount}`);
    console.log(`  Total: ${timestamps.length}`);
    console.log('');
    console.log(`Files saved to: ${DATA_DIR}`);
    console.log('');
    console.log('Note: These are CURRENT snapshots, not historical data.');
    console.log('For true historical data, you would need to:');
    console.log('  1. Run this script continuously over time to collect snapshots');
    console.log('  2. Or use schedule data to simulate historical positions');
    console.log('='.repeat(60));
}

downloadHistoricalSnapshots().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});

