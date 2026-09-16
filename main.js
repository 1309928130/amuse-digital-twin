/**
 * Main entry point for Zuidas 3D Visualization
 * Coordinates all modules and initializes the application
 */

import { initializeViewer } from './src/cesiumViewer.js';
import { configureShadows } from './src/shadowConfig.js';
import { loadOSMBuildings, clearOSMBuildings } from './src/osmLoader.js';
import { load3DBagTiles, remove3DBagTiles } from './src/threeDBagLoader.js';
import { startGTFSUpdates } from './src/gtfsRealtime.js';
import { initializeTimeController, setDisplayMode, setSelectedDate } from './src/timeController.js';
import { toggleGrasshopperHeat } from './src/heatmapVisualization.js';
import { toggleSunlightAnalysis } from './src/sunlightVisualization.js';
import { toggleNetworkFlow, togglePedestrianDemand } from './src/pedFlowVisualization.js';
import { showWindField, clearWindField, showPollutionField, clearPollutionField } from './src/cfdVisualization.js';
import { loadRouteVisualization, toggleRouteVisualization } from './src/routeVisualization.js';
import { loadLargeModel, removeLargeModel } from './src/largeModelLoader.js';
import { getViewer } from './src/cesiumViewer.js';
import { THREEDBAG_CONFIG } from './src/threeDBagLoader.js';
import { WIND_CONFIG, ZUIDAS_CENTER, LARGE_MODEL_CONFIG, SKETCHUP_CONFIG } from './src/config.js';
import { loadBoundaryFromGeoJSON, loadBoundaryFromKML } from './src/boundaryLoader.js';
import { initializePages, getActivePage } from './src/pageController.js';

// Show loading indicator
const loadingIndicator = document.getElementById('loadingIndicator');
loadingIndicator.style.display = 'block';

/**
 * Initialize the application
 */
async function initialize() {
    try {
        console.log('Initializing Zuidas 3D Visualization...');
        
        // 1. Initialize Cesium viewer
        console.log('Step 1: Initializing Cesium viewer...');
        const viewer = initializeViewer('cesiumContainer');
        
        // 2. Configure shadows
        console.log('Step 2: Configuring shadows...');
        configureShadows();
        
        // 3. Set up model selection controls (models will be loaded based on user selection)
        console.log('Step 3: Setting up model selection controls...');
        setupModelSelection();
        
        // 4. Initialize time controller
        console.log('Step 4: Initializing time controller...');
        initializeTimeController();
        
        // 5. Start GTFS-realtime updates (will start in real-time mode)
        console.log('Step 5: Starting GTFS-realtime updates...');
        try {
            await startGTFSUpdates();
        } catch (error) {
            console.warn('Could not start GTFS updates:', error);
            // Continue even if GTFS fails
        }
        
        // 6. Initialize visualization controls (heatmap and wind)
        console.log('Step 6: Setting up visualization controls...');
        setupVisualizationControls();

        // 6b. Restore checkbox toggles from last session (e.g. Urban Heat)
        console.log('Step 6b: Restoring UI toggles...');
        await restoreUiToggles();
        
        // 7. Load Zuidas boundary (if available)
        console.log('Step 7: Loading Zuidas boundary...');
        loadZuidasBoundary();
        
        // 8. Building models will be loaded via model selection controls
        // (No automatic loading - user controls via checkboxes)
        
        // 9. Load Zuidas datamodel (large GLB file) - only if enabled in config
        if (LARGE_MODEL_CONFIG.enabled) {
            console.log('Step 9: Loading Zuidas datamodel (LARGE_MODEL_CONFIG.enabled)...');
            try {
                loadedZuidasGlbModels = await loadZuidasDatamodel();
                const zuidasGlbSwitch = document.getElementById('zuidasGlbSwitch');
                if (zuidasGlbSwitch) zuidasGlbSwitch.checked = true;
            } catch (error) {
                console.error('Auto-load Zuidas GLB failed:', error);
            }
        } else {
            console.log('Step 9: Large model auto-load off — use "Zuidas Datamodel (GLB)" checkbox in 3D Models panel');
            if (loadingIndicator) {
                loadingIndicator.style.display = 'none';
            }
        }
        
        // Set up mode toggle functionality
        setupModeToggle();

        // 10. Set up assessment pages (left nav, camera presets, page-scoped layers)
        console.log('Step 10: Initializing assessment pages...');
        await initializePages(document.getElementById('navButtons'));
        
        console.log('Zuidas 3D Visualization initialized successfully!');
        
        // Add some helpful console messages
        console.log('Controls:');
        console.log('- Toggle between modes using the dropdown in top-right');
        console.log('- Real-time mode: Shows live GTFS data (timeline disabled, shadows enabled)');
        console.log('- Offline mode: Use time slider to view historical data (shadows enabled)');
        console.log('- Analytical mode: No shadows, optimized for viewing colored buildings and other content');
        console.log('- SUMO Simulation mode: Visualize SUMO simulation data with animated vehicles (shadows enabled)');
        console.log('- Use mouse to navigate the 3D scene');
        
    } catch (error) {
        console.error('Error initializing application:', error);
        loadingIndicator.textContent = 'Error initializing application. Check console for details.';
        loadingIndicator.style.display = 'block';
    }
}

