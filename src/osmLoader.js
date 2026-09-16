/**
 * OSM Buildings loader - fetches and displays 3D buildings from OpenStreetMap
 */

import { getViewer } from './cesiumViewer.js';
import { ZUIDAS_BOUNDS, OSM_CONFIG } from './config.js';
import { enableShadowsForEntity } from './shadowConfig.js';

/**
 * Build Overpass API query for Zuidas area
 * @returns {string} Overpass query string
 */
function buildOverpassQuery() {
    const bbox = `${ZUIDAS_BOUNDS.south},${ZUIDAS_BOUNDS.west},${ZUIDAS_BOUNDS.north},${ZUIDAS_BOUNDS.east}`;
    return `[out:json][timeout:25];
(
  way["building"](${bbox});
  relation["building"](${bbox});
);
out body;
>;
out skel qt;`;
}

/**
 * Load OSM data from local file if available, otherwise fetch from API
 * @returns {Promise<Object>} OSM data response
 */
async function fetchOSMBuildings() {
    // First, try to load from local file
    const localOSMFile = './data/osm/zuidas-buildings.json';
    
    try {
        const response = await fetch(localOSMFile);
        if (response.ok) {
            const data = await response.json();
            console.log(`Loaded OSM buildings from local file: ${localOSMFile}`);
            console.log(`  Buildings found: ${data.elements?.filter(e => e.type === 'way' && e.tags?.building).length || 0}`);
            return data;
        }
    } catch (localError) {
        console.log('Local OSM file not found, fetching from Overpass API...');
        console.log('Tip: Run "npm run download-osm" to download and cache OSM data locally');
    }
    
    // Fallback to fetching from Overpass API
    const query = buildOverpassQuery();
    // Try multiple Overpass API instances
    const endpoints = [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://lz4.overpass-api.de/api/interpreter'
    ];
    
    let lastError = null;
    
    for (const endpoint of endpoints) {
        try {
            console.log(`Trying Overpass API: ${endpoint}`);
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: `data=${encodeURIComponent(query)}`,
                // Increase timeout
                signal: AbortSignal.timeout(60000) // 60 second timeout
            });
            
            if (!response.ok) {
                if (response.status === 504 || response.status === 429) {
                    // Gateway timeout or rate limit - try next endpoint
                    console.warn(`${endpoint} returned ${response.status}, trying next...`);
                    lastError = new Error(`HTTP error! status: ${response.status}`);
                    continue;
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            console.log(`Successfully fetched OSM data from ${endpoint}`);
            return data;
        } catch (error) {
            console.warn(`Error with ${endpoint}:`, error.message);
            lastError = error;
            // Continue to next endpoint
            continue;
        }
    }
    
    // All endpoints failed
    console.error('All Overpass API endpoints failed');
    throw lastError || new Error('Failed to fetch OSM data from all endpoints');
}

/**
 * Extract building height from OSM tags
 * @param {Object} element - OSM element with tags
 * @returns {number} Building height in meters
 */
function getBuildingHeight(element) {
    const tags = element.tags || {};
    
    // Try different height tags
    if (tags['height']) {
        const height = parseFloat(tags['height']);
        if (!isNaN(height)) return height;
    }
    
    if (tags['building:levels']) {
        const levels = parseFloat(tags['building:levels']);
        if (!isNaN(levels)) return levels * 3; // Assume 3 meters per level
    }
    
    if (tags['building:height']) {
        const height = parseFloat(tags['building:height']);
        if (!isNaN(height)) return height;
    }
    
    // Default height
    return OSM_CONFIG.defaultBuildingHeight;
}

/**
 * Get building color based on building type from OSM tags
 * @param {Object} tags - OSM tags object
 * @returns {Cesium.Color} Color for the building
 */
