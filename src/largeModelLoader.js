/**
 * Large Model Loader for Cesium
 * 
 * Optimized loader for large GLB/glTF models (200MB+)
 * Includes performance optimizations and loading strategies
 */

import { getViewer } from './cesiumViewer.js';
import { enableShadowsForEntity } from './shadowConfig.js';

// Store loaded models
const loadedModels = new Map();

/**
 * Force model to be fully opaque by modifying materials and entity properties
 * @param {Cesium.Entity} entity - The entity containing the model
 * @param {Cesium.Model} model - The Cesium model object
 */
function forceModelOpacity(entity, model) {
    try {
        // Set entity model opacity to 1.0
        if (entity.model) {
            entity.model.opacity = 1.0;
        }
        
        // Force opacity on all materials in the model
        // Access the model's primitive and materials
        if (model._runtime && model._runtime.primitive) {
            const primitive = model._runtime.primitive;
            if (primitive && primitive.materials) {
                const materials = primitive.materials;
                for (let i = 0; i < materials.length; i++) {
                    const material = materials[i];
                    if (material && material.uniforms) {
                        // Set alpha to 1.0 in material uniforms
                        if (material.uniforms.alpha !== undefined) {
                            material.uniforms.alpha = 1.0;
                        }
                        if (material.uniforms.baseColor !== undefined) {
                            // Ensure baseColor alpha is 1.0
                            const baseColor = material.uniforms.baseColor;
                            if (baseColor && baseColor.length >= 4) {
                                baseColor[3] = 1.0; // Alpha channel
                            } else if (baseColor && baseColor.getValue) {
                                // If it's a Cesium property, get value and set alpha
                                const color = baseColor.getValue();
                                if (color) {
                                    baseColor.setValue(color.withAlpha(1.0));
                                }
                            }
                        }
                    }
                }
                console.log(`[LargeModel] Forced opacity to 1.0 on ${materials.length} materials`);
            }
        }
        
        // Also set opacity via model's color property if it exists
        if (entity.model && entity.model.color) {
            const currentColor = entity.model.color.getValue ? entity.model.color.getValue() : entity.model.color;
            if (currentColor) {
                const opaqueColor = currentColor instanceof Cesium.Color 
                    ? currentColor.withAlpha(1.0)
                    : Cesium.Color.fromCssColorString(currentColor).withAlpha(1.0);
                if (entity.model.color.setValue) {
                    entity.model.color.setValue(opaqueColor);
                } else {
                    entity.model.color = opaqueColor;
                }
            }
        }
    } catch (e) {
        console.warn('[LargeModel] Could not force opacity on materials:', e);
    }
}

/**
 * Load a large GLB/glTF model with performance optimizations
 * @param {string} modelUrl - URL or path to the model file
 * @param {Object} position - Geographic position {longitude, latitude, height}
 * @param {Object} options - Additional options
 * @returns {Promise<Cesium.Entity>} The created entity
 */