// Track loaded models for management
let loadedSketchupModel = null;
let loadedZuidasGlbModels = [];

/**
 * Set up model selection controls
 */
function setupModelSelection() {
    const osmOnlineSwitch = document.getElementById('osmOnlineSwitch');
    const osmLocalSwitch = document.getElementById('osmLocalSwitch');
    const threedbagSwitch = document.getElementById('threedbagSwitch');
    const zuidasGlbSwitch = document.getElementById('zuidasGlbSwitch');
    const sketchupSwitch = document.getElementById('sketchupSwitch');
    
    console.log('[ModelSelection] Setting up controls...', {
        osmOnline: !!osmOnlineSwitch,
        osmLocal: !!osmLocalSwitch,
        threedbag: !!threedbagSwitch,
        zuidasGlb: !!zuidasGlbSwitch,
        sketchup: !!sketchupSwitch
    });
    
    // OSM Online
    if (osmOnlineSwitch) {
        osmOnlineSwitch.addEventListener('change', async (e) => {
            if (e.target.checked) {
                try {
                    console.log('[ModelSelection] Loading OSM buildings (online)...');
                    await loadOSMBuildings({ useLocal: false, forceReload: true });
                } catch (error) {
                    console.error('[ModelSelection] Failed to load OSM (online):', error);
                    e.target.checked = false;
                }
            } else {
                console.log('[ModelSelection] Removing OSM buildings...');
                clearOSMBuildings();
            }
            saveUiToggles();
        });
    }
    
    // OSM Local
    if (osmLocalSwitch) {
        osmLocalSwitch.addEventListener('change', async (e) => {
            if (e.target.checked) {
                try {
                    console.log('[ModelSelection] Loading OSM buildings (local)...');
                    await loadOSMBuildings({ useLocal: true, forceReload: true });
                } catch (error) {
                    console.error('[ModelSelection] Failed to load OSM (local):', error);
                    e.target.checked = false;
                }
            } else {
                console.log('[ModelSelection] Removing OSM buildings...');
                clearOSMBuildings();
            }
            saveUiToggles();
        });
    }
    
    // 3DBAG
    if (threedbagSwitch) {
        threedbagSwitch.addEventListener('change', async (e) => {
            if (e.target.checked) {
                try {
                    console.log('[ModelSelection] Loading 3DBAG buildings...');
                    await load3DBagTiles(THREEDBAG_CONFIG.lod, {
                        replaceOSM: false, // Don't auto-remove OSM, user controls that
                        flyTo: false
                    });
                } catch (error) {
                    console.error('[ModelSelection] Failed to load 3DBAG:', error);
                    e.target.checked = false;
                }
            } else {
                console.log('[ModelSelection] Removing 3DBAG buildings...');
                remove3DBagTiles();
            }
            saveUiToggles();
        });
    }

    // Zuidas Datamodel GLB (full Rhino/SketchUp export)
    if (zuidasGlbSwitch) {
        zuidasGlbSwitch.addEventListener('change', async (e) => {
            if (e.target.checked) {
                try {
                    console.log('[ModelSelection] Loading Zuidas Datamodel GLB...');
                    loadedZuidasGlbModels = await loadZuidasDatamodel();
                } catch (error) {
                    console.error('[ModelSelection] Failed to load Zuidas GLB:', error);
                    e.target.checked = false;
                    alert(`Could not load Zuidas Datamodel GLB:\n${error.message || error}`);
                }
            } else {
                console.log('[ModelSelection] Removing Zuidas Datamodel GLB...');
                clearZuidasGlbModels();
            }
            saveUiToggles();
        });
    }
    
    // SketchUp Model
    if (sketchupSwitch) {
        sketchupSwitch.addEventListener('change', async (e) => {
            if (e.target.checked) {
                try {
                    console.log('[ModelSelection] Loading SketchUp model...');
                    const entity = await loadBuildingModels();
                    loadedSketchupModel = entity; // Store reference for removal
                } catch (error) {
                    console.error('[ModelSelection] Failed to load SketchUp model:', error);
                    e.target.checked = false;
                }
            } else {
                console.log('[ModelSelection] Removing SketchUp model...');
                const viewer = getViewer();
                let removed = false;
                
                // Method 1: Use stored reference
                if (loadedSketchupModel) {
                    try {
                        if (viewer.entities.contains(loadedSketchupModel)) {
                            viewer.entities.remove(loadedSketchupModel);
                            console.log('[ModelSelection] SketchUp model removed from entities (by reference)');
                            removed = true;
                        }
                        // Also use the largeModelLoader's removal function to clean up internal tracking
                        removeLargeModel(loadedSketchupModel);
                    } catch (error) {
                        console.warn('[ModelSelection] Error removing by reference:', error);
                    }
                    loadedSketchupModel = null;
                }
                
                // Method 2: Find by name "Building Block 1"
                if (!removed) {
                    try {
                        const entities = viewer.entities.values;
                        for (let i = 0; i < entities.length; i++) {
                            const entity = entities[i];
                            if (entity.name === 'Building Block 1' && entity.model) {
                                viewer.entities.remove(entity);
                                removeLargeModel(entity);
                                console.log('[ModelSelection] SketchUp model removed by name');
                                removed = true;
                                break;
                            }
                        }
                    } catch (error) {
                        console.warn('[ModelSelection] Error removing by name:', error);
                    }
                }
                
                // Method 3: Find by model path pattern
                if (!removed) {
                    try {
                        const entities = viewer.entities.values;
                        for (let i = 0; i < entities.length; i++) {
                            const entity = entities[i];
                            if (entity.model && entity.model.uri) {
                                const uri = entity.model.uri.getValue ? entity.model.uri.getValue() : entity.model.uri;
                                if (uri && uri.includes('building_block1.glb')) {
                                    viewer.entities.remove(entity);
                                    removeLargeModel(entity);
                                    console.log('[ModelSelection] SketchUp model removed by URI pattern');
                                    removed = true;
                                    break;
                                }
                            }
                        }
                    } catch (error) {
                        console.warn('[ModelSelection] Error removing by URI:', error);
                    }
                }
                
                if (!removed) {
                    console.warn('[ModelSelection] Could not find SketchUp model to remove');
                }
            }
            saveUiToggles();
        });
    }
    
    console.log('Model selection controls initialized');
}

