/**
 * Boundary Loader for Cesium
 * 
 * Loads area boundaries (polygons) from GeoJSON, KML, or other formats
 * and displays them on the Cesium map.
 */

import { getViewer } from './cesiumViewer.js';

/**
 * Fix GeoJSON CRS issues - remove CRS or convert coordinates if needed
 * @param {Object} geoJson - GeoJSON object
 * @returns {Object} Fixed GeoJSON object
 */
function fixGeoJsonCRS(geoJson) {
    // Create a deep copy to avoid mutating original
    const fixed = JSON.parse(JSON.stringify(geoJson));
    
    // Remove CRS property (Cesium expects WGS84/EPSG:4326)
    if (fixed.crs) {
        console.log('[Boundary] Removing CRS from GeoJSON (Cesium uses WGS84/EPSG:4326)');
        delete fixed.crs;
    }
    
    // If coordinates look like they might be in Web Mercator (EPSG:3857),
    // they would be very large numbers (millions). WGS84 coordinates are small.
    // But we'll assume the coordinates are already correct and just remove CRS.
    
    return fixed;
}

/**
 * Load a boundary from GeoJSON
 * @param {string|Object} geoJsonUrl - URL to GeoJSON file or GeoJSON object
 * @param {Object} options - Display options
 * @returns {Promise<Cesium.DataSource>} The loaded data source
 */
export async function loadBoundaryFromGeoJSON(geoJsonUrl, options = {}) {
    const viewer = getViewer();
    
    const defaultOptions = {
        strokeColor: Cesium.Color.YELLOW,
        strokeWidth: 3,
        fillColor: Cesium.Color.YELLOW.withAlpha(0.2),
        height: 0,
        extrudedHeight: options.extrudedHeight || 0,
        clampToGround: true,
        name: options.name || 'Boundary'
    };
    
    const finalOptions = { ...defaultOptions, ...options };
    
    try {
        let geoJsonData;
        
        // If it's a URL, fetch and parse it
        if (typeof geoJsonUrl === 'string') {
            const response = await fetch(geoJsonUrl);
            geoJsonData = await response.json();
        } else {
            geoJsonData = geoJsonUrl;
        }
        
        // Fix CRS issues
        geoJsonData = fixGeoJsonCRS(geoJsonData);
        
        // Load GeoJSON data source (pass as object, not URL, to avoid CRS issues)
        const dataSource = await Cesium.GeoJsonDataSource.load(geoJsonData, {
            stroke: finalOptions.strokeColor,
            strokeWidth: finalOptions.strokeWidth,
            fill: finalOptions.fillColor,
            clampToGround: finalOptions.clampToGround
        });
        
        // Add to viewer
        viewer.dataSources.add(dataSource);
        
        // Apply custom styling to polygons
        const entities = dataSource.entities.values;
        entities.forEach(entity => {
            if (entity.polygon) {
                // If clampToGround is false and height is 0, use RELATIVE_TO_GROUND instead of NONE
                // This ensures height: 0 means "at ground level" not "at ellipsoid height 0"
                let heightReference = Cesium.HeightReference.NONE;
                if (finalOptions.clampToGround) {
                    heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
                } else if (finalOptions.height === 0) {
                    // Height 0 with clampToGround false should still be relative to ground
                    heightReference = Cesium.HeightReference.RELATIVE_TO_GROUND;
                }
                
                entity.polygon.height = finalOptions.height;
                entity.polygon.extrudedHeight = finalOptions.extrudedHeight;
                entity.polygon.heightReference = heightReference;
                entity.polygon.extrudedHeightReference = Cesium.HeightReference.RELATIVE_TO_GROUND;
                entity.polygon.material = finalOptions.fillColor;
                
                // Disable default outline (it has limited width support on Windows)
                entity.polygon.outline = false;
                
                // Create a polyline outline instead (supports width properly)
                const hierarchy = entity.polygon.hierarchy.getValue();
                if (hierarchy && hierarchy.positions) {
                    const positions = hierarchy.positions;
                    // Close the polygon by adding first position at the end
                    const closedPositions = positions.concat([positions[0]]);
                    
                    // Adjust polyline positions to match polygon height
                    let polylinePositions = closedPositions;
                    if (!finalOptions.clampToGround && finalOptions.height !== 0) {
                        // If not clamped to ground and height is set, adjust positions
                        polylinePositions = closedPositions.map(pos => {
                            const cartographic = Cesium.Cartographic.fromCartesian(pos);
                            cartographic.height = finalOptions.height;
                            return Cesium.Cartographic.toCartesian(cartographic);
                        });
                    }
                    
                    // Determine height reference for polyline
                    let polylineHeightReference = Cesium.HeightReference.NONE;
                    if (finalOptions.clampToGround) {
                        polylineHeightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
                    } else if (finalOptions.height === 0) {
                        polylineHeightReference = Cesium.HeightReference.RELATIVE_TO_GROUND;
                    }
                    
                    // Create polyline entity for the outline
                    viewer.entities.add({
                        name: `${finalOptions.name} - Outline`,
                        polyline: {
                            positions: polylinePositions,
                            width: finalOptions.strokeWidth,
                            material: finalOptions.strokeColor,
                            clampToGround: finalOptions.clampToGround,
                            heightReference: polylineHeightReference
                        }
                    });
                }
                
                // Set name
                if (!entity.name) {
                    entity.name = finalOptions.name;
                }
            }
        });
        
        console.log(`[Boundary] Loaded boundary from GeoJSON: ${finalOptions.name}`);
        console.log(`[Boundary] Entities: ${entities.length}`);
        
        return dataSource;
    } catch (error) {
        console.error('[Boundary] Error loading GeoJSON:', error);
        throw error;
    }
}

