/**
 * 3D Wind Visualization Module
 * Creates animated 3D wind vectors showing wind speed and direction
 */

import { getViewer } from './cesiumViewer.js';
import { ZUIDAS_BOUNDS } from './config.js';

let windEntities = [];
let windEnabled = false;
let animationInterval = null;

/**
 * Generate fake wind data
 * Creates a grid of wind vectors with varying speed and direction
 * @param {Object} bounds - Bounding box {north, south, east, west}
 * @param {number} gridSize - Number of grid points per dimension
 * @param {number} height - Height above ground in meters
 * @returns {Array} Array of wind data objects
 */
function generateFakeWindData(bounds, gridSize = 10, height = 50) {
    const windData = [];
    const latStep = (bounds.north - bounds.south) / gridSize;
    const lonStep = (bounds.east - bounds.west) / gridSize;
    
    // Create wind patterns (e.g., circular flow around center)
    const centerLon = (bounds.east + bounds.west) / 2;
    const centerLat = (bounds.north + bounds.south) / 2;
    
    for (let i = 0; i <= gridSize; i++) {
        for (let j = 0; j <= gridSize; j++) {
            const lat = bounds.south + i * latStep;
            const lon = bounds.west + j * lonStep;
            
            // Calculate distance and angle from center
            const dx = lon - centerLon;
            const dy = lat - centerLat;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            // Create circular wind pattern (counter-clockwise)
            // Angle perpendicular to radius (tangent to circle)
            let angle = Math.atan2(dy, dx) + Math.PI / 2;
            
            // Add some variation
            angle += (Math.random() - 0.5) * 0.3;
            
            // Wind speed: faster near center, slower at edges
            const maxSpeed = 15; // m/s
            const minSpeed = 3; // m/s
            const speed = maxSpeed - (distance / 0.02) * (maxSpeed - minSpeed);
            const clampedSpeed = Math.max(minSpeed, Math.min(maxSpeed, speed));
            
            // Convert angle to heading (degrees, 0 = North, 90 = East)
            const headingDegrees = (angle * 180 / Math.PI + 90) % 360;
            
            windData.push({
                longitude: lon,
                latitude: lat,
                height: height + (Math.random() - 0.5) * 20, // Vary height slightly
                speed: clampedSpeed, // m/s
                direction: headingDegrees, // degrees (0 = North)
                u: Math.sin(angle) * clampedSpeed, // East component (m/s)
                v: Math.cos(angle) * clampedSpeed  // North component (m/s)
            });
        }
    }
    
    return windData;
}

/**
 * Convert wind speed to color
 * @param {number} speed - Wind speed in m/s
 * @returns {Cesium.Color} Color representing wind speed
 */
function speedToColor(speed) {
    // Color gradient: blue (calm) -> green -> yellow -> orange -> red (strong)
    const result = new Cesium.Color();
    
    if (speed < 5) {
        // Blue to cyan
        const t = speed / 5;
        Cesium.Color.lerp(Cesium.Color.BLUE, Cesium.Color.CYAN, t, result);
    } else if (speed < 10) {
        // Cyan to green
        const t = (speed - 5) / 5;
        Cesium.Color.lerp(Cesium.Color.CYAN, Cesium.Color.LIME, t, result);
    } else if (speed < 15) {
        // Green to yellow
        const t = (speed - 10) / 5;
        Cesium.Color.lerp(Cesium.Color.LIME, Cesium.Color.YELLOW, t, result);
    } else {
        // Yellow to red
        const t = Math.min((speed - 15) / 10, 1);
        Cesium.Color.lerp(Cesium.Color.YELLOW, Cesium.Color.RED, t, result);
    }
    
    return result;
}

/**
 * Create 3D wind visualization
 * @param {Object} options - Configuration options
 * @param {boolean} options.enabled - Whether to show wind vectors
 * @param {number} options.gridSize - Grid resolution (default: 10)
 * @param {number} options.height - Height above ground in meters (default: 50)
 * @param {number} options.vectorLength - Length multiplier for vectors (default: 1.0)
 * @param {number} options.vectorWidth - Width of vectors in pixels (default: 3)
 * @param {boolean} options.showArrows - Whether to show arrowheads (default: true)
 * @param {boolean} options.animate - Whether to animate wind vectors (default: true)
 */