/**
 * Scan for available date datasets
 * @returns {Promise<string[]>} Array of available dates in YYYY-MM-DD format
 */
async function scanAvailableDates() {
    const dates = [];
    try {
        // Since we can't directly list directories in browser, we'll check for dates
        // Try a wider range but with batching to avoid too many simultaneous requests
        const baseUrl = './data/static-gtfs/';
        
        // Try dates from last 90 days to next 90 days (wider range for historical data)
        const today = new Date();
        const datePromises = [];
        const batchSize = 10; // Process in batches to avoid overwhelming
        
        for (let i = -90; i <= 90; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() + i);
            const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
            const testUrl = `${baseUrl}gtfs-zuidas-${dateStr}/routes.txt`;
            
            datePromises.push(
                fetch(testUrl, { method: 'HEAD' }) // Use HEAD to reduce bandwidth
                    .then(res => {
                        if (res.ok) {
                            return dateStr;
                        }
                        // 404 is expected for dates without data - don't treat as error
                        return null;
                    })
                    .catch(error => {
                        // Silently ignore network errors (including 404s)
                        // These are expected when checking for dates that don't have data
                        return null;
                    })
            );
            
            // Process in batches to avoid too many simultaneous requests
            if (datePromises.length >= batchSize || i === 90) {
                const batchResults = await Promise.all(datePromises);
                dates.push(...batchResults.filter(d => d !== null));
                datePromises.length = 0; // Clear array
                
                // Small delay between batches
                if (i < 90) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            }
        }
        
        // Sort dates (newest first)
        dates.sort((a, b) => b.localeCompare(a));
        
        console.log(`[Date Scanner] Found ${dates.length} available date datasets`);
        
    } catch (error) {
        console.warn('[Date Scanner] Error scanning for dates:', error);
    }
    
    return dates;
}

/**
 * Populate date selector dropdown
 */
async function populateDateSelector() {
    const dateSelect = document.getElementById('dateSelect');
    if (!dateSelect) return;
    
    dateSelect.innerHTML = '<option value="">Loading dates...</option>';
    
    const dates = await scanAvailableDates();
    
    dateSelect.innerHTML = '';
    if (dates.length === 0) {
        dateSelect.innerHTML = '<option value="">No date datasets available</option>';
        return;
    }
    
    // Add default option
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Select a date...';
    dateSelect.appendChild(defaultOption);
    
    // Add date options
    dates.forEach(dateStr => {
        const option = document.createElement('option');
        option.value = dateStr;
        // Format date for display (e.g., "15 Dec 2025")
        const date = new Date(dateStr + 'T00:00:00');
        option.textContent = date.toLocaleDateString('en-US', { 
            day: 'numeric', 
            month: 'short', 
            year: 'numeric' 
        });
        dateSelect.appendChild(option);
    });
}

/**
 * Set up the mode toggle dropdown and date selector
 */
