/**
 * SUMO Data Loader
 * Parses SUMO XML files and converts coordinates from SUMO's Mercator projection to WGS84
 */

/**
 * Convert SUMO Mercator coordinates to WGS84 lat/lon
 * @param {number} x - SUMO X coordinate (meters)
 * @param {number} y - SUMO Y coordinate (meters)
 * @param {Object} projectionInfo - Projection info with netOffset
 * @returns {Object} {longitude, latitude}
 */
export function convertSUMOCoords(x, y, projectionInfo) {
    const { netOffsetX, netOffsetY } = projectionInfo;
    
    // SUMO uses Mercator projection with offset
    // Inverse Mercator projection
    // x and y are in meters, need to convert to radians first
    const lon = (x - netOffsetX) / 6378137.0 * (180.0 / Math.PI);
    const lat = Math.atan(Math.exp((y - netOffsetY) / 6378137.0)) * (360.0 / Math.PI) - 90.0;
    
    // Debug: log first few conversions
    if (!convertSUMOCoords._logged) {
        console.log('[SUMO] Coordinate conversion sample:', { 
            x: x.toFixed(2), 
            y: y.toFixed(2), 
            netOffsetX: netOffsetX.toFixed(2), 
            netOffsetY: netOffsetY.toFixed(2), 
            lon: lon.toFixed(6), 
            lat: lat.toFixed(6) 
        });
        convertSUMOCoords._logged = true;
    }
    
    return { longitude: lon, latitude: lat };
}

/**
 * Parse SUMO shape string into array of coordinates
 * @param {string} shapeStr - SUMO shape string like "x1,y1 x2,y2 x3,y3"
 * @param {Object} projectionInfo - Projection info for coordinate conversion
 * @returns {Array} Array of {longitude, latitude} objects
 */
function parseShape(shapeStr, projectionInfo) {
    if (!shapeStr) return [];
    
    const coords = [];
    const points = shapeStr.trim().split(/\s+/);
    
    for (const point of points) {
        const [x, y] = point.split(',').map(parseFloat);
        if (!isNaN(x) && !isNaN(y)) {
            const wgs84 = convertSUMOCoords(x, y, projectionInfo);
            coords.push(wgs84);
        }
    }
    
    return coords;
}

/**
 * Extract projection information from SUMO network XML
 * @param {Document} xmlDoc - Parsed XML document
 * @returns {Object} Projection info with netOffset
 */
function extractProjectionInfo(xmlDoc) {
    const location = xmlDoc.querySelector('location');
    if (!location) {
        throw new Error('No location element found in network file');
    }
    
    const netOffset = location.getAttribute('netOffset') || '0,0';
    const [netOffsetX, netOffsetY] = netOffset.split(',').map(parseFloat);
    
    return {
        netOffsetX: netOffsetX || 0,
        netOffsetY: netOffsetY || 0
    };
}

/**
 * Load and parse SUMO network file
 * @param {string} networkFile - Path to network XML file
 * @returns {Promise<Object>} Object with edgesMap and projectionInfo
 */
