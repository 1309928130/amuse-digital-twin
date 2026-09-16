/**
 * Static Digital Twin - Static GTFS Data Handler
 * Handles static vehicle positions from snapshot files
 * Simulates vehicle positions from schedule data for past periods
 */

import { GTFS_CONFIG, ZUIDAS_BOUNDS } from './config.js';
import { parseGTFSRealtime, updateVehicleEntity, clearVehicles } from './gtfsCommon.js';

// GTFS static data cache
let gtfsStaticData = null;
let gtfsDataLoaded = false;

// Date-specific schedule data cache (keyed by date string)
const dateSpecificScheduleCache = new Map();

/**
 * Find the closest snapshot file for a given timestamp
 * @param {Date} timestamp - The timestamp to find snapshot for
 * @returns {string|null} Path to snapshot file or null if not found
 */
function findSnapshotFile(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    
    const snapshotsDir = './data/static-gtfs/snapshots/';
    const exactFilename = `vehiclePositions-${year}-${month}-${day}-${hour}${minute}.pb`;
    
    return snapshotsDir + exactFilename;
}

/**
 * Load static GTFS data from snapshot files or single static file
 * @param {Date} timestamp - The timestamp to load data for
 * @returns {Promise<Object>} Vehicle positions data
 */
async function loadStaticGTFSData(timestamp) {
    try {
        // First, try to load from snapshot files (if available)
        // This fails silently if snapshots don't exist - that's expected
        const snapshotPath = findSnapshotFile(timestamp);
        if (snapshotPath) {
            try {
                const response = await fetch(snapshotPath, {
                    headers: {
                        'Accept': 'application/x-protobuf, application/octet-stream'
                    }
                });
                
                if (response.ok) {
                    const arrayBuffer = await response.arrayBuffer();
                    if (arrayBuffer && arrayBuffer.byteLength > 0) {
                        console.log(`[Static Digital Twin] Loaded snapshot from ${snapshotPath}: ${arrayBuffer.byteLength} bytes`);
                        const parsedData = await parseGTFSRealtime(arrayBuffer);
                        return parsedData;
                    }
                }
                // 404 is expected - snapshots may not exist, fail silently
            } catch (snapshotError) {
                // Snapshot not found - this is normal, continue to other sources
                // Don't log error - it's expected that snapshots may not exist
            }
        }
        
        // Try to load from local static data file (single snapshot)
        const localStaticFile = GTFS_CONFIG.staticDataEndpoint;
        
        console.log(`Loading static GTFS data from local file: ${localStaticFile}`);
        
        try {
            const response = await fetch(localStaticFile, {
                headers: {
                    'Accept': 'application/x-protobuf, application/octet-stream'
                }
            });
            
            if (response.ok) {
                const arrayBuffer = await response.arrayBuffer();
                
                if (!arrayBuffer || arrayBuffer.byteLength === 0) {
                    throw new Error('Empty local file');
                }
                
                console.log(`Loaded static GTFS from local file: ${arrayBuffer.byteLength} bytes`);
                const parsedData = await parseGTFSRealtime(arrayBuffer);
                return parsedData;
            } else {
                throw new Error(`Local file not found (${response.status})`);
            }
        } catch (localError) {
            console.warn(`Could not load local static data: ${localError.message}`);
            console.warn('Tip: Run "npm run download-static" to download static data files');
            console.warn('Tip: Run "npm run download-historical" to download multiple snapshots for a time period');
            
            // Fallback: try to load from API (may hit rate limits)
            console.log('Falling back to API endpoint...');
            const response = await fetch(GTFS_CONFIG.vehiclePositionsEndpoint, {
                headers: {
                    'Accept': 'application/x-protobuf, application/octet-stream'
                }
            });
            
            if (!response.ok) {
                if (response.status === 429) {
                    throw new Error('Rate limited. Please download static data first using: npm run download-static');
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const arrayBuffer = await response.arrayBuffer();
            
            if (!arrayBuffer || arrayBuffer.byteLength === 0) {
                throw new Error('Empty response from API');
            }
            
            console.log(`Loaded static GTFS from API: ${arrayBuffer.byteLength} bytes`);
            const parsedData = await parseGTFSRealtime(arrayBuffer);
            return parsedData;
        }
    } catch (error) {
        console.error('Error loading static GTFS data:', error);
        return { vehicles: [] };
    }
}

/**
 * Load GTFS static schedule data from extracted files
 * This contains routes, stops, schedules - used for simulation
 */
async function loadGTFSScheduleData() {
    if (gtfsDataLoaded && gtfsStaticData) {
        return gtfsStaticData;
    }
    
    try {
        // Load from extracted files (after running npm run extract-gtfs)
        const baseDir = './data/static-gtfs/gtfs-extracted/';
        const routesFile = baseDir + 'routes.txt';
        const tripsFile = baseDir + 'trips.txt';
        const stopTimesFile = baseDir + 'stop_times.txt';
        const stopsFile = baseDir + 'stops.txt';
        const calendarFile = baseDir + 'calendar.txt';
        const calendarDatesFile = baseDir + 'calendar_dates.txt';
        
        console.log('[Static Digital Twin] Loading GTFS schedule data for simulation...');
        
        try {
            const [routesRes, tripsRes, stopTimesRes, stopsRes, calendarRes, calendarDatesRes] = await Promise.all([
                fetch(routesFile).catch(() => null),
                fetch(tripsFile).catch(() => null),
                fetch(stopTimesFile).catch(() => null),
                fetch(stopsFile).catch(() => null),
                fetch(calendarFile).catch(() => null),
                fetch(calendarDatesFile).catch(() => null)
            ]);
            
            if (routesRes?.ok && tripsRes?.ok && stopTimesRes?.ok && stopsRes?.ok) {
                const [routesText, tripsText, stopTimesText, stopsText, calendarText, calendarDatesText] = await Promise.all([
                    routesRes.text(),
                    tripsRes.text(),
                    stopTimesRes.text(),
                    stopsRes.text(),
                    calendarRes?.ok ? calendarRes.text() : '',
                    calendarDatesRes?.ok ? calendarDatesRes.text() : ''
                ]);
                
                // Parse CSV files
                gtfsStaticData = {
                    routes: parseCSV(routesText),
                    trips: parseCSV(tripsText),
                    stopTimes: parseCSV(stopTimesText),
                    stops: parseCSV(stopsText),
                    calendar: calendarText ? parseCSV(calendarText) : [],
                    calendarDates: calendarDatesText ? parseCSV(calendarDatesText) : []
                };
                
                // Create lookup maps for faster access
                gtfsStaticData.stopsMap = new Map();
                gtfsStaticData.stops.forEach(stop => {
                    gtfsStaticData.stopsMap.set(stop.stop_id, stop);
                });
                
                gtfsStaticData.tripsMap = new Map();
                gtfsStaticData.trips.forEach(trip => {
                    gtfsStaticData.tripsMap.set(trip.trip_id, trip);
                });
                
                gtfsStaticData.stopTimesByTrip = new Map();
                gtfsStaticData.stopTimes.forEach(st => {
                    if (!gtfsStaticData.stopTimesByTrip.has(st.trip_id)) {
                        gtfsStaticData.stopTimesByTrip.set(st.trip_id, []);
                    }
                    gtfsStaticData.stopTimesByTrip.get(st.trip_id).push(st);
                });
                
                // Sort stop_times by stop_sequence
                gtfsStaticData.stopTimesByTrip.forEach(times => {
                    times.sort((a, b) => {
                        const seqA = parseInt(a.stop_sequence || 0);
                        const seqB = parseInt(b.stop_sequence || 0);
                        return seqA - seqB;
                    });
                });
                
                gtfsDataLoaded = true;
                console.log(`[Static Digital Twin] ✓ Loaded GTFS schedule data:`);
                console.log(`  Routes: ${gtfsStaticData.routes.length}`);
                console.log(`  Trips: ${gtfsStaticData.trips.length}`);
                console.log(`  Stops: ${gtfsStaticData.stops.length}`);
                console.log(`  Stop times: ${gtfsStaticData.stopTimes.length}`);
                return gtfsStaticData;
            }
        } catch (error) {
            console.warn('[Static Digital Twin] GTFS schedule files not found.');
            console.warn('  Run: npm run extract-gtfs');
        }
        
        console.warn('[Static Digital Twin] Schedule-based simulation disabled.');
        return null;
    } catch (error) {
        console.error('[Static Digital Twin] Error loading GTFS schedule data:', error);
        return null;
    }
}

/**
 * Load date-specific GTFS schedule data
 * @param {string} dateStr - Date string in YYYY-MM-DD format
 * @returns {Promise<Object|null>} Schedule data object or null if not found
 */
export async function loadDateSpecificScheduleData(dateStr) {
    // Check cache first
    if (dateSpecificScheduleCache.has(dateStr)) {
        return dateSpecificScheduleCache.get(dateStr);
    }
    
    try {
        const baseDir = `./data/static-gtfs/gtfs-zuidas-${dateStr}/`;
        console.log(`[Schedule Simulation] Loading date-specific data from ${baseDir}...`);
        
        const [routesRes, tripsRes, stopTimesRes, stopsRes, shapesRes, calendarDatesRes] = await Promise.all([
            fetch(baseDir + 'routes.txt').catch(() => null),
            fetch(baseDir + 'trips.txt').catch(() => null),
            fetch(baseDir + 'stop_times.txt').catch(() => null),
            fetch(baseDir + 'stops.txt').catch(() => null),
            fetch(baseDir + 'shapes.txt').catch(() => null),
            fetch(baseDir + 'calendar_dates.txt').catch(() => null)
        ]);
        
        if (!routesRes?.ok || !tripsRes?.ok || !stopTimesRes?.ok || !stopsRes?.ok) {
            console.warn(`[Schedule Simulation] Could not load date-specific data for ${dateStr}`);
            return null;
        }
        
        const [routesText, tripsText, stopTimesText, stopsText, shapesText, calendarDatesText] = await Promise.all([
            routesRes.text(),
            tripsRes.text(),
            stopTimesRes.text(),
            stopsRes.text(),
            shapesRes?.ok ? shapesRes.text() : null,
            calendarDatesRes?.ok ? calendarDatesRes.text() : null
        ]);
        
        // Parse CSV files
        const scheduleData = {
            routes: parseCSV(routesText),
            trips: parseCSV(tripsText),
            stopTimes: parseCSV(stopTimesText),
            stops: parseCSV(stopsText),
            shapes: shapesText ? parseCSV(shapesText) : [],
            calendarDates: calendarDatesText ? parseCSV(calendarDatesText) : [],
            dateStr: dateStr
        };
        
        // Create lookup maps
        scheduleData.stopsMap = new Map();
        scheduleData.stops.forEach(stop => {
            scheduleData.stopsMap.set(stop.stop_id, stop);
        });
        
        scheduleData.tripsMap = new Map();
        scheduleData.trips.forEach(trip => {
            scheduleData.tripsMap.set(trip.trip_id, trip);
        });
        
        scheduleData.stopTimesByTrip = new Map();
        scheduleData.stopTimes.forEach(st => {
            if (!scheduleData.stopTimesByTrip.has(st.trip_id)) {
                scheduleData.stopTimesByTrip.set(st.trip_id, []);
            }
            scheduleData.stopTimesByTrip.get(st.trip_id).push(st);
        });
        
        // Sort stop_times by stop_sequence
        scheduleData.stopTimesByTrip.forEach(times => {
            times.sort((a, b) => {
                const seqA = parseInt(a.stop_sequence || 0);
                const seqB = parseInt(b.stop_sequence || 0);
                return seqA - seqB;
            });
        });
        
        // Create shapes map
        scheduleData.shapesMap = new Map();
        if (scheduleData.shapes && scheduleData.shapes.length > 0) {
            scheduleData.shapes.forEach(shape => {
                const shapeId = shape.shape_id;
                if (!scheduleData.shapesMap.has(shapeId)) {
                    scheduleData.shapesMap.set(shapeId, []);
                }
                scheduleData.shapesMap.get(shapeId).push(shape);
            });
            
            // Sort each shape's points by sequence
            scheduleData.shapesMap.forEach((points, shapeId) => {
                points.sort((a, b) => {
                    const seqA = parseInt(a.shape_pt_sequence || 0);
                    const seqB = parseInt(b.shape_pt_sequence || 0);
                    return seqA - seqB;
                });
            });
        }
        
        // Cache the data
        dateSpecificScheduleCache.set(dateStr, scheduleData);
        
        console.log(`[Schedule Simulation] ✓ Loaded date-specific data for ${dateStr}:`);
        console.log(`  Routes: ${scheduleData.routes.length}`);
        console.log(`  Trips: ${scheduleData.trips.length}`);
        console.log(`  Stops: ${scheduleData.stops.length}`);
        console.log(`  Stop times: ${scheduleData.stopTimes.length}`);
        console.log(`  Shapes: ${scheduleData.shapes.length}`);
        
        return scheduleData;
    } catch (error) {
        console.error(`[Schedule Simulation] Error loading date-specific data for ${dateStr}:`, error);
        return null;
    }
}

/**
 * Clear date-specific schedule cache
 * @param {string} dateStr - Optional date string to clear specific date, or null to clear all
 */
export function clearDateSpecificScheduleCache(dateStr = null) {
    if (dateStr) {
        dateSpecificScheduleCache.delete(dateStr);
    } else {
        dateSpecificScheduleCache.clear();
    }
}

/**
 * Simple CSV parser (for GTFS files)
 * Handles quoted values and commas within quotes
 */
function parseCSV(text) {
    const lines = text.split('\n').filter(line => line.trim());
    if (lines.length === 0) return [];
    
    // Parse header
    const headers = parseCSVLine(lines[0]);
    const rows = [];
    
    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length === 0) continue;
        
        const row = {};
        headers.forEach((header, index) => {
            row[header] = values[index] || '';
        });
        rows.push(row);
    }
    
    return rows;
}