function setupModeToggle() {
    const modeSelect = document.getElementById('modeSelect');
    const dateSelect = document.getElementById('dateSelect');
    const dateSelectorContainer = document.getElementById('dateSelectorContainer');
    
    if (modeSelect) {
        // Start in real-time mode
        modeSelect.value = 'realtime';
        
        modeSelect.addEventListener('change', async (e) => {
            const mode = e.target.value;
            
            // Hide date selector for SUMO mode (it's only for offline mode)
            const dateSelectorContainer = document.getElementById('dateSelectorContainer');
            if (dateSelectorContainer) {
                dateSelectorContainer.style.display = (mode === 'offline') ? 'block' : 'none';
            }
            
            await setDisplayMode(mode);
            
            // Show/hide date selector based on mode
            if (dateSelectorContainer) {
                if (mode === 'offline') {
                    dateSelectorContainer.style.display = 'block';
                    // Populate dates if not already done
                    if (dateSelect.options.length <= 1) {
                        populateDateSelector();
                    }
                } else {
                    dateSelectorContainer.style.display = 'none';
                }
            }
        });
        
        // Set initial state
        if (dateSelectorContainer) {
            dateSelectorContainer.style.display = 'none';
        }
        
        console.log('Mode toggle initialized');
    } else {
        console.warn('Mode select element not found');
    }
    
    // Set up date selector
    if (dateSelect) {
        dateSelect.addEventListener('change', async (e) => {
            const selectedDate = e.target.value;
            if (selectedDate) {
                console.log(`[Date Selector] Loading data for date: ${selectedDate}`);
                
                // Set selected date in time controller
                setSelectedDate(selectedDate);
                
                // Clear existing routes and reload with selected date
                const { clearRouteVisualization } = await import('./src/routeVisualization.js');
                clearRouteVisualization();
                await loadRouteVisualization(selectedDate);
                
                // If in offline mode, reload vehicles with schedule simulation and jump to selected date
                if (modeSelect && modeSelect.value === 'offline') {
                    const { getViewer } = await import('./src/cesiumViewer.js');
                    const viewer = getViewer();
                    
                    // Jump timeline to the selected date at start of day
                    const selectedDateObj = new Date(selectedDate + 'T00:00:00');
                    const selectedJulian = Cesium.JulianDate.fromDate(selectedDateObj);
                    viewer.clock.currentTime = selectedJulian;
                    
                    // Reload historical data with the new date
                    const { showHistoricalData } = await import('./src/timeController.js');
                    await showHistoricalData(selectedDateObj);
                }
            } else {
                // Clear selected date
                setSelectedDate(null);
            }
        });
    }
    
    // Initial population (will be hidden until offline mode is selected)
    populateDateSelector();
}

/**
 * Remove all loaded Zuidas datamodel GLB entities.
 */
function clearZuidasGlbModels() {
    const viewer = getViewer();
    const toRemove = [...loadedZuidasGlbModels];

    // Also find by name pattern in case restore/reload lost references
    try {
        const entities = viewer.entities.values;
        for (let i = 0; i < entities.length; i++) {
            const entity = entities[i];
            if (entity.name && String(entity.name).startsWith('Zuidas Datamodel')) {
                toRemove.push(entity);
            }
        }
    } catch (_) { /* ignore */ }

    const seen = new Set();
    toRemove.forEach((entity) => {
        if (!entity || seen.has(entity)) return;
        seen.add(entity);
        try { removeLargeModel(entity); } catch (_) { /* ignore */ }
        try {
            if (viewer.entities.contains(entity)) viewer.entities.remove(entity);
        } catch (_) { /* ignore */ }
    });
    loadedZuidasGlbModels = [];
}

/**
 * Resolve WGS84 placement for the Rhino/GLB export (sidecar JSON if present).
 */
async function resolveGlbPlacement() {
    const fallback = {
        longitude: ZUIDAS_CENTER.longitude,
        latitude: ZUIDAS_CENTER.latitude,
        height: 0,
    };
    const orientation = LARGE_MODEL_CONFIG.orientation || { heading: 0, pitch: 0, roll: 0 };
    const path = LARGE_MODEL_CONFIG.placementJson;
    if (!path) return { position: fallback, orientation };

    try {
        const res = await fetch(path, { cache: 'no-store' });
        if (!res.ok) return { position: fallback, orientation };
        const meta = await res.json();
        const p = meta.placement_wgs84 || {};
        const o = meta.orientation_hint || orientation;
        return {
            position: {
                longitude: Number.isFinite(p.longitude) ? p.longitude : fallback.longitude,
                latitude: Number.isFinite(p.latitude) ? p.latitude : fallback.latitude,
                height: Number.isFinite(p.height) ? p.height : 0,
            },
            orientation: {
                heading: o.heading ?? 0,
                pitch: o.pitch ?? 0,
                roll: o.roll ?? 0,
            },
            meta,
        };
    } catch (e) {
        console.warn('[GLB] Could not load placement JSON:', e);
        return { position: fallback, orientation };
    }
}

/**
 * Load Zuidas datamodel - prefers export_for_visualization.glb, then split parts, then legacy large GLBs.
 * @returns {Promise<Array>} Loaded Cesium entities
 */