export function createWindVisualization(options = {}) {
    try {
        const {
            enabled = true,
            gridSize = 10,
            height = 50,
            vectorLength = 3.0,
            vectorWidth = 4,
            showArrows = true,
            animate = true
        } = options;
        
        console.log('Creating wind visualization with options:', { enabled, gridSize, height, vectorLength, vectorWidth });
        
        const viewer = getViewer();
        
        // Clear existing wind visualization
        clearWindVisualization();
        
        if (!enabled) {
            console.log('Wind visualization disabled, skipping creation');
            return;
        }
        
        windEnabled = true;
        
        // Generate fake wind data
        const windData = generateFakeWindData(ZUIDAS_BOUNDS, gridSize, height);
        console.log(`Generated ${windData.length} wind data points`);
        
        // Use viewer.entities directly (same as GTFS vehicles)
        const entities = viewer.entities;
        console.log('Using viewer.entities for wind visualization');
        
        let vectorCount = 0;
        // Create wind vectors
        windData.forEach((wind, index) => {
            try {
                const color = speedToColor(wind.speed);
                
                // Calculate vector end point
                // Convert speed from m/s to degrees (rough approximation: 1 m/s ≈ 0.000009 degrees at equator)
                // Increased scale for better visibility
                const scale = 0.00005 * vectorLength; // Increased from 0.000009
                const endLon = wind.longitude + Math.sin(Cesium.Math.toRadians(wind.direction)) * wind.speed * scale;
                const endLat = wind.latitude + Math.cos(Cesium.Math.toRadians(wind.direction)) * wind.speed * scale;
                
                // Create polyline for wind vector
                const positions = [
                    Cesium.Cartesian3.fromDegrees(wind.longitude, wind.latitude, wind.height),
                    Cesium.Cartesian3.fromDegrees(endLon, endLat, wind.height)
                ];
                
                const entity = entities.add({
            id: `wind-vector-${index}`,
            polyline: {
                positions: positions,
                width: vectorWidth,
                material: color,
                clampToGround: false,
                arcType: Cesium.ArcType.NONE
            }
        });
        
                // Store arrowhead entities if enabled
                let arrow1Entity = null;
                let arrow2Entity = null;
                
                if (showArrows) {
                    const arrowLength = wind.speed * scale * 0.3; // Arrow size proportional to speed
                    const arrowAngle = Math.PI / 6; // 30 degrees
                    
                    // Calculate arrowhead positions
                    const baseAngle = Cesium.Math.toRadians(wind.direction);
                    const arrow1Angle = baseAngle + Math.PI - arrowAngle;
                    const arrow2Angle = baseAngle + Math.PI + arrowAngle;
                    
                    const arrow1Lon = endLon + Math.sin(arrow1Angle) * arrowLength;
                    const arrow1Lat = endLat + Math.cos(arrow1Angle) * arrowLength;
                    const arrow2Lon = endLon + Math.sin(arrow2Angle) * arrowLength;
                    const arrow2Lat = endLat + Math.cos(arrow2Angle) * arrowLength;
                    
                    // Arrowhead line 1
                    arrow1Entity = entities.add({
                        id: `wind-arrow1-${index}`,
                        polyline: {
                            positions: [
                                Cesium.Cartesian3.fromDegrees(endLon, endLat, wind.height),
                                Cesium.Cartesian3.fromDegrees(arrow1Lon, arrow1Lat, wind.height)
                            ],
                            width: vectorWidth,
                            material: color,
                            clampToGround: false
                        }
                    });
                    
                    // Arrowhead line 2
                    arrow2Entity = entities.add({
                        id: `wind-arrow2-${index}`,
                        polyline: {
                            positions: [
                                Cesium.Cartesian3.fromDegrees(endLon, endLat, wind.height),
                                Cesium.Cartesian3.fromDegrees(arrow2Lon, arrow2Lat, wind.height)
                            ],
                            width: vectorWidth,
                            material: color,
                            clampToGround: false
                        }
                    });
                }
                
                // Store wind data for animation
                wind.originalData = {
                    longitude: wind.longitude,
                    latitude: wind.latitude,
                    height: wind.height,
                    speed: wind.speed,
                    direction: wind.direction
                };
                
                windEntities.push({
                    entity: entity,
                    arrow1: arrow1Entity,
                    arrow2: arrow2Entity,
                    wind: wind
                });
                vectorCount++;
            } catch (error) {
                console.error(`Error creating wind vector ${index}:`, error);
            }
        });
        
        console.log(`Created ${vectorCount} wind vectors`);
        
        // Animate wind vectors if enabled
        if (animate) {
            startWindAnimation();
        }
        
        console.log(`Wind visualization created successfully with ${vectorCount} vectors`);
    } catch (error) {
        console.error('Error creating wind visualization:', error);
        windEnabled = false;
    }
}

/**
 * Start wind animation
 */
