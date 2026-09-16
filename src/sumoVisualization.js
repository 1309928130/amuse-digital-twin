/**
 * SUMO Visualization
 * Renders SUMO simulation data in Cesium
 */

import { getViewer } from './cesiumViewer.js';
import { 
    loadSUMONetwork, 
    loadSUMOVehicles, 
    loadSUMOStops,
    loadSUMOFCD,
    getVehiclePositionFromFCD,
    buildRouteGeometry,
    getEdgeGeometry
} from './sumoDataLoader.js';
import { SUMO_CONFIG, ZUIDAS_BOUNDS } from './config.js';

// Store visualization entities
const roadNetworkEntities = [];
const stopEntities = [];
const routeEntities = [];
const vehicleEntities = new Map();

/**
 * Check if a point is within Zuidas bounds
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {boolean} True if within bounds
 */
function isWithinZuidasBounds(lat, lon) {
    return lat >= ZUIDAS_BOUNDS.south && 
           lat <= ZUIDAS_BOUNDS.north &&
           lon >= ZUIDAS_BOUNDS.west && 
           lon <= ZUIDAS_BOUNDS.east;
}

// Store loaded data
let sumoData = null;
let fcdData = null; // FCD position data (time -> vehicles array)
let currentSimulationTime = 0; // Time in seconds since simulation start

/**
 * Calculate vehicle position at given simulation time
 * Uses FCD data if available, otherwise interpolates from route
 * @param {Object} vehicle - Vehicle object
 * @param {number} simulationTime - Current simulation time in seconds
 * @param {Map} edgesMap - Map of edge geometries
 * @returns {Object|null} Position {longitude, latitude, angle?, speed?} or null if vehicle not active
 */
function calculateVehiclePosition(vehicle, simulationTime, edgesMap) {
    // First, try to get position from FCD data (exact positions from SUMO simulation)
    if (fcdData) {
        const fcdPosition = getVehiclePositionFromFCD(vehicle.id, simulationTime, fcdData);
        if (fcdPosition && fcdPosition.position) {
            // Return FCD position with angle and speed if available
            return {
                longitude: fcdPosition.position.longitude,
                latitude: fcdPosition.position.latitude,
                angle: fcdPosition.angle,
                speed: fcdPosition.speed
            };
        }
        // If FCD lookup fails and vehicle has no route data (FCD-only vehicles like bikes/pedestrians),
        // return null (they only exist in FCD data)
        if (!vehicle.edgeSequence || vehicle.edgeSequence.length === 0) {
            return null;
        }
        // If FCD lookup fails, fall through to route-based interpolation
        // For trips (private cars), we'll try a simplified interpolation
    }
    
    // Fall back to route-based interpolation if FCD not available or failed
    // This works for public transport vehicles with full routes
    // For trips (private cars), it will use a simplified from/to interpolation
    // For FCD-only vehicles (bikes/pedestrians without routes), this will return null
    if (!vehicle.edgeSequence || vehicle.edgeSequence.length === 0) {
        return null; // No route data, can't interpolate
    }
    return calculateVehiclePositionFromRoute(vehicle, simulationTime, edgesMap);
}

/**
 * Calculate vehicle position along route at given simulation time (fallback method)
 * @param {Object} vehicle - Vehicle object
 * @param {number} simulationTime - Current simulation time in seconds
 * @param {Map} edgesMap - Map of edge geometries
 * @returns {Object|null} Position {longitude, latitude} or null if vehicle not active
 */