async function loadZuidasDatamodel() {
    try {
        const loadingIndicator = document.getElementById('loadingIndicator');
        const { position, orientation } = await resolveGlbPlacement();

        const heightReference = (LARGE_MODEL_CONFIG.heightReference === 'CLAMP_TO_GROUND')
            ? Cesium.HeightReference.CLAMP_TO_GROUND
            : Cesium.HeightReference.NONE;

        const commonOptions = {
            scale: LARGE_MODEL_CONFIG.scale ?? 1.0,
            minimumPixelSize: LARGE_MODEL_CONFIG.minimumPixelSize ?? 128,
            maximumScale: LARGE_MODEL_CONFIG.maximumScale ?? 10000,
            enableShadows: LARGE_MODEL_CONFIG.enableShadows ?? false,
            allowPicking: LARGE_MODEL_CONFIG.allowPicking ?? false,
            heightReference,
            orientation,
            color: LARGE_MODEL_CONFIG.color === undefined ? undefined : LARGE_MODEL_CONFIG.color,
        };

        // Prefer configured paths first (small Rhino export)
        const modelPaths = (LARGE_MODEL_CONFIG.modelPaths && LARGE_MODEL_CONFIG.modelPaths.length)
            ? LARGE_MODEL_CONFIG.modelPaths
            : ['./models/export_for_visualization.glb'];

        let modelPath = null;
        for (const path of modelPaths) {
            // Skip split-part placeholders unless the file exists
            try {
                const response = await fetch(path, { method: 'HEAD' });
                if (response.ok) {
                    modelPath = path;
                    console.log(`Found model: ${path}`);
                    break;
                }
            } catch (e) {
                // continue
            }
        }

        // If first hit is a split part, load all existing parts
        if (modelPath && /zuidas_part\d+\.glb$/i.test(modelPath)) {
            const splitModelPatterns = [];
            for (let i = 1; i <= 8; i++) splitModelPatterns.push(`./models/zuidas_part${i}.glb`);
            const existingSplitModels = [];
            for (const p of splitModelPatterns) {
                try {
                    const response = await fetch(p, { method: 'HEAD' });
                    if (response.ok) existingSplitModels.push(p);
                } catch (_) { /* ignore */ }
            }
            if (existingSplitModels.length > 0) {
                console.log(`Loading ${existingSplitModels.length} split model parts...`);
                if (loadingIndicator) {
                    loadingIndicator.textContent = `Loading ${existingSplitModels.length} model parts...`;
                    loadingIndicator.style.display = 'block';
                }
                const models = await Promise.all(existingSplitModels.map((p, index) =>
                    loadLargeModel(p, position, {
                        ...commonOptions,
                        name: `Zuidas Datamodel Part ${index + 1}`,
                        showLoadingIndicator: false,
                    })
                ));
                if (loadingIndicator) loadingIndicator.style.display = 'none';
                try { getViewer().flyTo(models[0]); } catch (_) { /* ignore */ }
                return models.filter(Boolean);
            }
        }

        if (!modelPath) {
            throw new Error('No model file found under visualization/models/ (expected export_for_visualization.glb).');
        }

        console.log(`Loading Zuidas datamodel from: ${modelPath}`);
        if (loadingIndicator) {
            loadingIndicator.textContent = `Loading model (${modelPath.split('/').pop()})...`;
            loadingIndicator.style.display = 'block';
        }

        const model = await loadLargeModel(
            modelPath,
            position,
            {
                ...commonOptions,
                name: 'Zuidas Datamodel',
                showLoadingIndicator: true,
                readyTimeoutMs: 8000, // small Rhino export — don't spin forever
            }
        );

        console.log('✓ Zuidas datamodel loaded successfully at', position);
        if (loadingIndicator) loadingIndicator.style.display = 'none';
        try { getViewer().flyTo(model); } catch (error) {
            console.warn('Could not fly to model:', error);
        }
        return model ? [model] : [];
    } catch (error) {
        console.error('Error loading Zuidas datamodel:', error);
        const loadingIndicator = document.getElementById('loadingIndicator');
        if (loadingIndicator) {
            loadingIndicator.innerHTML = `
                <strong>Model failed to load</strong><br>
                Error: ${error.message || 'Unknown error'}<br>
            `;
            loadingIndicator.style.color = '#ff6b6b';
        }
        throw error;
    }
}

/**
 * Load building models (GLB files)
 */