/**
 * Parse a single CSV line, handling quoted values
 */
function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            values.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    
    values.push(current.trim());
    return values;
}

/**
 * Check if a point is within Zuidas bounds
 */
function isInZuidasArea(lat, lon) {
    return lat >= ZUIDAS_BOUNDS.south && lat <= ZUIDAS_BOUNDS.north &&
           lon >= ZUIDAS_BOUNDS.west && lon <= ZUIDAS_BOUNDS.east;
}

/**
 * Check if a trip passes through Zuidas area
 */
function tripPassesThroughZuidas(tripId, scheduleData) {
    const stopTimes = scheduleData.stopTimesByTrip.get(tripId);
    if (!stopTimes) return false;
    
    for (const st of stopTimes) {
        const stop = scheduleData.stopsMap.get(st.stop_id);
        if (stop && stop.stop_lat && stop.stop_lon) {
            const lat = parseFloat(stop.stop_lat);
            const lon = parseFloat(stop.stop_lon);
            if (isInZuidasArea(lat, lon)) {
                return true;
            }
        }
    }
    
    return false;
}

/**
 * Detect time range from stop_times for a given date
 * @param {Object} scheduleData - Schedule data object
 * @returns {Object} Object with startTime and endTime in seconds since midnight
 */
export function detectTimeRangeFromStopTimes(scheduleData) {
    if (!scheduleData || !scheduleData.stopTimes || scheduleData.stopTimes.length === 0) {
        return { startTime: 0, endTime: 86400 }; // Default to full day
    }
    
    let earliestTime = Infinity;
    let latestTime = -Infinity;
    
    scheduleData.stopTimes.forEach(st => {
        const arrival = timeToSeconds(st.arrival_time);
        const departure = timeToSeconds(st.departure_time);
        
        if (arrival > 0) {
            earliestTime = Math.min(earliestTime, arrival);
            latestTime = Math.max(latestTime, arrival);
        }
        if (departure > 0) {
            earliestTime = Math.min(earliestTime, departure);
            latestTime = Math.max(latestTime, departure);
        }
    });
    
    // Handle overnight services (times > 24:00:00 = 86400 seconds)
    // Normalize to same day for simplicity
    if (earliestTime === Infinity) {
        earliestTime = 0; // Midnight
    }
    if (latestTime === -Infinity) {
        latestTime = 86400; // End of day
    }
    
    // If latest time is > 24 hours, it's an overnight service
    // For display purposes, we'll cap at 24 hours but note it
    const normalizedLatest = latestTime > 86400 ? 86400 : latestTime;
    
    return {
        startTime: Math.max(0, earliestTime),
        endTime: normalizedLatest,
        hasOvernight: latestTime > 86400
    };
}

