/**
 * GTFS Common Utilities - Shared functions for both static and dynamic digital twins
 * Handles protobuf parsing, vehicle visualization, and shared constants
 */

import { getViewer } from './cesiumViewer.js';
import { GTFS_CONFIG, ZUIDAS_BOUNDS } from './config.js';

// Route type lookup map: route_id -> route_type
// GTFS route_type values: 0=Tram, 1=Subway/Metro, 2=Rail/Train, 3=Bus, 4=Ferry, etc.
let routeTypeMap = new Map();
let routeTypeMapLoaded = false;

/**
 * Add position to vehicle history and update route trail
 * @param {string} vehicleId - Vehicle identifier
 * @param {Object} position - Position object with latitude, longitude
 * @param {Date} timestamp - Timestamp of the position
 * @param {Object} vehicle - Optional vehicle data object to get color from
 */
function updateVehicleRouteTrail(vehicleId, position, timestamp, vehicle = null) {
    if (!GTFS_CONFIG.showRouteTrails) {
        return;
    }
    
    const viewer = getViewer();
    const entities = viewer.entities;
    
    // Get or create position history
    let history = vehiclePositionHistory.get(vehicleId);
    if (!history) {
        history = [];
        vehiclePositionHistory.set(vehicleId, history);
    }
    
    // Add current position to history
    const currentTime = timestamp || new Date();
    history.push({
        position: {
            latitude: position.latitude,
            longitude: position.longitude
        },
        timestamp: currentTime.getTime()
    });
    
    // Limit history by count
    if (history.length > GTFS_CONFIG.maxTrailPoints) {
        history.shift(); // Remove oldest
    }
    
    // Limit history by age
    const maxAge = currentTime.getTime() - GTFS_CONFIG.maxTrailAge;
    while (history.length > 0 && history[0].timestamp < maxAge) {
        history.shift();
    }
    
    // Need at least 2 points to draw a trail
    if (history.length < 2) {
        return;
    }
    
    // Get or create polyline entity
    let polylineEntity = vehicleRoutePolylines.get(vehicleId);
    
    // Get vehicle color for the trail
    // Try to get color from vehicle data first, then from entity
    let vehicleColor = Cesium.Color.CYAN; // Default color
    
    if (vehicle) {
        // Use getVehicleColor to get a proper Cesium.Color object
        vehicleColor = getVehicleColor(vehicle);
    } else {
        // Fallback: try to get from entity
        const vehicleEntity = vehicleEntities.get(vehicleId);
        if (vehicleEntity?.point?.color) {
            const colorValue = vehicleEntity.point.color;
            if (colorValue instanceof Cesium.Color) {
                vehicleColor = colorValue;
            } else {
                // If not a Color object, use default
                vehicleColor = Cesium.Color.CYAN;
            }
        }
    }
    
    // Create positions array for polyline
    const positions = history.map(h => 
        Cesium.Cartesian3.fromDegrees(
            h.position.longitude,
            h.position.latitude,
            0
        )
    );
    
    // Create color with opacity for the trail
    const trailColor = vehicleColor.withAlpha(GTFS_CONFIG.trailOpacity);
    
    if (polylineEntity) {
        // Update existing polyline
        polylineEntity.polyline.positions = positions;
        polylineEntity.polyline.material = trailColor;
    } else {
        // Create new polyline
        polylineEntity = entities.add({
            id: `vehicle-trail-${vehicleId}`,
            name: `Route trail for ${vehicleId}`,
            show: transitVehiclesVisible,
            polyline: {
                positions: positions,
                width: GTFS_CONFIG.trailWidth,
                material: trailColor,
                clampToGround: true,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                // Make trail slightly less prominent
                distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 50000) // Show up to 50km away
            }
        });
        vehicleRoutePolylines.set(vehicleId, polylineEntity);
    }
}

// Shared state
export const vehicleEntities = new Map(); // Map of vehicle_id -> Cesium.Entity

/**
 * Whether transit vehicle dots (and their trails) are drawn.
 *
 * Independent of whether updates are running: the feed can keep refreshing
 * positions while the layer is hidden, so turning it back on does not wait for
 * the next poll. Defaults to on; the Visual quality page turns it off because
 * the tram numbers compete with the eye-level read-out.
 */