function calculateVehiclePositionFromRoute(vehicle, simulationTime, edgesMap) {
    // Check if vehicle is active at this time
    if (simulationTime < vehicle.depart) {
        return null; // Vehicle hasn't departed yet
    }
    
    // For trips (private cars), estimate arrival time if not provided
    let arrivalTime = vehicle.arrival;
    if (!arrivalTime && vehicle.edgeSequence && vehicle.edgeSequence.length <= 2) {
        // Private car trip - estimate arrival based on typical travel time
        // Estimate distance between from/to edges and calculate arrival time
        const fromEdge = vehicle.edgeSequence[0];
        const toEdge = vehicle.edgeSequence[1];
        const fromCoords = getEdgeGeometry(fromEdge, edgesMap);
        const toCoords = getEdgeGeometry(toEdge, edgesMap);
        
        if (fromCoords && fromCoords.length > 0 && toCoords && toCoords.length > 0) {
            // Calculate distance between start of from edge and end of to edge
            const startCoord = fromCoords[0];
            const endCoord = toCoords[toCoords.length - 1];
            const lat1 = startCoord.latitude * Math.PI / 180;
            const lat2 = endCoord.latitude * Math.PI / 180;
            const dLat = lat2 - lat1;
            const dLon = (endCoord.longitude - startCoord.longitude) * Math.PI / 180;
            const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                      Math.cos(lat1) * Math.cos(lat2) *
                      Math.sin(dLon/2) * Math.sin(dLon/2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            const distance = 6371000 * c; // Distance in meters
            
            // Estimate travel time at 50 km/h (13.89 m/s)
            const estimatedSpeed = 13.89; // m/s
            const estimatedTravelTime = distance / estimatedSpeed;
            arrivalTime = vehicle.depart + estimatedTravelTime;
        } else {
            // Fallback: use a default travel time (e.g., 5 minutes)
            arrivalTime = vehicle.depart + 300; // 5 minutes default
        }
    }
    
    if (arrivalTime && simulationTime > arrivalTime) {
        return null; // Vehicle has arrived
    }
    
    // Calculate time since departure
    let timeSinceDepart = simulationTime - vehicle.depart;
    
    // Account for stops (vehicles pause at stops)
    let totalStopDuration = 0;
    for (const stop of vehicle.stops || []) {
        // Estimate when vehicle reaches this stop (simplified)
        // In reality, we'd need to calculate based on route position
        // For now, assume stops are evenly distributed along the route
        const stopArrivalTime = vehicle.depart + (vehicle.arrival - vehicle.depart) * (vehicle.stops.indexOf(stop) + 1) / (vehicle.stops.length + 1);
        
        if (simulationTime >= stopArrivalTime && simulationTime < stopArrivalTime + stop.duration) {
            // Vehicle is currently at a stop
            // Find the stop position (we'd need stop coordinates for this)
            // For now, continue with route-based calculation
        }
        
        if (simulationTime > stopArrivalTime + stop.duration) {
            totalStopDuration += stop.duration;
        } else if (simulationTime > stopArrivalTime) {
            // Currently at stop, use stop arrival time for position calculation
            timeSinceDepart = stopArrivalTime - vehicle.depart;
            break;
        }
    }
    
    // Adjust time for stops (subtract time spent at stops)
    const travelTime = timeSinceDepart - totalStopDuration;
    if (travelTime < 0) {
        // Still at first stop or before departure
        return null;
    }
    
    // Build route geometry
    let routeCoords = buildRouteGeometry(vehicle.edgeSequence, edgesMap);
    
    // Handle trips with only from/to edges (private cars)
    if (routeCoords.length === 0 || (vehicle.edgeSequence && vehicle.edgeSequence.length === 2 && routeCoords.length < 10)) {
        // Trip with only from/to edges - try to get a better route
        if (vehicle.edgeSequence && vehicle.edgeSequence.length === 2) {
            const fromEdge = vehicle.edgeSequence[0];
            const toEdge = vehicle.edgeSequence[1];
            const fromCoords = getEdgeGeometry(fromEdge, edgesMap);
            const toCoords = getEdgeGeometry(toEdge, edgesMap);
            
            if (fromCoords && fromCoords.length > 0 && toCoords && toCoords.length > 0) {
                // For trips, create a route that connects from edge end to to edge start
                // This creates a more realistic path (though still simplified)
                // Use the full from edge, then connect to the start of to edge, then full to edge
                const fromEnd = fromCoords[fromCoords.length - 1];
                const toStart = toCoords[0];
                
                // Create intermediate points for smoother interpolation
                // Add a few intermediate points between from end and to start for smoother movement
                const intermediatePoints = [];
                const numIntermediate = 5; // Number of intermediate points
                for (let i = 1; i < numIntermediate; i++) {
                    const t = i / numIntermediate;
                    intermediatePoints.push({
                        longitude: fromEnd.longitude + (toStart.longitude - fromEnd.longitude) * t,
                        latitude: fromEnd.latitude + (toStart.latitude - fromEnd.latitude) * t
                    });
                }
                
                // Combine: full from edge + intermediate points + full to edge
                routeCoords = [...fromCoords, ...intermediatePoints, ...toCoords];
            }
        }
    }
    
    if (routeCoords.length < 2) {
        // Can't build a valid route - try to show at least at start or end edge
        if (vehicle.edgeSequence && vehicle.edgeSequence.length > 0) {
            const firstEdge = vehicle.edgeSequence[0];
            const firstEdgeCoords = getEdgeGeometry(firstEdge, edgesMap);
            if (firstEdgeCoords && firstEdgeCoords.length > 0) {
                // Show at start of first edge (at least vehicle appears)
                return {
                    longitude: firstEdgeCoords[0].longitude,
                    latitude: firstEdgeCoords[0].latitude
                };
            }
        }
        return null;
    }
    
    // Calculate actual route length by summing distances between points
    let totalRouteLength = 0;
    const segmentLengths = [];
    for (let i = 0; i < routeCoords.length - 1; i++) {
        const p1 = routeCoords[i];
        const p2 = routeCoords[i + 1];
        // Haversine distance approximation (good enough for short distances)
        const lat1 = p1.latitude * Math.PI / 180;
        const lat2 = p2.latitude * Math.PI / 180;
        const dLat = lat2 - lat1;
        const dLon = (p2.longitude - p1.longitude) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(lat1) * Math.cos(lat2) *
                  Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        const distance = 6371000 * c; // Earth radius in meters
        segmentLengths.push(distance);
        totalRouteLength += distance;
    }
    
    // Estimate vehicle speed based on type (different speeds for different vehicles)
    let vehicleSpeed = 13.89; // Default 50 km/h
    if (vehicle.type.includes('train')) {
        vehicleSpeed = 27.78; // 100 km/h for trains
    } else if (vehicle.type.includes('tram')) {
        vehicleSpeed = 11.11; // 40 km/h for trams
    } else if (vehicle.type.includes('bus')) {
        vehicleSpeed = 13.89; // 50 km/h for buses
    } else if (vehicle.type.includes('passenger') || vehicle.type.includes('veh_passenger')) {
        // Private passenger cars - use typical city driving speed
        vehicleSpeed = 13.89; // 50 km/h (can vary, but use same as bus for now)
    } else if (vehicle.type.includes('bike') || vehicle.type.includes('bicycle') || vehicle.type.includes('cyclist')) {
        // Bicycles - typical cycling speed
        vehicleSpeed = 5.56; // 20 km/h (typical cycling speed)
    } else if (vehicle.type.includes('pedestrian') || vehicle.type.includes('ped') || vehicle.type.includes('walk')) {
        // Pedestrians - walking speed
        vehicleSpeed = 1.39; // 5 km/h (typical walking speed)
    }
    
    // Calculate distance traveled
    const distanceTraveled = travelTime * vehicleSpeed;
    
    // Find position along route based on actual distances
    if (distanceTraveled >= totalRouteLength) {
        // Vehicle has reached the end
        return routeCoords[routeCoords.length - 1];
    }
    
    // Find which segment we're in
    let accumulatedDistance = 0;
    for (let i = 0; i < segmentLengths.length; i++) {
        if (accumulatedDistance + segmentLengths[i] >= distanceTraveled) {
            // We're in this segment
            const segmentProgress = (distanceTraveled - accumulatedDistance) / segmentLengths[i];
            const p1 = routeCoords[i];
            const p2 = routeCoords[i + 1];
            
            return {
                longitude: p1.longitude + (p2.longitude - p1.longitude) * segmentProgress,
                latitude: p1.latitude + (p2.latitude - p1.latitude) * segmentProgress
            };
        }
        accumulatedDistance += segmentLengths[i];
    }
    
    // Fallback: return last position
    return routeCoords[routeCoords.length - 1];
}

/**
 * Get vehicle color based on type
 * @param {string} vehicleType - Vehicle type (pt_bus, pt_tram, pt_train, etc.)
 * @returns {Cesium.Color}
 */
function getVehicleColor(vehicleType) {
    if (!vehicleType) return Cesium.Color.WHITE;
    
    // Use exact hex colors to match the vehicle legend
    // Legend colors: Bus=#8E44AD (purple), Tram=#FF0000, Train=#FFFF00, Metro=#00FF00, Ferry=#00FFFF, Other=#95A5A6
    if (vehicleType.includes('bus')) {
        return Cesium.Color.fromCssColorString('#8E44AD'); // Bus - purple
    } else if (vehicleType.includes('tram')) {
        return Cesium.Color.fromCssColorString('#FF0000'); // Tram - red
    } else if (vehicleType.includes('train')) {
        return Cesium.Color.fromCssColorString('#FFFF00'); // Train - yellow
    } else if (vehicleType.includes('subway') || vehicleType.includes('metro')) {
        return Cesium.Color.fromCssColorString('#00FF00'); // Metro - green
    } else if (vehicleType.includes('ferry')) {
        return Cesium.Color.fromCssColorString('#00FFFF'); // Ferry - cyan
    } else if (vehicleType.includes('passenger') || vehicleType.includes('veh_passenger')) {
        // Private passenger cars - use orange to distinguish from public transport
        return Cesium.Color.fromCssColorString('#FFA500'); // Orange for private cars
    } else if (vehicleType.includes('bike') || vehicleType.includes('bicycle') || vehicleType.includes('cyclist')) {
        // Bicycles - use lime green
        return Cesium.Color.fromCssColorString('#00FF00'); // Lime green for bikes
    } else if (vehicleType.includes('pedestrian') || vehicleType.includes('ped') || vehicleType.includes('walk') || vehicleType === 'DEFAULT_PEDTYPE') {
        // Pedestrians - use magenta/pink
        return Cesium.Color.fromCssColorString('#FF00FF'); // Magenta for pedestrians
    } else {
        return Cesium.Color.fromCssColorString('#95A5A6'); // Other - gray
    }
}

/**
 * Get darker version of a color for tracks/edges
 * @param {Cesium.Color} color - Base color
 * @param {number} darkenFactor - Factor to darken (0.0-1.0, lower = darker, 1.0 = original brightness)
 * @returns {Cesium.Color} Darker color with full opacity
 */
function getDarkerColor(color, darkenFactor = 0.5) {
    return new Cesium.Color(
        color.red * darkenFactor,
        color.green * darkenFactor,
        color.blue * darkenFactor,
        1.0 // Full opacity for tracks to make them more visible
    );
}

/**
 * Determine edge color based on vehicle types that use it
 * @param {string} edgeId - Edge ID
 * @param {Map} edgeVehicleTypes - Map of edgeId -> Set of vehicle types using it
 * @returns {Cesium.Color} Color for the edge
 */
function getEdgeColor(edgeId, edgeVehicleTypes) {
    const vehicleTypes = edgeVehicleTypes.get(edgeId);
    
    if (!vehicleTypes || vehicleTypes.size === 0) {
        // No vehicles use this edge - use gray
        return Cesium.Color.GRAY.withAlpha(0.3);
    }
    
    // Get vehicle type colors - use same colors as transit routes
    // Match the colors from routeVisualization.js getRouteColor function
    const typeColors = {
        'bus': Cesium.Color.fromCssColorString('#8E44AD').withAlpha(0.7), // Bus purple
        'tram': Cesium.Color.RED.withAlpha(0.7), // Same as transit route Tram (route_type 0)
        'train': Cesium.Color.YELLOW.withAlpha(0.7), // Same as transit route Train (route_type 2)
        'metro': Cesium.Color.GREEN.withAlpha(0.7), // Same as transit route Metro (route_type 1)
        'ferry': Cesium.Color.CYAN.withAlpha(0.7), // Same as transit route Ferry (route_type 4)
        'bike': Cesium.Color.fromCssColorString('#00FF00').withAlpha(0.7), // Lime green for bikes
        'bicycle': Cesium.Color.fromCssColorString('#00FF00').withAlpha(0.7), // Lime green for bikes
        'pedestrian': Cesium.Color.fromCssColorString('#FF00FF').withAlpha(0.7), // Magenta for pedestrians
        'ped': Cesium.Color.fromCssColorString('#FF00FF').withAlpha(0.7), // Magenta for pedestrians
        'other': Cesium.Color.WHITE.withAlpha(0.7) // Same as transit route Other (default)
    };
    
    // If multiple types use the edge, use the first one found (or could blend colors)
    // Priority: train > tram > metro > bus > ferry > bike > pedestrian > other
    const priority = ['train', 'tram', 'metro', 'bus', 'ferry', 'bike', 'bicycle', 'pedestrian', 'ped', 'other'];
    
    for (const type of priority) {
        if (vehicleTypes.has(type)) {
            return typeColors[type] || Cesium.Color.GRAY;
        }
    }
    
    // Fallback: use first type found
    const firstType = Array.from(vehicleTypes)[0];
    if (firstType) {
        // Extract base type (e.g., 'pt_bus' -> 'bus')
        for (const [key, color] of Object.entries(typeColors)) {
            if (firstType.includes(key)) {
                return color;
            }
        }
    }
    
    return Cesium.Color.GRAY;
}

/**
 * Build a map of which edges are used by which vehicle types
 * @param {Array} vehiclesArray - Array of vehicle objects
 * @returns {Map} Map of edgeId -> Set of vehicle types
 */
function buildEdgeVehicleTypeMap(vehiclesArray) {
    const edgeVehicleTypes = new Map();
    
    for (const vehicle of vehiclesArray) {
        // Extract base vehicle type (e.g., 'pt_bus' -> 'bus')
        let vehicleType = 'other';
        if (vehicle.type.includes('bus')) {
            vehicleType = 'bus';
        } else if (vehicle.type.includes('tram')) {
            vehicleType = 'tram';
        } else if (vehicle.type.includes('train')) {
            vehicleType = 'train';
        } else if (vehicle.type.includes('subway') || vehicle.type.includes('metro')) {
            vehicleType = 'metro';
        } else if (vehicle.type.includes('ferry')) {
            vehicleType = 'ferry';
        }
        
        // Add this vehicle type to all edges in its route
        if (vehicle.edgeSequence && vehicle.edgeSequence.length > 0) {
            for (const edgeId of vehicle.edgeSequence) {
                // Remove lane suffix if present
                const baseEdgeId = edgeId.split('#')[0];
                // Handle negative edges (reverse direction)
                const normalizedEdgeId = baseEdgeId.startsWith('-') ? baseEdgeId.substring(1) : baseEdgeId;
                
                if (!edgeVehicleTypes.has(normalizedEdgeId)) {
                    edgeVehicleTypes.set(normalizedEdgeId, new Set());
                }
                edgeVehicleTypes.get(normalizedEdgeId).add(vehicleType);
            }
        }
    }
    
    return edgeVehicleTypes;
}

/**
 * Visualize road network edges
 * @param {Map} edgesMap - Map of edge ID to edge data
 * @param {Object} viewer - Cesium viewer
 * @param {Array} vehiclesArray - Array of vehicle objects (optional, for coloring by vehicle type)
 */
function visualizeRoadNetwork(edgesMap, viewer, vehiclesArray = null) {
    const entities = viewer.entities;
    
    // Clear existing road network
    roadNetworkEntities.forEach(entity => entities.remove(entity));
    roadNetworkEntities.length = 0;
    
    // Build map of edges to vehicle types if vehicles are provided
    let edgeVehicleTypes = new Map();
    if (vehiclesArray && vehiclesArray.length > 0) {
        edgeVehicleTypes = buildEdgeVehicleTypeMap(vehiclesArray);
        console.log(`[SUMO] Built edge-vehicle type map: ${edgeVehicleTypes.size} edges used by vehicles`);
    }
    
    let edgeCount = 0;
    const maxEdges = SUMO_CONFIG.maxRoadNetworkEdges || 10000;
    
    for (const [edgeId, edgeData] of edgesMap) {
        if (edgeCount >= maxEdges) break;
        
        if (edgeData.coords && edgeData.coords.length >= 2) {
            const positions = edgeData.coords.map(coord =>
                Cesium.Cartesian3.fromDegrees(coord.longitude, coord.latitude, 0)
            );
            
            // Determine color based on vehicle types using this edge
            const color = getEdgeColor(edgeId, edgeVehicleTypes);
            
            const entity = entities.add({
                id: `sumo-road-${edgeId}`,
                name: `Road ${edgeId}`,
                polyline: {
                    positions: positions,
                    width: SUMO_CONFIG.roadWidth || 2,
                    material: color,
                    clampToGround: true,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 10000.0)
                }
            });
            
            roadNetworkEntities.push(entity);
            edgeCount++;
        }
    }
    
    console.log(`[SUMO] Visualized ${roadNetworkEntities.length} road edges`);
}