export async function loadLargeModel(modelUrl, position, options = {}) {
    const viewer = getViewer();
    const entities = viewer.entities;
    
    const scale = options.scale !== undefined ? options.scale : 1.0;
    const orientation = options.orientation || { heading: 0, pitch: 0, roll: 0 };
    const name = options.name || `Large Model at ${position.longitude.toFixed(4)}, ${position.latitude.toFixed(4)}`;
    
    // minimumPixelSize: 0 means true geographic size (must not use `||`, since 0 is valid)
    const minimumPixelSize = options.minimumPixelSize !== undefined ? options.minimumPixelSize : 256;
    const maximumScale = options.maximumScale !== undefined ? options.maximumScale : 20000;
    // Off unless a caller explicitly asks for it. Defaulting to on meant any new
    // call site that simply forgot the option brought back a "Loading <file>..."
    // box for a model that loads in under a frame, which is how the notice kept
    // reappearing on page load. Showing progress should be the deliberate choice.
    const showLoadingIndicator = options.showLoadingIndicator === true;
    
    console.log(`[LargeModel] Loading model: ${modelUrl}`);
    console.log(`[LargeModel] Position: ${position.longitude}, ${position.latitude}, height: ${position.height || 0}`);
    console.log(`[LargeModel] scale=${scale}, minimumPixelSize=${minimumPixelSize}, maximumScale=${maximumScale}`);
    
    const fileLabel = (modelUrl || '').split('/').pop() || 'model';
    const startTime = Date.now();

    // Show loading indicator (label from actual filename — not hardcoded 254MB)
    let loadingIndicator = null;
    if (showLoadingIndicator) {
        loadingIndicator = document.getElementById('loadingIndicator');
        if (loadingIndicator) {
            loadingIndicator.textContent = `Loading ${fileLabel}...`;
            loadingIndicator.style.display = 'block';
            loadingIndicator.style.color = '';
        }
    }
    
    // Validate file path
    if (!modelUrl || modelUrl.trim() === '') {
        const error = new Error('Model URL is empty');
        console.error('[LargeModel] ✗', error);
        if (loadingIndicator) loadingIndicator.style.display = 'none';
        return Promise.reject(error);
    }
    
    console.log(`[LargeModel] Model URL: ${modelUrl}`);
    
    // Prepare model properties
    const modelProperties = {
        uri: modelUrl,
        scale: scale,
        minimumPixelSize: minimumPixelSize, // Cull when smaller than this
        maximumScale: maximumScale, // Cull when larger than this
        shadows: options.enableShadows !== false ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED,
        // Silhouette/outline settings - will be enhanced in analysis mode
        silhouetteColor: options.silhouetteColor !== undefined ? options.silhouetteColor : Cesium.Color.BLUE,
        silhouetteSize: options.silhouetteSize !== undefined ? options.silhouetteSize : 2.0,
        // Set opacity to 1.0 (fully opaque) to prevent transparency
        // This ensures all parts of the model are fully visible
        opacity: options.opacity !== undefined ? options.opacity : 1.0
    };
    
    // Handle color: if null, don't set (use original model colors)
    // if undefined, use WHITE; if provided, use the provided color
    if (options.color !== undefined && options.color !== null) {
        // Convert string color to Cesium.Color if needed
        let cesiumColor;
        if (typeof options.color === 'string') {
            try {
                cesiumColor = Cesium.Color.fromCssColorString(options.color);
            } catch (e) {
                console.warn(`[LargeModel] Invalid color string: ${options.color}, using WHITE`);
                cesiumColor = Cesium.Color.WHITE;
            }
        } else if (options.color instanceof Cesium.Color) {
            cesiumColor = options.color;
        } else {
            cesiumColor = Cesium.Color.WHITE;
        }
        // Ensure color is fully opaque (alpha = 1.0) to prevent transparency
        cesiumColor = cesiumColor.withAlpha(1.0);
        modelProperties.color = cesiumColor;
        modelProperties.colorBlendMode = options.colorBlendMode !== undefined 
            ? options.colorBlendMode 
            : Cesium.ColorBlendMode.HIGHLIGHT;
        modelProperties.colorBlendAmount = options.colorBlendAmount !== undefined 
            ? options.colorBlendAmount 
            : 0.0;
    } else if (options.color === null) {
        // null means use original colors - don't set color property
        // But we can still set blend mode/amount if provided
        if (options.colorBlendMode !== undefined) {
            modelProperties.colorBlendMode = options.colorBlendMode;
        }
        if (options.colorBlendAmount !== undefined) {
            modelProperties.colorBlendAmount = options.colorBlendAmount;
        }
    } else {
        // undefined - use default WHITE
        modelProperties.color = Cesium.Color.WHITE;
        modelProperties.colorBlendMode = options.colorBlendMode !== undefined 
            ? options.colorBlendMode 
            : Cesium.ColorBlendMode.HIGHLIGHT;
        modelProperties.colorBlendAmount = options.colorBlendAmount !== undefined 
            ? options.colorBlendAmount 
            : 0.0;
    }
    
    // Create entity with optimized settings
    const entity = entities.add({
        id: `large-model-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: name,
        position: Cesium.Cartesian3.fromDegrees(
            position.longitude,
            position.latitude,
            position.height || 0
        ),
        model: {
            ...modelProperties,
            // Performance optimizations for very large models
            allowPicking: options.allowPicking !== false,
            // IMPORTANT: HeightReference.NONE === 0, so do not use `||` (would fall back to CLAMP)
            heightReference: options.heightReference !== undefined
                ? options.heightReference
                : Cesium.HeightReference.CLAMP_TO_GROUND,
            // Additional optimizations to prevent stack overflow
            runAnimations: false, // Disable animations for large models
            clampAnimations: false,
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
    
    // Enable shadows only if requested (disabled by default for large models)
    if (options.enableShadows !== false) {
        enableShadowsForEntity(entity);
    }
    
    // Store model reference
    loadedModels.set(entity.id, entity);
    
    // ## Why this does not wait for the model to be "ready"
    //
    // It used to. Roughly 260 lines polled `entity.model.readyPromise` and
    // `entity.model.ready`, with a 5-minute poll and error handling for stack
    // overflows and out-of-memory conditions. None of it ever ran, and the
    // reason is worth recording so it is not re-added:
    //
    //   * `entity.model` is a **`ModelGraphics`** -- the declarative
    //     *description* of a model, whose keys are `_uri`, `_scale`, `_color`
    //     and their `*Subscription` handles. It has no `ready`, no
    //     `readyPromise` and no `_runtime`; those belong to `Cesium.Model`,
    //     which Cesium creates privately inside its own visualizer and never
    //     exposes on the entity.
    //   * `Cesium.Model.fromGltfAsync` is not an alternative: measured on this
    //     build (Cesium 1.110) it resolves almost immediately to an
    //     unpopulated object that reports `ready === false` forever, has no
    //     `readyPromise`, and throws on `boundingSphere`.
    //
    // So there is no readiness signal to wait on for either the Zuidas massing
    // or the Ladybug sunlight mesh, and every branch of the old code was
    // unreachable -- including the `✓ Model loaded` logs, which had never once
    // printed. The timeout was therefore the *entire* wait rather than a safety
    // net, which is why it appeared as a fixed 12 s no matter how small the
    // file was.
    //
    // Cesium composites the mesh on its own schedule. The honest behaviour is
    // to add the entity and return, letting the caller proceed: the model will
    // appear when it appears, and nothing here can know sooner.
    //
    // `readyTimeoutMs` is retained because callers pass it and it now means
    // "how long to hold the loading indicator", not "how long to wait for
    // ready". Nothing blocks on it.
    const readyTimeoutMs = options.readyTimeoutMs != null ? options.readyTimeoutMs : 12000;
    if (readyTimeoutMs > 0) {
        setTimeout(() => {
            if (loadingIndicator) loadingIndicator.style.display = 'none';
        }, readyTimeoutMs);
    } else if (loadingIndicator) {
        loadingIndicator.style.display = 'none';
    }

    try {
        forceModelOpacity(entity, entity.model);
    } catch (_) {
        /* the graphics object accepts opacity; the underlying model may not exist yet */
    }

    return Promise.resolve(entity);
}


/**
 * Remove a large model
 * @param {Cesium.Entity|string} entityOrId - The model entity or its ID
 */
export function removeLargeModel(entityOrId) {
    const viewer = getViewer();
    const entity = typeof entityOrId === 'string' ? loadedModels.get(entityOrId) : entityOrId;
    
    if (entity) {
        viewer.entities.remove(entity);
        loadedModels.delete(entity.id);
        console.log(`[LargeModel] Removed model: ${entity.name || entity.id}`);
    }
}

/**
 * Get all loaded large models
 * @returns {Array<Cesium.Entity>} Array of loaded model entities
 */
export function getLoadedLargeModels() {
    return Array.from(loadedModels.values());
}

