/**
 * Extract GTFS schedule data from zip file
 * Extracts routes.txt, trips.txt, stop_times.txt, stops.txt for schedule-based simulation
 * 
 * Run with: node extract-gtfs-schedule.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GTFS_ZIP = path.join(__dirname, 'data', 'static-gtfs', 'gtfs-nl.zip');
const EXTRACT_DIR = path.join(__dirname, 'data', 'static-gtfs', 'gtfs-extracted');

// Files we need for simulation
const REQUIRED_FILES = [
    'routes.txt',
    'trips.txt',
    'stop_times.txt',
    'stops.txt',
    'calendar.txt',      // Service availability
    'calendar_dates.txt' // Service exceptions
];

/**
 * Extract GTFS zip file
 */
async function extractGTFS() {
    console.log('='.repeat(60));
    console.log('GTFS Schedule Data Extractor');
    console.log('='.repeat(60));
    console.log('');
    
    // Check if zip file exists
    if (!fs.existsSync(GTFS_ZIP)) {
        console.error(`✗ GTFS zip file not found: ${GTFS_ZIP}`);
        console.error('');
        console.error('Please download it first:');
        console.error('  1. Start proxy: npm run proxy');
        console.error('  2. Download: npm run download-static');
        console.error('');
        process.exit(1);
    }
    
    console.log(`Source: ${GTFS_ZIP}`);
    console.log(`Extract to: ${EXTRACT_DIR}`);
    console.log('');
    
    // Create extract directory
    if (!fs.existsSync(EXTRACT_DIR)) {
        fs.mkdirSync(EXTRACT_DIR, { recursive: true });
        console.log(`Created directory: ${EXTRACT_DIR}`);
    }
    
    try {
        console.log('Extracting GTFS zip file...');
        const zip = new AdmZip(GTFS_ZIP);
        
        // Extract only the files we need
        const entries = zip.getEntries();
        let extractedCount = 0;
        
        for (const entry of entries) {
            if (REQUIRED_FILES.includes(entry.entryName)) {
                const filePath = path.join(EXTRACT_DIR, entry.entryName);
                zip.extractEntryTo(entry, EXTRACT_DIR, false, true);
                extractedCount++;
                
                const stats = fs.statSync(filePath);
                console.log(`  ✓ Extracted ${entry.entryName} (${(stats.size / 1024).toFixed(2)} KB)`);
            }
        }
        
        console.log('');
        console.log(`Extracted ${extractedCount} files`);
        console.log(`Files saved to: ${EXTRACT_DIR}`);
        console.log('');
        console.log('='.repeat(60));
        console.log('Extraction complete!');
        console.log('You can now use schedule-based simulation.');
        console.log('='.repeat(60));
        
    } catch (error) {
        console.error('');
        console.error('✗ Error extracting GTFS zip:', error.message);
        console.error('');
        process.exit(1);
    }
}

extractGTFS().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});