export async function loadSUMONetwork(networkFile) {
    try {
        const response = await fetch(networkFile);
        if (!response.ok) {
            throw new Error(`Failed to load network file: ${response.statusText}`);
        }
        
        const text = await response.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, 'text/xml');
        
        // Check for parsing errors
        const parserError = xmlDoc.querySelector('parsererror');
        if (parserError) {
            throw new Error(`XML parsing error: ${parserError.textContent}`);
        }
        
        // Extract projection info
        const projectionInfo = extractProjectionInfo(xmlDoc);
        
        // Parse edges
        const edgesMap = new Map();
        const edges = xmlDoc.querySelectorAll('edge');
        
        for (const edge of edges) {
            const edgeId = edge.getAttribute('id');
            if (!edgeId || edgeId.startsWith(':')) {
                // Skip internal edges (they start with :)
                continue;
            }
            
            // Get lanes for this edge
            const lanes = edge.querySelectorAll('lane');
            if (lanes.length === 0) continue;
            
            // Use the first lane's shape as the edge geometry
            const firstLane = lanes[0];
            const shape = firstLane.getAttribute('shape');
            if (!shape) continue;
            
            const coords = parseShape(shape, projectionInfo);
            if (coords.length > 0) {
                edgesMap.set(edgeId, {
                    id: edgeId,
                    coords: coords,
                    length: parseFloat(firstLane.getAttribute('length')) || 0,
                    speed: parseFloat(firstLane.getAttribute('speed')) || 13.89,
                    type: edge.getAttribute('type') || 'unknown'
                });
            }
        }
        
        console.log(`[SUMO] Loaded ${edgesMap.size} edges from network file`);
        
        return {
            edgesMap,
            projectionInfo
        };
    } catch (error) {
        console.error('[SUMO] Error loading network file:', error);
        throw error;
    }
}

/**
 * Get edge geometry by ID
 * @param {string} edgeId - Edge ID (may include #lane suffix)
 * @param {Map} edgesMap - Map of edge ID to edge data
 * @returns {Array|null} Array of coordinates or null if not found
 */
export function getEdgeGeometry(edgeId, edgesMap) {
    // Remove lane suffix if present (e.g., "467752394#0" -> "467752394")
    const baseEdgeId = edgeId.split('#')[0];
    
    // Try exact match first
    if (edgesMap.has(edgeId)) {
        return edgesMap.get(edgeId).coords;
    }
    
    // Try base edge ID
    if (edgesMap.has(baseEdgeId)) {
        return edgesMap.get(baseEdgeId).coords;
    }
    
    // Try with negative prefix (reverse direction)
    const negativeEdgeId = `-${baseEdgeId}`;
    if (edgesMap.has(negativeEdgeId)) {
        const coords = edgesMap.get(negativeEdgeId).coords;
        // Reverse coordinates for negative edge
        return [...coords].reverse();
    }
    
    return null;
}

/**
 * Build complete route geometry from edge sequence
 * @param {Array<string>} edgeSequence - Array of edge IDs
 * @param {Map} edgesMap - Map of edge ID to edge data
 * @returns {Array} Array of {longitude, latitude} coordinates
 */
export function buildRouteGeometry(edgeSequence, edgesMap) {
    const routeCoords = [];
    
    for (const edgeId of edgeSequence) {
        const edgeCoords = getEdgeGeometry(edgeId, edgesMap);
        if (edgeCoords && edgeCoords.length > 0) {
            // Avoid duplicate points at edge connections
            if (routeCoords.length > 0) {
                const lastPoint = routeCoords[routeCoords.length - 1];
                const firstPoint = edgeCoords[0];
                
                // Only add if not duplicate
                if (lastPoint.longitude !== firstPoint.longitude || 
                    lastPoint.latitude !== firstPoint.latitude) {
                    routeCoords.push(...edgeCoords);
                } else {
                    // Skip first point if duplicate
                    routeCoords.push(...edgeCoords.slice(1));
                }
            } else {
                routeCoords.push(...edgeCoords);
            }
        }
    }
    
    return routeCoords;
}

/**
 * Load SUMO vehicle routes
 * @param {Array<string>} routeFiles - Array of route file paths
 * @returns {Promise<Array>} Array of vehicle objects
 */
