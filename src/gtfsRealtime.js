/**
 * Dynamic Digital Twin - Real-time GTFS Data Handler
 * Handles live vehicle positions from GTFS-realtime API
 * Collects snapshots for historical playback
 */

import { getViewer } from './cesiumViewer.js';
import { GTFS_CONFIG } from './config.js';
import { 
    initializeProtobuf, 
    parseGTFSRealtime, 
    updateVehicleEntity, 
    clearVehicles,
    vehicleEntities,
    getVehicleType,
    vehicleRoutePolylines,
    vehiclePositionHistory,
    loadRouteTypeMap
} from './gtfsCommon.js';

let updateIntervalId = null;
const historicalData = new Map(); // Map of timestamp -> vehicle positions
let consecutiveErrors = 0; // Track consecutive errors for backoff
let lastErrorTime = 0; // Track when last error occurred
let backoffMultiplier = 1; // Exponential backoff multiplier

/**
 * Fetch GTFS real-time data from OVapi
 * Used in real-time mode to get live vehicle positions
 * @returns {Promise<Object>} Vehicle positions data
 */
async function fetchGTFSData() {
    try {
        if (GTFS_CONFIG.useMockData) {
            const response = await fetch(GTFS_CONFIG.mockEndpoint);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return await response.json();
        } else {
            try {
                const response = await fetch(GTFS_CONFIG.vehiclePositionsEndpoint, {
                    headers: {
                        'Accept': 'application/x-protobuf, application/octet-stream'
                    }
                });
                
                if (!response.ok) {
                    if (response.status === 429) {
                        consecutiveErrors++;
                        lastErrorTime = Date.now();
                        const backoffDelay = Math.min(300000, 30000 * Math.pow(2, consecutiveErrors - 1));
                        console.warn(`Rate limited by OVapi (attempt ${consecutiveErrors}). Trying static fallback…`);
                        // Prefer local snapshot over empty map while rate-limited
                        try {
                            const fallback = await fetch(GTFS_CONFIG.staticDataEndpoint, { cache: 'no-store' });
                            if (fallback.ok) {
                                const arrayBuffer = await fallback.arrayBuffer();
                                if (arrayBuffer.byteLength > 0) {
                                    console.warn(`Using static GTFS snapshot (${arrayBuffer.byteLength} bytes) while rate-limited`);
                                    return await parseGTFSRealtime(arrayBuffer);
                                }
                            }
                        } catch (fallbackErr) {
                            console.warn('Static GTFS fallback failed:', fallbackErr.message || fallbackErr);
                        }
                        console.warn(`Will retry live feed after ${Math.round(backoffDelay / 1000)}s`);
                        throw new Error(`Rate limited (429). Backoff: ${backoffDelay}ms`);
                    }
                    // Reset error counter on non-rate-limit errors
                    if (response.status !== 429) {
                        consecutiveErrors = 0;
                    }
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                // Success - reset error counters
                consecutiveErrors = 0;
                backoffMultiplier = 1;
                
                const arrayBuffer = await response.arrayBuffer();
                
                if (!arrayBuffer || arrayBuffer.byteLength === 0) {
                    console.warn('Received empty response from GTFS API');
                    return { vehicles: [] };
                }

                // Proxy sometimes forwards HTML 429 with status 200 — detect and fall back
                const head = new Uint8Array(arrayBuffer.slice(0, 16));
                const looksHtml = head[0] === 0x3c; // '<'
                if (looksHtml) {
                    console.warn('GTFS response looks like HTML (rate limit page). Using static fallback…');
                    const fallback = await fetch(GTFS_CONFIG.staticDataEndpoint, { cache: 'no-store' });
                    if (fallback.ok) {
                        return await parseGTFSRealtime(await fallback.arrayBuffer());
                    }
                    return { vehicles: [] };
                }
                
                console.log(`Received ${arrayBuffer.byteLength} bytes of GTFS-realtime data`);
                return await parseGTFSRealtime(arrayBuffer);
            } catch (fetchError) {
                if (fetchError.message.includes('CORS') || fetchError.message.includes('Failed to fetch')) {
                    console.error('CORS error: OVapi does not allow direct browser access.');
                    console.error('Solutions:');
                    console.error('1. Use mock data: Set GTFS_CONFIG.useMockData = true in config.js');
                    console.error('2. Set up a proxy server (see PROXY_SETUP.md)');
                    console.error('3. Use a CORS proxy service (not recommended for production)');
                }
                throw fetchError;
            }
        }
    } catch (error) {
        console.error('Error fetching GTFS-realtime data:', error);
        throw error;
    }
}

/**
 * Process and display GTFS real-time data
 * Updates vehicle entities and collects snapshots
 * @param {Object} data - GTFS data with vehicle positions
 * @param {Date} timestamp - Optional timestamp for the data
 */
function processGTFSData(data, timestamp = new Date()) {
    const vehicles = data.vehicles || [];
    const activeVehicleIds = new Set();
    
    // Track vehicle types for legend
    const vehicleTypeCounts = {
        'bus': 0,
        'tram': 0,
        'train': 0,
        'metro': 0,
        'ferry': 0,
        'bike': 0,
        'pedestrian': 0,
        'privateCar': 0,
        'other': 0
    };
    
    // Update or create vehicle entities
    vehicles.forEach(vehicle => {
        const vehicleId = vehicle.id;
        if (vehicleId) {
            activeVehicleIds.add(vehicleId);
            updateVehicleEntity(vehicle);
            
            // Count vehicle types
            const vehicleType = getVehicleType(vehicle);
            if (vehicleTypeCounts.hasOwnProperty(vehicleType)) {
                vehicleTypeCounts[vehicleType]++;
            } else {
                vehicleTypeCounts['other']++;
            }
        }
    });
    
    // Update legend with vehicle counts
    updateVehicleLegend(vehicleTypeCounts, vehicles.length);
    
    // Remove vehicles that are no longer in the data
    vehicleEntities.forEach((entity, vehicleId) => {
        if (!activeVehicleIds.has(vehicleId)) {
            const viewer = getViewer();
            viewer.entities.remove(entity);
            vehicleEntities.delete(vehicleId);
            
            // Also remove route trail if it exists
            const polylineEntity = vehicleRoutePolylines.get(vehicleId);
            if (polylineEntity) {
                viewer.entities.remove(polylineEntity);
                vehicleRoutePolylines.delete(vehicleId);
            }
            vehiclePositionHistory.delete(vehicleId);
        }
    });
    
    // Store historical data snapshots (for dynamic digital twin playback)
    if (timestamp && vehicles.length > 0 && updateIntervalId !== null) {
        const snapshot = {
            timestamp: timestamp,
            vehicles: vehicles.map(v => ({
                id: v.id,
                position: v.position,
                vehicle: v.vehicle
            }))
        };
        
        historicalData.set(timestamp.getTime(), snapshot);
        
        // Clean up old historical data (keep last 500 snapshots)
        if (historicalData.size > 500) {
            const sortedKeys = Array.from(historicalData.keys()).sort();
            const keysToDelete = sortedKeys.slice(0, sortedKeys.length - 500);
            keysToDelete.forEach(key => historicalData.delete(key));
        }
        
        if (historicalData.size % 10 === 0) {
            console.log(`Collected ${historicalData.size} snapshots for historical playback`);
        }
    }
    
    if (GTFS_CONFIG.filterByArea && vehicles.length < 10) {
        console.warn(`Only ${vehicles.length} vehicles shown. Consider:`);
        console.warn(`  - Setting filterByArea: false in config.js to show all vehicles`);
        console.warn(`  - Increasing areaExpansionFactor in config.js to expand the area`);
    }
    console.log(`Updated ${vehicleEntities.size} vehicles from GTFS real-time data (${vehicles.length} in current feed)`);
    
    // Log vehicle type breakdown
    if (vehicles.length > 0) {
        console.log(`Vehicle types: Bus=${vehicleTypeCounts.bus}, Tram=${vehicleTypeCounts.tram}, Train=${vehicleTypeCounts.train}, Metro=${vehicleTypeCounts.metro}, Ferry=${vehicleTypeCounts.ferry}, Bike=${vehicleTypeCounts.bike || 0}, Pedestrian=${vehicleTypeCounts.pedestrian || 0}, Private Car=${vehicleTypeCounts.privateCar || 0}, Other=${vehicleTypeCounts.other}`);
    }
}

/**
 * Update the vehicle legend with current counts
 * @param {Object} vehicleTypeCounts - Object with vehicle type counts
 * @param {number} totalCount - Total number of vehicles
 */
function updateVehicleLegend(vehicleTypeCounts, totalCount) {
    const legendElement = document.getElementById('vehicleLegend');
    if (!legendElement) return;
    
    const countsElement = document.getElementById('vehicleCounts');
    if (countsElement) {
        countsElement.innerHTML = `
            <div style="margin-bottom: 4px;"><strong>Total: <span id="totalVehicles">${totalCount}</span></strong></div>
            <div style="font-size: 10px; opacity: 0.8;">
                Bus: ${vehicleTypeCounts.bus || 0} | 
                Tram: ${vehicleTypeCounts.tram || 0} | 
                Train: ${vehicleTypeCounts.train || 0}<br>
                Metro: ${vehicleTypeCounts.metro || 0} | 
                Ferry: ${vehicleTypeCounts.ferry || 0}<br>
                Bike: ${vehicleTypeCounts.bike || 0} | 
                Pedestrian: ${vehicleTypeCounts.pedestrian || 0}<br>
                Private Car: ${vehicleTypeCounts.privateCar || 0} | 
                Other: ${vehicleTypeCounts.other || 0}
            </div>
        `;
    }
}

/**
 * Start fetching and updating GTFS real-time data
 * This function is used in real-time mode to continuously fetch live vehicle positions
 */
export async function startGTFSUpdates() {
    try {
        await initializeProtobuf();
        
        // Load route type mapping from static GTFS data for accurate vehicle type detection
        await loadRouteTypeMap();
        
        const data = await fetchGTFSData();
        processGTFSData(data);
        
        updateIntervalId = setInterval(async () => {
            try {
                // Check if we should skip this update due to recent rate limiting
                const timeSinceLastError = Date.now() - lastErrorTime;
                const backoffTime = 30000 * Math.pow(2, consecutiveErrors - 1); // 30s, 60s, 120s, etc.
                if (consecutiveErrors > 0 && timeSinceLastError < backoffTime) {
                    const waitTime = Math.round((backoffTime - timeSinceLastError) / 1000);
                    console.log(`Skipping update due to recent rate limit. Waiting ${waitTime}s more...`);
                    return; // Skip this update cycle
                }
                
                const data = await fetchGTFSData();
                processGTFSData(data);
            } catch (error) {
                // Don't log as error if it's a rate limit we're handling
                if (error.message && error.message.includes('Rate limited')) {
                    console.warn('GTFS update skipped due to rate limiting');
                } else {
                    console.error('Error in GTFS update cycle:', error);
                }
            }
        }, GTFS_CONFIG.updateInterval);
        
        console.log(`Started GTFS-realtime updates from OVapi (interval: ${GTFS_CONFIG.updateInterval}ms)`);
    } catch (error) {
        console.warn('Could not initialize GTFS-realtime updates:', error);
        console.warn('The visualization will continue without real-time vehicle data.');
    }
}

/**
 * Stop GTFS-realtime updates
 */
export function stopGTFSUpdates() {
    if (updateIntervalId) {
        clearInterval(updateIntervalId);
        updateIntervalId = null;
        // Reset error counters when stopping
        consecutiveErrors = 0;
        lastErrorTime = 0;
        backoffMultiplier = 1;
        console.log('Stopped GTFS-realtime updates');
    }
}

/**
 * Get historical data from collected snapshots
 * @param {Date} timestamp - The timestamp to get data for
 * @returns {Object|null} Historical vehicle data or null if not available
 */
export function getHistoricalData(timestamp) {
    const timeKey = timestamp.getTime();
    
    if (historicalData.size === 0) {
        return null;
    }
    
    let closestBefore = null;
    let closestAfter = null;
    let minDiffBefore = Infinity;
    let minDiffAfter = Infinity;
    
    historicalData.forEach((data, storedTime) => {
        const diff = storedTime - timeKey;
        if (diff <= 0 && Math.abs(diff) < minDiffBefore) {
            minDiffBefore = Math.abs(diff);
            closestBefore = storedTime;
        } else if (diff > 0 && diff < minDiffAfter) {
            minDiffAfter = diff;
            closestAfter = storedTime;
        }
    });
    
    const maxTimeDiff = 5 * 60 * 1000; // 5 minutes
    
    if (closestBefore && minDiffBefore < maxTimeDiff) {
        const data = historicalData.get(closestBefore);
        if (closestAfter && minDiffAfter < maxTimeDiff && minDiffAfter < minDiffBefore) {
            return historicalData.get(closestAfter);
        }
        return data;
    }
    
    if (closestAfter && minDiffAfter < maxTimeDiff) {
        return historicalData.get(closestAfter);
    }
    
    return null;
}

/**
 * Get the time range of available historical snapshots
 */
export function getHistoricalDataRange() {
    if (historicalData.size === 0) {
        return null;
    }
    
    const times = Array.from(historicalData.keys()).sort();
    return {
        startTime: new Date(times[0]),
        endTime: new Date(times[times.length - 1]),
        snapshotCount: historicalData.size
    };
}
