/**
 * 3DBAG 3D Tiles Loader for Cesium
 * 
 * Loads 3DBAG (3D Building dataset for Netherlands) as Cesium 3D Tiles.
 * This provides high-quality 3D building models that are more detailed than OSM.
 * 
 * 3DBAG offers three levels of detail (LoD):
 * - LoD1.2: Simple extruded buildings (fastest)
 * - LoD1.3: Buildings with roof shapes (balanced)
 * - LoD2.2: Detailed buildings with textures (most detailed, slower)
 * 
 * Usage:
 *   import { load3DBagTiles } from './src/threeDBagLoader.js';
 *   await load3DBagTiles('lod12'); // or 'lod13', 'lod22'
 */

import { getViewer } from './cesiumViewer.js';
import { ZUIDAS_BOUNDS } from './config.js';

// ============================================================================
// 3DBAG CONFIGURATION - All settings consolidated here
// ============================================================================
export const THREEDBAG_CONFIG = {
    enabled: false, // Set to true to use 3DBAG instead of OSM buildings
    version: 'v20250903',
    baseUrl: 'https://data.3dbag.nl/v20250903/cesium3dtiles',
    // Level of detail: 'lod12' (simple), 'lod13' (roof shapes), 'lod22' (detailed with textures)
    lod: 'lod12', // 'lod12', 'lod13', or 'lod22'
    // Maximum screen space error (lower = more detail, higher = better performance)
    maximumScreenSpaceError: 16,
    // Replace OSM buildings when loading 3DBAG
    replaceOSM: true,
    // Height offset in meters to fix vertical datum mismatch
    // 3DBAG uses NAP (Normaal Amsterdams Peil) - geoid-based vertical datum
    // Cesium uses WGS84 ellipsoid heights
    // In Netherlands (Amsterdam area), geoid undulation is ~-49.5m (geoid below ellipsoid)
    // Set to null to auto-calculate, or specify a custom value
    // Try values between -48 and -52 if buildings are still misaligned
    heightOffset: null, // null = auto-calculate (-49.5m for Amsterdam), or specify value like -50
    // Building color configuration
    // Options:
    // - null or undefined = use original building colors/textures
    // - Cesium.Color object = uniform color (e.g., Cesium.Color.WHITE)
    // - CSS color string = uniform color (e.g., '#FF5733', 'rgb(255, 87, 51)', 'blue')
    // - Object with style properties = custom style
    buildingColor: '#FFFFFF', // null = original colors, or CSS color string like '#FF5733'
    // Color blend amount (0.0 = full color override, 1.0 = original colors)
    // Only used if buildingColor is set
    colorBlendAmount: 0.0, // 0.0 = replace color completely, 0.5 = blend, 1.0 = original
    // Shadow settings
    shadowsEnabled: false, // Set to false to disable shadows for brighter colors
    // Fly to tileset after loading
    flyTo: false
};

// 3DBAG internal configuration
const VERSION = THREEDBAG_CONFIG.version;
const BASE_URL = `https://data.3dbag.nl/${VERSION}/cesium3dtiles`;

// Available LoD levels
const LOD_LEVELS = {
    lod12: {
        name: 'LoD1.2',
        description: 'Simple extruded buildings (fastest)',
        url: `${BASE_URL}/lod12/tileset.json`
    },
    lod13: {
        name: 'LoD1.3',
        description: 'Buildings with roof shapes (balanced)',
        url: `${BASE_URL}/lod13/tileset.json`
    },
    lod22: {
        name: 'LoD2.2',
        description: 'Detailed buildings with textures (most detailed)',
        url: `${BASE_URL}/lod22/tileset.json`
    }
};

let currentTileset = null;
let currentLod = null;

/**
 * Update shadow settings for the current 3DBAG tileset
 * @param {boolean} enabled - Whether shadows should be enabled
 */
export function update3DBagShadows(enabled) {
    if (currentTileset) {
        currentTileset.shadows = enabled ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED;
        console.log(`[3DBAG] Shadows ${enabled ? 'enabled' : 'disabled'} for tileset`);
    }
}

