/**
 * Heatmap Visualization Module
 * Creates a 2D heatmap overlay showing data density (e.g., vehicle density, traffic flow)
 * Also loads Grasshopper / Ladybug heat CSV exports (EPSG:4326 preferred).
 */

import { getViewer } from './cesiumViewer.js';
import { ZUIDAS_BOUNDS } from './config.js';

let heatmapEntity = null;
let heatmapEnabled = false;
let heatmapDataPoints = [];
let ghHeatEntities = [];
let ghHeatEnabled = false;
/** CustomDataSource / PolylineCollection for GH heat arrows */
let ghHeatDataSource = null;
let ghHeatPolylineCollection = null;

/** Default Grasshopper heat CSV (WGS84), relative to visualization/ */
import { resolveExistingPath } from './dataRegistry.js';

/**
 * Display scale: CSV vectors are ~4 m; Rhino Vector Display looks longer.
 * Multiply ENU offset so arrows read like the GH quiver plot.
 */
const GH_ARROW_LENGTH_SCALE = 1.0;
/** Thin stroke like Rhino Vector Display (not filled triangle tips) */
const GH_ARROW_PIXEL_WIDTH = 2.0;
/** Open V head size as fraction of shaft length */
const GH_ARROW_HEAD_FRAC = 0.32;
/** Half-angle of the V wings (radians) */
const GH_ARROW_HEAD_HALF_ANGLE = (60 * Math.PI) / 180;

/**
 * Parse CSV text into row objects
 */
function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map((h) => h.trim());
    return lines.slice(1).map((line) => {
        const cols = line.split(',');
        const row = {};
        headers.forEach((h, i) => {
            row[h] = cols[i] !== undefined ? cols[i].trim() : '';
        });
        return row;
    });
}

/**
 * Offset a lon/lat/height start point by an ENU vector in meters (vx=E, vy=N, vz=Up).
 */
function enuOffsetEnd(lon, lat, height, vx, vy, vz, scale) {
    const start = Cesium.Cartesian3.fromDegrees(lon, lat, height);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(start);
    const local = new Cesium.Cartesian3(vx * scale, vy * scale, vz * scale);
    return Cesium.Matrix4.multiplyByPoint(enu, local, new Cesium.Cartesian3());
}

/**
 * Build open V-style arrow geometry (shaft + two wing lines), Rhino Vector Display look.
 * Returns { shaft: [start, tip], head: [left, tip, right] } in Cartesian3.
 */
function buildOpenArrow(start, end) {
    const tip = Cesium.Cartesian3.clone(end);
    const shaftDir = Cesium.Cartesian3.subtract(end, start, new Cesium.Cartesian3());
    const shaftLen = Cesium.Cartesian3.magnitude(shaftDir);
    if (shaftLen < 1e-6) return null;

    const dir = Cesium.Cartesian3.normalize(shaftDir, new Cesium.Cartesian3());

    // Perpendicular in the local horizontal plane (prefer cross with geodetic up)
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(tip, new Cesium.Cartesian3());
    let side = Cesium.Cartesian3.cross(dir, up, new Cesium.Cartesian3());
    if (Cesium.Cartesian3.magnitudeSquared(side) < 1e-12) {
        // Nearly vertical: fall back to a world-east reference
        side = Cesium.Cartesian3.cross(dir, Cesium.Cartesian3.UNIT_X, new Cesium.Cartesian3());
    }
    Cesium.Cartesian3.normalize(side, side);

    const headLen = shaftLen * GH_ARROW_HEAD_FRAC;
    const back = Cesium.Cartesian3.multiplyByScalar(dir, -headLen * Math.cos(GH_ARROW_HEAD_HALF_ANGLE), new Cesium.Cartesian3());
    const wing = Cesium.Cartesian3.multiplyByScalar(side, headLen * Math.sin(GH_ARROW_HEAD_HALF_ANGLE), new Cesium.Cartesian3());

    const left = Cesium.Cartesian3.add(tip, back, new Cesium.Cartesian3());
    Cesium.Cartesian3.add(left, wing, left);
    const right = Cesium.Cartesian3.add(tip, back, new Cesium.Cartesian3());
    Cesium.Cartesian3.subtract(right, wing, right);

    return {
        shaft: [Cesium.Cartesian3.clone(start), tip],
        head: [left, tip, right],
    };
}