/**
 * Interpolate position along shape points
 * @param {Array} shapePoints - Array of shape points sorted by sequence
 * @param {Object} currentStop - Current stop_time object
 * @param {Object} nextStop - Next stop_time object
 * @param {number} progress - Progress from 0 to 1 between stops
 * @returns {Object|null} Position {latitude, longitude} or null if cannot interpolate
 */
function interpolateAlongShape(shapePoints, currentStop, nextStop, progress) {
    if (!shapePoints || shapePoints.length === 0) {
        return null;
    }
    
    // Try to use shape_dist_traveled if available
    const currentDist = parseFloat(currentStop.shape_dist_traveled || 0);
    const nextDist = parseFloat(nextStop.shape_dist_traveled || 0);
    
    if (currentDist > 0 && nextDist > 0 && nextDist > currentDist) {
        // Interpolate based on distance
        const targetDist = currentDist + (nextDist - currentDist) * progress;
        
        // Find the two shape points that bracket targetDist
        for (let i = 0; i < shapePoints.length - 1; i++) {
            const dist1 = parseFloat(shapePoints[i].shape_dist_traveled || 0);
            const dist2 = parseFloat(shapePoints[i + 1].shape_dist_traveled || 0);
            
            if (targetDist >= dist1 && targetDist <= dist2) {
                // Interpolate between these two shape points
                const segmentProgress = (targetDist - dist1) / (dist2 - dist1);
                const lat1 = parseFloat(shapePoints[i].shape_pt_lat);
                const lon1 = parseFloat(shapePoints[i].shape_pt_lon);
                const lat2 = parseFloat(shapePoints[i + 1].shape_pt_lat);
                const lon2 = parseFloat(shapePoints[i + 1].shape_pt_lon);
                
                return {
                    latitude: lat1 + (lat2 - lat1) * segmentProgress,
                    longitude: lon1 + (lon2 - lon1) * segmentProgress
                };
            }
        }
    }
    
    // Fallback: use sequence-based interpolation
    // Find stops in shape sequence (approximate)
    const currentSeq = parseInt(currentStop.stop_sequence || 0);
    const nextSeq = parseInt(nextStop.stop_sequence || 0);
    const totalStops = nextSeq - currentSeq;
    
    if (totalStops > 0 && shapePoints.length > 0) {
        // Estimate position based on sequence
        const startIdx = Math.floor((currentSeq / (nextSeq + 1)) * shapePoints.length);
        const endIdx = Math.floor((nextSeq / (nextSeq + 1)) * shapePoints.length);
        const segmentLength = endIdx - startIdx;
        
        if (segmentLength > 0) {
            const pointIdx = Math.floor(startIdx + segmentLength * progress);
            const clampedIdx = Math.min(Math.max(0, pointIdx), shapePoints.length - 1);
            const point = shapePoints[clampedIdx];
            
            return {
                latitude: parseFloat(point.shape_pt_lat),
                longitude: parseFloat(point.shape_pt_lon)
            };
        }
    }
    
    return null;
}

