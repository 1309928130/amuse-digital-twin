/**
 * SketchUp Model Loader for Cesium
 * 
 * Loads glTF/GLB models exported from SketchUp into the Cesium viewer.
 * 
 * SketchUp Export Instructions:
 * 1. In SketchUp, go to File > Export > 3D Model
 * 2. Choose "glTF" or "GLB" format
 * 3. Export your model
 * 4. Place the exported file in your project's models/ directory
 * 5. Use loadSketchupModel() to load it
 * 
 * Usage:
 *   import { loadSketchupModel } from './src/sketchupModelLoader.js';
 *   await loadSketchupModel('./models/my-model.glb', {
 *       longitude: 4.8625,
 *       latitude: 52.3375,
 *       height: 0
 *   });
 */

import { getViewer } from './cesiumViewer.js';
import { enableShadowsForEntity } from './shadowConfig.js';

// Store loaded models for management
const loadedModels = new Map();

/**
 * Load a SketchUp model (glTF/GLB) into Cesium
 * @param {string} modelUrl - URL or path to the glTF/GLB model file
 * @param {Object} position - Geographic position {longitude, latitude, height}
 * @param {Object} options - Additional options
 * @param {number} options.scale - Scale factor (default: 1.0)
 * @param {Object} options.orientation - Orientation {heading, pitch, roll} in degrees (default: {0, 0, 0})
 * @param {string} options.name - Name for the model entity
 * @param {Cesium.Color} options.color - Color tint (default: white, no tint)
 * @param {number} options.minimumPixelSize - Minimum pixel size before culling (default: 128)
 * @param {number} options.maximumScale - Maximum scale before culling (default: 20000)
 * @returns {Promise<Cesium.Entity>} The created entity
 */
export async function loadSketchupModel(modelUrl, position, options = {}) {
    const viewer = getViewer();
    const entities = viewer.entities;
    
    const scale = options.scale !== undefined ? options.scale : 1.0;
    const orientation = options.orientation || { heading: 0, pitch: 0, roll: 0 };
    const minimumPixelSize = options.minimumPixelSize || 128;
    const maximumScale = options.maximumScale || 20000;
    const name = options.name || `SketchUp Model at ${position.longitude.toFixed(4)}, ${position.latitude.toFixed(4)}`;
    
    console.log(`[SketchUp] Loading model: ${modelUrl}`);
    console.log(`[SketchUp] Position: ${position.longitude}, ${position.latitude}, height: ${position.height || 0}`);
    
    // Create entity with model
    const entity = entities.add({
        id: `sketchup-model-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: name,
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
    
    // Store model reference
    loadedModels.set(entity.id, entity);
    
    // Wait for model to load
    return new Promise((resolve, reject) => {
        const model = entity.model;
        if (model.ready) {
            console.log(`[SketchUp] ✓ Model loaded: ${modelUrl}`);
            resolve(entity);
        } else {
            model.readyPromise.then(() => {
                console.log(`[SketchUp] ✓ Model loaded: ${modelUrl}`);
                console.log(`[SketchUp] Model bounds:`, model.boundingSphere);
                resolve(entity);
            }).catch(error => {
                console.error(`[SketchUp] ✗ Error loading model ${modelUrl}:`, error);
                entities.remove(entity);
                loadedModels.delete(entity.id);
                reject(error);
            });
        }
    });
}

/**
 * Load multiple SketchUp models
 * @param {Array} models - Array of model configurations
 * @returns {Promise<Array<Cesium.Entity>>} Array of created entities
 */
export async function loadSketchupModels(models) {
    const promises = models.map(modelConfig => 
        loadSketchupModel(
            modelConfig.url,
            modelConfig.position,
            modelConfig.options || {}
        )
    );
    
    try {
        const entities = await Promise.all(promises);
        console.log(`[SketchUp] ✓ Loaded ${entities.length} models`);
        return entities;
    } catch (error) {
        console.error('[SketchUp] ✗ Error loading models:', error);
        throw error;
    }
}

/**
 * Update model position
 * @param {Cesium.Entity|string} entityOrId - The model entity or its ID
 * @param {Object} position - New position {longitude, latitude, height}
 */
export function updateSketchupModelPosition(entityOrId, position) {
    const entity = typeof entityOrId === 'string' ? loadedModels.get(entityOrId) : entityOrId;
    
    if (entity && entity.position) {
        entity.position = Cesium.Cartesian3.fromDegrees(
            position.longitude,
            position.latitude,
            position.height || 0
        );
        console.log(`[SketchUp] Updated position for model: ${entity.name || entity.id}`);
    } else {
        console.warn('[SketchUp] Model not found for position update');
    }
}

/**
 * Update model orientation
 * @param {Cesium.Entity|string} entityOrId - The model entity or its ID
 * @param {Object} orientation - New orientation {heading, pitch, roll} in degrees
 */
export function updateSketchupModelOrientation(entityOrId, orientation) {
    const entity = typeof entityOrId === 'string' ? loadedModels.get(entityOrId) : entityOrId;
    
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
        console.log(`[SketchUp] Updated orientation for model: ${entity.name || entity.id}`);
    } else {
        console.warn('[SketchUp] Model not found for orientation update');
    }
}

/**
 * Update model scale
 * @param {Cesium.Entity|string} entityOrId - The model entity or its ID
 * @param {number} scale - New scale factor
 */
export function updateSketchupModelScale(entityOrId, scale) {
    const entity = typeof entityOrId === 'string' ? loadedModels.get(entityOrId) : entityOrId;
    
    if (entity && entity.model) {
        entity.model.scale = scale;
        console.log(`[SketchUp] Updated scale for model: ${entity.name || entity.id} to ${scale}`);
    } else {
        console.warn('[SketchUp] Model not found for scale update');
    }
}

/**
 * Remove a SketchUp model from the scene
 * @param {Cesium.Entity|string} entityOrId - The model entity or its ID
 */
export function removeSketchupModel(entityOrId) {
    const viewer = getViewer();
    const entity = typeof entityOrId === 'string' ? loadedModels.get(entityOrId) : entityOrId;
    
    if (entity) {
        viewer.entities.remove(entity);
        loadedModels.delete(entity.id);
        console.log(`[SketchUp] Removed model: ${entity.name || entity.id}`);
    } else {
        console.warn('[SketchUp] Model not found for removal');
    }
}

/**
 * Remove all SketchUp models from the scene
 */
export function removeAllSketchupModels() {
    const viewer = getViewer();
    let count = 0;
    
    loadedModels.forEach((entity, id) => {
        viewer.entities.remove(entity);
        count++;
    });
    
    loadedModels.clear();
    console.log(`[SketchUp] Removed ${count} models`);
}

/**
 * Get all loaded SketchUp models
 * @returns {Array<Cesium.Entity>} Array of loaded model entities
 */
export function getLoadedSketchupModels() {
    return Array.from(loadedModels.values());
}

/**
 * Get a model by ID
 * @param {string} id - Model entity ID
 * @returns {Cesium.Entity|undefined} The model entity or undefined
 */
export function getSketchupModelById(id) {
    return loadedModels.get(id);
}