export async function loadSUMOVehicles(routeFiles) {
    const vehicles = [];
    
    for (const routeFile of routeFiles) {
        try {
            const response = await fetch(routeFile);
            if (!response.ok) {
                console.warn(`[SUMO] Failed to load route file ${routeFile}: ${response.statusText}`);
                continue;
            }
            
            const text = await response.text();
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(text, 'text/xml');
            
            // Check for parsing errors
            const parserError = xmlDoc.querySelector('parsererror');
            if (parserError) {
                console.warn(`[SUMO] XML parsing error in ${routeFile}: ${parserError.textContent}`);
                continue;
            }
            
            // Parse vehicles and trips
            // Note: 'vehicle' elements have full routes, 'trip' elements have from/to (need routing)
            const vehicleElements = xmlDoc.querySelectorAll('vehicle, trip');
            
            for (const veh of vehicleElements) {
                const vehicleId = veh.getAttribute('id');
                const vehicleType = veh.getAttribute('type') || 'unknown';
                const depart = parseFloat(veh.getAttribute('depart')) || 0;
                const arrival = parseFloat(veh.getAttribute('arrival')) || null;
                
                // Get route edges
                let edgeSequence = [];
                const routeElement = veh.querySelector('route');
                
                if (routeElement) {
                    // Vehicle has full route
                    const edgesAttr = routeElement.getAttribute('edges');
                    if (edgesAttr) {
                        edgeSequence = edgesAttr.trim().split(/\s+/);
                    }
                } else {
                    // Trip element - has from/to edges (private cars often use trips)
                    const fromEdge = veh.getAttribute('from');
                    const toEdge = veh.getAttribute('to');
                    if (fromEdge && toEdge) {
                        // For trips, we'll need to calculate the route later or use FCD data
                        // For now, store from/to so we can build route if needed
                        edgeSequence = [fromEdge, toEdge]; // Simplified - actual routing would be needed
                    }
                }
                
                // Get stops
                const stops = [];
                const stopElements = veh.querySelectorAll('stop');
                for (const stop of stopElements) {
                    stops.push({
                        busStop: stop.getAttribute('busStop'),
                        duration: parseFloat(stop.getAttribute('duration')) || 30,
                        until: parseFloat(stop.getAttribute('until')) || null
                    });
                }
                
                vehicles.push({
                    id: vehicleId,
                    type: vehicleType,
                    depart: depart,
                    arrival: arrival,
                    edgeSequence: edgeSequence,
                    stops: stops
                });
            }
            
            console.log(`[SUMO] Loaded ${vehicleElements.length} vehicles from ${routeFile}`);
        } catch (error) {
            console.error(`[SUMO] Error loading route file ${routeFile}:`, error);
        }
    }
    
    return vehicles;
}

/**
 * Load SUMO stops
 * @param {string} stopsFile - Path to stops XML file
 * @param {Object} projectionInfo - Projection info for coordinate conversion
 * @param {Map} edgesMap - Map of edge ID to edge data (for stop position calculation)
 * @returns {Promise<Array>} Array of stop objects with positions
 */