/**
 * Visualize public transport stops
 * @param {Array} stopsArray - Array of stop objects
 * @param {Object} viewer - Cesium viewer
 */
function visualizeStops(stopsArray, viewer) {
    const entities = viewer.entities;
    
    // Clear existing stops
    stopEntities.forEach(entity => entities.remove(entity));
    stopEntities.length = 0;
    
    for (const stop of stopsArray) {
        if (!stop.position) continue;
        
        const entity = entities.add({
            id: `sumo-stop-${stop.id}`,
            name: stop.name,
            position: Cesium.Cartesian3.fromDegrees(
                stop.position.longitude,
                stop.position.latitude,
                0
            ),
            point: {
                pixelSize: SUMO_CONFIG.stopSize || 5,
                color: Cesium.Color.GRAY,
                outlineColor: Cesium.Color.DARKGRAY,
                outlineWidth: 1,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            },
            label: {
                text: stop.name,
                font: '10pt sans-serif',
                fillColor: Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -25),
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                show: SUMO_CONFIG.showStopLabels !== false
            }
        });
        
        stopEntities.push(entity);
    }
    
    console.log(`[SUMO] Visualized ${stopEntities.length} stops`);
}

/**
 * Visualize vehicle routes (optional)
 * @param {Array} vehiclesArray - Array of vehicle objects
 * @param {Map} edgesMap - Map of edge geometries
 * @param {Object} viewer - Cesium viewer
 */
