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
    const showLoadingIndicator = options.showLoadingIndicator !== false;
    
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
    
    // Wait for model to load with progress tracking
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            if (loadingIndicator) loadingIndicator.style.display = 'none';
            fn(value);
        };

        // Failsafe: small exports can hang on readyPromise (esp. with bad heightReference).
        // Unblock UI after readyTimeoutMs even if Cesium is still warming up.
        const readyTimeoutMs = options.readyTimeoutMs != null ? options.readyTimeoutMs : 12000;
        const failsafe = setTimeout(() => {
            if (settled) return;
            console.warn(`[LargeModel] readyPromise slow (>${readyTimeoutMs}ms) for ${fileLabel}; continuing anyway`);
            try { forceModelOpacity(entity, entity.model); } catch (_) { /* ignore */ }
            finish(resolve, entity);
        }, readyTimeoutMs);

        // Function to check model status
        const checkModelStatus = () => {
            const model = entity.model;
            
            if (!model) {
                // Model property not yet available, wait a bit and check again
                setTimeout(checkModelStatus, 100);
                return;
            }
            
            checkModelReady(model);
        };
        
        const checkModelReady = (model) => {
            // Check if model is already ready
            if (model.ready) {
                const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
                console.log(`[LargeModel] ✓ Model already loaded: ${modelUrl} (${loadTime}s)`);
                
                // Force model to be fully opaque
                forceModelOpacity(entity, model);
                clearTimeout(failsafe);
                finish(resolve, entity);
                return;
            }
            
            // Check if readyPromise exists
            if (!model.readyPromise) {
                // If no readyPromise, wait a bit and check again
                setTimeout(() => {
                    if (model.ready) {
                        const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
                        console.log(`[LargeModel] ✓ Model loaded: ${modelUrl} (${loadTime}s)`);
                        
                        // Force opacity after model is ready
                        forceModelOpacity(entity, model);
                        clearTimeout(failsafe);
                        finish(resolve, entity);
                    } else {
                        // Try to get readyPromise again
                        if (model.readyPromise) {
                            setupPromiseHandler(model);
                        } else {
                            // Fallback: poll for ready state
                            pollForReady(model, entity);
                        }
                    }
                }, 500);
                return;
            }
            
            setupPromiseHandler(model);
        };
        
        const setupPromiseHandler = (model) => {
            // Show progress updates
            const progressInterval = setInterval(() => {
                if (settled) {
                    clearInterval(progressInterval);
                    return;
                }
                if (loadingIndicator) {
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    loadingIndicator.textContent = `Loading ${fileLabel}... ${elapsed}s elapsed`;
                }
            }, 1000);
            
            model.readyPromise.then(() => {
                clearInterval(progressInterval);
                clearTimeout(failsafe);
                const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
                console.log(`[LargeModel] ✓ Model loaded: ${modelUrl} (${loadTime}s)`);
                
                // Force model to be fully opaque
                forceModelOpacity(entity, model);
                
                // Enhance lighting to show different face brightness
                try {
                    // Access the model's primitive to enable better lighting
                    if (model._runtime && model._runtime.primitive) {
                        const primitive = model._runtime.primitive;
                        if (primitive) {
                            // Enable lighting on the primitive
                            // This helps different faces show different brightness based on their orientation
                            if (primitive.lightColor !== undefined) {
                                primitive.lightColor = new Cesium.Cartesian3(1.0, 1.0, 1.0); // White light
                            }
                            // Ensure lighting is enabled
                            if (primitive.enableLighting !== undefined) {
                                primitive.enableLighting = true;
                            }
                        }
                    }
                    
                    // Also try to set lighting on the model itself
                    if (model.lightColor !== undefined) {
                        model.lightColor = new Cesium.Cartesian3(1.0, 1.0, 1.0);
                    }
                    if (model.enableLighting !== undefined) {
                        model.enableLighting = true;
                    }
                    
                    console.log('[LargeModel] Enhanced lighting enabled for better face differentiation');
                } catch (e) {
                    console.warn('[LargeModel] Could not enhance lighting:', e);
                }
                
                try {
                    if (model.boundingSphere) {
                        console.log(`[LargeModel] Model bounds:`, model.boundingSphere);
                        console.log(`[LargeModel] Model radius: ${(model.boundingSphere.radius / 1000).toFixed(2)} km`);
                    }
                } catch (e) {
                    // Bounding sphere might not be available yet
                }
                
                if (loadingIndicator) {
                    loadingIndicator.textContent = 'Model loaded!';
                }
                finish(resolve, entity);
            }).catch(error => {
                clearInterval(progressInterval);
                clearTimeout(failsafe);
                console.error(`[LargeModel] ✗ Error loading model ${modelUrl}:`, error);
                console.error(`[LargeModel] Error details:`, {
                    message: error.message,
                    stack: error.stack,
                    modelUrl: modelUrl,
                    entityId: entity.id
                });
                
                // Check for stack overflow or model complexity errors first
                const errorMessage = error.message || error.toString();
                if (errorMessage.includes('Maximum call stack size exceeded') || 
                    errorMessage.includes('stack size exceeded') ||
                    errorMessage.includes('Failed to load glTF')) {
                    console.error('[LargeModel] ⚠ Model is too complex for browser to load.');
                    console.error('[LargeModel] ⚠ Recommendations:');
                    console.error('[LargeModel]   1. Split the model into smaller parts');
                    console.error('[LargeModel]   2. Simplify the model structure in source software');
                    console.error('[LargeModel]   3. Reduce polygon count and nested nodes');
                    console.error('[LargeModel]   4. Consider using 3D Tiles format instead');
                    
                    if (loadingIndicator) {
                        loadingIndicator.innerHTML = `
                            <strong>Model too complex to load</strong><br>
                            Error: ${errorMessage.substring(0, 100)}...<br>
                            See console for recommendations.
                        `;
                        loadingIndicator.style.color = '#ff6b6b';
                        loadingIndicator.style.display = 'block';
                    }
                } else if (error.message && error.message.includes('404')) {
                    console.error('[LargeModel] File not found! Check the file path.');
                    if (loadingIndicator) {
                        loadingIndicator.textContent = `Error: File not found (404)`;
                        loadingIndicator.style.color = '#ff6b6b';
                        loadingIndicator.style.display = 'block';
                    }
                } else if (error.message && error.message.includes('CORS')) {
                    console.error('[LargeModel] CORS error! File may need to be served from same origin.');
                    if (loadingIndicator) {
                        loadingIndicator.textContent = `Error: CORS issue`;
                        loadingIndicator.style.color = '#ff6b6b';
                        loadingIndicator.style.display = 'block';
                    }
                } else if (error.message && error.message.includes('memory')) {
                    console.error('[LargeModel] Out of memory! Model may be too large for browser.');
                    if (loadingIndicator) {
                        loadingIndicator.textContent = `Error: Out of memory`;
                        loadingIndicator.style.color = '#ff6b6b';
                        loadingIndicator.style.display = 'block';
                    }
                } else {
                    if (loadingIndicator) {
                        loadingIndicator.textContent = `Error: ${errorMessage.substring(0, 50)}...`;
                        loadingIndicator.style.color = '#ff6b6b';
                        loadingIndicator.style.display = 'block';
                    }
                }
                entities.remove(entity);
                loadedModels.delete(entity.id);
                finish(reject, error);
            });
        };
        
        const pollForReady = (model, entity) => {
            // Fallback: poll for ready state
            const progressInterval = setInterval(() => {
                if (settled) {
                    clearInterval(progressInterval);
                    return;
                }
                if (loadingIndicator) {
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    loadingIndicator.textContent = `Loading ${fileLabel}... ${elapsed}s elapsed`;
                }
                
                // Check for errors
                if (model.error) {
                    clearInterval(progressInterval);
                    clearTimeout(failsafe);
                    console.error(`[LargeModel] ✗ Model error detected:`, model.error);
                    if (loadingIndicator) {
                        loadingIndicator.textContent = `Error: ${model.error}`;
                        loadingIndicator.style.display = 'block';
                    }
                    entities.remove(entity);
                    loadedModels.delete(entity.id);
                    finish(reject, new Error(`Model error: ${model.error}`));
                    return;
                }
                
                if (model.ready) {
                    clearInterval(progressInterval);
                    clearTimeout(failsafe);
                    const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
                    console.log(`[LargeModel] ✓ Model loaded (polled): ${modelUrl} (${loadTime}s)`);
                    forceModelOpacity(entity, model);
                    finish(resolve, entity);
                }
            }, 500);
            
            // Timeout after 5 minutes
            setTimeout(() => {
                clearInterval(progressInterval);
                if (!settled && !model.ready) {
                    clearTimeout(failsafe);
                    console.error(`[LargeModel] ✗ Model loading timeout after 5 minutes: ${modelUrl}`);
                    console.error(`[LargeModel] File: ${fileLabel} — check Network tab for the real URL / size.`);
                    if (loadingIndicator) {
                        loadingIndicator.textContent = `Loading timeout: ${fileLabel}`;
                        loadingIndicator.style.display = 'block';
                    }
                    entities.remove(entity);
                    loadedModels.delete(entity.id);
                    finish(reject, new Error('Model loading timeout after 5 minutes'));
                }
            }, 300000); // 5 minutes
        };
        
        // Start checking after a short delay to allow entity to initialize
        setTimeout(checkModelStatus, 100);
    });
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