async function loadBuildingModels() {
    try {
        // Load building_block1.glb
        const buildingModelPath = './models/building_block1.glb';
        
        try {
            const response = await fetch(buildingModelPath, { method: 'HEAD' });
            if (response.ok) {
                console.log('Found building model, loading...');
                const entity = await loadLargeModel(
                    buildingModelPath,
                    {
                        longitude: 4.877517,
                        latitude: 52.336434,
                        height: 0
                    },
                    {
                        name: 'Building Block 1',
                        scale: 1.0,
                        minimumPixelSize: 64, // Lower = better quality (less aggressive culling)
                        maximumScale: 20000, // Higher = better quality at distance
                        enableShadows: true,
                        showLoadingIndicator: false, // Don't show loading indicator for individual buildings
                        allowPicking: true,
                        // Disable silhouette to prevent blurriness (outline can make edges look blurred)
                        silhouetteSize: 0, // 0 = no silhouette/outline for sharper edges
                        silhouetteColor: Cesium.Color.TRANSPARENT, // Transparent silhouette
                        // Orientation adjustment for SketchUp models
                        // Adjust these values in SKETCHUP_CONFIG.defaultOrientation in config.js
                        // Common fixes:
                        // - roll: -90 (Y-up to Z-up conversion, most common for SketchUp)
                        // - heading: 90 or -90 (rotate compass direction)
                        // - pitch: 180 (flip upside down)
                        orientation: SKETCHUP_CONFIG.defaultOrientation,
                        // Color configuration from SKETCHUP_CONFIG
                        // Use HIGHLIGHT mode with blend amount to allow lighting to show through
                        // This makes different faces have different brightness
                        color: SKETCHUP_CONFIG.color,
                        colorBlendAmount: SKETCHUP_CONFIG.colorBlendAmount !== undefined 
                            ? SKETCHUP_CONFIG.colorBlendAmount 
                            : 0.3, // Default to 0.3 to allow lighting variation
                        colorBlendMode: SKETCHUP_CONFIG.colorBlendMode === 'REPLACE' 
                            ? Cesium.ColorBlendMode.REPLACE 
                            : Cesium.ColorBlendMode.HIGHLIGHT, // HIGHLIGHT preserves lighting
                        // Opacity: set to 1.0 to make all parts fully opaque (no transparency)
                        opacity: SKETCHUP_CONFIG.opacity !== undefined ? SKETCHUP_CONFIG.opacity : 1.0
                    }
                );
                loadedSketchupModel = entity; // Store reference for removal
                console.log('✓ Building block 1 loaded successfully!');
                return entity;
            } else {
                console.log('Building model not found, skipping...');
            }
        } catch (e) {
            console.log('Building model check failed, skipping...');
        }
    } catch (error) {
        console.warn('Could not load building models:', error);
        console.log('This is optional - visualization will continue without building models');
    }
}

/**
 * Load Zuidas boundary from QGIS export (GeoJSON or KML)
 */
async function loadZuidasBoundary() {
    try {
        // Try to load GeoJSON first
        const geoJsonPath = './models/ZuidasBoundaryEPSG4326WGS84.geojson';
        try {
            const response = await fetch(geoJsonPath, { method: 'HEAD' });
            if (response.ok) {
                console.log('Found GeoJSON boundary file, loading...');
                await loadBoundaryFromGeoJSON(geoJsonPath, {
                    strokeColor: Cesium.Color.WHITE,
                    strokeWidth: 3,
                    fillColor: Cesium.Color.WHITE.withAlpha(0.15),
                    name: 'Zuidas Boundary',
                    clampToGround: false,   // Set to false to allow height control
                    height: -6,            // Base height in meters (change this value)
                    extrudedHeight: -6       // Extrusion height in meters (0 = flat, >0 = 3D wall)
                });
                console.log('✓ Zuidas boundary loaded successfully!');
                return;
            }
        } catch (e) {
            // GeoJSON not found, try KML
        }
        
        // Try to load KML
        const kmlPath = './models/zuidas-boundary.kml';
        try {
            const response = await fetch(kmlPath, { method: 'HEAD' });
            if (response.ok) {
                console.log('Found KML boundary file, loading...');
                await loadBoundaryFromKML(kmlPath);
                console.log('✓ Zuidas boundary loaded successfully!');
                return;
            }
        } catch (e) {
            // KML not found
        }
        
        console.log('No boundary file found. To add boundary:');
        console.log('1. Open Zuidas.qgz in QGIS');
        console.log('2. Export boundary layer as GeoJSON');
        console.log('3. Save as models/zuidas-boundary.geojson');
        
    } catch (error) {
        console.warn('Could not load Zuidas boundary:', error);
        console.log('This is optional - visualization will continue without boundary');
    }
}

/**
 * Persist / restore checkbox toggles across page refresh (sessionStorage).
 */
const UI_TOGGLES_KEY = 'pedmodel.visualization.uiToggles';
const UI_CHECKBOX_IDS = [
    'urbanHeatSwitch',
    'sunlightSwitch',
    'networkFlowSwitch',
    'pedDemandSwitch',
    'windSwitch',
    'pollutionSwitch',
    'routesSwitch',
    'osmOnlineSwitch',
    'osmLocalSwitch',
    'threedbagSwitch',
    'zuidasGlbSwitch',
    'sketchupSwitch',
];

function saveUiToggles() {
    try {
        const state = {};
        UI_CHECKBOX_IDS.forEach((id) => {
            const el = document.getElementById(id);
            if (el) state[id] = !!el.checked;
        });
        sessionStorage.setItem(UI_TOGGLES_KEY, JSON.stringify(state));
    } catch (_) {
        /* ignore */
    }
}

function readUiToggles() {
    try {
        const raw = sessionStorage.getItem(UI_TOGGLES_KEY);
        if (!raw) return null;
        const state = JSON.parse(raw);
        // Migrate old GH Heat checkbox id
        if (state.ghHeatSwitch != null && state.urbanHeatSwitch == null) {
            state.urbanHeatSwitch = state.ghHeatSwitch;
        }
        return state;
    } catch (_) {
        return null;
    }
}