function visualizeRoutes(vehiclesArray, edgesMap, viewer) {
    const entities = viewer.entities;
    
    // Clear existing routes
    routeEntities.forEach(entity => entities.remove(entity));
    routeEntities.length = 0;
    
    if (!SUMO_CONFIG.showRoutes) {
        return;
    }
    
    let routeCount = 0;
    const maxRoutes = SUMO_CONFIG.maxRoutes || 100;
    
    for (const vehicle of vehiclesArray) {
        if (routeCount >= maxRoutes) break;
        
        const routeCoords = buildRouteGeometry(vehicle.edgeSequence, edgesMap);
        if (routeCoords.length < 2) continue;
        
        const positions = routeCoords.map(coord =>
            Cesium.Cartesian3.fromDegrees(coord.longitude, coord.latitude, 0)
        );
        
        const vehicleColor = getVehicleColor(vehicle.type);
        
        const entity = entities.add({
            id: `sumo-route-${vehicle.id}`,
            name: `Route ${vehicle.id}`,
            polyline: {
                positions: positions,
                width: 1,
                material: vehicleColor.withAlpha(0.3),
                clampToGround: true,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 5000.0)
            }
        });
        
        routeEntities.push(entity);
        routeCount++;
    }
    
    console.log(`[SUMO] Visualized ${routeEntities.length} vehicle routes`);
}