export async function loadSUMOStops(stopsFile, projectionInfo, edgesMap) {
    try {
        const response = await fetch(stopsFile);
        if (!response.ok) {
            throw new Error(`Failed to load stops file: ${response.statusText}`);
        }
        
        const text = await response.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, 'text/xml');
        
        // Check for parsing errors
        const parserError = xmlDoc.querySelector('parsererror');
        if (parserError) {
            throw new Error(`XML parsing error: ${parserError.textContent}`);
        }
        
        const stops = [];
        const stopElements = xmlDoc.querySelectorAll('busStop');
        
        for (const stop of stopElements) {
            const stopId = stop.getAttribute('id');
            const stopName = stop.getAttribute('name') || stopId;
            const laneId = stop.getAttribute('lane');
            const startPos = parseFloat(stop.getAttribute('startPos')) || 0;
            const endPos = parseFloat(stop.getAttribute('endPos')) || 0;
            const lines = stop.getAttribute('lines') || '';
            
            // Calculate stop position from lane
            let position = null;
            if (laneId) {
                // Extract edge ID from lane (format: "edgeId_laneIndex" or "-edgeId_laneIndex")
                const laneParts = laneId.split('_');
                const edgeId = laneParts[0];
                
                // Get edge data (includes length) and coordinates
                const edgeData = edgesMap.get(edgeId) || edgesMap.get(edgeId.replace('-', ''));
                const edgeCoords = edgeData ? edgeData.coords : getEdgeGeometry(edgeId, edgesMap);
                
                if (edgeCoords && edgeCoords.length > 0) {
                    // Interpolate position along edge based on startPos (in meters)
                    if (edgeCoords.length === 1) {
                        position = edgeCoords[0];
                    } else if (edgeCoords.length > 1) {
                        // Calculate position ratio based on startPos and edge length
                        // startPos is in meters along the lane
                        const edgeLength = edgeData ? edgeData.length : 0;
                        let posRatio = 0.5; // Default to center
                        
                        if (edgeLength > 0 && startPos >= 0) {
                            // Use actual edge length if available
                            posRatio = Math.min(1.0, Math.max(0.0, startPos / edgeLength));
                        } else if (startPos > 0) {
                            // Fallback: estimate ratio (assume typical edge length of 50-200m)
                            // Use a conservative estimate
                            posRatio = Math.min(1.0, Math.max(0.0, startPos / 150.0));
                        }
                        
                        const index = Math.floor(posRatio * (edgeCoords.length - 1));
                        const nextIndex = Math.min(index + 1, edgeCoords.length - 1);
                        const t = (posRatio * (edgeCoords.length - 1)) - index;
                        
                        const p1 = edgeCoords[index];
                        const p2 = edgeCoords[nextIndex];
                        
                        // Validate that both points exist and have valid coordinates
                        if (p1 && p2 && 
                            typeof p1.longitude === 'number' && typeof p1.latitude === 'number' &&
                            typeof p2.longitude === 'number' && typeof p2.latitude === 'number') {
                            position = {
                                longitude: p1.longitude + (p2.longitude - p1.longitude) * t,
                                latitude: p1.latitude + (p2.latitude - p1.latitude) * t
                            };
                        } else if (p1 && typeof p1.longitude === 'number' && typeof p1.latitude === 'number') {
                            // Fallback to first point if second is invalid
                            position = p1;
                        }
                    }
                }
            }
            
            // Fallback: if we couldn't calculate position, use lane center
            if (!position && laneId) {
                // Try to get edge center
                const laneParts = laneId.split('_');
                const edgeId = laneParts[0];
                const edgeCoords = getEdgeGeometry(edgeId, edgesMap);
                if (edgeCoords && edgeCoords.length > 0) {
                    const centerIndex = Math.floor(edgeCoords.length / 2);
                    const centerPoint = edgeCoords[centerIndex];
                    if (centerPoint && 
                        typeof centerPoint.longitude === 'number' && 
                        typeof centerPoint.latitude === 'number') {
                        position = centerPoint;
                    } else if (edgeCoords[0] && 
                               typeof edgeCoords[0].longitude === 'number' && 
                               typeof edgeCoords[0].latitude === 'number') {
                        // Use first point as fallback
                        position = edgeCoords[0];
                    }
                }
            }
            
            // Only add stop if we have a valid position
            if (position && 
                typeof position.longitude === 'number' && 
                typeof position.latitude === 'number' &&
                !isNaN(position.longitude) && 
                !isNaN(position.latitude)) {
                stops.push({
                    id: stopId,
                    name: stopName,
                    position: position,
                    laneId: laneId,
                    lines: lines.split(' ').filter(l => l)
                });
            } else {
                console.warn(`[SUMO] Could not determine position for stop ${stopId} (lane: ${laneId}), skipping`);
            }
        }
        
        console.log(`[SUMO] Loaded ${stops.length} stops from stops file`);
        
        return stops;
    } catch (error) {
        console.error('[SUMO] Error loading stops file:', error);
        throw error;
    }
}

/**
 * Load SUMO FCD (Floating Car Data) output
 * FCD contains vehicle positions at each simulation timestep
 * @param {string} fcdFile - Path to FCD XML file
 * @param {Object} projectionInfo - Projection info for coordinate conversion
 * @returns {Promise<Map>} Map of time (seconds) -> Array of vehicle positions
 */