let transitVehiclesVisible = true;
export const vehiclePositionHistory = new Map(); // Map of vehicle_id -> Array of {position, timestamp}
export const vehicleRoutePolylines = new Map(); // Map of vehicle_id -> Cesium.Entity (polyline)
export const vehiclePreviousPositions = new Map(); // Map of vehicle_id -> {position: {lat, lon}, timestamp: number}
export let FeedMessage = null; // Protobuf message type

// Get protobuf from global scope (loaded via CDN script tag)
function getProtobuf() {
    if (typeof window !== 'undefined' && window.protobuf) {
        return window.protobuf;
    }
    return null;
}

/**
 * Initialize protobuf schema for GTFS-realtime
 */
export async function initializeProtobuf() {
    if (FeedMessage) return; // Already initialized
    
    let protobuf = getProtobuf();
    if (!protobuf) {
        console.warn('protobufjs library not loaded yet, waiting...');
        await new Promise(resolve => setTimeout(resolve, 500));
        protobuf = getProtobuf();
        if (!protobuf) {
            throw new Error('protobufjs not available. Please ensure the CDN script is included in index.html');
        }
    }
    
    try {
        let protoText;
        
        try {
            const protoUrl = 'https://raw.githubusercontent.com/google/transit/master/gtfs-realtime/proto/gtfs-realtime.proto';
            const response = await fetch(protoUrl);
            if (response.ok) {
                protoText = await response.text();
                console.log('Loaded GTFS-realtime proto from Google (official)');
            } else {
                throw new Error('Failed to fetch from Google');
            }
        } catch (googleError) {
            console.warn('Could not load Google proto, trying OVapi:', googleError);
            try {
                const protoUrl = 'https://gtfs.ovapi.nl/nl/gtfs-realtime.proto';
                const response = await fetch(protoUrl);
                if (!response.ok) throw new Error('Failed to fetch proto');
                protoText = await response.text();
                console.log('Loaded GTFS-realtime proto from OVapi');
            } catch (fetchError) {
                try {
                    const localProtoUrl = './src/gtfs-realtime.proto';
                    const response = await fetch(localProtoUrl);
                    if (response.ok) {
                        protoText = await response.text();
                        console.log('Loaded GTFS-realtime proto from local file');
                    } else {
                        throw new Error('Local proto not found');
                    }
                } catch (localError) {
                    console.warn('Could not load proto file, using minimal definition');
                    protoText = getMinimalProtoDefinition();
                }
            }
        }
        
        const root = protobuf.parse(protoText, { keepCase: true }).root;
        FeedMessage = root.lookupType('transit_realtime.FeedMessage');
        
        if (!FeedMessage) {
            throw new Error('FeedMessage type not found in proto');
        }
        
        console.log('GTFS-realtime protobuf schema initialized');
    } catch (error) {
        console.error('Error loading protobuf schema:', error);
        throw error;
    }
}

/**
 * Get minimal proto definition as fallback
 */
function getMinimalProtoDefinition() {
    return `
syntax = "proto2";
package transit_realtime;

message FeedMessage {
  required FeedHeader header = 1;
  repeated FeedEntity entity = 2;
}

message FeedHeader {
  required string gtfs_realtime_version = 1;
  optional uint64 timestamp = 3;
}

message FeedEntity {
  required string id = 1;
  optional VehiclePosition vehicle = 4;
}

message TripDescriptor {
  optional string trip_id = 1;
  optional string route_id = 5;
  optional uint32 direction_id = 6;
  optional string start_time = 2;
  optional string start_date = 3;
}

message VehiclePosition {
  optional TripDescriptor trip = 1;
  optional VehicleDescriptor vehicle = 2;
  optional Position position = 3;
  optional uint64 timestamp = 7;
}

message Position {
  required float latitude = 1;
  required float longitude = 2;
  optional float bearing = 3;
  optional float speed = 5;
}

message VehicleDescriptor {
  optional string id = 1;
  optional string label = 2;
  optional string license_plate = 3;
}
`;
}

/**
 * Parse GTFS-realtime protobuf data
 * @param {ArrayBuffer} data - Protobuf binary data
 * @returns {Promise<Object>} Parsed vehicle positions
 */