/**
 * Update vehicle positions based on simulation time
 * @param {number} simulationTime - Current simulation time in seconds
 * @param {Array} vehiclesArray - Array of vehicle objects
 * @param {Map} edgesMap - Map of edge geometries
 * @param {Object} viewer - Cesium viewer
 */
export function updateVehiclePositions(simulationTime, vehiclesArray, edgesMap, viewer) {
    const entities = viewer.entities;
    currentSimulationTime = simulationTime;
    
    // Track active vehicles
    const activeVehicleIds = new Set();
    
    // Limit number of displayed vehicles for performance
    const maxVehicles = SUMO_CONFIG.maxVehicles || 200;
    
    // Separate vehicles by type to ensure private cars are included
    const publicTransportVehicles = [];
    const privateCars = [];
    const otherVehicles = [];
    
    // Create a map of vehicle IDs for quick lookup
    const vehiclesMap = new Map();
    for (const vehicle of vehiclesArray) {
        vehiclesMap.set(vehicle.id, vehicle);
    }
    
    // If FCD data exists, also check for vehicles/persons that are in FCD but not in vehiclesArray
    // This handles bikes and pedestrians that might only be in FCD data
    if (fcdData && fcdData.size > 0) {
        const fcdVehicleIds = new Set();
        // Collect all unique vehicle/person IDs from FCD data
        for (const vehicles of fcdData.values()) {
            for (const veh of vehicles) {
                if (!vehiclesMap.has(veh.id)) {
                    fcdVehicleIds.add(veh.id);
                }
            }
        }
        
        // Create virtual vehicle objects for FCD-only vehicles (bikes, pedestrians, etc.)
        for (const vehicleId of fcdVehicleIds) {
            // Determine vehicle type from ID pattern AND check FCD data for type attribute
            let vehicleType = 'unknown';
            
            // Check FCD data to get actual type attribute
            let actualType = null;
            for (const vehicles of fcdData.values()) {
                const veh = vehicles.find(v => v.id === vehicleId);
                if (veh && veh.type) {
                    actualType = veh.type;
                    break;
                }
            }
            
            // Use actual type from FCD if available, otherwise infer from ID
            if (actualType) {
                if (actualType.includes('bicycle') || actualType.includes('bike')) {
                    vehicleType = 'bike_bicycle';
                } else if (actualType.includes('pedestrian') || actualType.includes('ped') || actualType === 'DEFAULT_PEDTYPE') {
                    vehicleType = 'ped_pedestrian';
                } else {
                    vehicleType = actualType;
                }
            } else {
                // Fallback to ID-based detection
                if (vehicleId.startsWith('bike')) {
                    vehicleType = 'bike_bicycle';
                } else if (vehicleId.startsWith('ped')) {
                    vehicleType = 'ped_pedestrian';
                }
            }
            
            // Create a minimal vehicle object for FCD-only vehicles
            const virtualVehicle = {
                id: vehicleId,
                type: vehicleType,
                depart: 0, // Will be determined from FCD data
                arrival: null,
                edgeSequence: [], // No route data, will use FCD positions
                stops: []
            };
            
            vehiclesArray.push(virtualVehicle);
            vehiclesMap.set(vehicleId, virtualVehicle);
        }
        
        if (fcdVehicleIds.size > 0) {
            console.log(`[SUMO] Found ${fcdVehicleIds.size} vehicles/persons in FCD data that are not in route files (bikes, pedestrians, etc.)`);
        }
    }
    
    for (const vehicle of vehiclesArray) {
        if (vehicle.edgeSequence && vehicle.edgeSequence.length <= 2) {
            // Private car (trip with only from/to edges)
            privateCars.push(vehicle);
        } else if (vehicle.type && (vehicle.type.includes('pt_') || vehicle.type.includes('bus') || vehicle.type.includes('tram') || vehicle.type.includes('train'))) {
            // Public transport
            publicTransportVehicles.push(vehicle);
        } else {
            // Other vehicles (bikes, pedestrians, etc.)
            otherVehicles.push(vehicle);
        }
    }
    
    // Process vehicles: prioritize private cars, then public transport, then others (bikes, pedestrians)
    // Reserve at least 30% of slots for private cars
    // Reserve some slots for bikes and pedestrians (they're important for visualization)
    const privateCarLimit = Math.max(30, Math.floor(maxVehicles * 0.3));
    const bikePedLimit = Math.max(20, Math.floor(maxVehicles * 0.2)); // Reserve 20% for bikes/pedestrians
    const publicTransportLimit = maxVehicles - privateCarLimit - bikePedLimit;
    
    let vehicleCount = 0;
    let activeCount = 0;
    let inactiveCount = 0;
    let privateCarCount = 0;
    let publicTransportCount = 0;
    
    // Process private cars first (up to their limit)
    for (const vehicle of privateCars) {
        if (privateCarCount >= privateCarLimit) break;
        
        const position = calculateVehiclePosition(vehicle, simulationTime, edgesMap);
        if (!position) {
            inactiveCount++;
            continue;
        }
        
        // Filter by Zuidas bounds
        if (!isWithinZuidasBounds(position.latitude, position.longitude)) {
            // Vehicle is outside Zuidas area, skip it
            continue;
        }
        
        activeVehicleIds.add(vehicle.id);
        privateCarCount++;
        vehicleCount++;
        activeCount++;
        
        // Create/update entity (code continues below)
        let entity = vehicleEntities.get(vehicle.id);
        const vehicleColor = getVehicleColor(vehicle.type);
        
        const newPosition = Cesium.Cartesian3.fromDegrees(
            position.longitude,
            position.latitude,
            0
        );
        
        let orientation = undefined;
        if (position.angle !== undefined && !isNaN(position.angle)) {
            try {
                orientation = Cesium.Transforms.headingPitchRollQuaternion(
                    newPosition,
                    new Cesium.HeadingPitchRoll(
                        Cesium.Math.toRadians(position.angle - 90),
                        0,
                        0
                    )
                );
            } catch (e) {
                // Ignore orientation errors
            }
        }
        
        if (!entity) {
            entity = entities.add({
                id: `sumo-vehicle-${vehicle.id}`,
                name: `Vehicle ${vehicle.id}`,
                position: newPosition,
                point: {
                    pixelSize: SUMO_CONFIG.vehicleSize || 10,
                    color: vehicleColor,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                },
                orientation: orientation,
                label: SUMO_CONFIG.showVehicleLabels ? {
                    text: vehicle.id,
                    font: '10pt sans-serif',
                    fillColor: Cesium.Color.WHITE,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    pixelOffset: new Cesium.Cartesian2(0, -30),
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    show: SUMO_CONFIG.showVehicleLabels !== false
                } : undefined
            });
            vehicleEntities.set(vehicle.id, entity);
        } else {
            entity.position = newPosition;
            if (orientation) {
                entity.orientation = orientation;
            }
        }
    }
    
    // Process public transport vehicles (up to their limit)
    for (const vehicle of publicTransportVehicles) {
        if (publicTransportCount >= publicTransportLimit) break;
        
        const position = calculateVehiclePosition(vehicle, simulationTime, edgesMap);
        if (!position) {
            inactiveCount++;
            continue;
        }
        
        // Filter by Zuidas bounds
        if (!isWithinZuidasBounds(position.latitude, position.longitude)) {
            // Vehicle is outside Zuidas area, skip it
            continue;
        }
        
        activeVehicleIds.add(vehicle.id);
        publicTransportCount++;
        vehicleCount++;
        activeCount++;
        
        // Create/update entity (same code as above)
        let entity = vehicleEntities.get(vehicle.id);
        const vehicleColor = getVehicleColor(vehicle.type);
        
        const newPosition = Cesium.Cartesian3.fromDegrees(
            position.longitude,
            position.latitude,
            0
        );
        
        let orientation = undefined;
        if (position.angle !== undefined && !isNaN(position.angle)) {
            try {
                orientation = Cesium.Transforms.headingPitchRollQuaternion(
                    newPosition,
                    new Cesium.HeadingPitchRoll(
                        Cesium.Math.toRadians(position.angle - 90),
                        0,
                        0
                    )
                );
            } catch (e) {
                // Ignore orientation errors
            }
        }
        
        if (!entity) {
            entity = entities.add({
                id: `sumo-vehicle-${vehicle.id}`,
                name: `Vehicle ${vehicle.id}`,
                position: newPosition,
                point: {
                    pixelSize: SUMO_CONFIG.vehicleSize || 10,
                    color: vehicleColor,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                },
                orientation: orientation,
                label: SUMO_CONFIG.showVehicleLabels ? {
                    text: vehicle.id,
                    font: '10pt sans-serif',
                    fillColor: Cesium.Color.WHITE,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    pixelOffset: new Cesium.Cartesian2(0, -30),
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    show: SUMO_CONFIG.showVehicleLabels !== false
                } : undefined
            });
            vehicleEntities.set(vehicle.id, entity);
        } else {
            entity.position = newPosition;
            if (orientation) {
                entity.orientation = orientation;
            }
        }
    }
    
    // Process other vehicles (bikes, pedestrians, etc.) - reserve slots for them
    let bikePedCount = 0;
    for (const vehicle of otherVehicles) {
        if (bikePedCount >= bikePedLimit) break;
        if (vehicleCount >= maxVehicles) break;
        
        const position = calculateVehiclePosition(vehicle, simulationTime, edgesMap);
        if (!position) {
            inactiveCount++;
            // Debug: log why bikes/pedestrians are inactive (only first few)
            if (inactiveCount <= 5 && (vehicle.id.startsWith('bike') || vehicle.id.startsWith('ped'))) {
                console.log(`[SUMO] ${vehicle.id.startsWith('bike') ? 'Bike' : 'Pedestrian'} ${vehicle.id} inactive at time ${simulationTime.toFixed(1)}s - no position from FCD`);
            }
            continue;
        }
        
        // Filter by Zuidas bounds
        if (!isWithinZuidasBounds(position.latitude, position.longitude)) {
            // Vehicle is outside Zuidas area, skip it
            continue;
        }
        
        activeVehicleIds.add(vehicle.id);
        bikePedCount++;
        vehicleCount++;
        activeCount++;
        
        // Debug: log first few bikes/pedestrians being processed
        if (bikePedCount <= 3 && (vehicle.id.startsWith('bike') || vehicle.id.startsWith('ped'))) {
            console.log(`[SUMO] Processing ${vehicle.id.startsWith('bike') ? 'bike' : 'pedestrian'} ${vehicle.id} at position (${position.longitude.toFixed(6)}, ${position.latitude.toFixed(6)})`);
        }
        
        // Create/update entity (same code as above)
        let entity = vehicleEntities.get(vehicle.id);
        const vehicleColor = getVehicleColor(vehicle.type);
        
        const newPosition = Cesium.Cartesian3.fromDegrees(
            position.longitude,
            position.latitude,
            0
        );
        
        let orientation = undefined;
        if (position.angle !== undefined && !isNaN(position.angle)) {
            try {
                orientation = Cesium.Transforms.headingPitchRollQuaternion(
                    newPosition,
                    new Cesium.HeadingPitchRoll(
                        Cesium.Math.toRadians(position.angle - 90),
                        0,
                        0
                    )
                );
            } catch (e) {
                // Ignore orientation errors
            }
        }
        
        if (!entity) {
            entity = entities.add({
                id: `sumo-vehicle-${vehicle.id}`,
                name: `Vehicle ${vehicle.id}`,
                position: newPosition,
                point: {
                    pixelSize: SUMO_CONFIG.vehicleSize || 10,
                    color: vehicleColor,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                },
                orientation: orientation,
                label: SUMO_CONFIG.showVehicleLabels ? {
                    text: vehicle.id,
                    font: '10pt sans-serif',
                    fillColor: Cesium.Color.WHITE,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    pixelOffset: new Cesium.Cartesian2(0, -30),
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    show: SUMO_CONFIG.showVehicleLabels !== false
                } : undefined
            });
            vehicleEntities.set(vehicle.id, entity);
        } else {
            entity.position = newPosition;
            if (orientation) {
                entity.orientation = orientation;
            }
        }
    }
    
    // Remove vehicles that are no longer active
    // Only remove if they're truly inactive (position is null, not just filtered by maxVehicles)
    let removedCount = 0;
    const entitiesToRemove = [];
    
    for (const [vehicleId, entity] of vehicleEntities.entries()) {
        if (!activeVehicleIds.has(vehicleId)) {
            // Check if this vehicle is actually inactive (position is null)
            const vehicle = vehiclesArray.find(v => v.id === vehicleId);
            if (vehicle) {
                const pos = calculateVehiclePosition(vehicle, simulationTime, edgesMap);
                if (!pos) {
                    // Vehicle is truly inactive (finished trip or hasn't started)
                    entitiesToRemove.push({ vehicleId, entity });
                } else {
                    // Vehicle has a position but wasn't processed (probably filtered by maxVehicles limit)
                    // Keep the entity - it will be updated in the next cycle if it becomes active
                    // Don't remove it, just skip updating it for now
                }
            } else {
                // Vehicle not in array, remove it
                entitiesToRemove.push({ vehicleId, entity });
            }
        }
    }
    
    // Actually remove entities (do this after iterating to avoid modifying map during iteration)
    for (const { vehicleId, entity } of entitiesToRemove) {
        entities.remove(entity);
        vehicleEntities.delete(vehicleId);
        removedCount++;
    }
    
    // Debug: log if many entities were removed
    if (removedCount > 0 && (!updateVehiclePositions._removedLog || (simulationTime - updateVehiclePositions._removedLog) > 30)) {
        console.log(`[SUMO] Removed ${removedCount} inactive vehicle entities at time ${simulationTime.toFixed(1)}s`);
        updateVehiclePositions._removedLog = simulationTime;
    }
    
    // Debug logging (only log occasionally to avoid spam)
    if (!updateVehiclePositions._lastLog || (simulationTime - updateVehiclePositions._lastLog) > 10) {
        const fcdStatus = fcdData ? 'FCD' : 'route-based';
        const createdThisUpdate = activeCount - (vehicleEntities.size - (activeCount - activeVehicleIds.size));
        const bikeCount = otherVehicles.filter(v => v.id && v.id.startsWith('bike')).length;
        const pedCount = otherVehicles.filter(v => v.id && v.id.startsWith('ped')).length;
        console.log(`[SUMO] Updated vehicle positions at ${simulationTime.toFixed(1)}s (${fcdStatus}): ${activeCount} active (${privateCarCount} cars, ${publicTransportCount} PT, ${bikePedCount} bikes/peds), ${inactiveCount} inactive, ${vehicleEntities.size} total entities`);
        if (bikeCount > 0 || pedCount > 0) {
            console.log(`[SUMO] Bikes/Pedestrians: ${bikeCount} bikes, ${pedCount} pedestrians in otherVehicles array, ${bikePedCount} processed`);
        }
        
        // Additional debug: check if positions are valid
        if (activeCount > 0 && vehicleEntities.size === 0) {
            console.warn(`[SUMO] WARNING: ${activeCount} vehicles are active but 0 entities exist! This suggests entities are being removed or not created.`);
            // Sample a few vehicle positions to check
            let sampleCount = 0;
            for (const vehicle of vehiclesArray) {
                if (sampleCount >= 3) break;
                const pos = calculateVehiclePosition(vehicle, simulationTime, edgesMap);
                if (pos) {
                    console.log(`[SUMO] Sample vehicle ${vehicle.id} position:`, pos);
                    sampleCount++;
                }
            }
        }
        updateVehiclePositions._lastLog = simulationTime;
    }
}