/**
 * Convert time string (HH:MM:SS) to seconds since midnight
 */
function timeToSeconds(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    if (parts.length < 2) return 0;
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + (parseInt(parts[2]) || 0);
}

/**
 * Convert seconds since midnight to time string
 */
function secondsToTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Calculate distance between two lat/lon points (Haversine formula)
 * Returns distance in meters
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Calculate bearing from point 1 to point 2 (in degrees)
 */
function calculateBearing(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    
    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
              Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
    
    const bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360;
}

/**
 * Check if a service is available on a given date
 */
function isServiceAvailable(serviceId, date, scheduleData) {
    const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
    const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = dayNames[dayOfWeek];
    
    // Check calendar_dates for exceptions
    for (const cd of scheduleData.calendarDates || []) {
        if (cd.service_id === serviceId && cd.date === dateStr) {
            return cd.exception_type === '1'; // 1 = added, 2 = removed
        }
    }
    
    // Check calendar for regular service
    for (const cal of scheduleData.calendar || []) {
        if (cal.service_id === serviceId) {
            const startDate = cal.start_date;
            const endDate = cal.end_date;
            if (dateStr >= startDate && dateStr <= endDate) {
                return cal[dayName] === '1';
            }
        }
    }
    
    return false;
}

/**
 * Simulate vehicle positions from schedule data
 * Calculates where vehicles should be at a given time based on routes and schedules
 * Only includes vehicles whose trajectories pass through Zuidas area
 * @param {Date} timestamp - The timestamp to simulate positions for
 * @param {string} dateStr - Optional date string (YYYY-MM-DD) for date-specific data
 * @returns {Promise<Object>} Simulated vehicle positions
 */
