/**
 * Cesium Viewer initialization and configuration
 */

import { ZUIDAS_CENTER, ZUIDAS_BOUNDS, CESIUM_CONFIG, SHADOW_CONFIG } from './config.js';

let viewer = null;

/**
 * Initialize the Cesium viewer
 * @param {string} containerId - ID of the HTML container element
 * @returns {Cesium.Viewer} The initialized Cesium viewer instance
 */
export function initializeViewer(containerId = 'cesiumContainer') {
    // Set Cesium Ion access token if provided
    if (CESIUM_CONFIG.ionAccessToken) {
        Cesium.Ion.defaultAccessToken = CESIUM_CONFIG.ionAccessToken;
    }

    // Create terrain provider
    let terrainProvider;
    if (CESIUM_CONFIG.terrainProvider === 'CesiumWorldTerrain') {
        // Try to create world terrain (requires Ion token for premium terrain)
        if (typeof Cesium.createWorldTerrain === 'function') {
            try {
                terrainProvider = Cesium.createWorldTerrain();
            } catch (e) {
                console.warn('Could not create world terrain, using ellipsoid:', e);
                terrainProvider = new Cesium.EllipsoidTerrainProvider();
            }
        } else if (typeof Cesium.Terrain !== 'undefined' && Cesium.Terrain.fromWorldTerrain) {
            // Alternative API for newer versions
            try {
                terrainProvider = Cesium.Terrain.fromWorldTerrain();
            } catch (e) {
                console.warn('Could not create world terrain, using ellipsoid:', e);
                terrainProvider = new Cesium.EllipsoidTerrainProvider();
            }
        } else {
            // Fallback to ellipsoid terrain
            console.warn('World terrain not available, using ellipsoid terrain');
            terrainProvider = new Cesium.EllipsoidTerrainProvider();
        }
    } else {
        terrainProvider = new Cesium.EllipsoidTerrainProvider();
    }

    // Create viewer with improved rendering quality
    viewer = new Cesium.Viewer(containerId, {
        terrainProvider: terrainProvider,
        // Improve rendering quality
        requestRenderMode: false, // Always render (better quality, slightly less performant)
        maximumRenderTimeChange: Infinity, // Don't limit render time
        timeline: true,
        animation: true,
        vrButton: false,
        sceneModePicker: true,
        baseLayerPicker: true,
        geocoder: true,
        homeButton: true,
        infoBox: true,
        selectionIndicator: true,
        navigationHelpButton: true,
        fullscreenButton: true
    });

    // Initial camera = the overview framing shared with the assessment pages.
    // Page navigation (pageController.js) owns the camera from here on, so a
    // restored sessionStorage view must NOT override a page preset on reload.
    {
        const cameraOffsetLat = -0.015; // South of centre (negative = south)
        const cameraOffsetLon = 0.013;  // East of centre (positive = east)
        const cameraHeight = 2500;      // Higher altitude for the whole-area view

        const cameraLon = ZUIDAS_CENTER.longitude + cameraOffsetLon;
        const cameraLat = ZUIDAS_CENTER.latitude + cameraOffsetLat;

        const dx = ZUIDAS_CENTER.longitude - cameraLon;  // West (negative) from camera
        const dy = ZUIDAS_CENTER.latitude - cameraLat;   // North (positive) from camera
        const heading = Math.atan2(0.5 * dx, 0.9 * dy);

        viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(cameraLon, cameraLat, cameraHeight),
            orientation: {
                heading: heading,
                pitch: Cesium.Math.toRadians(-55),
                roll: 0.0,
            },
        });
    }

    // Configure scene settings
    const scene = viewer.scene;
    
    // Enable terrain lighting for better visualization
    scene.globe.dynamicAtmosphereLighting = true;
    scene.globe.dynamicAtmosphereLightingFromSun = true;
    
    // Enable shadows if configured
    if (SHADOW_CONFIG.enabled) {
        scene.shadowMap.enabled = true;
        scene.shadowMap.softShadows = SHADOW_CONFIG.softShadows;
        scene.shadowMap.size = SHADOW_CONFIG.shadowMapSize;
        scene.shadowMap.maximumDistance = SHADOW_CONFIG.maximumDistance;
    }

    // Enable lighting
    scene.globe.enableLighting = true;
    scene.globe.dynamicAtmosphereLighting = true;
    scene.globe.dynamicAtmosphereLightingFromSun = true;
    
    // Enhance scene lighting for better model face differentiation
    // Increase light intensity to make face differences more visible
    if (scene.lightSource) {
        // Ensure sun lighting is enabled and bright
        if (scene.lightSource && scene.lightSource.color) {
            scene.lightSource.color = new Cesium.Cartesian3(1.0, 1.0, 1.0); // Bright white light
        }
    }
    
    // Configure directional lighting for better face visibility
    // This helps distinguish different faces of buildings
    if (scene.sun) {
        scene.sun.show = true;
        // Make sun brighter for better face differentiation
        if (scene.sun.color) {
            scene.sun.color = new Cesium.Cartesian3(1.0, 1.0, 1.0);
        }
    }

    // Configure fog for better depth perception
    scene.fog.enabled = true;
    scene.fog.density = 0.0002;

    // Set sun position for realistic lighting
    scene.sun.show = true;
    scene.moon.show = false;
    
    // Ensure terrain is visible
    scene.globe.show = true;
    scene.globe.showGroundAtmosphere = true;
    
    // Automatically select the default base map (WGS84 Ellipsoid or default imagery)
    // This ensures the base map is visible without manual selection
    if (viewer.baseLayerPicker && viewer.baseLayerPicker.viewModel) {
        const viewModel = viewer.baseLayerPicker.viewModel;
        
        // Wait a moment for the picker to initialize
        setTimeout(() => {
            const imageryProviders = viewModel.imageryProviderViewModels;
            
            if (imageryProviders && imageryProviders.length > 0) {
                // Find WGS84 Ellipsoid or default imagery provider
                // Usually the first one is the default (WGS84 Ellipsoid or Bing Maps)
                const defaultProvider = imageryProviders.find(p => 
                    p.name && (
                        p.name.toLowerCase().includes('wgs84') || 
                        p.name.toLowerCase().includes('ellipsoid') ||
                        p.name.toLowerCase().includes('bing') ||
                        p.name.toLowerCase().includes('world')
                    )
                ) || imageryProviders[0]; // Fallback to first available
                
                if (defaultProvider) {
                    viewModel.selectedImagery = defaultProvider;
                    console.log('Auto-selected base map:', defaultProvider.name || 'Default');
                }
            }
            
            // Also ensure the terrain picker selects default terrain
            if (viewModel.terrainProviderViewModels && viewModel.terrainProviderViewModels.length > 0) {
                const defaultTerrain = viewModel.terrainProviderViewModels.find(t =>
                    t.name && (
                        t.name.toLowerCase().includes('ellipsoid') ||
                        t.name.toLowerCase().includes('wgs84')
                    )
                ) || viewModel.terrainProviderViewModels[0];
                
                if (defaultTerrain) {
                    viewModel.selectedTerrain = defaultTerrain;
                    console.log('Auto-selected terrain:', defaultTerrain.name || 'Default');
                }
            }
        }, 100);
    }
    
    // Ensure imagery layers are visible and not time-dependent
    if (viewer.imageryLayers && viewer.imageryLayers.length > 0) {
        for (let i = 0; i < viewer.imageryLayers.length; i++) {
            const layer = viewer.imageryLayers.get(i);
            if (layer) {
                layer.show = true;
                // Ensure layer doesn't disappear when clock time changes
                // Most base imagery providers should work regardless of time
            }
        }
    }
    
    // Prevent imagery from disappearing when clock time changes
    // Hook into clock updates to ensure imagery stays visible
    const originalClockTick = viewer.clock.onTick;
    viewer.clock.onTick.addEventListener(() => {
        // Ensure all imagery layers stay visible
        if (viewer.imageryLayers) {
            for (let i = 0; i < viewer.imageryLayers.length; i++) {
                const layer = viewer.imageryLayers.get(i);
                if (layer && !layer.show) {
                    layer.show = true;
                }
            }
        }
    });

    return viewer;
}

/**
 * Get the current viewer instance
 * @returns {Cesium.Viewer} The viewer instance
 */
export function getViewer() {
    if (!viewer) {
        throw new Error('Viewer not initialized. Call initializeViewer() first.');
    }
    return viewer;
}

/**
 * Update camera to focus on a specific location
 * @param {number} longitude - Longitude in degrees
 * @param {number} latitude - Latitude in degrees
 * @param {number} height - Height in meters
 */
export function flyToLocation(longitude, latitude, height = 1000) {
    if (!viewer) return;
    
    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, height),
        orientation: {
            heading: Cesium.Math.toRadians(0),
            pitch: Cesium.Math.toRadians(-90), // Top-down view
            roll: 0.0
        },
        duration: 2.0
    });
}