/**
 * Load 3DBAG 3D Tiles in Cesium
 * All settings can be configured in THREEDBAG_CONFIG at the top of this file.
 * Options passed here will override the config values.
 * 
 * @param {string} lod - Level of detail: 'lod12', 'lod13', or 'lod22' (default: from THREEDBAG_CONFIG.lod)
 * @param {Object} options - Additional options (all optional, will use THREEDBAG_CONFIG if not provided)
 * @param {boolean} options.replaceOSM - If true, removes OSM buildings first (default: from THREEDBAG_CONFIG)
 * @param {number} options.maximumScreenSpaceError - Maximum screen space error for tiles (default: from THREEDBAG_CONFIG)
 * @param {number|null} options.heightOffset - Height offset in meters (default: from THREEDBAG_CONFIG)
 * @param {string|Cesium.Color|null} options.buildingColor - Building color (default: from THREEDBAG_CONFIG)
 * @param {number} options.colorBlendAmount - Color blend amount 0.0-1.0 (default: from THREEDBAG_CONFIG)
 * @param {boolean} options.shadowsEnabled - Enable shadows (default: from THREEDBAG_CONFIG)
 * @param {boolean} options.flyTo - Fly to tileset after loading (default: from THREEDBAG_CONFIG)
 * @returns {Promise<Cesium.Cesium3DTileset>} The loaded tileset
 */