export async function simulateVehiclePositions(timestamp, dateStr = null) {
    let scheduleData;
    
    // Try date-specific data first if date is provided
    if (dateStr) {
        scheduleData = await loadDateSpecificScheduleData(dateStr);
    }
    
    // Fall back to general schedule data if date-specific not available
    if (!scheduleData) {
        scheduleData = await loadGTFSScheduleData();
    }
    
    if (!scheduleData) {
        console.warn('[Static Digital Twin] Cannot simulate: GTFS schedule data not loaded');
        if (dateStr) {
            console.warn(`  Date-specific data for ${dateStr} not found`);
        } else {
            console.warn('  Run: npm run extract-gtfs');
        }
        return { vehicles: [] };
    }
    
    const targetTime = new Date(timestamp);
    const targetDateStr = targetTime.toISOString().split('T')[0].replace(/-/g, '');
    const targetSeconds = targetTime.getHours() * 3600 + targetTime.getMinutes() * 60 + targetTime.getSeconds();
    
    console.log(`[Static Digital Twin] Simulating vehicle positions for ${timestamp.toISOString()}...`);
    
    const vehicles = [];
    const processedTrips = new Set();
    
    // Find all trips that pass through Zuidas area
    const zuidasTrips = [];
    for (const trip of scheduleData.trips) {
        if (tripPassesThroughZuidas(trip.trip_id, scheduleData)) {
            zuidasTrips.push(trip);
        }
    }
    
    console.log(`[Static Digital Twin] Found ${zuidasTrips.length} trips passing through Zuidas area`);
    
    // Performance: Limit to max 100 active vehicles to avoid performance issues
    const MAX_VEHICLES = 100;
    let vehicleCount = 0;
    
    // For each trip, check if it's active at this time and calculate vehicle position
    for (const trip of zuidasTrips) {
        // Stop if we've reached the limit
        if (vehicleCount >= MAX_VEHICLES) {
            console.log(`[Static Digital Twin] Reached vehicle limit (${MAX_VEHICLES}), stopping simulation`);
            break;
        }
        // Check if service is available on this date
        if (!isServiceAvailable(trip.service_id, targetTime, scheduleData)) {
            continue;
        }
        
        const stopTimes = scheduleData.stopTimesByTrip.get(trip.trip_id);
        if (!stopTimes || stopTimes.length < 2) continue;
        
        // Find the segment the vehicle is currently in
        for (let i = 0; i < stopTimes.length - 1; i++) {
            const currentStop = stopTimes[i];
            const nextStop = stopTimes[i + 1];
            
            const currentArrival = timeToSeconds(currentStop.arrival_time);
            const nextArrival = timeToSeconds(nextStop.arrival_time);
            
            // Check if vehicle is between these two stops at target time
            if (targetSeconds >= currentArrival && targetSeconds <= nextArrival) {
                const currentStopData = scheduleData.stopsMap.get(currentStop.stop_id);
                const nextStopData = scheduleData.stopsMap.get(nextStop.stop_id);
                
                if (!currentStopData || !nextStopData) continue;
                
                const lat1 = parseFloat(currentStopData.stop_lat);
                const lon1 = parseFloat(currentStopData.stop_lon);
                const lat2 = parseFloat(nextStopData.stop_lat);
                const lon2 = parseFloat(nextStopData.stop_lon);
                
                // Interpolate position based on time
                const timeDiff = nextArrival - currentArrival;
                const elapsed = targetSeconds - currentArrival;
                const progress = timeDiff > 0 ? elapsed / timeDiff : 0;
                
                // Try shape-based interpolation first, fall back to linear
                let position = null;
                const trip = scheduleData.tripsMap.get(stopTimes[0].trip_id);
                const shapeId = trip?.shape_id;
                
                if (shapeId && scheduleData.shapesMap && scheduleData.shapesMap.has(shapeId)) {
                    const shapePoints = scheduleData.shapesMap.get(shapeId);
                    position = interpolateAlongShape(shapePoints, currentStop, nextStop, progress);
                }
                
                // Fall back to linear interpolation if shape interpolation failed
                if (!position) {
                    position = {
                        latitude: lat1 + (lat2 - lat1) * progress,
                        longitude: lon1 + (lon2 - lon1) * progress
                    };
                }
                
                const lat = position.latitude;
                const lon = position.longitude;
                
                // Only include if in or near Zuidas area (within 2km)
                const centerLat = (ZUIDAS_BOUNDS.north + ZUIDAS_BOUNDS.south) / 2;
                const centerLon = (ZUIDAS_BOUNDS.east + ZUIDAS_BOUNDS.west) / 2;
                
                if (isInZuidasArea(lat, lon) || 
                    calculateDistance(lat, lon, centerLat, centerLon) < 2000) {
                    
                    // Calculate bearing based on interpolated position direction
                    // Use next stop for bearing calculation
                    const nextLat = parseFloat(nextStopData.stop_lat);
                    const nextLon = parseFloat(nextStopData.stop_lon);
                    const bearing = calculateBearing(lat, lon, nextLat, nextLon);
                    
                    // Calculate speed based on distance and time
                    const distance = calculateDistance(lat, lon, nextLat, nextLon);
                    const speed = timeDiff > 0 ? (distance / timeDiff) * 3.6 : 0; // km/h
                    
                    const route = scheduleData.routes.find(r => r.route_id === trip.route_id);
                    const routeShortName = route?.route_short_name || trip.route_id;
                    
                    vehicles.push({
                        id: `sim_${trip.trip_id}_${i}`,
                        position: {
                            latitude: lat,
                            longitude: lon,
                            bearing: bearing,
                            speed: speed
                        },
                        vehicle: {
                            id: trip.trip_id,
                            label: `${routeShortName} ${trip.trip_headsign || ''}`.trim(),
                            licensePlate: null
                        },
                        timestamp: timestamp
                    });
                    
                    processedTrips.add(trip.trip_id);
                    vehicleCount++;
                    break; // Only one vehicle per trip at a time
                }
            }
        }
    }
    
    console.log(`[Static Digital Twin] ✓ Simulated ${vehicles.length} vehicles from schedule data`);
    return { vehicles };
}