export async function parseGTFSRealtime(data) {
    if (!FeedMessage) {
        await initializeProtobuf();
    }
    
    if (!FeedMessage) {
        throw new Error('Protobuf schema not initialized');
    }
    
    try {
        let buffer;
        if (data instanceof ArrayBuffer) {
            buffer = new Uint8Array(data);
        } else if (data instanceof Uint8Array) {
            buffer = data;
        } else {
            buffer = new Uint8Array(data);
        }
        
        if (buffer.length === 0) {
            console.warn('Empty GTFS-realtime data received');
            return { vehicles: [] };
        }
        
        let message;
        try {
            message = FeedMessage.decode(buffer);
        } catch (decodeError) {
            console.error('Failed to decode protobuf message:', decodeError);
            console.warn('Returning empty vehicle list due to decode error');
            return { vehicles: [] };
        }
        
        const feedMessage = FeedMessage.toObject(message, {
            longs: String,
            enums: String,
            bytes: String,
            defaults: true,
            arrays: true,
            objects: true,
            oneofs: true
        });
        
        const vehicles = [];
        let totalVehicles = 0;
        let filteredOut = 0;
        
        if (feedMessage.entity && Array.isArray(feedMessage.entity)) {
            for (const entity of feedMessage.entity) {
                if (entity.vehicle && entity.vehicle.position) {
                    totalVehicles++;
                    const pos = entity.vehicle.position;
                    const vehicle = entity.vehicle.vehicle;
                    
                    if (GTFS_CONFIG.filterByArea) {
                        const lat = pos.latitude;
                        const lon = pos.longitude;
                        
                        const expansion = GTFS_CONFIG.areaExpansionFactor || 1.0;
                        const latRange = (ZUIDAS_BOUNDS.north - ZUIDAS_BOUNDS.south) * (expansion - 1) / 2;
                        const lonRange = (ZUIDAS_BOUNDS.east - ZUIDAS_BOUNDS.west) * (expansion - 1) / 2;
                        
                        const southBound = ZUIDAS_BOUNDS.south - latRange;
                        const northBound = ZUIDAS_BOUNDS.north + latRange;
                        const westBound = ZUIDAS_BOUNDS.west - lonRange;
                        const eastBound = ZUIDAS_BOUNDS.east + lonRange;
                        
                        if (lat < southBound || lat > northBound ||
                            lon < westBound || lon > eastBound) {
                            filteredOut++;
                            continue;
                        }
                    }
                    
                    // Extract route information if available
                    // Proto is loaded with keepCase:true → snake_case field names (route_id),
                    // but tolerate camelCase too if the schema load path differs.
                    const trip = entity.vehicle.trip;
                    const routeId = trip?.route_id || trip?.routeId || null;
                    const tripId = trip?.trip_id || trip?.tripId || null;
                    const directionId = trip?.direction_id ?? trip?.directionId ?? null;
                    
                    vehicles.push({
                        id: entity.id || vehicle?.id || `vehicle_${Math.random()}`,
                        position: {
                            latitude: pos.latitude,
                            longitude: pos.longitude,
                            bearing: pos.bearing !== undefined ? pos.bearing : 0,
                            speed: pos.speed !== undefined ? pos.speed : 0
                        },
                        vehicle: {
                            id: vehicle?.id,
                            label: vehicle?.label,
                            licensePlate: vehicle?.license_plate || vehicle?.licensePlate
                        },
                        trip: {
                            tripId: tripId,
                            routeId: routeId,
                            directionId: directionId
                        },
                        timestamp: entity.vehicle.timestamp ? 
                            new Date(entity.vehicle.timestamp * 1000) : new Date()
                    });
                }
            }
        }
        
        if (GTFS_CONFIG.filterByArea && filteredOut > 0) {
            console.log(`Vehicle filtering: ${totalVehicles} total, ${filteredOut} outside Zuidas area, ${vehicles.length} shown`);
        } else {
            console.log(`Vehicle parsing: ${totalVehicles} total vehicles found, ${vehicles.length} processed`);
        }
        
        return { vehicles, feedHeader: feedMessage.header };
    } catch (error) {
        console.error('Error parsing GTFS-realtime protobuf:', error);
        throw error;
    }
}

/**
 * Load route type mapping from static GTFS routes.txt file
 * This provides accurate vehicle type information based on GTFS route_type field
 */