export async function loadSUMOFCD(fcdFile, projectionInfo) {
    try {
        const response = await fetch(fcdFile);
        if (!response.ok) {
            console.warn(`[SUMO] FCD file not found: ${fcdFile} (this is optional)`);
            return null;
        }
        
        let text = await response.text();
        
        // Try to fix common XML issues before parsing
        // Fix missing attribute values (e.g., speed="" -> speed="0")
        text = text.replace(/(\w+)=""/g, '$1="0"');
        // Fix attributes without quotes (e.g., speed= -> speed="0")
        text = text.replace(/(\w+)=(\s|>)/g, '$1="0"$2');
        // Fix attributes with incomplete values (e.g., speed=" -> speed="0")
        text = text.replace(/(\w+)="(\s|>)/g, '$1="0"$2');
        
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, 'text/xml');
        
        // Check for parsing errors
        const parserError = xmlDoc.querySelector('parsererror');
        if (parserError) {
            // Try parsing with a more lenient approach - use regex to extract data
            // Don't show the full error message, just a brief note
            console.log(`[SUMO] XML parser detected issues, using regex-based parsing (this is normal for large FCD files)`);
            return parseFCDWithRegex(text, projectionInfo);
        }
        
        // FCD format: <fcd-export><timestep time="X"><vehicle id="..." x="..." y="..." angle="..." speed="..."/></timestep></fcd-export>
        const fcdData = new Map(); // time (seconds) -> Array of vehicle positions
        
        const timesteps = xmlDoc.querySelectorAll('timestep');
        
        for (const timestep of timesteps) {
            const time = parseFloat(timestep.getAttribute('time')) || 0;
            const vehicles = [];
            
            // Parse vehicles (cars, buses, bikes, etc.)
            const vehicleElements = timestep.querySelectorAll('vehicle');
            for (const veh of vehicleElements) {
                const vehicleId = veh.getAttribute('id');
                const x = parseFloat(veh.getAttribute('x'));
                const y = parseFloat(veh.getAttribute('y'));
                const angle = parseFloat(veh.getAttribute('angle')) || 0;
                const speed = parseFloat(veh.getAttribute('speed')) || 0;
                const vehicleType = veh.getAttribute('type') || null;
                
                if (!isNaN(x) && !isNaN(y)) {
                    // Convert SUMO coordinates to WGS84
                    const wgs84 = convertSUMOCoords(x, y, projectionInfo);
                    
                    vehicles.push({
                        id: vehicleId,
                        type: vehicleType,
                        position: {
                            longitude: wgs84.longitude,
                            latitude: wgs84.latitude
                        },
                        angle: angle,
                        speed: speed
                    });
                }
            }
            
            // Parse persons (pedestrians)
            const personElements = timestep.querySelectorAll('person');
            for (const person of personElements) {
                const personId = person.getAttribute('id');
                const x = parseFloat(person.getAttribute('x'));
                const y = parseFloat(person.getAttribute('y'));
                const angle = parseFloat(person.getAttribute('angle')) || 0;
                const speed = parseFloat(person.getAttribute('speed')) || 0;
                const personType = person.getAttribute('type') || 'DEFAULT_PEDTYPE';
                
                if (!isNaN(x) && !isNaN(y)) {
                    // Convert SUMO coordinates to WGS84
                    const wgs84 = convertSUMOCoords(x, y, projectionInfo);
                    
                    vehicles.push({
                        id: personId,
                        type: personType,
                        position: {
                            longitude: wgs84.longitude,
                            latitude: wgs84.latitude
                        },
                        angle: angle,
                        speed: speed
                    });
                }
            }
            
            if (vehicles.length > 0) {
                fcdData.set(time, vehicles);
            }
        }
        
        console.log(`[SUMO] Loaded FCD data: ${fcdData.size} timesteps, ${Array.from(fcdData.values()).reduce((sum, arr) => sum + arr.length, 0)} total vehicle positions`);
        
        return fcdData;
    } catch (error) {
        console.warn(`[SUMO] Error loading FCD file (will use route-based interpolation):`, error.message);
        return null;
    }
}