export async function load3DBagTiles(lod = null, options = {}) {
    // Use config lod if not provided
    if (!lod) {
        lod = THREEDBAG_CONFIG.lod || 'lod12';
    }
    const viewer = getViewer();
    
    // Validate LoD
    if (!LOD_LEVELS[lod]) {
        throw new Error(`Invalid LoD: ${lod}. Must be one of: ${Object.keys(LOD_LEVELS).join(', ')}`);
    }
    
    const lodConfig = LOD_LEVELS[lod];
    
    // Remove existing 3DBAG tileset if any
    if (currentTileset) {
        console.log('[3DBAG] Removing existing 3DBAG tileset...');
        viewer.scene.primitives.remove(currentTileset);
        currentTileset = null;
    }
    
    // Optionally remove OSM buildings
    const replaceOSM = options.replaceOSM !== undefined ? options.replaceOSM : THREEDBAG_CONFIG.replaceOSM;
    if (replaceOSM) {
        const { clearOSMBuildings } = await import('./osmLoader.js');
        clearOSMBuildings();
        console.log('[3DBAG] Removed OSM buildings');
    }
    
    console.log(`[3DBAG] Loading ${lodConfig.name} (${lodConfig.description})...`);
    console.log(`[3DBAG] URL: ${lodConfig.url}`);
    
    try {
        // Load the 3D Tiles tileset
        const shadowsEnabled = options.shadowsEnabled !== undefined 
            ? options.shadowsEnabled 
            : (THREEDBAG_CONFIG.shadowsEnabled !== undefined ? THREEDBAG_CONFIG.shadowsEnabled : false);
        
        currentTileset = await Cesium.Cesium3DTileset.fromUrl(lodConfig.url, {
            maximumScreenSpaceError: options.maximumScreenSpaceError || THREEDBAG_CONFIG.maximumScreenSpaceError || 16,
            // Shadow settings - disabled by default for brighter colors
            shadows: shadowsEnabled ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED,
            // Disable image-based lighting to prevent environment lighting from affecting colors
            // This ensures assigned colors appear exactly as specified (especially important for white)
            imageBasedLightingFactor: new Cesium.Cartesian2(0.0, 0.0), // (x, y) = (IBL intensity, IBL intensity)
            // Enable lighting
            lightColor: new Cesium.Cartesian3(1.0, 1.0, 1.0),
            // For LoD22 with textures, we'll override colors via style
            // Note: Cesium doesn't have a direct API to disable texture sampling,
            // but using vec4() in the style should completely replace the color output
        });
        
        // Add to scene
        viewer.scene.primitives.add(currentTileset);
        
        // Wait for tileset to be ready
        await currentTileset.readyPromise;
        
        // Apply height offset to fix vertical datum mismatch
        // 3DBAG uses NAP (Normaal Amsterdams Peil) which is geoid-based (approximately sea level)
        // Cesium terrain uses WGS84 ellipsoid heights
        // In the Netherlands (Amsterdam area), the geoid undulation is approximately -47 to -50 meters
        // So we need to offset buildings DOWN to align with terrain
        let heightOffset = options.heightOffset !== undefined 
            ? options.heightOffset 
            : (THREEDBAG_CONFIG.heightOffset !== undefined ? THREEDBAG_CONFIG.heightOffset : null); // Will calculate if not provided
        
        // If height offset not provided, try to calculate it by sampling terrain
        if (heightOffset === null) {
            try {
                // Sample terrain at Zuidas center to determine offset
                const centerCartographic = Cesium.Cartographic.fromDegrees(
                    ZUIDAS_BOUNDS.west + (ZUIDAS_BOUNDS.east - ZUIDAS_BOUNDS.west) / 2,
                    ZUIDAS_BOUNDS.south + (ZUIDAS_BOUNDS.north - ZUIDAS_BOUNDS.south) / 2
                );
                
                // Get terrain height at center point
                const terrainHeight = await viewer.scene.globe.getHeight(centerCartographic);
                
                // If we have terrain height, we can estimate offset
                // For now, use a more accurate value for Amsterdam area: -49.5 meters
                // This accounts for the geoid undulation in the Amsterdam region
                heightOffset = -49.5;
                console.log(`[3DBAG] Using calculated height offset: ${heightOffset} meters`);
            } catch (error) {
                console.warn('[3DBAG] Could not sample terrain, using default offset:', error);
                heightOffset = -49.5; // Default for Amsterdam area
            }
        }
        
        if (heightOffset !== 0) {
            // Apply vertical offset using modelMatrix
            // This creates a translation that only affects the Z (vertical) axis
            // The translation is in ECEF (Earth-Centered, Earth-Fixed) coordinates
            // For a vertical-only offset, we translate along the local up vector
            const boundingSphere = currentTileset.boundingSphere;
            const centerCartographic = Cesium.Cartographic.fromCartesian(boundingSphere.center);
            
            // Get the up vector at the tileset center (points away from Earth center)
            const upVector = Cesium.Cartesian3.normalize(
                boundingSphere.center,
                new Cesium.Cartesian3()
            );
            
            // Scale the up vector by the height offset
            const offsetVector = Cesium.Cartesian3.multiplyByScalar(
                upVector,
                heightOffset,
                new Cesium.Cartesian3()
            );
            
            // Create translation matrix
            const translationMatrix = Cesium.Matrix4.fromTranslation(offsetVector);
            
            // Apply as modelMatrix (this only affects vertical position, not XY)
            currentTileset.modelMatrix = translationMatrix;
            
            console.log(`[3DBAG] Applied height offset: ${heightOffset} meters (NAP to WGS84 ellipsoid)`);
            console.log(`[3DBAG] Tileset center: lat=${(centerCartographic.latitude * 180 / Math.PI).toFixed(6)}, lon=${(centerCartographic.longitude * 180 / Math.PI).toFixed(6)}`);
            console.log(`[3DBAG] If buildings are still misaligned, adjust heightOffset in config.js (try -50 to -52)`);
        }
        
        // Set color blend mode to REPLACE to completely override textures/colors
        // This ensures that assigned colors fully replace original textures without blending
        const colorBlendAmount = options.colorBlendAmount !== undefined 
            ? options.colorBlendAmount 
            : (THREEDBAG_CONFIG.colorBlendAmount !== undefined ? THREEDBAG_CONFIG.colorBlendAmount : 0.0);
        
        if (colorBlendAmount === 0.0) {
            // Full replacement mode - completely override textures
            currentTileset.colorBlendMode = Cesium.Cesium3DTileColorBlendMode.REPLACE;
        } else {
            // Blending mode - mix with original colors
            currentTileset.colorBlendMode = Cesium.Cesium3DTileColorBlendMode.HIGHLIGHT;
        }
        
        // Apply building color/style if specified
        // Use config value if not provided in options
        const buildingColor = options.buildingColor !== undefined 
            ? options.buildingColor 
            : (options.colorStyle ? null : (THREEDBAG_CONFIG.buildingColor !== undefined ? THREEDBAG_CONFIG.buildingColor : undefined));
        
        if (buildingColor !== null && buildingColor !== undefined) {
            applyBuildingColor(currentTileset, buildingColor, colorBlendAmount);
        } else if (options.colorStyle) {
            // Apply custom style
            if (typeof options.colorStyle === 'string') {
                currentTileset.style = new Cesium.Cesium3DTileStyle({
                    color: options.colorStyle
                });
            } else if (options.colorStyle instanceof Cesium.Cesium3DTileStyle) {
                currentTileset.style = options.colorStyle;
            } else {
                currentTileset.style = new Cesium.Cesium3DTileStyle(options.colorStyle);
            }
            console.log('[3DBAG] Applied custom color style');
        }
        
        console.log(`[3DBAG] ✓ Successfully loaded ${lodConfig.name} tileset`);
        console.log(`[3DBAG] Bounding sphere center:`, currentTileset.boundingSphere.center);
        console.log(`[3DBAG] Bounding sphere radius:`, currentTileset.boundingSphere.radius);
        
        // Optionally fly to the tileset
        const shouldFlyTo = options.flyTo !== undefined ? options.flyTo : THREEDBAG_CONFIG.flyTo;
        if (shouldFlyTo) {
            viewer.flyTo(currentTileset);
        }
        
        // Store current LoD
        currentLod = lod;
        
        // Set up error handling
        currentTileset.tileFailed.addEventListener((tile, error) => {
            console.warn('[3DBAG] Tile failed to load:', error);
        });
        
        return currentTileset;
        
    } catch (error) {
        console.error('[3DBAG] Error loading 3D Tiles:', error);
        throw error;
    }
}