/**
 * Re-apply saved checkboxes and load their layers (without stealing the camera).
 */
async function restoreUiToggles() {
    const state = readUiToggles();

    // No saved state: keep existing defaults (e.g. WIND_CONFIG)
    if (!state) {
        // CFD layers are page-scoped now — `pageController` decides which are
        // on for the active page, so nothing to restore here.
        return;
    }

    console.log('[UI] Restoring toggles:', state);

    const osmOnlineSwitch = document.getElementById('osmOnlineSwitch');
    const osmLocalSwitch = document.getElementById('osmLocalSwitch');
    const threedbagSwitch = document.getElementById('threedbagSwitch');
    const zuidasGlbSwitch = document.getElementById('zuidasGlbSwitch');
    const sketchupSwitch = document.getElementById('sketchupSwitch');
    const urbanHeatSwitch = document.getElementById('urbanHeatSwitch');
    const sunlightSwitch = document.getElementById('sunlightSwitch');
    const networkFlowSwitch = document.getElementById('networkFlowSwitch');
    const pedDemandSwitch = document.getElementById('pedDemandSwitch');
    const windSwitch = document.getElementById('windSwitch');
    const pollutionSwitch = document.getElementById('pollutionSwitch');
    const routesSwitch = document.getElementById('routesSwitch');

    if (state.osmOnlineSwitch && osmOnlineSwitch) {
        osmOnlineSwitch.checked = true;
        try {
            await loadOSMBuildings({ useLocal: false, forceReload: true });
        } catch (error) {
            console.error('[UI] Restore OSM online failed:', error);
            osmOnlineSwitch.checked = false;
        }
    }

    if (state.osmLocalSwitch && osmLocalSwitch) {
        osmLocalSwitch.checked = true;
        try {
            await loadOSMBuildings({ useLocal: true, forceReload: true });
        } catch (error) {
            console.error('[UI] Restore OSM local failed:', error);
            osmLocalSwitch.checked = false;
        }
    }

    if (state.threedbagSwitch && threedbagSwitch) {
        threedbagSwitch.checked = true;
        try {
            await load3DBagTiles(THREEDBAG_CONFIG.lod, { replaceOSM: false, flyTo: false });
        } catch (error) {
            console.error('[UI] Restore 3DBAG failed:', error);
            threedbagSwitch.checked = false;
        }
    }

    if (state.zuidasGlbSwitch && zuidasGlbSwitch) {
        zuidasGlbSwitch.checked = true;
        try {
            loadedZuidasGlbModels = await loadZuidasDatamodel();
        } catch (error) {
            console.error('[UI] Restore Zuidas GLB failed:', error);
            zuidasGlbSwitch.checked = false;
        }
    }

    if (state.sketchupSwitch && sketchupSwitch) {
        sketchupSwitch.checked = true;
        try {
            loadedSketchupModel = await loadBuildingModels();
        } catch (error) {
            console.error('[UI] Restore SketchUp failed:', error);
            sketchupSwitch.checked = false;
        }
    }

    if (state.urbanHeatSwitch && urbanHeatSwitch) {
        urbanHeatSwitch.checked = true;
        try {
            await toggleGrasshopperHeat(true, { flyTo: false });
        } catch (error) {
            console.error('[UI] Restore Urban Heat failed:', error);
            urbanHeatSwitch.checked = false;
        }
    }

    if (state.sunlightSwitch && sunlightSwitch) {
        sunlightSwitch.checked = true;
        try {
            const designEntities = [
                ...(loadedZuidasGlbModels || []),
                ...(loadedSketchupModel ? [loadedSketchupModel] : []),
            ];
            await toggleSunlightAnalysis(true, { designEntities });
        } catch (error) {
            console.error('[UI] Restore Sunlight failed:', error);
            sunlightSwitch.checked = false;
        }
    }

    if (state.networkFlowSwitch && networkFlowSwitch) {
        networkFlowSwitch.checked = true;
        try {
            await toggleNetworkFlow(true, { flyTo: false });
        } catch (error) {
            console.error('[UI] Restore Network Flow failed:', error);
            networkFlowSwitch.checked = false;
        }
    }

    if (state.pedDemandSwitch && pedDemandSwitch) {
        pedDemandSwitch.checked = true;
        try {
            await togglePedestrianDemand(true);
        } catch (error) {
            console.error('[UI] Restore Pedestrian Demand failed:', error);
            pedDemandSwitch.checked = false;
        }
    }

    if (state.windSwitch && windSwitch) {
        windSwitch.checked = true;
        try {
            await showWindField();
        } catch (error) {
            console.error('[UI] Restore Wind (CFD) failed:', error);
            windSwitch.checked = false;
        }
    }

    if (state.pollutionSwitch && pollutionSwitch) {
        pollutionSwitch.checked = true;
        try {
            await showPollutionField();
        } catch (error) {
            console.error('[UI] Restore Pollution (CFD) failed:', error);
            pollutionSwitch.checked = false;
        }
    }

    if (state.routesSwitch && routesSwitch) {
        routesSwitch.checked = true;
        toggleRouteVisualization(true);
    }

    saveUiToggles();
}