/**
 * Fallback parser for malformed FCD XML using regex
 * @param {string} text - FCD XML text
 * @param {Object} projectionInfo - Projection info for coordinate conversion
 * @returns {Map|null} FCD data map or null if parsing fails
 */
function parseFCDWithRegex(text, projectionInfo) {
    try {
        const fcdData = new Map();
        
        // Match timestep blocks: <timestep time="X">...</timestep>
        const timestepRegex = /<timestep\s+time="([^"]+)">(.*?)<\/timestep>/gs;
        let match;
        
        while ((match = timestepRegex.exec(text)) !== null) {
            const time = parseFloat(match[1]) || 0;
            const timestepContent = match[2];
            const vehicles = [];
            
            // Match vehicle elements: <vehicle id="..." x="..." y="..." .../>
            // Handle attributes that might be missing values
            const vehicleRegex = /<vehicle\s+([^>]+)\/>/g;
            let vehMatch;
            
            while ((vehMatch = vehicleRegex.exec(timestepContent)) !== null) {
                const attrs = vehMatch[1];
                
                // Extract attributes with regex (more lenient)
                const idMatch = attrs.match(/id="([^"]*)"/);
                const xMatch = attrs.match(/x="([^"]*)"/);
                const yMatch = attrs.match(/y="([^"]*)"/);
                const angleMatch = attrs.match(/angle="([^"]*)"/);
                const speedMatch = attrs.match(/speed="([^"]*)"/);
                
                if (!idMatch || !xMatch || !yMatch) continue;
                
                const vehicleId = idMatch[1];
                const x = parseFloat(xMatch[1]);
                const y = parseFloat(yMatch[1]);
                const angle = angleMatch ? parseFloat(angleMatch[1]) || 0 : 0;
                const speed = speedMatch ? parseFloat(speedMatch[1]) || 0 : 0;
                const typeMatch = attrs.match(/type="([^"]*)"/);
                const vehicleType = typeMatch ? typeMatch[1] : null;
                
                if (!isNaN(x) && !isNaN(y)) {
                    const wgs84 = convertSUMOCoords(x, y, projectionInfo);
                    vehicles.push({
                        id: vehicleId,
                        type: vehicleType,
                        position: {
                            longitude: wgs84.longitude,
                            latitude: wgs84.latitude
                        },
                        angle: angle,
                        speed: speed
                    });
                }
            }
            
            // Match person elements (pedestrians): <person id="..." x="..." y="..." .../>
            const personRegex = /<person\s+([^>]+)\/>/g;
            let personMatch;
            
            while ((personMatch = personRegex.exec(timestepContent)) !== null) {
                const attrs = personMatch[1];
                
                // Extract attributes with regex (more lenient)
                const idMatch = attrs.match(/id="([^"]*)"/);
                const xMatch = attrs.match(/x="([^"]*)"/);
                const yMatch = attrs.match(/y="([^"]*)"/);
                const angleMatch = attrs.match(/angle="([^"]*)"/);
                const speedMatch = attrs.match(/speed="([^"]*)"/);
                
                if (!idMatch || !xMatch || !yMatch) continue;
                
                const personId = idMatch[1];
                const x = parseFloat(xMatch[1]);
                const y = parseFloat(yMatch[1]);
                const angle = angleMatch ? parseFloat(angleMatch[1]) || 0 : 0;
                const speed = speedMatch ? parseFloat(speedMatch[1]) || 0 : 0;
                const typeMatch = attrs.match(/type="([^"]*)"/);
                const personType = typeMatch ? typeMatch[1] : 'DEFAULT_PEDTYPE';
                
                if (!isNaN(x) && !isNaN(y)) {
                    const wgs84 = convertSUMOCoords(x, y, projectionInfo);
                    vehicles.push({
                        id: personId,
                        type: personType,
                        position: {
                            longitude: wgs84.longitude,
                            latitude: wgs84.latitude
                        },
                        angle: angle,
                        speed: speed
                    });
                }
            }
            
            if (vehicles.length > 0) {
                fcdData.set(time, vehicles);
            }
        }
        
        if (fcdData.size > 0) {
            console.log(`[SUMO] Loaded FCD data (regex parser): ${fcdData.size} timesteps, ${Array.from(fcdData.values()).reduce((sum, arr) => sum + arr.length, 0)} total vehicle positions`);
            return fcdData;
        }
        
        return null;
    } catch (error) {
        console.warn(`[SUMO] Regex-based FCD parsing also failed:`, error.message);
        return null;
    }
}