export async function loadRouteTypeMap() {
    if (routeTypeMapLoaded) {
        return; // Already loaded
    }
    
    try {
        // Try to load from extracted routes.txt first, then from zip
        const routesFiles = [
            './data/static-gtfs/gtfs-nl/routes.txt',
            './data/static-gtfs/gtfs-extracted/routes.txt'
        ];
        
        let routesText = null;
        for (const file of routesFiles) {
            try {
                const response = await fetch(file);
                if (response.ok) {
                    routesText = await response.text();
                    console.log(`[GTFS] Loaded route types from ${file}`);
                    break;
                }
            } catch (e) {
                // Try next file
                continue;
            }
        }
        
        if (!routesText) {
            console.warn('[GTFS] Could not load routes.txt, vehicle type detection will use fallback methods');
            routeTypeMapLoaded = true; // Mark as loaded to prevent repeated attempts
            return;
        }
        
        // Parse CSV (skip header line)
        const lines = routesText.split('\n').filter(line => line.trim());
        if (lines.length < 2) {
            console.warn('[GTFS] routes.txt appears empty or invalid');
            return;
        }
        
        // Find column indices
        const header = lines[0].split(',');
        const routeIdIdx = header.indexOf('route_id');
        const routeTypeIdx = header.indexOf('route_type');
        
        if (routeIdIdx === -1 || routeTypeIdx === -1) {
            console.warn('[GTFS] routes.txt missing required columns (route_id or route_type)');
            return;
        }
        
        // Parse routes and build map
        let count = 0;
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            if (cols.length > Math.max(routeIdIdx, routeTypeIdx)) {
                const routeId = cols[routeIdIdx]?.trim();
                const routeType = parseInt(cols[routeTypeIdx]?.trim(), 10);
                
                if (routeId && !isNaN(routeType)) {
                    routeTypeMap.set(routeId, routeType);
                    count++;
                }
            }
        }
        
        console.log(`[GTFS] Loaded ${count} route types into lookup map`);
        routeTypeMapLoaded = true;
    } catch (error) {
        console.warn('[GTFS] Error loading route type map:', error);
        routeTypeMapLoaded = true; // Mark as loaded to prevent repeated attempts
    }
}

/**
 * Get vehicle type from vehicle data
 * Uses GTFS route_type from static schedule data if available, otherwise falls back to pattern matching
 * @param {Object} vehicle - Vehicle data object
 * @returns {string} Vehicle type: 'bus', 'tram', 'train', 'metro', 'ferry', 'other'
 */
export function getVehicleType(vehicle) {
    const routeId = String(vehicle.trip?.routeId || vehicle.trip?.route_id || '');
    
    // First, try to get route_type from static GTFS data (most accurate)
    if (routeId && routeTypeMap.has(routeId)) {
        const routeType = routeTypeMap.get(routeId);
        
        // GTFS route_type values (basic + common extended ranges):
        // 0 = Tram, 1 = Metro, 2 = Rail, 3 = Bus, 4 = Ferry
        // 100–199 rail, 200–299 coach, 400–499 metro, 700–799 bus, 900–999 tram, 1000 ferry
        
        switch (routeType) {
            case 0:
                return 'tram';
            case 1:
                return 'metro';
            case 2:
                return 'train';
            case 3:
                return 'bus';
            case 4:
                return 'ferry';
            default:
                if (routeType >= 900 && routeType < 1000) return 'tram';
                if (routeType >= 400 && routeType < 500) return 'metro';
                if (routeType >= 100 && routeType < 200) return 'train';
                if (routeType >= 200 && routeType < 300) return 'bus';
                if (routeType >= 700 && routeType < 800) return 'bus';
                if (routeType >= 1000 && routeType < 1100) return 'ferry';
                // For unknown route types, fall through to pattern matching
                console.log(`[VehicleType] Route ${routeId} has unknown route_type: ${routeType}, using fallback`);
                break;
        }
    } else if (routeId && routeTypeMapLoaded) {
        // Route ID exists but not in map - log for debugging
        if (routeId && !routeId.includes(':')) {
            // Only log numeric route IDs (not agency:route format) to avoid spam
            console.log(`[VehicleType] Route ${routeId} not found in route type map, using fallback detection`);
        }
    }
    
    // Fallback: Pattern matching on route ID and label (for when route_type not available)
    const label = vehicle.vehicle?.label || vehicle.id || '';
    const labelLower = String(label).toLowerCase();
    const routeIdLower = routeId.toLowerCase();
    const entityId = String(vehicle.id || '').toLowerCase();
    
    // Agency hints from entity id (e.g. "2025-12-08:GVB:26:31697")
    if (entityId.includes(':gvb:') || entityId.includes(':ret:') || entityId.includes(':cxx:') ||
        entityId.includes(':arr:') || entityId.includes(':ebs:') || entityId.includes(':qbuzz:')) {
        // Prefer map/pattern; if still unknown, bus is most common for these agencies except GVB tram/metro
    }
    
    // Metro detection
    if (labelLower.includes('metro') || 
        (labelLower.includes('m') && (labelLower.includes('line') || labelLower.includes('lijn'))) ||
        routeIdLower.startsWith('gvb:m') ||
        routeIdLower.includes('metro') ||
        /:gvb:5[0-9]:/.test(entityId)) {
        return 'metro';
    }
    
    // Tram detection
    if (labelLower.includes('tram') || 
        routeIdLower.startsWith('gvb:t') ||
        routeIdLower.startsWith('tram') ||
        (/^[a-z]+\d+$/.test(routeIdLower) && !labelLower.includes('bus'))) {
        return 'tram';
    }
    
    // Train detection
    if (labelLower.includes('train') || 
        labelLower.includes('sprinter') ||
        labelLower.includes('intercity') ||
        labelLower.includes('ns') ||
        routeIdLower.startsWith('ns:') ||
        routeIdLower.includes('train') ||
        entityId.includes(':iff:') ||
        entityId.includes(':ns:')) {
        return 'train';
    }
    
    // Bus detection (default for most public transport)
    if (labelLower.includes('bus') ||
        routeIdLower.startsWith('gvb:b') ||
        routeIdLower.startsWith('bus') ||
        /^\d+$/.test(routeIdLower) || // Numeric route IDs are often buses
        /^[0-9]+[a-z]?$/.test(routeIdLower) ||
        entityId.includes(':bus') ||
        entityId.includes(':cxx:') ||
        entityId.includes(':arr:') ||
        entityId.includes(':ebs:') ||
        entityId.includes(':qbuzz:') ||
        entityId.includes(':connexxion:')) {
        return 'bus';
    }
    
    // Ferry detection
    if (labelLower.includes('ferry') || 
        labelLower.includes('veer') ||
        routeIdLower.includes('ferry')) {
        return 'ferry';
    }
    
    // Default to bus if we have a route ID but can't determine type
    if (routeId) {
        return 'bus';
    }
    
    return 'other';
}