/**
 * Load a boundary from KML
 * @param {string} kmlUrl - URL to KML file
 * @param {Object} options - Display options
 * @returns {Promise<Cesium.DataSource>} The loaded data source
 */
export async function loadBoundaryFromKML(kmlUrl, options = {}) {
    const viewer = getViewer();
    
    try {
        const dataSource = await Cesium.KmlDataSource.load(kmlUrl, {
            camera: viewer.scene.camera,
            canvas: viewer.scene.canvas
        });
        
        viewer.dataSources.add(dataSource);
        
        console.log(`[Boundary] Loaded boundary from KML`);
        
        return dataSource;
    } catch (error) {
        console.error('[Boundary] Error loading KML:', error);
        throw error;
    }
}

/**
 * Load a boundary from coordinates array
 * @param {Array<Array<number>>} coordinates - Array of [longitude, latitude] pairs
 * @param {Object} options - Display options
 * @returns {Cesium.Entity} The created entity
 */
export function loadBoundaryFromCoordinates(coordinates, options = {}) {
    const viewer = getViewer();
    const entities = viewer.entities;
    
    const defaultOptions = {
        strokeColor: Cesium.Color.YELLOW,
        strokeWidth: 3,
        fillColor: Cesium.Color.YELLOW.withAlpha(0.2),
        height: 0,
        extrudedHeight: 0,
        clampToGround: true,
        name: 'Zuidas Boundary'
    };
    
    const finalOptions = { ...defaultOptions, ...options };
    
    // Convert coordinates to Cesium positions
    const positions = coordinates.map(coord => 
        Cesium.Cartesian3.fromDegrees(coord[0], coord[1], finalOptions.height)
    );
    
    // Create polygon entity
    const entity = entities.add({
        name: finalOptions.name,
        polygon: {
            hierarchy: new Cesium.PolygonHierarchy(positions),
            height: finalOptions.height,
            extrudedHeight: finalOptions.extrudedHeight,
            heightReference: finalOptions.clampToGround 
                ? Cesium.HeightReference.CLAMP_TO_GROUND 
                : Cesium.HeightReference.NONE,
            extrudedHeightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            material: finalOptions.fillColor,
            outline: true,
            outlineColor: finalOptions.strokeColor,
            outlineWidth: finalOptions.strokeWidth
        }
    });
    
    console.log(`[Boundary] Created boundary from coordinates: ${finalOptions.name}`);
    console.log(`[Boundary] Points: ${coordinates.length}`);
    
    return entity;
}

/**
 * Remove a boundary from the map
 * @param {Cesium.DataSource|Cesium.Entity} boundary - The boundary to remove
 */
export function removeBoundary(boundary) {
    const viewer = getViewer();
    
    if (boundary instanceof Cesium.DataSource) {
        viewer.dataSources.remove(boundary);
    } else if (boundary instanceof Cesium.Entity) {
        viewer.entities.remove(boundary);
    }
}

/**
 * Fly to the boundary
 * @param {Cesium.DataSource|Cesium.Entity} boundary - The boundary to fly to
 */
export async function flyToBoundary(boundary) {
    const viewer = getViewer();
    
    if (boundary instanceof Cesium.DataSource) {
        await viewer.zoomTo(boundary);
    } else if (boundary instanceof Cesium.Entity) {
        viewer.flyTo(boundary);
    }
}