/**
 * Load static GTFS data for historical/static mode
 * Prioritizes schedule-based simulation for dynamic movement, then falls back to snapshots/static file
 * @param {Date} timestamp - The timestamp to load data for
 * @param {string} dateStr - Optional date string to skip snapshot loading (use schedule simulation instead)
 * @returns {Promise<Object>} Vehicle positions data
 */
export async function loadStaticGTFSDataForTimestamp(timestamp, dateStr = null) {
    // If date-specific data is available, skip snapshot loading (use schedule simulation instead)
    if (dateStr) {
        return { vehicles: [] }; // Return empty, schedule simulation will be used
    }
    
    // Schedule-based simulation is disabled to reduce heavy display
    // Skip simulation and go straight to static snapshots/file
    
    // Try snapshot files (optional - may not exist, but provide dynamic movement if available)
    // Note: We check for snapshots but don't log 404 errors since they're expected
    const snapshotPath = findSnapshotFile(timestamp);
    if (snapshotPath) {
        try {
            const response = await fetch(snapshotPath, {
                headers: {
                    'Accept': 'application/x-protobuf, application/octet-stream'
                }
            }).catch(() => null); // Silently catch network errors (404 is expected)
            
            if (response && response.ok) {
                const arrayBuffer = await response.arrayBuffer();
                if (arrayBuffer && arrayBuffer.byteLength > 0) {
                    console.log(`[Static Digital Twin] ✓ Loaded snapshot: ${arrayBuffer.byteLength} bytes`);
                    const parsedData = await parseGTFSRealtime(arrayBuffer);
                    return parsedData;
                }
            }
            // 404 is expected if snapshots don't exist - fail silently (don't log or throw)
        } catch (error) {
            // Snapshot not found - this is normal, continue silently
            // Suppress all errors to avoid console spam
        }
    }
    
    // Try static file (single snapshot - static positions, vehicles won't move)
    try {
        const staticFile = GTFS_CONFIG.staticDataEndpoint;
        const response = await fetch(staticFile, {
            headers: {
                'Accept': 'application/x-protobuf, application/octet-stream'
            }
        });
        
        if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            if (arrayBuffer && arrayBuffer.byteLength > 0) {
                console.log(`[Static Digital Twin] ✓ Loaded static file: ${arrayBuffer.byteLength} bytes`);
                console.log(`  Note: This is a single snapshot - vehicles won't move with time changes`);
                console.log(`  Tip: Use schedule simulation or download multiple snapshots for dynamic movement`);
                const parsedData = await parseGTFSRealtime(arrayBuffer);
                return parsedData;
            }
        }
    } catch (error) {
        console.warn(`[Static Digital Twin] Could not load static file: ${error.message}`);
    }
    
    return { vehicles: [] };
}