/**
 * Get vehicle color based on type
 * @param {Object} vehicle - Vehicle data object
 * @returns {Cesium.Color} Color for the vehicle
 */
export function getVehicleColor(vehicle) {
    const vehicleType = getVehicleType(vehicle);
    
    const colorMap = {
        'bus': Cesium.Color.fromCssColorString('#8E44AD'), // Purple (bus)
        'tram': Cesium.Color.fromCssColorString('#FF0000'), // Red
        'train': Cesium.Color.fromCssColorString('#FFFF00'), // Yellow
        'metro': Cesium.Color.fromCssColorString('#00FF00'), // Green
        'ferry': Cesium.Color.fromCssColorString('#00FFFF'), // Cyan
        'other': Cesium.Color.fromCssColorString('#95A5A6') // Gray
    };
    
    return colorMap[vehicleType] || Cesium.Color.fromCssColorString('#95A5A6'); // Default to gray
}

/**
 * Ease-in-out interpolation function
 * @param {number} t - Progress from 0 to 1
 * @returns {number} Eased progress
 */
function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Interpolate between two positions
 * @param {Object} start - Start position {latitude, longitude}
 * @param {Object} end - End position {latitude, longitude}
 * @param {number} progress - Progress from 0 to 1
 * @returns {Object} Interpolated position {latitude, longitude}
 */
function interpolatePosition(start, end, progress) {
    const eased = easeInOut(progress);
    return {
        longitude: start.longitude + (end.longitude - start.longitude) * eased,
        latitude: start.latitude + (end.latitude - start.latitude) * eased
    };
}

/**
 * Create or update vehicle entity in Cesium with smooth interpolation
 */