function startWindAnimation() {
    const viewer = getViewer();
    let time = 0;
    
    // Update wind vectors periodically
    animationInterval = setInterval(() => {
        if (!windEnabled || windEntities.length === 0) return;
        
        time += 0.1; // Increment time
        
        windEntities.forEach(({ entity, arrow1, arrow2, wind }) => {
            // Add slight variation to wind direction and speed
            const variation = Math.sin(time + wind.originalData.longitude * 100) * 0.1;
            const currentDirection = wind.originalData.direction + variation * 10;
            const currentSpeed = wind.originalData.speed * (1 + variation * 0.1);
            
            // Recalculate vector end point
            const scale = 0.00005 * 1.0; // Match the scale used in creation
            const endLon = wind.originalData.longitude + 
                Math.sin(Cesium.Math.toRadians(currentDirection)) * currentSpeed * scale;
            const endLat = wind.originalData.latitude + 
                Math.cos(Cesium.Math.toRadians(currentDirection)) * currentSpeed * scale;
            
            // Update main vector polyline positions
            entity.polyline.positions = [
                Cesium.Cartesian3.fromDegrees(
                    wind.originalData.longitude,
                    wind.originalData.latitude,
                    wind.originalData.height
                ),
                Cesium.Cartesian3.fromDegrees(endLon, endLat, wind.originalData.height)
            ];
            
            // Update color based on current speed
            const color = speedToColor(currentSpeed);
            entity.polyline.material = color;
            
            // Update arrowhead positions if they exist
            if (arrow1 && arrow2) {
                const arrowLength = currentSpeed * scale * 0.3; // Arrow size proportional to speed
                const arrowAngle = Math.PI / 6; // 30 degrees
                
                // Calculate arrowhead positions relative to new end point
                const baseAngle = Cesium.Math.toRadians(currentDirection);
                const arrow1Angle = baseAngle + Math.PI - arrowAngle;
                const arrow2Angle = baseAngle + Math.PI + arrowAngle;
                
                const arrow1Lon = endLon + Math.sin(arrow1Angle) * arrowLength;
                const arrow1Lat = endLat + Math.cos(arrow1Angle) * arrowLength;
                const arrow2Lon = endLon + Math.sin(arrow2Angle) * arrowLength;
                const arrow2Lat = endLat + Math.cos(arrow2Angle) * arrowLength;
                
                // Update arrowhead line 1
                arrow1.polyline.positions = [
                    Cesium.Cartesian3.fromDegrees(endLon, endLat, wind.originalData.height),
                    Cesium.Cartesian3.fromDegrees(arrow1Lon, arrow1Lat, wind.originalData.height)
                ];
                arrow1.polyline.material = color;
                
                // Update arrowhead line 2
                arrow2.polyline.positions = [
                    Cesium.Cartesian3.fromDegrees(endLon, endLat, wind.originalData.height),
                    Cesium.Cartesian3.fromDegrees(arrow2Lon, arrow2Lat, wind.originalData.height)
                ];
                arrow2.polyline.material = color;
            }
        });
    }, 100); // Update every 100ms
}

/**
 * Stop wind animation
 */
function stopWindAnimation() {
    if (animationInterval) {
        clearInterval(animationInterval);
        animationInterval = null;
    }
}

/**
 * Clear wind visualization
 */
export function clearWindVisualization() {
    try {
        stopWindAnimation();
        
        const viewer = getViewer();
        
        // Remove all wind entities (vectors and arrows)
        // We need to find all wind-related entities
        const entitiesToRemove = [];
        viewer.entities.values.forEach(entity => {
            if (entity.id && (entity.id.startsWith('wind-vector-') || 
                             entity.id.startsWith('wind-arrow1-') || 
                             entity.id.startsWith('wind-arrow2-'))) {
                entitiesToRemove.push(entity);
            }
        });
        
        entitiesToRemove.forEach(entity => {
            viewer.entities.remove(entity);
        });
        
        windEntities = [];
        windEnabled = false;
        console.log(`Wind visualization cleared (removed ${entitiesToRemove.length} entities)`);
    } catch (error) {
        console.error('Error clearing wind visualization:', error);
        windEntities = [];
        windEnabled = false;
    }
}

/**
 * Toggle wind visualization
 * @param {boolean} show - Whether to show wind vectors
 */
export function toggleWindVisualization(show) {
    console.log(`Toggling wind visualization: ${show}`);
    try {
        if (show && !windEnabled) {
            createWindVisualization({ enabled: true });
        } else if (!show && windEnabled) {
            clearWindVisualization();
        }
    } catch (error) {
        console.error('Error toggling wind visualization:', error);
    }
}

/**
 * Update wind visualization with new data
 * @param {Array} windData - Array of wind data objects
 */
export function updateWindVisualization(windData) {
    clearWindVisualization();
    
    if (!windData || windData.length === 0) {
        return;
    }
    
    // Use provided data to create visualization
    createWindVisualization({ enabled: true, animate: false });
}

/**
 * Check if wind visualization is currently enabled
 * @returns {boolean}
 */
export function isWindVisualizationEnabled() {
    return windEnabled;
}

