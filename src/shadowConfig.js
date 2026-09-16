/**
 * Shadow and lighting configuration for Cesium scene
 */

import { getViewer } from './cesiumViewer.js';
import { SHADOW_CONFIG } from './config.js';

/**
 * Apply shadow configuration to the Cesium scene
 */
export function configureShadows() {
    const viewer = getViewer();
    const scene = viewer.scene;

    // Enable shadow maps (check if shadowMap exists)
    if (scene.shadowMap) {
        scene.shadowMap.enabled = SHADOW_CONFIG.enabled;
        
        if (SHADOW_CONFIG.enabled) {
            // Configure shadow map quality
            if (scene.shadowMap.softShadows !== undefined) {
                scene.shadowMap.softShadows = SHADOW_CONFIG.softShadows;
            }
            if (scene.shadowMap.size !== undefined) {
                scene.shadowMap.size = SHADOW_CONFIG.shadowMapSize;
            }
            if (scene.shadowMap.maximumDistance !== undefined) {
                scene.shadowMap.maximumDistance = SHADOW_CONFIG.maximumDistance;
            }
            
            // Enable shadows for all entities
            if (scene.shadowMap.shadowsEnabled !== undefined) {
                scene.shadowMap.shadowsEnabled = true;
            }
            
            // Configure shadow darkness
            if (scene.shadowMap.darkness !== undefined) {
                scene.shadowMap.darkness = 0.3;
            }
        }
    } else {
        console.warn('Shadow map not available in this Cesium version');
    }

    // Configure lighting
    scene.globe.enableLighting = true;
    scene.globe.dynamicAtmosphereLighting = true;
    scene.globe.dynamicAtmosphereLightingFromSun = true;

    // Enable sun for realistic shadows
    if (scene.sun) {
        scene.sun.show = true;
        if (scene.shadowMap) {
            scene.sun.shadowMap = scene.shadowMap;
        }
    }

    // Configure ambient lighting (if available)
    if (scene.lightSource) {
        scene.lightSource.ambientLightColor = new Cesium.Color(0.3, 0.3, 0.3, 1.0);
    } else if (scene.globe && scene.globe.ambientLightColor !== undefined) {
        // Alternative API for ambient light
        scene.globe.ambientLightColor = new Cesium.Color(0.3, 0.3, 0.3, 1.0);
    }
}

/**
 * Enable shadows for a specific entity
 * @param {Cesium.Entity} entity - The entity to enable shadows for
 */
export function enableShadowsForEntity(entity) {
    if (SHADOW_CONFIG.enabled && entity.model) {
        entity.model.shadows = Cesium.ShadowMode.ENABLED;
    } else if (SHADOW_CONFIG.enabled && entity.polygon) {
        entity.polygon.shadows = Cesium.ShadowMode.ENABLED;
    }
}

/**
 * Update shadow settings dynamically
 * @param {Object} settings - New shadow settings
 */
export function updateShadowSettings(settings) {
    const viewer = getViewer();
    const scene = viewer.scene;
    
    if (settings.enabled !== undefined) {
        scene.shadowMap.enabled = settings.enabled;
    }
    if (settings.softShadows !== undefined) {
        scene.shadowMap.softShadows = settings.softShadows;
    }
    if (settings.shadowMapSize !== undefined) {
        scene.shadowMap.size = settings.shadowMapSize;
    }
    if (settings.maximumDistance !== undefined) {
        scene.shadowMap.maximumDistance = settings.maximumDistance;
    }
}