export function updateVehicleEntity(vehicle) {
    const viewer = getViewer();
    const entities = viewer.entities;
    const vehicleId = vehicle.id;
    
    if (!vehicleId) {
        console.warn('Vehicle missing ID, skipping');
        return;
    }
    
    const position = vehicle.position;
    if (!position || position.latitude === undefined || position.longitude === undefined) {
        console.warn(`Vehicle ${vehicleId} missing position, skipping`);
        return;
    }
    
    let entity = vehicleEntities.get(vehicleId);
    const currentTime = vehicle.timestamp ? new Date(vehicle.timestamp).getTime() : Date.now();
    const targetPosition = { latitude: position.latitude, longitude: position.longitude };
    const vehicleType = getVehicleType(vehicle);
    const color = getVehicleColor(vehicle);
    
    if (entity) {
        // Honour the layer toggle: updates keep running while hidden, so a vehicle
        // that appears during a hidden period must still respect the flag.
        entity.show = transitVehiclesVisible;
        // Keep color in sync (e.g. after route map / type detection fixes)
        if (entity.point) {
            entity.point.color = color;
        }
        // Check if we have a previous position for interpolation
        const previous = vehiclePreviousPositions.get(vehicleId);
        
        if (previous && previous.position) {
            // Calculate time difference
            const timeDiff = currentTime - previous.timestamp;
            const interpolationDuration = GTFS_CONFIG.updateInterval || 30000; // Default 30 seconds
            
            // Only interpolate if time difference is reasonable (not too old, not too new)
            if (timeDiff > 0 && timeDiff < interpolationDuration * 2) {
                // Use Cesium's SampledPositionProperty for smooth interpolation
                if (!entity.position || !(entity.position instanceof Cesium.SampledPositionProperty)) {
                    // Convert to SampledPositionProperty for smooth movement
                    const sampledPosition = new Cesium.SampledPositionProperty();
                    sampledPosition.setInterpolationOptions({
                        interpolationDegree: 1,
                        interpolationAlgorithm: Cesium.LinearApproximation
                    });
                    
                    // Add previous position
                    const prevTime = Cesium.JulianDate.fromDate(new Date(previous.timestamp));
                    const prevCartesian = Cesium.Cartesian3.fromDegrees(
                        previous.position.longitude,
                        previous.position.latitude,
                        0
                    );
                    sampledPosition.addSample(prevTime, prevCartesian);
                    
                    entity.position = sampledPosition;
                }
                
                // Add new target position
                const targetTime = Cesium.JulianDate.fromDate(new Date(currentTime));
                const targetCartesian = Cesium.Cartesian3.fromDegrees(
                    targetPosition.longitude,
                    targetPosition.latitude,
                    0
                );
                
                if (entity.position instanceof Cesium.SampledPositionProperty) {
                    entity.position.addSample(targetTime, targetCartesian);
                    
                    // Remove old samples to keep memory usage reasonable (keep last 2)
                    const samples = entity.position._values;
                    if (samples && samples.length > 2) {
                        // Keep only the last 2 samples
                        const keepCount = 2;
                        const removeCount = samples.length - keepCount;
                        for (let i = 0; i < removeCount; i++) {
                            entity.position._values.shift();
                            entity.position._times.shift();
                        }
                    }
                } else {
                    // Fallback: direct position update
                    entity.position = targetCartesian;
                }
            } else {
                // Time difference too large or invalid, update directly
                const newPosition = Cesium.Cartesian3.fromDegrees(
                    targetPosition.longitude,
                    targetPosition.latitude,
                    0
                );
                entity.position = newPosition;
            }
        } else {
            // No previous position, update directly
            const newPosition = Cesium.Cartesian3.fromDegrees(
                targetPosition.longitude,
                targetPosition.latitude,
                0
            );
            entity.position = newPosition;
        }
        
        // Store current position as previous for next update
        vehiclePreviousPositions.set(vehicleId, {
            position: targetPosition,
            timestamp: currentTime
        });
        
        // Update route trail
        updateVehicleRouteTrail(vehicleId, targetPosition, vehicle.timestamp, vehicle);
        
        if (position.bearing !== undefined && entity.position) {
            // Get current position (works for both Cartesian3 and SampledPositionProperty)
            let currentPos = null;
            
            if (entity.position instanceof Cesium.SampledPositionProperty) {
                try {
                    currentPos = entity.position.getValue(viewer.clock.currentTime);
                } catch (e) {
                    // If getValue fails (e.g., time out of range), try to get the latest sample
                    const samples = entity.position._values;
                    if (samples && samples.length > 0) {
                        currentPos = samples[samples.length - 1];
                    }
                }
            } else if (entity.position instanceof Cesium.Cartesian3) {
                currentPos = entity.position;
            }
            
            // Only set orientation if we have a valid position
            if (currentPos && currentPos.x !== undefined && currentPos.y !== undefined && currentPos.z !== undefined) {
                try {
                    entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(
                        currentPos,
                        new Cesium.HeadingPitchRoll(
                            Cesium.Math.toRadians(position.bearing),
                            0,
                            0
                        )
                    );
                } catch (e) {
                    console.warn(`[GTFS] Failed to set vehicle orientation for ${vehicleId}:`, e);
                }
            }
        }
    } else {
        // Create new entity
        const label = vehicle.vehicle?.label || vehicleId;
        
        // Log vehicle type for debugging (only first time, and only a few examples)
        if (!vehicleEntities.has(vehicleId) && vehicleEntities.size < 5) {
            const routeId = vehicle.trip?.routeId || vehicle.trip?.route_id || 'N/A';
            const routeType = routeId !== 'N/A' && routeTypeMap.has(routeId) 
                ? routeTypeMap.get(routeId) 
                : 'not in map';
            console.log(`[Vehicle] ${vehicleId}: type=${vehicleType}, label=${label}, routeId=${routeId}, route_type=${routeType}`);
        }
        
        entity = entities.add({
            id: vehicleId,
            name: label,
            show: transitVehiclesVisible,
            position: Cesium.Cartesian3.fromDegrees(
                position.longitude,
                position.latitude,
                0
            ),
            point: {
                pixelSize: 10,
                color: color,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                // Depth-tested, so a tram behind a block is hidden by it.
                //
                // This used to be POSITIVE_INFINITY, which disables depth testing
                // entirely: every vehicle drew through every building and was
                // visible from anywhere. The intent was to keep a tram readable
                // against the ground it sits on, and that is what
                // `HeightReference.CLAMP_TO_GROUND` already does. The infinity was
                // doing something else as well, and that other thing was wrong --
                // on the eye-level pages it scattered route numbers across the
                // façades like HUD markers, with no way to tell which street they
                // were on.
                //
                // The cost is that a tram in a deep street canyon can be hidden by
                // the block in front of it. That is the correct behaviour for a
                // view that is meant to look like a place.
                disableDepthTestDistance: 0
            },
            label: {
                text: label,
                font: '12pt sans-serif',
                fillColor: Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -30),
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                // Stated rather than left to the default, because it is the
                // sibling of a value that was wrong: the label must be occluded by
                // the same buildings as the point it annotates, or a route number
                // floats on a façade with no tram under it.
                disableDepthTestDistance: 0
            }
        });
        
        if (position.bearing !== undefined && entity.position) {
            // Only set orientation if position is valid
            if (entity.position instanceof Cesium.Cartesian3) {
                try {
                    entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(
                        entity.position,
                        new Cesium.HeadingPitchRoll(
                            Cesium.Math.toRadians(position.bearing),
                            0,
                            0
                        )
                    );
                } catch (e) {
                    console.warn(`[GTFS] Failed to set vehicle orientation for ${vehicleId}:`, e);
                }
            }
        }
        
        vehicleEntities.set(vehicleId, entity);
        
        // Store initial position
        vehiclePreviousPositions.set(vehicleId, {
            position: targetPosition,
            timestamp: currentTime
        });
        
        // Initialize route trail with first position
        updateVehicleRouteTrail(vehicleId, targetPosition, vehicle.timestamp, vehicle);
    }
}

/**
 * Show or hide every GTFS vehicle entity and its trail.
 *
 * @param {boolean} show Whether vehicles should be drawn.
 */
export function setTransitVehiclesVisible(show) {
    transitVehiclesVisible = !!show;
    vehicleEntities.forEach((entity) => {
        if (entity) entity.show = transitVehiclesVisible;
    });
    vehicleRoutePolylines.forEach((entity) => {
        if (entity) entity.show = transitVehiclesVisible;
    });
}

/** Whether transit vehicles are currently set to draw. */
export function areTransitVehiclesVisible() {
    return transitVehiclesVisible;
}

/**
 * Clear all vehicle entities, their route trails, and previous positions
 */
export function clearVehicles() {
    const viewer = getViewer();
    
    // Remove vehicle entities
    vehicleEntities.forEach(entity => {
        viewer.entities.remove(entity);
    });
    vehicleEntities.clear();
    
    // Remove route trail polylines
    vehicleRoutePolylines.forEach(polylineEntity => {
        viewer.entities.remove(polylineEntity);
    });
    vehicleRoutePolylines.clear();
    
    // Clear position history
    vehiclePositionHistory.clear();
    vehiclePreviousPositions.clear();
    
    console.log('Cleared all vehicle entities and route trails');
}