/**
 * Load and visualize SUMO data
 * @param {string} sumoDataPath - Base path to SUMO data directory
 * @returns {Promise<Object>} Loaded SUMO data object
 */
export async function loadSUMOVisualization(sumoDataPath) {
    try {
        console.log('[SUMO] Loading SUMO visualization...');
        console.log('[SUMO] Data path:', sumoDataPath);
        
        const viewer = getViewer();
        
        // Load network
        const networkFile = `${sumoDataPath}/osm.net.xml`;
        console.log('[SUMO] Loading network file:', networkFile);
        const { edgesMap, projectionInfo } = await loadSUMONetwork(networkFile);
        console.log('[SUMO] Network loaded:', edgesMap.size, 'edges');
        
        // Load vehicles from multiple route files
        // Include public transport (pt_*), private passenger cars (veh_passenger), bikes, and pedestrians
        const routeFiles = [
            `${sumoDataPath}/vehroutes.xml`,
            `${sumoDataPath}/osm_pt.rou.xml`,
            `${sumoDataPath}/trips.trips.xml`,
            `${sumoDataPath}/osm.passenger.trips.xml`, // Private passenger cars
            `${sumoDataPath}/osm.bike.trips.xml`,      // Bicycles (optional)
            `${sumoDataPath}/osm.pedestrian.trips.xml` // Pedestrians (optional)
        ];
        console.log('[SUMO] Loading vehicle files:', routeFiles);
        const vehicles = await loadSUMOVehicles(routeFiles);
        console.log('[SUMO] Vehicles loaded:', vehicles.length);
        
        // Load stops
        const stopsFile = `${sumoDataPath}/osm_stops.add.xml`;
        console.log('[SUMO] Loading stops file:', stopsFile);
        const stops = await loadSUMOStops(stopsFile, projectionInfo, edgesMap);
        console.log('[SUMO] Stops loaded:', stops.length);
        
        // Try to load FCD data (optional - provides exact positions)
        const fcdFile = `${sumoDataPath}/fcd-output.xml`;
        console.log('[SUMO] Attempting to load FCD data:', fcdFile);
        fcdData = await loadSUMOFCD(fcdFile, projectionInfo);
        if (fcdData) {
            console.log('[SUMO] ✓ Using FCD data for exact vehicle positions');
        } else {
            console.log('[SUMO] No FCD data found, using route-based interpolation');
        }
        
        // Store loaded data
        sumoData = {
            edgesMap,
            projectionInfo,
            vehicles,
            stops
        };
        
        // Visualize components
        if (SUMO_CONFIG.showRoadNetwork !== false) {
            visualizeRoadNetwork(edgesMap, viewer, vehicles);
        }
        
        if (SUMO_CONFIG.showStops !== false) {
            visualizeStops(stops, viewer);
        }
        
        if (SUMO_CONFIG.showRoutes) {
            visualizeRoutes(vehicles, edgesMap, viewer);
        }
        
        // Calculate simulation time range
        const departTimes = vehicles.map(v => v.depart).filter(t => !isNaN(t));
        const arrivalTimes = vehicles.map(v => v.arrival).filter(t => t && !isNaN(t));
        
        const minTime = departTimes.length > 0 ? Math.min(...departTimes) : 0;
        const maxTime = arrivalTimes.length > 0 ? Math.max(...arrivalTimes) : 
                       (departTimes.length > 0 ? Math.max(...departTimes) + 3600 : 3600);
        
        console.log(`[SUMO] Loaded ${vehicles.length} vehicles, ${stops.length} stops`);
        console.log(`[SUMO] Simulation time range: ${minTime}s - ${maxTime}s`);
        
        return {
            ...sumoData,
            timeRange: {
                start: minTime,
                end: maxTime
            }
        };
    } catch (error) {
        console.error('[SUMO] Error loading SUMO visualization:', error);
        throw error;
    }
}

/**
 * Clear all SUMO visualization entities
 */
export function clearSUMOVisualization() {
    const viewer = getViewer();
    const entities = viewer.entities;
    
    // Remove all SUMO entities
    roadNetworkEntities.forEach(entity => entities.remove(entity));
    roadNetworkEntities.length = 0;
    
    stopEntities.forEach(entity => entities.remove(entity));
    stopEntities.length = 0;
    
    routeEntities.forEach(entity => entities.remove(entity));
    routeEntities.length = 0;
    
    vehicleEntities.forEach(entity => entities.remove(entity));
    vehicleEntities.clear();
    
    sumoData = null;
    fcdData = null;
    currentSimulationTime = 0;
    
    console.log('[SUMO] Cleared all SUMO visualization');
}

/**
 * Get current SUMO data
 * @returns {Object|null} Current SUMO data or null
 */
export function getSUMOData() {
    return sumoData;
}

/**
 * Get FCD data (for external access if needed)
 * @returns {Map|null} FCD data map or null
 */
export function getFCDData() {
    return fcdData;
}