/**
 * Sort RGB samples cool → warm (Ladybug-like spectrum: blue → cyan → green → yellow → orange).
 */
function heatColorSortKey(rgb) {
    const [r, g, b] = rgb;
    // Prefer blue-low / red-high; also walk green mid-range
    return (r - b) + 0.35 * g;
}

/**
 * Show Urban Heat legend from unique colors in the loaded field.
 * @param {Array<[number, number, number]>} colorsRgb
 */
function showUrbanHeatLegend(colorsRgb) {
    const panel = document.getElementById('urbanHeatLegend');
    const bar = document.getElementById('urbanHeatLegendBar');
    const items = document.getElementById('urbanHeatLegendItems');
    if (!panel || !bar || !items) return;

    const unique = [];
    const seen = new Set();
    colorsRgb.forEach(([r, g, b]) => {
        const key = `${r},${g},${b}`;
        if (seen.has(key)) return;
        seen.add(key);
        unique.push([r, g, b]);
    });
    unique.sort((a, b) => heatColorSortKey(a) - heatColorSortKey(b));

    if (!unique.length) {
        panel.style.display = 'none';
        return;
    }

    const gradient = unique.map(([r, g, b]) => `rgb(${r},${g},${b})`).join(', ');
    bar.style.background = `linear-gradient(to right, ${gradient})`;

    // Compact swatches: first, a few mids, last
    const picks = unique.length <= 6
        ? unique
        : [
            unique[0],
            unique[Math.floor(unique.length * 0.33)],
            unique[Math.floor(unique.length * 0.66)],
            unique[unique.length - 1],
        ];
    items.innerHTML = picks.map(([r, g, b], i) => {
        const label = i === 0 ? 'Cooler' : (i === picks.length - 1 ? 'Warmer' : '');
        return `<div style="display: flex; align-items: center; gap: 8px;">
            <div style="width: 14px; height: 14px; background: rgb(${r},${g},${b}); border: 1px solid rgba(255,255,255,0.3); flex-shrink: 0;"></div>
            <span style="opacity: ${label ? 0.95 : 0.5};">${label || '·'}</span>
        </div>`;
    }).join('');

    panel.style.display = 'block';
}

function hideUrbanHeatLegend() {
    const panel = document.getElementById('urbanHeatLegend');
    if (panel) panel.style.display = 'none';
}

/**
 * Load Urban Heat field as colored open-V arrows (Rhino Vector Display style).
 * CSV columns (WGS84): longitude, latitude, z, r, g, b, width, vx, vy, vz
 * @param {string} csvPath
 * @param {{ flyTo?: boolean }} [options] - flyTo defaults false (keeps saved camera)
 */