/**
 * Show historical/static data for a given timestamp
 * Used in static mode to display vehicle positions
 * @param {Date} timestamp - The timestamp to display
 * @param {string} dateStr - Optional date string (YYYY-MM-DD) for date-specific schedule simulation
 */
export async function showHistoricalData(timestamp, dateStr = null) {
    // Check if schedule simulation is enabled
    if (dateStr && GTFS_CONFIG.enableScheduleSimulation) {
        try {
            const simulatedData = await simulateVehiclePositions(timestamp, dateStr);
            if (simulatedData && simulatedData.vehicles && simulatedData.vehicles.length > 0) {
                clearVehicles();
                
                simulatedData.vehicles.forEach(vehicle => {
                    if (vehicle.position) {
                        updateVehicleEntity({
                            id: vehicle.id,
                            position: vehicle.position,
                            vehicle: vehicle.vehicle,
                            timestamp: vehicle.timestamp || timestamp
                        });
                    }
                });
                
                console.log(`[Schedule Simulation] Showing ${simulatedData.vehicles.length} vehicles for ${timestamp.toISOString()}`);
                return;
            } else {
                console.log(`[Schedule Simulation] No vehicles found for ${timestamp.toISOString()}`);
                clearVehicles();
                return;
            }
        } catch (error) {
            console.error(`[Schedule Simulation] Error simulating vehicles:`, error);
            clearVehicles();
            return;
        }
    }
    
    // Schedule simulation is disabled or dateStr not provided
    // Fall back to snapshot/static file loading
    if (dateStr && !GTFS_CONFIG.enableScheduleSimulation) {
        console.log(`[Offline Mode] Schedule simulation disabled. Looking for snapshot files for ${dateStr}...`);
        console.log(`[Offline Mode] Tip: Use SUMO mode for simulation, or enable schedule simulation in config.js`);
    }
    
    // Fall back to static data (snapshots, static file)
    const staticData = await loadStaticGTFSDataForTimestamp(timestamp, dateStr && !GTFS_CONFIG.enableScheduleSimulation ? null : dateStr);
    
    if (staticData && staticData.vehicles && staticData.vehicles.length > 0) {
        clearVehicles();
        
        staticData.vehicles.forEach(vehicle => {
            if (vehicle.position) {
                updateVehicleEntity({
                    id: vehicle.id,
                    position: vehicle.position,
                    vehicle: vehicle.vehicle
                });
            }
        });
        
        console.log(`[Static Digital Twin] Showing ${staticData.vehicles.length} vehicles for ${timestamp.toISOString()}`);
    } else {
        console.log(`[Static Digital Twin] No static data available for ${timestamp.toISOString()}`);
        if (!dateStr) {
            console.log(`  Tip: Run "npm run download-static" to download static data`);
            console.log(`  Tip: Run "npm run download-historical" to download multiple snapshots`);
        }
        clearVehicles();
    }
}

