/**
 * Unreal Engine model loader - loads glTF/GLB models exported from Unreal Engine
 */

import { getViewer } from './cesiumViewer.js';
import { UNREAL_CONFIG } from './config.js';
import { enableShadowsForEntity } from './shadowConfig.js';

/**
 * Load a glTF/GLB model from Unreal Engine
 * @param {string} modelUrl - URL or path to the glTF/GLB model file
 * @param {Object} position - Geographic position {longitude, latitude, height}
 * @param {Object} options - Additional options (scale, orientation, etc.)
 * @returns {Promise<Cesium.Entity>} The created entity
 */
export async function loadUnrealModel(modelUrl, position, options = {}) {
    const viewer = getViewer();
    const entities = viewer.entities;
    
    const scale = options.scale !== undefined ? options.scale : UNREAL_CONFIG.defaultScale;
    const orientation = options.orientation || UNREAL_CONFIG.defaultOrientation;
    const minimumPixelSize = options.minimumPixelSize || 128;
    const maximumScale = options.maximumScale || 20000;
    
    // Create entity with model
    const entity = entities.add({
        name: options.name || `Model at ${position.longitude}, ${position.latitude}`,
        position: Cesium.Cartesian3.fromDegrees(
            position.longitude,
            position.latitude,
            position.height || 0
        ),
        model: {
            uri: modelUrl,
            scale: scale,
            minimumPixelSize: minimumPixelSize,
            maximumScale: maximumScale,
            shadows: Cesium.ShadowMode.ENABLED,
            silhouetteColor: Cesium.Color.BLUE,
            silhouetteSize: 2.0,
            color: options.color || Cesium.Color.WHITE,
            colorBlendMode: options.colorBlendMode || Cesium.ColorBlendMode.HIGHLIGHT,
            colorBlendAmount: options.colorBlendAmount || 0.0
        },
        orientation: Cesium.Transforms.headingPitchRollQuaternion(
            Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude, position.height || 0),
            new Cesium.HeadingPitchRoll(
                Cesium.Math.toRadians(orientation.heading),
                Cesium.Math.toRadians(orientation.pitch),
                Cesium.Math.toRadians(orientation.roll)
            )
        )
    });
    
    // Enable shadows for the model
    enableShadowsForEntity(entity);
    
    // Wait for model to load
    return new Promise((resolve, reject) => {
        const model = entity.model;
        if (model.ready) {
            resolve(entity);
        } else {
            model.readyPromise.then(() => {
                console.log(`Loaded Unreal Engine model: ${modelUrl}`);
                resolve(entity);
            }).catch(error => {
                console.error(`Error loading model ${modelUrl}:`, error);
                entities.remove(entity);
                reject(error);
            });
        }
    });
}

/**
 * Load multiple Unreal Engine models
 * @param {Array} models - Array of model configurations
 * @returns {Promise<Array<Cesium.Entity>>} Array of created entities
 */
export async function loadUnrealModels(models) {
    const promises = models.map(modelConfig => 
        loadUnrealModel(
            modelConfig.url,
            modelConfig.position,
            modelConfig.options || {}
        )
    );
    
    try {
        const entities = await Promise.all(promises);
        console.log(`Loaded ${entities.length} Unreal Engine models`);
        return entities;
    } catch (error) {
        console.error('Error loading Unreal Engine models:', error);
        throw error;
    }
}

/**
 * Update model position
 * @param {Cesium.Entity} entity - The model entity
 * @param {Object} position - New position {longitude, latitude, height}
 */
export function updateModelPosition(entity, position) {
    if (entity && entity.position) {
        entity.position = Cesium.Cartesian3.fromDegrees(
            position.longitude,
            position.latitude,
            position.height || 0
        );
    }
}

/**
 * Update model orientation
 * @param {Cesium.Entity} entity - The model entity
 * @param {Object} orientation - New orientation {heading, pitch, roll} in degrees
 */
export function updateModelOrientation(entity, orientation) {
    if (entity && entity.position) {
        const position = entity.position.getValue();
        entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(
            position,
            new Cesium.HeadingPitchRoll(
                Cesium.Math.toRadians(orientation.heading),
                Cesium.Math.toRadians(orientation.pitch),
                Cesium.Math.toRadians(orientation.roll)
            )
        );
    }
}

/**
 * Remove a model from the scene
 * @param {Cesium.Entity} entity - The model entity to remove
 */
export function removeUnrealModel(entity) {
    const viewer = getViewer();
    viewer.entities.remove(entity);
}

