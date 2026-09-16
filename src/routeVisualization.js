/**
 * Route Visualization Module
 * Visualizes transit routes (bus, tram, train, metro) within the Zuidas area
 */

import { getViewer } from './cesiumViewer.js';
import { ZUIDAS_BOUNDS } from './config.js';

let routeEntities = [];
let routesLoaded = false;

/**
 * Check if a point is within Zuidas bounds
 */
function isWithinZuidasBounds(lat, lon) {
    return lat >= ZUIDAS_BOUNDS.south && 
           lat <= ZUIDAS_BOUNDS.north &&
           lon >= ZUIDAS_BOUNDS.west && 
           lon <= ZUIDAS_BOUNDS.east;
}

/**
 * Parse CSV file
 */
function parseCSV(text) {
    const lines = text.split('\n').filter(line => line.trim());
    if (lines.length === 0) return [];
    
    const header = lines[0].split(',').map(h => h.trim());
    const data = [];
    
    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',');
        const row = {};
        header.forEach((col, idx) => {
            row[col] = values[idx]?.trim() || '';
        });
        data.push(row);
    }
    
    return data;
}

/**
 * Get color for route type
 */
function getRouteColor(routeType) {
    // GTFS route_type: 0=Tram, 1=Metro, 2=Train, 3=Bus, 4=Ferry
    switch (parseInt(routeType, 10)) {
        case 0: // Tram
            return Cesium.Color.RED.withAlpha(0.7);
        case 1: // Metro
            return Cesium.Color.GREEN.withAlpha(0.7);
        case 2: // Train
            return Cesium.Color.YELLOW.withAlpha(0.7);
        case 3: // Bus
            return Cesium.Color.fromCssColorString('#8E44AD').withAlpha(0.7);
        case 4: // Ferry
            return Cesium.Color.CYAN.withAlpha(0.7);
        default:
            return Cesium.Color.WHITE.withAlpha(0.7);
    }
}

/**
 * Load and visualize routes within Zuidas area
 * @param {string} dateStr - Optional date string (YYYY-MM-DD) for date-specific dataset
 */