/**
 * Load 3DBAG 3D Tiles with default configuration from THREEDBAG_CONFIG
 * Convenience function that uses all THREEDBAG_CONFIG settings
 * @returns {Promise<Cesium.Cesium3DTileset>} The loaded tileset
 */
export async function load3DBagWithDefaults() {
    return load3DBagTiles(THREEDBAG_CONFIG.lod, {
        replaceOSM: THREEDBAG_CONFIG.replaceOSM,
        maximumScreenSpaceError: THREEDBAG_CONFIG.maximumScreenSpaceError,
        heightOffset: THREEDBAG_CONFIG.heightOffset,
        buildingColor: THREEDBAG_CONFIG.buildingColor,
        colorBlendAmount: THREEDBAG_CONFIG.colorBlendAmount,
        shadowsEnabled: THREEDBAG_CONFIG.shadowsEnabled,
        flyTo: THREEDBAG_CONFIG.flyTo
    });
}

/**
 * Switch to a different LoD level
 * @param {string} lod - New LoD level
 * @param {Object} options - Options (same as load3DBagTiles)
 */
export async function switch3DBagLod(lod, options = {}) {
    return load3DBagTiles(lod, options);
}

/**
 * Remove 3DBAG tiles from the scene
 */
export function remove3DBagTiles() {
    const viewer = getViewer();
    
    if (currentTileset) {
        viewer.scene.primitives.remove(currentTileset);
        currentTileset = null;
        currentLod = null;
        console.log('[3DBAG] Removed 3DBAG tiles');
    }
}

/**
 * Get the currently loaded LoD level
 * @returns {string|null} Current LoD or null if not loaded
 */
export function getCurrentLod() {
    return currentLod;
}

/**
 * Get information about available LoD levels
 * @returns {Object} LoD information
 */
export function getLodInfo() {
    return LOD_LEVELS;
}

/**
 * Check if 3DBAG tiles are currently loaded
 * @returns {boolean}
 */
export function is3DBagLoaded() {
    return currentTileset !== null;
}

/**
 * Adjust the height offset of loaded 3DBAG tiles
 * Useful for fine-tuning alignment with terrain
 * @param {number} newOffset - New height offset in meters (negative = down, positive = up)
 */
export function adjust3DBagHeightOffset(newOffset) {
    if (!currentTileset) {
        console.warn('[3DBAG] No tileset loaded. Load tiles first.');
        return;
    }
    
    const boundingSphere = currentTileset.boundingSphere;
    const upVector = Cesium.Cartesian3.normalize(
        boundingSphere.center,
        new Cesium.Cartesian3()
    );
    
    const offsetVector = Cesium.Cartesian3.multiplyByScalar(
        upVector,
        newOffset,
        new Cesium.Cartesian3()
    );
    
    currentTileset.modelMatrix = Cesium.Matrix4.fromTranslation(offsetVector);
    console.log(`[3DBAG] Height offset adjusted to: ${newOffset} meters`);
}

/**
 * Apply building color to tileset
 * @param {Cesium.Cesium3DTileset} tileset - The tileset to style
 * @param {Cesium.Color|string|Object} color - Color to apply
 * @param {number} blendAmount - Blend amount (0.0 = full color, 1.0 = original)
 */