/**
 * Set up visualization controls (heatmap and wind)
 */
function setupVisualizationControls() {
    const urbanHeatSwitch = document.getElementById('urbanHeatSwitch');
    const sunlightSwitch = document.getElementById('sunlightSwitch');
    const networkFlowSwitch = document.getElementById('networkFlowSwitch');
    const pedDemandSwitch = document.getElementById('pedDemandSwitch');
    const windSwitch = document.getElementById('windSwitch');
    const routesSwitch = document.getElementById('routesSwitch');

    // Urban Heat (Grasshopper / Ladybug CSV)
    if (urbanHeatSwitch) {
        urbanHeatSwitch.addEventListener('change', async (e) => {
            try {
                await toggleGrasshopperHeat(e.target.checked, { flyTo: false });
                if (e.target.checked) {
                    console.log('[Urban Heat] enabled');
                }
            } catch (err) {
                e.target.checked = false;
                alert(`Could not load Urban Heat CSV:\n${err.message || err}`);
            }
            saveUiToggles();
        });
        console.log('Urban Heat toggle initialized');
    } else {
        console.warn('Urban Heat switch element not found');
    }

    // Sunlight analysis mesh (Ladybug bake → GLB); hides design GLBs while on
    if (sunlightSwitch) {
        sunlightSwitch.addEventListener('change', async (e) => {
            try {
                const designEntities = [
                    ...(loadedZuidasGlbModels || []),
                    ...(loadedSketchupModel ? [loadedSketchupModel] : []),
                ];
                await toggleSunlightAnalysis(e.target.checked, { designEntities });
                if (e.target.checked) {
                    console.log('[Sunlight] enabled');
                }
            } catch (err) {
                e.target.checked = false;
                alert(`Could not load Sunlight analysis:\n${err.message || err}`);
            }
            saveUiToggles();
        });
        console.log('Sunlight toggle initialized');
    } else {
        console.warn('Sunlight switch element not found');
    }

    // PedMac network flow (link volumes + hourly hover)
    if (networkFlowSwitch) {
        networkFlowSwitch.addEventListener('change', async (e) => {
            try {
                await toggleNetworkFlow(e.target.checked, { flyTo: false });
                if (e.target.checked) {
                    console.log('[Network Flow] enabled');
                }
            } catch (err) {
                e.target.checked = false;
                alert(`Could not load Network Flow:\n${err.message || err}`);
            }
            saveUiToggles();
        });
        console.log('Network Flow toggle initialized');
    } else {
        console.warn('Network Flow switch element not found');
    }

    // PedMac trip-generation demand heatmap
    if (pedDemandSwitch) {
        pedDemandSwitch.addEventListener('change', async (e) => {
            try {
                await togglePedestrianDemand(e.target.checked);
                if (e.target.checked) {
                    console.log('[Pedestrian Demand] enabled');
                }
            } catch (err) {
                e.target.checked = false;
                alert(`Could not load Pedestrian Demand:\n${err.message || err}`);
            }
            saveUiToggles();
        });
        console.log('Pedestrian Demand toggle initialized');
    } else {
        console.warn('Pedestrian Demand switch element not found');
    }
    
    // Wind + pollution are page-scoped CFD layers. `pageController` sets the
    // initial state per page; these listeners only handle manual overrides.
    if (windSwitch) {
        windSwitch.addEventListener('change', async (e) => {
            try {
                if (e.target.checked) {
                    await showWindField();
                } else {
                    clearWindField();
                }
            } catch (err) {
                e.target.checked = false;
                console.warn('[CFD] Wind layer failed:', err);
            }
            saveUiToggles();
        });

        console.log('Wind (CFD) toggle initialized');
    } else {
        console.warn('Wind switch element not found');
    }

    if (pollutionSwitch) {
        pollutionSwitch.addEventListener('change', async (e) => {
            try {
                if (e.target.checked) {
                    await showPollutionField();
                } else {
                    clearPollutionField();
                }
            } catch (err) {
                e.target.checked = false;
                console.warn('[CFD] Pollution layer failed:', err);
            }
            saveUiToggles();
        });

        console.log('Pollution (CFD) toggle initialized');
    } else {
        console.warn('Pollution switch element not found');
    }
    
    // Routes visualization toggle (element is optional: lives in the utility bar)
    if (routesSwitch) {
        routesSwitch.addEventListener('change', (e) => {
            toggleRouteVisualization(e.target.checked);
            saveUiToggles();
        });
        
        console.log('Routes visualization toggle initialized');
    } else {
        console.warn('Routes switch element not found');
    }
}

// Start initialization when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
} else {
    initialize();
}

// Export for potential external use
export { initialize };