function getBuildingColorByType(tags) {
    const buildingType = tags.building || '';
    const buildingUse = tags['building:use'] || '';
    const amenity = tags.amenity || '';
    const shop = tags.shop || '';
    const office = tags.office || '';
    const leisure = tags.leisure || '';
    const tourism = tags.tourism || '';
    
    // Color scheme based on building type/use
    // Residential buildings
    if (buildingType === 'residential' || buildingType === 'house' || buildingType === 'apartments') {
        return Cesium.Color.fromBytes(255, 200, 150, 204); // Light orange/beige (alpha 0.8)
    }
    
    // Commercial/Retail
    if (buildingType === 'commercial' || buildingType === 'retail' || shop || 
        buildingUse === 'retail' || buildingUse === 'commercial') {
        return Cesium.Color.fromBytes(255, 150, 150, 204); // Light red/pink
    }
    
    // Office buildings
    if (buildingType === 'office' || office || buildingUse === 'office') {
        return Cesium.Color.fromBytes(150, 200, 255, 204); // Light blue
    }
    
    // Industrial
    if (buildingType === 'industrial' || buildingUse === 'industrial') {
        return Cesium.Color.fromBytes(200, 200, 200, 204); // Light gray
    }
    
    // Educational (schools, universities)
    if (amenity === 'school' || amenity === 'university' || amenity === 'college' ||
        buildingType === 'school' || buildingUse === 'education') {
        return Cesium.Color.fromBytes(255, 255, 150, 204); // Light yellow
    }
    
    // Healthcare (hospitals, clinics)
    if (amenity === 'hospital' || amenity === 'clinic' || amenity === 'doctors' ||
        buildingUse === 'healthcare') {
        return Cesium.Color.fromBytes(255, 100, 100, 204); // Light red
    }
    
    // Hotels/Hospitality
    if (tourism === 'hotel' || amenity === 'hotel' || buildingUse === 'hotel') {
        return Cesium.Color.fromBytes(200, 150, 255, 204); // Light purple
    }
    
    // Restaurants/Food
    if (amenity === 'restaurant' || amenity === 'cafe' || amenity === 'fast_food' ||
        amenity === 'bar' || amenity === 'pub') {
        return Cesium.Color.fromBytes(255, 180, 100, 204); // Orange
    }
    
    // Parking/Garages
    if (buildingType === 'garage' || buildingType === 'garages' || 
        amenity === 'parking' || buildingUse === 'parking') {
        return Cesium.Color.fromBytes(150, 150, 150, 153); // Gray (more transparent)
    }
    
    // Public/Civic buildings
    if (amenity === 'townhall' || amenity === 'library' || amenity === 'community_centre' ||
        buildingUse === 'civic' || buildingUse === 'public') {
        return Cesium.Color.fromBytes(150, 255, 150, 204); // Light green
    }
    
    // Religious buildings
    if (amenity === 'place_of_worship' || buildingType === 'church' || 
        buildingType === 'mosque' || buildingType === 'synagogue' || buildingType === 'temple') {
        return Cesium.Color.fromBytes(255, 220, 150, 204); // Light gold
    }
    
    // Warehouses/Storage
    if (buildingType === 'warehouse' || buildingType === 'storage' || 
        buildingUse === 'warehouse' || buildingUse === 'storage') {
        return Cesium.Color.fromBytes(180, 180, 200, 204); // Light blue-gray
    }
    
    // Default: Generic buildings (light gray-blue)
    return Cesium.Color.fromBytes(200, 220, 240, 204); // Light blue-gray
}

/**
 * Convert OSM way to Cesium polygon coordinates
 * @param {Object} way - OSM way element
 * @param {Object} nodes - Map of node IDs to coordinates
 * @returns {Array} Array of Cesium Cartesian3 positions
 */
function wayToCoordinates(way, nodes) {
    const coordinates = [];
    
    if (way.nodes) {
        for (const nodeId of way.nodes) {
            const node = nodes[nodeId];
            if (node && node.lat !== undefined && node.lon !== undefined) {
                coordinates.push(
                    Cesium.Cartesian3.fromDegrees(node.lon, node.lat)
                );
            }
        }
    }
    
    return coordinates;
}

/**
 * Process OSM data and create Cesium entities
 * @param {Object} osmData - OSM API response
 */
function processOSMData(osmData, clearPrevious = false) {
    const viewer = getViewer();
    const entities = viewer.entities;
    
    // Clear previous OSM entities if reloading
    if (clearPrevious && osmEntities.length > 0) {
        console.log(`[OSM] Clearing ${osmEntities.length} previous OSM entities...`);
        osmEntities.forEach(entity => entities.remove(entity));
        osmEntities = [];
    }
    
    // Create a map of nodes for quick lookup
    const nodes = {};
    if (osmData.elements) {
        for (const element of osmData.elements) {
            if (element.type === 'node') {
                nodes[element.id] = element;
            }
        }
    }
    
    // Process ways and relations that are buildings
    let buildingCount = 0;
    
    for (const element of osmData.elements || []) {
        if (element.type === 'way' && element.tags && element.tags.building) {
            const coordinates = wayToCoordinates(element, nodes);
            
            if (coordinates.length >= 3) {
                const height = getBuildingHeight(element);
                
                // Create building entity with extrusion, clamped to terrain
                const building = entities.add({
                    name: element.tags.name || `Building ${element.id}`,
                    polygon: {
                        hierarchy: new Cesium.PolygonHierarchy(coordinates),
                        extrudedHeight: height,
                        height: 0,
                        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                        extrudedHeightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
                        material: getBuildingColorByType(element.tags), // Use building type-based color
                        outline: true,
                        outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
                        shadows: Cesium.ShadowMode.ENABLED,
                        perPositionHeight: false // Use terrain heights
                    }
                });
                
                enableShadowsForEntity(building);
                osmEntities.push(building); // Track this entity for removal
                buildingCount++;
            }
        }
    }
    
    console.log(`Loaded ${buildingCount} buildings from OSM`);
    return buildingCount;
}

// Track if buildings have been loaded to prevent reloading
let buildingsLoaded = false;
// Track which OSM entities were created (for selective removal)
let osmEntities = [];

/**
 * Load OSM data from local file only
 * @returns {Promise<Object>} OSM data response
 */