/**
 * Get vehicle position from FCD data for a given time
 * Interpolates between timesteps if exact time not found
 * @param {string} vehicleId - Vehicle ID
 * @param {number} simulationTime - Simulation time in seconds
 * @param {Map} fcdData - FCD data map (time -> vehicles array)
 * @returns {Object|null} Vehicle position data or null if not found
 */
export function getVehiclePositionFromFCD(vehicleId, simulationTime, fcdData) {
    if (!fcdData || fcdData.size === 0) {
        return null;
    }
    
    // Find closest timesteps
    const times = Array.from(fcdData.keys()).sort((a, b) => a - b);
    
    // Find exact match or closest timesteps
    let exactTime = null;
    let prevTime = null;
    let nextTime = null;
    
    for (let i = 0; i < times.length; i++) {
        if (times[i] === simulationTime) {
            exactTime = times[i];
            break;
        } else if (times[i] < simulationTime) {
            prevTime = times[i];
        } else if (times[i] > simulationTime && nextTime === null) {
            nextTime = times[i];
            break;
        }
    }
    
    // Try exact match first
    if (exactTime !== null) {
        const vehicles = fcdData.get(exactTime);
        const vehicle = vehicles.find(v => v.id === vehicleId);
        if (vehicle) {
            return vehicle;
        }
    }
    
    // Interpolate between timesteps
    if (prevTime !== null && nextTime !== null) {
        const prevVehicles = fcdData.get(prevTime);
        const nextVehicles = fcdData.get(nextTime);
        
        const prevVehicle = prevVehicles.find(v => v.id === vehicleId);
        const nextVehicle = nextVehicles.find(v => v.id === vehicleId);
        
        if (prevVehicle && nextVehicle) {
            const timeDiff = nextTime - prevTime;
            const elapsed = simulationTime - prevTime;
            const t = timeDiff > 0 ? elapsed / timeDiff : 0;
            
            return {
                id: vehicleId,
                position: {
                    longitude: prevVehicle.position.longitude + (nextVehicle.position.longitude - prevVehicle.position.longitude) * t,
                    latitude: prevVehicle.position.latitude + (nextVehicle.position.latitude - prevVehicle.position.latitude) * t
                },
                angle: prevVehicle.angle + (nextVehicle.angle - prevVehicle.angle) * t,
                speed: prevVehicle.speed + (nextVehicle.speed - prevVehicle.speed) * t
            };
        }
    }
    
    // Use closest available timestep (prefer previous over next for smoother movement)
    if (prevTime !== null) {
        const vehicles = fcdData.get(prevTime);
        if (vehicles) {
            const vehicle = vehicles.find(v => v.id === vehicleId);
            if (vehicle) {
                return vehicle;
            }
        }
    }
    
    if (nextTime !== null) {
        const vehicles = fcdData.get(nextTime);
        if (vehicles) {
            const vehicle = vehicles.find(v => v.id === vehicleId);
            if (vehicle) {
                return vehicle;
            }
        }
    }
    
    // If no match found, vehicle might have finished its trip or isn't in FCD data
    return null;
}