export async function loadRouteVisualization(dateStr = null) {
    // Always allow reloading if date is specified (for date selection)
    if (routesLoaded && !dateStr) {
        console.log('[Routes] Routes already loaded');
        return;
    }
    
    // Reset loaded state if date is specified to force reload
    if (dateStr) {
        routesLoaded = false;
    }
    
    try {
        console.log('[Routes] Loading route visualization...');
        if (dateStr) {
            console.log(`[Routes] Using date-specific dataset for: ${dateStr}`);
        }
        
        // Clear any existing routes first
        clearRouteVisualization();
        
        // Build directory list - prioritize date-specific if provided
        const baseDirs = [];
        if (dateStr) {
            // Format: YYYY-MM-DD -> gtfs-zuidas-YYYY-MM-DD
            baseDirs.push(`./data/static-gtfs/gtfs-zuidas-${dateStr}/`);
        }
        // Always include general filtered data and fallbacks
        baseDirs.push(
            './data/static-gtfs/gtfs-zuidas/',  // Pre-filtered data (recommended)
            './data/static-gtfs/gtfs-nl/',
            './data/static-gtfs/gtfs-extracted/'
        );
        
        let routes = null;
        let stops = null;
        let trips = null;
        let stopTimes = null;
        let shapes = null;
        
        // Load GTFS files
        for (const baseDir of baseDirs) {
            try {
                const [routesRes, stopsRes, tripsRes, stopTimesRes, shapesRes] = await Promise.all([
                    fetch(baseDir + 'routes.txt').catch(() => null),
                    fetch(baseDir + 'stops.txt').catch(() => null),
                    fetch(baseDir + 'trips.txt').catch(() => null),
                    fetch(baseDir + 'stop_times.txt').catch(() => null),
                    fetch(baseDir + 'shapes.txt').catch(() => null)
                ]);
                
                if (routesRes?.ok && stopsRes?.ok && tripsRes?.ok && stopTimesRes?.ok) {
                    const [routesText, stopsText, tripsText, stopTimesText, shapesText] = await Promise.all([
                        routesRes.text(),
                        stopsRes.text(),
                        tripsRes.text(),
                        stopTimesRes.text(),
                        shapesRes?.ok ? shapesRes.text() : null
                    ]);
                    
                    routes = parseCSV(routesText);
                    stops = parseCSV(stopsText);
                    trips = parseCSV(tripsText);
                    stopTimes = parseCSV(stopTimesText);
                    shapes = shapesText ? parseCSV(shapesText) : null;
                    
                    console.log(`[Routes] Loaded GTFS data from ${baseDir}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        if (!routes || !stops || !trips || !stopTimes) {
            console.warn('[Routes] Could not load GTFS files. Make sure routes.txt, stops.txt, trips.txt, and stop_times.txt exist.');
            return;
        }
        
        // Create lookup maps
        const stopsMap = new Map();
        stops.forEach(stop => {
            stopsMap.set(stop.stop_id, stop);
        });
        
        const tripsByRoute = new Map();
        const tripsMap = new Map(); // trip_id -> trip for fast lookup
        trips.forEach(trip => {
            tripsMap.set(trip.trip_id, trip);
            if (!tripsByRoute.has(trip.route_id)) {
                tripsByRoute.set(trip.route_id, []);
            }
            tripsByRoute.get(trip.route_id).push(trip);
        });
        
        const stopTimesByTrip = new Map();
        stopTimes.forEach(st => {
            if (!stopTimesByTrip.has(st.trip_id)) {
                stopTimesByTrip.set(st.trip_id, []);
            }
            stopTimesByTrip.get(st.trip_id).push(st);
        });
        
        // Sort stop_times by sequence
        stopTimesByTrip.forEach(times => {
            times.sort((a, b) => {
                const seqA = parseInt(a.stop_sequence || 0);
                const seqB = parseInt(b.stop_sequence || 0);
                return seqA - seqB;
            });
        });
        
        // Create shapes map if shapes data is available
        const shapesMap = new Map(); // shape_id -> sorted array of shape points
        if (shapes && shapes.length > 0) {
            shapes.forEach(shape => {
                const shapeId = shape.shape_id;
                if (!shapesMap.has(shapeId)) {
                    shapesMap.set(shapeId, []);
                }
                shapesMap.get(shapeId).push(shape);
            });
            // Sort each shape's points by sequence
            shapesMap.forEach((points, shapeId) => {
                points.sort((a, b) => {
                    const seqA = parseInt(a.shape_pt_sequence || 0);
                    const seqB = parseInt(b.shape_pt_sequence || 0);
                    return seqA - seqB;
                });
            });
            console.log(`[Routes] Loaded ${shapesMap.size} shapes for route visualization`);
        }
        
        // Find stops within Zuidas area
        const zuidasStops = new Set();
        stops.forEach(stop => {
            const lat = parseFloat(stop.stop_lat);
            const lon = parseFloat(stop.stop_lon);
            if (!isNaN(lat) && !isNaN(lon) && isWithinZuidasBounds(lat, lon)) {
                zuidasStops.add(stop.stop_id);
            }
        });
        
        console.log(`[Routes] Found ${zuidasStops.size} stops within Zuidas area`);
        
        // Find routes that pass through Zuidas stops
        // More efficient approach: find all trips that use Zuidas stops, then get their routes
        const zuidasRoutes = new Set();
        const tripsUsingZuidasStops = new Set();
        const routeStops = new Map(); // route_id -> Set of stop_ids
        
        // Find all trips that use Zuidas stops by checking stop_times
        console.log(`[Routes] Checking stop_times for trips using ${zuidasStops.size} Zuidas stops...`);
        
        stopTimes.forEach(st => {
            const stopId = st.stop_id;
            if (zuidasStops.has(stopId)) {
                tripsUsingZuidasStops.add(st.trip_id);
            }
        });
        
        console.log(`[Routes] Found ${tripsUsingZuidasStops.size} trips using Zuidas stops`);
        
        // Get route_ids from trips that use Zuidas stops
        tripsUsingZuidasStops.forEach(tripId => {
            const trip = tripsMap.get(tripId);
            if (trip && trip.route_id) {
                const routeId = trip.route_id;
                zuidasRoutes.add(routeId);
                
                // Build route stops map for later use
                if (!routeStops.has(routeId)) {
                    routeStops.set(routeId, new Set());
                }
                const tripStopTimes = stopTimesByTrip.get(tripId);
                if (tripStopTimes) {
                    tripStopTimes.forEach(st => {
                        routeStops.get(routeId).add(st.stop_id);
                    });
                }
            }
        });
        
        console.log(`[Routes] Found ${zuidasRoutes.size} routes passing through Zuidas area`);
        
        // Visualize routes
        const viewer = getViewer();
        let routeCount = 0;
        
        // Show all routes (or limit if too many)
        // Don't limit to 20 - show all routes that pass through Zuidas
        const routesToShow = Array.from(zuidasRoutes);
        
        // Log route types for debugging
        const routeTypes = new Map();
        routesToShow.forEach(routeId => {
            const route = routes.find(r => r.route_id === routeId);
            if (route) {
                const routeType = parseInt(route.route_type || -1);
                const typeName = routeType === 0 ? 'Tram' : routeType === 1 ? 'Metro' : routeType === 2 ? 'Train' : routeType === 3 ? 'Bus' : routeType === 4 ? 'Ferry' : 'Other';
                routeTypes.set(typeName, (routeTypes.get(typeName) || 0) + 1);
            }
        });
        console.log(`[Routes] Route types:`, Object.fromEntries(routeTypes));
        console.log(`[Routes] Processing ${routesToShow.length} routes...`);
        
        for (const routeId of routesToShow) {
            try {
                const route = routes.find(r => r.route_id === routeId);
                if (!route) continue;
                
                const routeType = parseInt(route.route_type || -1);
                const routeTypeName = routeType === 0 ? 'Tram' : routeType === 1 ? 'Metro' : routeType === 2 ? 'Train' : routeType === 3 ? 'Bus' : routeType === 4 ? 'Ferry' : 'Other';
                
                // Get a representative trip for this route
                const routeTrips = tripsByRoute.get(routeId);
                if (!routeTrips || routeTrips.length === 0) {
                    console.warn(`[Routes] Route ${routeId} (${routeTypeName}) has no trips, skipping`);
                    continue;
                }
                
                // Use first trip (or find one with most stops in Zuidas)
                const trip = routeTrips[0];
                const stopTimes = stopTimesByTrip.get(trip.trip_id);
                if (!stopTimes || stopTimes.length < 2) {
                    console.warn(`[Routes] Route ${routeId} (${routeTypeName}) has insufficient stop times, skipping`);
                    continue;
                }
                
                // Try to use shape data if available, otherwise fall back to stops
                let positions = [];
                const shapeId = trip.shape_id;
                let usedShape = false;
                
                if (shapeId && shapesMap.has(shapeId)) {
                    // Use shape points for accurate route path
                    const shapePoints = shapesMap.get(shapeId);
                    positions = shapePoints.map(sp => {
                        const lat = parseFloat(sp.shape_pt_lat);
                        const lon = parseFloat(sp.shape_pt_lon);
                        if (!isNaN(lat) && !isNaN(lon)) {
                            return Cesium.Cartesian3.fromDegrees(lon, lat, 0);
                        }
                        return null;
                    }).filter(pos => pos !== null);
                    
                    if (positions.length >= 2) {
                        usedShape = true;
                    } else {
                        // Fall back to stops if shape is invalid
                        console.warn(`[Routes] Route ${routeId} (${routeTypeName}): Shape ${shapeId} has insufficient points (${positions.length}), falling back to stops`);
                        positions = [];
                    }
                } else if (shapeId) {
                    console.warn(`[Routes] Route ${routeId} (${routeTypeName}): Shape ${shapeId} not found in shapes map, falling back to stops`);
                } else {
                    console.log(`[Routes] Route ${routeId} (${routeTypeName}): No shape_id, using stop-based visualization`);
                }
                
                // Fall back to stop-based polyline if no shape or shape failed
                if (positions.length < 2) {
                    // Limit stop sequence to avoid huge polylines (max 100 stops per route)
                    const limitedStopTimes = stopTimes.slice(0, 100);
                    
                    // Build polyline from stop sequence
                    for (const st of limitedStopTimes) {
                        const stop = stopsMap.get(st.stop_id);
                        if (stop) {
                            const lat = parseFloat(stop.stop_lat);
                            const lon = parseFloat(stop.stop_lon);
                            if (!isNaN(lat) && !isNaN(lon)) {
                                positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, 0));
                            }
                        }
                    }
                }
                
                if (positions.length < 2) {
                    console.warn(`[Routes] Route ${routeId} (${routeTypeName}): Could not build route path (only ${positions.length} valid positions), skipping`);
                    continue;
                }
                
                // Create polyline entity
                const routeColor = getRouteColor(route.route_type);
                const routeName = route.route_short_name || route.route_long_name || routeId;
                
                // Use slightly wider lines for trams and trains (they have tracks)
                const lineWidth = (routeType === 0 || routeType === 2) ? 3 : 2;
                
                const entity = viewer.entities.add({
                    id: `route-${routeId}`,
                    name: `${routeTypeName} ${routeName}`,
                    polyline: {
                        positions: positions,
                        width: lineWidth,
                        material: routeColor,
                        clampToGround: true,
                        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                        classificationType: Cesium.ClassificationType.TERRAIN,
                        // Performance optimizations
                        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 10000.0) // Only show within 10km
                    }
                });
                
                routeEntities.push(entity);
                routeCount++;
                
                // Log first few routes for debugging
                if (routeCount <= 5) {
                    console.log(`[Routes] ✓ Visualized ${routeTypeName} route ${routeName} (${routeId}): ${positions.length} points, ${usedShape ? 'shape-based' : 'stop-based'}`);
                }
                
                // Process in batches to avoid blocking
                if (routeCount % 5 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 10)); // Small delay every 5 routes
                }
            } catch (error) {
                console.error(`[Routes] Error processing route ${routeId}:`, error);
                // Continue with next route instead of crashing
                continue;
            }
        }
        
        routesLoaded = true;
        console.log(`[Routes] ✓ Visualized ${routeCount} routes within Zuidas area`);
        
    } catch (error) {
        console.error('[Routes] Error loading route visualization:', error);
    }
}

/**
 * Clear route visualization
 */
export function clearRouteVisualization() {
    const viewer = getViewer();
    
    routeEntities.forEach(entity => {
        viewer.entities.remove(entity);
    });
    
    routeEntities = [];
    routesLoaded = false;
    console.log('[Routes] Route visualization cleared');
}

/**
 * Toggle route visualization
 */
export function toggleRouteVisualization(show) {
    if (show && !routesLoaded) {
        loadRouteVisualization();
    } else if (!show && routesLoaded) {
        clearRouteVisualization();
    }
}