async function fetchOSMBuildingsLocal() {
    const localOSMFile = './data/osm/zuidas-buildings.json';
    const response = await fetch(localOSMFile);
    if (!response.ok) {
        throw new Error(`Local OSM file not found: ${localOSMFile}`);
    }
    const data = await response.json();
    console.log(`Loaded OSM buildings from local file: ${localOSMFile}`);
    console.log(`  Buildings found: ${data.elements?.filter(e => e.type === 'way' && e.tags?.building).length || 0}`);
    return data;
}

/**
 * Load OSM data from online API only
 * @returns {Promise<Object>} OSM data response
 */
async function fetchOSMBuildingsOnline() {
    const query = buildOverpassQuery();
    const endpoints = [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://lz4.overpass-api.de/api/interpreter'
    ];
    
    let lastError = null;
    for (const endpoint of endpoints) {
        try {
            console.log(`Trying Overpass API: ${endpoint}`);
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: `data=${encodeURIComponent(query)}`,
                signal: AbortSignal.timeout(60000)
            });
            
            if (!response.ok) {
                if (response.status === 504 || response.status === 429) {
                    console.warn(`${endpoint} returned ${response.status}, trying next...`);
                    lastError = new Error(`HTTP error! status: ${response.status}`);
                    continue;
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            console.log(`Successfully fetched OSM data from ${endpoint}`);
            return data;
        } catch (error) {
            console.warn(`Error with ${endpoint}:`, error.message);
            lastError = error;
            continue;
        }
    }
    
    throw lastError || new Error('Failed to fetch OSM data from all endpoints');
}

/**
 * Load and display OSM buildings in Cesium
 * @param {Object} options - Loading options
 * @param {boolean} options.useLocal - If true, load from local file only. If false, load from online API only.
 * @param {boolean} options.forceReload - If true, reload even if already loaded
 * @returns {Promise<number>} Number of buildings loaded
 */
export async function loadOSMBuildings(options = {}) {
    const { useLocal = false, forceReload = false } = options;
    
    // Prevent reloading if already loaded (unless forceReload is true)
    if (buildingsLoaded && !forceReload) {
        console.log('[OSM] Buildings already loaded, skipping reload');
        const viewer = getViewer();
        const entities = viewer.entities;
        let count = 0;
        entities.values.forEach(entity => {
            if (entity.polygon && entity.polygon.extrudedHeight !== undefined) {
                count++;
            }
        });
        return count;
    }
    
    try {
        console.log(`[OSM] Fetching OSM building data ${useLocal ? 'from local file' : 'from online API'}...`);
        const osmData = useLocal 
            ? await fetchOSMBuildingsLocal()
            : await fetchOSMBuildingsOnline();
        console.log('[OSM] Processing OSM data...');
        const buildingCount = processOSMData(osmData, forceReload);
        buildingsLoaded = true;
        console.log(`[OSM] ✓ Loaded ${buildingCount} buildings`);
        
        // Show building legend when buildings are loaded
        showBuildingLegend();
        
        // Force viewer to render to ensure buildings appear immediately
        const viewer = getViewer();
        viewer.scene.requestRender();
        
        return buildingCount;
    } catch (error) {
        console.error('[OSM] Error loading OSM buildings:', error);
        throw error;
    }
}

/**
 * Show building type legend
 */
function showBuildingLegend() {
    const legendElement = document.getElementById('buildingLegend');
    if (legendElement) {
        legendElement.style.display = 'block';
        
        // Re-initialize drag functionality for building legend (since it starts hidden)
        // Wait a bit for the element to be rendered
        setTimeout(() => {
            if (window.makeDraggable) {
                // If the function is available globally, call it
                const panel = document.getElementById('buildingLegend');
                const header = panel?.querySelector('.panel-header');
                if (panel && header && !header.hasAttribute('data-drag-initialized')) {
                    // Re-initialize drag by calling makeDraggable if available
                    // The drag handler should already be attached, but ensure it works
                    header.setAttribute('data-drag-initialized', 'true');
                }
            }
        }, 100);
    }
}

/**
 * Hide building type legend
 */
function hideBuildingLegend() {
    const legendElement = document.getElementById('buildingLegend');
    if (legendElement) {
        legendElement.style.display = 'none';
    }
}

/**
 * Clear all OSM buildings from the scene
 */
export function clearOSMBuildings() {
    const viewer = getViewer();
    // Clear tracked entities
    if (osmEntities.length > 0) {
        console.log(`[OSM] Removing ${osmEntities.length} OSM buildings...`);
        osmEntities.forEach(entity => viewer.entities.remove(entity));
        osmEntities = [];
    }
    buildingsLoaded = false;
    console.log('[OSM] OSM buildings cleared');
    
    // Hide building legend when buildings are cleared
    hideBuildingLegend();
    
    // Remove all entities that have polygon with extrudedHeight
    const toRemove = [];
    viewer.entities.values.forEach(entity => {
        if (entity.polygon && entity.polygon.extrudedHeight !== undefined) {
            toRemove.push(entity);
        }
    });
    
    toRemove.forEach(entity => viewer.entities.remove(entity));
    if (toRemove.length > 0) {
        console.log(`Cleared ${toRemove.length} additional OSM buildings`);
    }
}