function applyBuildingColor(tileset, color, blendAmount = 0.0) {
    let cesiumColor;
    
    // Convert color to Cesium.Color
    if (color instanceof Cesium.Color) {
        cesiumColor = color;
    } else if (typeof color === 'string') {
        // Try CSS color string
        try {
            cesiumColor = Cesium.Color.fromCssColorString(color);
        } catch (e) {
            console.warn(`[3DBAG] Invalid color string: ${color}, using default`);
            cesiumColor = Cesium.Color.LIGHTGRAY;
        }
    } else {
        // Assume it's an object with r, g, b, a properties
        cesiumColor = new Cesium.Color(
            color.r || 0.3,
            color.g || 0.3,
            color.b || 0.3,
            color.a !== undefined ? color.a : 1.0
        );
    }
    
    // Apply color using style
    // For 3D Tiles with textures, we need to use a style that replaces the color
    // The color() function multiplies with existing colors, so we use a more aggressive approach
    if (blendAmount > 0) {
        // Blend with original color
        tileset.style = new Cesium.Cesium3DTileStyle({
            color: {
                conditions: [
                    ['true', `color("${cesiumColor.toCssColorString()}", ${blendAmount})`]
                ]
            }
        });
    } else {
        // Full color replacement - completely override textures
        // Ensure colorBlendMode is set to REPLACE for complete color override
        if (tileset.colorBlendMode !== Cesium.Cesium3DTileColorBlendMode.REPLACE) {
            tileset.colorBlendMode = Cesium.Cesium3DTileColorBlendMode.REPLACE;
        }
        
        // Disable image-based lighting to prevent environment lighting from affecting colors
        // This ensures the assigned color appears exactly as specified
        if (tileset.imageBasedLightingFactor !== undefined) {
            tileset.imageBasedLightingFactor = new Cesium.Cartesian2(0.0, 0.0); // Disable IBL
        }
        
        const r = cesiumColor.red;
        const g = cesiumColor.green;
        const b = cesiumColor.blue;
        const a = cesiumColor.alpha;
        
        // Use vec4() to completely replace color - this ignores textures
        // Combined with colorBlendMode.REPLACE and disabled IBL, this ensures pure color display
        // Note: Lighting may still affect the color slightly. For pure white (#ffffff),
        // you may need to use a brighter value or disable lighting entirely.
        tileset.style = new Cesium.Cesium3DTileStyle({
            color: `vec4(${r}, ${g}, ${b}, ${a})`
        });
    }
    
    console.log(`[3DBAG] Applied building color: ${cesiumColor.toCssColorString()} (blend: ${blendAmount})`);
    if (blendAmount === 0.0) {
        console.log(`[3DBAG] Using vec4() to completely override textures. If textures are still visible, try:`);
        console.log(`[3DBAG]   1. Refresh the page to reload the tileset with new style`);
        console.log(`[3DBAG]   2. Use LoD13 instead of LoD22 (LoD13 has no textures)`);
        console.log(`[3DBAG]   3. Check if the tileset material structure allows color override`);
    } else {
        console.log(`[3DBAG] Style applied. If color doesn't show, try refreshing the page or reloading the tileset.`);
    }
}

/**
 * Set the color of 3DBAG buildings
 * @param {Cesium.Color|string} color - Color to apply (Cesium.Color or CSS color string)
 * @param {number} blendAmount - Blend amount (0.0 = full color override, 1.0 = original colors)
 */
export function set3DBagColor(color, blendAmount = 0.0) {
    if (!currentTileset) {
        console.warn('[3DBAG] No tileset loaded. Load tiles first.');
        return;
    }
    
    applyBuildingColor(currentTileset, color, blendAmount);
}

/**
 * Reset 3DBAG buildings to original colors
 */
export function reset3DBagColor() {
    if (!currentTileset) {
        console.warn('[3DBAG] No tileset loaded. Load tiles first.');
        return;
    }
    
    currentTileset.style = undefined;
    console.log('[3DBAG] Color reset to original');
}

/**
 * Get diagnostic information about the loaded tileset
 * @returns {Object} Diagnostic information
 */
export function get3DBagDiagnostics() {
    if (!currentTileset) {
        return { error: 'No tileset loaded' };
    }
    
    const boundingSphere = currentTileset.boundingSphere;
    const centerCartographic = Cesium.Cartographic.fromCartesian(boundingSphere.center);
    
    return {
        loaded: true,
        lod: currentLod,
        center: {
            latitude: centerCartographic.latitude * 180 / Math.PI,
            longitude: centerCartographic.longitude * 180 / Math.PI,
            height: centerCartographic.height
        },
        boundingSphereRadius: boundingSphere.radius,
        modelMatrix: currentTileset.modelMatrix ? 'Applied' : 'None',
        hasStyle: currentTileset.style !== undefined
    };
}