export async function loadGrasshopperHeat(csvPath, options = {}) {
    const viewer = getViewer();
    clearGrasshopperHeat();

    try {
        const res = await fetch(csvPath, { cache: 'no-store' });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} for ${csvPath}`);
        }
        const rows = parseCsv(await res.text());
        if (!rows.length) {
            throw new Error('CSV has no data rows');
        }

        ghHeatPolylineCollection = new Cesium.PolylineCollection();
        viewer.scene.primitives.add(ghHeatPolylineCollection);

        ghHeatEnabled = true;
        let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
        let drawn = 0;
        const legendColors = [];

        rows.forEach((row) => {
            const lon = parseFloat(row.longitude ?? row.lon ?? row.x);
            const lat = parseFloat(row.latitude ?? row.lat ?? row.y);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;

            const vx = parseFloat(row.vx);
            const vy = parseFloat(row.vy);
            const vz = parseFloat(row.vz ?? 0);
            if (!Number.isFinite(vx) || !Number.isFinite(vy)) return;
            if (Math.abs(vx) + Math.abs(vy) + Math.abs(vz || 0) < 1e-9) return;

            minLon = Math.min(minLon, lon);
            maxLon = Math.max(maxLon, lon);
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);

            const z = parseFloat(row.z);
            const height = Number.isFinite(z) ? z : 2;
            const r = parseInt(row.r ?? 51, 10);
            const g = parseInt(row.g ?? 136, 10);
            const b = parseInt(row.b ?? 255, 10);
            const width = parseFloat(row.width);
            const color = Cesium.Color.fromBytes(
                Math.max(0, Math.min(255, r)),
                Math.max(0, Math.min(255, g)),
                Math.max(0, Math.min(255, b)),
                255
            );
            legendColors.push([
                Math.max(0, Math.min(255, r)),
                Math.max(0, Math.min(255, g)),
                Math.max(0, Math.min(255, b)),
            ]);

            const start = Cesium.Cartesian3.fromDegrees(lon, lat, height);
            const end = enuOffsetEnd(
                lon, lat, height,
                vx, vy, Number.isFinite(vz) ? vz : 0,
                GH_ARROW_LENGTH_SCALE
            );

            const geom = buildOpenArrow(start, end);
            if (!geom) return;

            const pixelWidth = Number.isFinite(width) && width > 0
                ? Math.max(1.5, Math.min(4, width))
                : GH_ARROW_PIXEL_WIDTH;

            // Shaft
            ghHeatPolylineCollection.add({
                positions: geom.shaft,
                width: pixelWidth,
                material: Cesium.Material.fromType('Color', { color }),
            });
            // Open V head (two line segments meeting at tip — not a filled triangle)
            ghHeatPolylineCollection.add({
                positions: geom.head,
                width: pixelWidth,
                material: Cesium.Material.fromType('Color', { color }),
            });
            drawn += 1;
        });

        if (drawn === 0) {
            throw new Error('No valid arrow vectors in CSV');
        }

        showUrbanHeatLegend(legendColors);

        const shouldFlyTo = options.flyTo === true;
        if (shouldFlyTo && Number.isFinite(minLon) && Number.isFinite(maxLon)) {
            const pad = 0.001;
            viewer.camera.flyTo({
                destination: Cesium.Rectangle.fromDegrees(
                    minLon - pad,
                    minLat - pad,
                    maxLon + pad,
                    maxLat + pad
                ),
                duration: 1.2,
            });
        }

        console.log(`[Urban Heat] Drew ${drawn} open-V arrows from ${csvPath}`);
        return drawn;
    } catch (error) {
        console.error('[Urban Heat] Failed to load CSV:', error);
        ghHeatEnabled = false;
        hideUrbanHeatLegend();
        throw error;
    }
}

export function clearGrasshopperHeat() {
    const viewer = getViewer();
    if (ghHeatPolylineCollection) {
        try { viewer.scene.primitives.remove(ghHeatPolylineCollection); } catch (_) { /* ignore */ }
        try { ghHeatPolylineCollection.destroy(); } catch (_) { /* ignore */ }
        ghHeatPolylineCollection = null;
    }
    if (ghHeatDataSource) {
        try { viewer.dataSources.remove(ghHeatDataSource, true); } catch (_) { /* ignore */ }
        ghHeatDataSource = null;
    }
    ghHeatEntities.forEach((e) => {
        try { viewer.entities.remove(e); } catch (_) { /* ignore */ }
    });
    ghHeatEntities = [];
    ghHeatEnabled = false;
    hideUrbanHeatLegend();
}

export function toggleGrasshopperHeat(show, options = {}) {
    if (show && !ghHeatEnabled) {
        // Resolved for the active study: a proposal may ship its own heat grid.
        return resolveExistingPath('heat').then((url) =>
            url ? loadGrasshopperHeat(url, options) : Promise.resolve()
        );
    }
    if (!show && ghHeatEnabled) {
        clearGrasshopperHeat();
    }
    return Promise.resolve();
}

export function isGrasshopperHeatEnabled() {
    return ghHeatEnabled;
}

/**
 * Generate fake heatmap data points
 * Creates a grid of data points with varying intensity values
 * @param {Object} bounds - Bounding box {north, south, east, west}
 * @param {number} gridSize - Number of grid points per dimension
 * @returns {Array} Array of {longitude, latitude, intensity} objects
 */
function generateFakeHeatmapData(bounds, gridSize = 20) {
    const dataPoints = [];
    
    // Calculate aspect ratio to maintain proper grid spacing
    const latRange = bounds.north - bounds.south;
    const lonRange = bounds.east - bounds.west;
    const aspectRatio = lonRange / latRange; // > 1 means wider (west-east elongated)
    
    // Adjust grid size to match aspect ratio (more points in the longer dimension)
    const latGridSize = gridSize;
    const lonGridSize = Math.round(gridSize * aspectRatio);
    
    const latStep = latRange / latGridSize;
    const lonStep = lonRange / lonGridSize;
    
    // Create hotspots (areas with higher intensity)
    // Centered around Zuidas station, aligned with west-east elongation
    const centerLon = (bounds.east + bounds.west) / 2;
    const centerLat = (bounds.north + bounds.south) / 2;
    
    // Use aspect-ratio-aware offsets: larger offsets in longitude (west-east direction)
    // Increased radii to cover larger area with visible heat
    const lonOffset = lonRange * 0.25; // 25% of longitude range (increased from 15%)
    const latOffset = latRange * 0.20; // 20% of latitude range (increased from 10%)
    const radiusLon = lonRange * 0.35; // 35% of longitude range (increased from 12%) - covers most of west-east
    const radiusLat = latRange * 0.30; // 30% of latitude range (increased from 10%) - covers most of north-south
    
    // Hotspots aligned west-east (along the long axis) with larger coverage
    const hotspots = [
        { lon: centerLon, lat: centerLat, intensity: 0.95, radiusLon: radiusLon, radiusLat: radiusLat }, // Zuidas station (center) - largest
        { lon: centerLon + lonOffset * 0.7, lat: centerLat, intensity: 0.85, radiusLon: radiusLon * 0.9, radiusLat: radiusLat * 0.9 }, // East of center
        { lon: centerLon - lonOffset * 0.7, lat: centerLat, intensity: 0.85, radiusLon: radiusLon * 0.9, radiusLat: radiusLat * 0.9 }, // West of center
        { lon: centerLon + lonOffset * 0.4, lat: centerLat + latOffset * 0.6, intensity: 0.75, radiusLon: radiusLon * 0.8, radiusLat: radiusLat * 0.8 }, // Northeast
        { lon: centerLon - lonOffset * 0.4, lat: centerLat - latOffset * 0.6, intensity: 0.75, radiusLon: radiusLon * 0.8, radiusLat: radiusLat * 0.8 }, // Southwest
        { lon: centerLon + lonOffset * 0.2, lat: centerLat, intensity: 0.70, radiusLon: radiusLon * 0.7, radiusLat: radiusLat * 0.7 }, // East-central
        { lon: centerLon - lonOffset * 0.2, lat: centerLat, intensity: 0.70, radiusLon: radiusLon * 0.7, radiusLat: radiusLat * 0.7 }  // West-central
    ];
    
    for (let i = 0; i <= latGridSize; i++) {
        for (let j = 0; j <= lonGridSize; j++) {
            const lat = bounds.south + i * latStep;
            const lon = bounds.west + j * lonStep;
            
            // Calculate intensity based on distance from hotspots
            // Use elliptical distance to match the rectangular area shape
            let intensity = 0.2; // Base intensity (increased from 0.1 for more visible background)
            
            for (const hotspot of hotspots) {
                // Calculate normalized distance (accounting for aspect ratio)
                const dx = (lon - hotspot.lon) / hotspot.radiusLon;
                const dy = (lat - hotspot.lat) / hotspot.radiusLat;
                const distance = Math.sqrt(dx * dx + dy * dy); // Elliptical distance
                
                if (distance < 1.0) { // Normalized radius is 1.0
                    // Gaussian falloff
                    const contribution = hotspot.intensity * Math.exp(
                        -Math.pow(distance, 2) * 2
                    );
                    intensity = Math.max(intensity, contribution);
                }
            }
            
            // Add some noise for realism
            intensity += (Math.random() - 0.5) * 0.1;
            intensity = Math.max(0, Math.min(1, intensity)); // Clamp to [0, 1]
            
            dataPoints.push({
                longitude: lon,
                latitude: lat,
                intensity: intensity
            });
        }
    }
    
    return dataPoints;
}

/**
 * Convert intensity value to color
 * @param {number} intensity - Value between 0 and 1
 * @returns {Cesium.Color} Color representing the intensity
 */
function intensityToColor(intensity) {
    // Color gradient: blue (low) -> green -> yellow -> red (high)
    const result = new Cesium.Color();
    
    if (intensity < 0.25) {
        // Blue to cyan
        const t = intensity / 0.25;
        Cesium.Color.lerp(Cesium.Color.BLUE, Cesium.Color.CYAN, t, result);
    } else if (intensity < 0.5) {
        // Cyan to green
        const t = (intensity - 0.25) / 0.25;
        Cesium.Color.lerp(Cesium.Color.CYAN, Cesium.Color.LIME, t, result);
    } else if (intensity < 0.75) {
        // Green to yellow
        const t = (intensity - 0.5) / 0.25;
        Cesium.Color.lerp(Cesium.Color.LIME, Cesium.Color.YELLOW, t, result);
    } else {
        // Yellow to red
        const t = (intensity - 0.75) / 0.25;
        Cesium.Color.lerp(Cesium.Color.YELLOW, Cesium.Color.RED, t, result);
    }
    
    return result;
}

/**
 * Create a 2D heatmap visualization using a rectangle overlay
 * @param {Object} options - Configuration options
 * @param {boolean} options.enabled - Whether to show heatmap
 * @param {number} options.gridSize - Grid resolution (default: 20)
 * @param {number} options.opacity - Opacity of heatmap (0-1, default: 0.6)
 * @param {boolean} options.animate - Whether to animate the heatmap (default: false)
 */
export function createHeatmap(options = {}) {
    try {
        const {
            enabled = true,
            gridSize = 20,
            opacity = 0.6,
            animate = false
        } = options;
        
        console.log('Creating 2D heatmap with options:', { enabled, gridSize, opacity });
        
        const viewer = getViewer();
        
        // Clear existing heatmap
        clearHeatmap();
        
        if (!enabled) {
            console.log('Heatmap disabled, skipping creation');
            return;
        }
        
        heatmapEnabled = true;
        
        // Generate fake data
        const dataPoints = generateFakeHeatmapData(ZUIDAS_BOUNDS, gridSize);
        heatmapDataPoints = dataPoints;
        console.log(`Generated ${dataPoints.length} heatmap data points`);
        
        // Use viewer.entities directly
        const entities = viewer.entities;
        console.log('Creating 2D heatmap rectangle overlay');
        
        // Create a single rectangle entity covering the entire area with custom material
        heatmapEntity = entities.add({
            id: 'heatmap-overlay',
            rectangle: {
                coordinates: Cesium.Rectangle.fromDegrees(
                    ZUIDAS_BOUNDS.west,
                    ZUIDAS_BOUNDS.south,
                    ZUIDAS_BOUNDS.east,
                    ZUIDAS_BOUNDS.north
                ),
                material: createHeatmapMaterial(dataPoints, ZUIDAS_BOUNDS, opacity),
                height: 0,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                classificationType: Cesium.ClassificationType.TERRAIN
            }
        });
        
        console.log('2D heatmap created successfully');
    } catch (error) {
        console.error('Error creating heatmap:', error);
        heatmapEnabled = false;
    }
}

/**
 * Create a custom material for the 2D heatmap
 * @param {Array} dataPoints - Array of heatmap data points
 * @param {Object} bounds - Bounding box
 * @param {number} opacity - Opacity value
 * @returns {Cesium.Material} Custom material
 */
function createHeatmapMaterial(dataPoints, bounds, opacity) {
    // Calculate aspect ratio to match geographic bounds
    const latRange = bounds.north - bounds.south;
    const lonRange = bounds.east - bounds.west;
    const aspectRatio = lonRange / latRange; // > 1 means wider (west-east elongated)
    
    // Base canvas size
    const baseSize = 512;
    // Adjust canvas dimensions to match geographic aspect ratio
    // This ensures circles appear round on the map, not squeezed
    const width = Math.round(baseSize * aspectRatio);
    const height = baseSize;
    
    // Create a canvas to draw the heatmap
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    
    // Clear canvas with transparent background
    ctx.clearRect(0, 0, width, height);
    
    // Calculate scale factors to convert geographic coordinates to canvas pixels
    // These account for the aspect ratio
    const lonToX = width / lonRange;
    const latToY = height / latRange;
    
    // Draw heatmap points with radial gradients
    dataPoints.forEach(point => {
        // Convert lat/lon to canvas coordinates
        const x = (point.longitude - bounds.west) * lonToX;
        const y = (bounds.north - point.latitude) * latToY;
        
        // Create gradient based on intensity
        const color = intensityToColor(point.intensity);
        // Use a consistent radius in canvas pixels (not scaled by aspect ratio)
        // This ensures circles appear round on the map
        const radius = 25 * point.intensity; // Radius based on intensity (in canvas pixels)
        
        // Create radial gradient for smooth blending
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        const r = Math.floor(color.red * 255);
        const g = Math.floor(color.green * 255);
        const b = Math.floor(color.blue * 255);
        
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${opacity})`);
        gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${opacity * 0.6})`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
        
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    });
    
    // Create Cesium material from canvas
    return new Cesium.ImageMaterialProperty({
        image: canvas,
        transparent: true
    });
}

/**
 * Clear the heatmap visualization
 */
export function clearHeatmap() {
    try {
        const viewer = getViewer();
        
        // Remove heatmap entity
        if (heatmapEntity) {
            viewer.entities.remove(heatmapEntity);
            heatmapEntity = null;
        }
        
        heatmapDataPoints = [];
        heatmapEnabled = false;
        console.log('2D heatmap cleared');
    } catch (error) {
        console.error('Error clearing heatmap:', error);
        heatmapEntity = null;
        heatmapDataPoints = [];
        heatmapEnabled = false;
    }
}

/**
 * Toggle heatmap visibility
 * @param {boolean} show - Whether to show the heatmap
 */
export function toggleHeatmap(show) {
    console.log(`Toggling heatmap: ${show}`);
    try {
        if (show && !heatmapEnabled) {
            createHeatmap({ enabled: true });
        } else if (!show && heatmapEnabled) {
            clearHeatmap();
        }
    } catch (error) {
        console.error('Error toggling heatmap:', error);
    }
}

/**
 * Update heatmap with new data
 * @param {Array} dataPoints - Array of {longitude, latitude, intensity} objects
 */
export function updateHeatmap(dataPoints) {
    if (!dataPoints || dataPoints.length === 0) {
        clearHeatmap();
        return;
    }
    
    // Update the data points and recreate the heatmap
    heatmapDataPoints = dataPoints;
    
    if (heatmapEntity) {
        // Update the material with new data
        const viewer = getViewer();
        const bounds = ZUIDAS_BOUNDS;
        const opacity = 0.6;
        
        heatmapEntity.rectangle.material = new Cesium.CallbackProperty(() => {
            return createHeatmapMaterial(dataPoints, bounds, opacity);
        }, false);
    } else {
        // Create new heatmap if it doesn't exist
        createHeatmap({ enabled: true });
    }
    
    heatmapEnabled = true;
}

/**
 * Check if heatmap is currently enabled
 * @returns {boolean}
 */
export function isHeatmapEnabled() {
    return heatmapEnabled;
}

