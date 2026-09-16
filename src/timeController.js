/**
 * Historical time slider and date management
 */

import { getViewer } from './cesiumViewer.js';
import { TIME_CONFIG, GTFS_CONFIG, SUMO_CONFIG } from './config.js';
import { startGTFSUpdates, stopGTFSUpdates, getHistoricalData, getHistoricalDataRange } from './gtfsRealtime.js';
import { showHistoricalData as showStaticHistoricalData, detectTimeRangeFromStopTimes, loadDateSpecificScheduleData } from './gtfsStatic.js';
import { updateVehicleEntity, clearVehicles } from './gtfsCommon.js';
import { updateShadowSettings } from './shadowConfig.js';
import { update3DBagShadows } from './threeDBagLoader.js';
import { loadSUMOVisualization, clearSUMOVisualization, updateVehiclePositions, getSUMOData } from './sumoVisualization.js';
import { initializeSUMOTimeSlider, hideSUMOTimeSlider, setSUMOTime } from './sumoTimeSlider.js';

let currentMode = 'realtime'; // 'realtime', 'offline', 'analytical', or 'sumo'
let isRealTimeMode = true; // Legacy support
let isOfflineMode = false; // Legacy support (renamed from isHistoricalMode)
let selectedDate = null; // Selected date string (YYYY-MM-DD) for date-specific data
let sumoTimeRange = null; // SUMO simulation time range in seconds
let sumoBaseDate = null; // Base date for SUMO simulation time conversion

/**
 * Switch between display modes
 * @param {string} mode - 'realtime', 'offline', 'analytical', or 'sumo'
 */
export async function setDisplayMode(mode) {
    const previousMode = currentMode;
    currentMode = mode;
    // Update legacy flags for backward compatibility
    isRealTimeMode = (mode === 'realtime');
    isOfflineMode = (mode === 'offline');
    
    const viewer = getViewer();
    const timeline = viewer.timeline;
    const animation = viewer.animation;
    const scene = viewer.scene;
    
    // Configure shadows based on mode
    if (mode === 'analytical') {
        // Analytical mode: disable shadows for better visibility of colored buildings
        if (scene.shadowMap) {
            scene.shadowMap.enabled = false;
        }
        // Disable shadows for all entities and enhance silhouettes for better geometry visibility
        viewer.entities.values.forEach(entity => {
            if (entity.model) {
                entity.model.shadows = Cesium.ShadowMode.DISABLED;
                
                // Enhance silhouette/outline to improve geometry visibility without shadows
                // Make edges more prominent to distinguish facades and geometries
                try {
                    // Access the actual model object (may need to wait for it to be ready)
                    const model = entity.model;
                    if (model) {
                        // Set silhouette properties directly
                        model.silhouetteSize = 3.0; // Increase from default 2.0 for better edge visibility
                        model.silhouetteColor = Cesium.Color.BLACK.withAlpha(0.8); // Darker for better contrast
                        
                        // Also try to access via the primitive if available
                        if (model._runtime && model._runtime.primitive) {
                            const primitive = model._runtime.primitive;
                            if (primitive) {
                                primitive.silhouetteSize = 3.0;
                                primitive.silhouetteColor = Cesium.Color.BLACK.withAlpha(0.8);
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[TimeController] Could not enhance silhouette for entity:', e);
                }
            }
            if (entity.polygon) {
                entity.polygon.shadows = Cesium.ShadowMode.DISABLED;
            }
        });
        
        // Enhance scene lighting to provide some depth without shadows
        // Use slightly directional lighting to help distinguish surfaces
        if (scene.globe) {
            // Adjust globe lighting for better depth perception
            scene.globe.enableLighting = true;
        }
        // Disable shadows for 3D Tiles (3DBAG buildings)
        update3DBagShadows(false);
        console.log('Analytical mode: Shadows disabled, silhouettes enhanced');
    } else {
        // Real-time and Offline modes: enable shadows
        // Note: If 3DBAG tileset was loaded with shadows disabled, 
        // scene-level shadows may still cast sunlight shadows
        if (scene.shadowMap) {
            scene.shadowMap.enabled = true;
        }
        // Re-enable shadows for entities (they'll be controlled individually)
        // Restore default silhouette settings (smaller, less prominent when shadows are on)
        viewer.entities.values.forEach(entity => {
            if (entity.model && entity.model.shadows !== undefined) {
                // Only enable if it was previously enabled
                entity.model.shadows = Cesium.ShadowMode.ENABLED;
                // Restore default silhouette settings (shadows provide depth, so less prominent outline needed)
                if (entity.model.silhouetteSize !== undefined) {
                    entity.model.silhouetteSize = 2.0; // Default size
                }
                if (entity.model.silhouetteColor !== undefined) {
                    entity.model.silhouetteColor = Cesium.Color.BLUE; // Default color
                }
            }
            if (entity.polygon && entity.polygon.shadows !== undefined) {
                entity.polygon.shadows = Cesium.ShadowMode.ENABLED;
            }
        });
        // Re-enable shadows for 3D Tiles (3DBAG buildings)
        // Note: This respects the tileset's shadow mode set during loading
        update3DBagShadows(true);
        console.log(`${mode === 'realtime' ? 'Real-time' : 'Offline'} mode: Shadows enabled`);
        console.log(`Note: If 3DBAG was loaded with shadows disabled, scene-level shadows may still appear.`);
    }
    
    if (mode === 'realtime') {
        // Real-time mode: disable timeline interaction, show live data
        // Clear SUMO visualization if switching from SUMO mode
        if (previousMode === 'sumo') {
            clearSUMOVisualization();
            hideSUMOTimeSlider();
            sumoBaseDate = null;
            sumoTimeRange = null;
            
            // Show Cesium timeline again
            const timeline = viewer.timeline;
            const animation = viewer.animation;
            if (timeline.container) {
                timeline.container.style.display = '';
            }
            if (animation && animation.container) {
                animation.container.style.display = '';
            }
        }
        
        timeline.makeLabel = () => 'Real-time (Live)';
        const currentDate = new Date();
        const currentTime = Cesium.JulianDate.fromDate(currentDate);
        
        // Clear the keep-alive interval if it exists
        if (viewer._clockButtonKeepAlive) {
            clearInterval(viewer._clockButtonKeepAlive);
            viewer._clockButtonKeepAlive = null;
        }
        
        // Ensure stopTime includes current time for clock button to work (add buffer)
        if (Cesium.JulianDate.lessThan(viewer.clock.stopTime, currentTime)) {
            viewer.clock.stopTime = Cesium.JulianDate.addSeconds(
                currentTime,
                10,
                new Cesium.JulianDate()
            );
        }
        
        timeline.zoomTo(currentTime, currentTime); // Collapse timeline to current time
        viewer.clock.currentTime = currentTime;
        viewer.clock.shouldAnimate = false;
        
        // Disable timeline scrubbing
        timeline.scrubFunction = null;
        
        // Start real-time updates
        startGTFSUpdates();
        
        console.log('Switched to Real-time mode');
    } else if (mode === 'offline') {
        // Offline mode: enable timeline, show historical data
        // Clear SUMO visualization if switching from SUMO mode
        if (previousMode === 'sumo') {
            clearSUMOVisualization();
            hideSUMOTimeSlider();
            sumoBaseDate = null;
            sumoTimeRange = null;
            
            // Show Cesium timeline again
            const timeline = viewer.timeline;
            const animation = viewer.animation;
            if (timeline.container) {
                timeline.container.style.display = '';
            }
            if (animation && animation.container) {
                animation.container.style.display = '';
            }
        }
        
        let startTime, endTime;
        
        // If date-specific data is selected, use detected time range
        if (selectedDate) {
            const scheduleData = await loadDateSpecificScheduleData(selectedDate);
            if (scheduleData) {
                const timeRange = detectTimeRangeFromStopTimes(scheduleData);
                const selectedDateObj = new Date(selectedDate + 'T00:00:00');
                
                // Convert seconds to Date objects
                const startDate = new Date(selectedDateObj);
                startDate.setHours(Math.floor(timeRange.startTime / 3600));
                startDate.setMinutes(Math.floor((timeRange.startTime % 3600) / 60));
                startDate.setSeconds(timeRange.startTime % 60);
                
                const endDate = new Date(selectedDateObj);
                endDate.setHours(Math.floor(timeRange.endTime / 3600));
                endDate.setMinutes(Math.floor((timeRange.endTime % 3600) / 60));
                endDate.setSeconds(timeRange.endTime % 60);
                
                startTime = Cesium.JulianDate.fromDate(startDate);
                endTime = Cesium.JulianDate.fromDate(endDate);
                
                console.log(`[Offline Mode] Using time range for ${selectedDate}: ${startDate.toLocaleTimeString()} - ${endDate.toLocaleTimeString()}`);
            } else {
                // Fall back to default range
                startTime = Cesium.JulianDate.fromDate(TIME_CONFIG.startDate);
                const now = new Date();
                endTime = Cesium.JulianDate.fromDate(now > TIME_CONFIG.endDate ? now : TIME_CONFIG.endDate);
            }
        } else {
            // Default time range
            startTime = Cesium.JulianDate.fromDate(TIME_CONFIG.startDate);
            const now = new Date();
            const nowJulian = Cesium.JulianDate.fromDate(now);
            endTime = Cesium.JulianDate.fromDate(
                TIME_CONFIG.endDate > now ? TIME_CONFIG.endDate : now
            );
        }
        
        // Update clock stopTime to always be ahead of current time (add 10 seconds buffer)
        // This ensures the clock button stays enabled
        const now = new Date();
        const nowJulian = Cesium.JulianDate.fromDate(now);
        viewer.clock.stopTime = Cesium.JulianDate.addSeconds(
            endTime,
            10,
            new Cesium.JulianDate()
        );
        
        // Also set up a periodic check to keep stopTime ahead of current time
        if (!viewer._clockButtonKeepAlive) {
            viewer._clockButtonKeepAlive = setInterval(() => {
                const currentNow = new Date();
                const currentNowJulian = Cesium.JulianDate.fromDate(currentNow);
                if (Cesium.JulianDate.lessThan(viewer.clock.stopTime, currentNowJulian)) {
                    viewer.clock.stopTime = Cesium.JulianDate.addSeconds(
                        currentNowJulian,
                        10,
                        new Cesium.JulianDate()
                    );
                }
            }, 1000);
        }
        
        timeline.zoomTo(startTime, endTime);
        timeline.makeLabel = (time, viewModel) => {
            const date = Cesium.JulianDate.toDate(time);
            return date.toLocaleString();
        };
        
        // Enable timeline scrubbing with debouncing
        let scrubTimeout = null;
        timeline.scrubFunction = (date) => {
            viewer.clock.currentTime = date;
            
            // Debounce: only update after user stops dragging for 500ms
            if (scrubTimeout) {
                clearTimeout(scrubTimeout);
            }
            scrubTimeout = setTimeout(() => {
                handleTimeChange(date);
            }, 500);
        };
        
        // Stop real-time updates
        stopGTFSUpdates();
        
        // If date is selected, jump to start of that date
        if (selectedDate) {
            const selectedDateObj = new Date(selectedDate + 'T00:00:00');
            const selectedJulian = Cesium.JulianDate.fromDate(selectedDateObj);
            viewer.clock.currentTime = selectedJulian;
            timeline.zoomTo(startTime, endTime); // Ensure timeline shows the correct range
            await showHistoricalData(selectedDateObj);
        } else {
            // Show historical data for current time
            const currentTime = Cesium.JulianDate.toDate(viewer.clock.currentTime);
            await showHistoricalData(currentTime);
        }
        
        console.log('Switched to Offline mode');
    } else if (mode === 'analytical') {
        // Analytical mode: similar to real-time but with shadows disabled
        // Stop real-time updates (no vehicle tracking needed)
        stopGTFSUpdates();
        clearVehicles();
        
        // Clear SUMO visualization if switching from SUMO mode
        if (previousMode === 'sumo') {
            clearSUMOVisualization();
            hideSUMOTimeSlider();
            sumoBaseDate = null;
            sumoTimeRange = null;
            
            // Show Cesium timeline again
            const timeline = viewer.timeline;
            const animation = viewer.animation;
            if (timeline.container) {
                timeline.container.style.display = '';
            }
            if (animation && animation.container) {
                animation.container.style.display = '';
            }
        }
        
        // Disable timeline interaction
        timeline.makeLabel = () => 'Analytical Mode';
        const currentDate = new Date();
        const currentTime = Cesium.JulianDate.fromDate(currentDate);
        
        // Clear the keep-alive interval if it exists
        if (viewer._clockButtonKeepAlive) {
            clearInterval(viewer._clockButtonKeepAlive);
            viewer._clockButtonKeepAlive = null;
        }
        
        timeline.zoomTo(currentTime, currentTime);
        viewer.clock.currentTime = currentTime;
        viewer.clock.shouldAnimate = false;
        timeline.scrubFunction = null;
        
        console.log('Switched to Analytical mode (shadows enabled)');
    } else if (mode === 'sumo') {
        // SUMO Simulation mode: load SUMO data and enable timeline for simulation
        // Stop real-time GTFS updates and clear GTFS vehicles
        stopGTFSUpdates();
        clearVehicles(); // This should clear all GTFS vehicle entities
        
        // Clear route visualization if any
        try {
            const { clearRouteVisualization } = await import('./routeVisualization.js');
            clearRouteVisualization();
        } catch (e) {
            // Route visualization module may not be loaded
        }
        
        // Clear existing SUMO visualization if any
        clearSUMOVisualization();
        
        // Force clear any remaining GTFS entities (in case clearVehicles didn't catch everything)
        const viewer = getViewer();
        const entities = viewer.entities;
        const allEntities = entities.values;
        for (let i = allEntities.length - 1; i >= 0; i--) {
            const entity = allEntities[i];
            if (entity && entity.id && entity.id.startsWith('vehicle-')) {
                entities.remove(entity);
            }
        }
        
        // Ensure GTFS updates stay stopped (prevent any auto-restart)
        // Double-check that updates are stopped - SUMO mode should never show real-time GTFS vehicles
        stopGTFSUpdates();
        console.log('[SUMO Mode] GTFS real-time updates disabled - only SUMO vehicles will be shown');
        
        // Reset SUMO base date and time range
        sumoBaseDate = null;
        sumoTimeRange = null;
        
        // Load SUMO data
        try {
            console.log('[SUMO Mode] Loading SUMO visualization...');
            console.log('[SUMO Mode] Data path:', SUMO_CONFIG.dataPath);
            const sumoData = await loadSUMOVisualization(SUMO_CONFIG.dataPath);
            
            if (sumoData && sumoData.timeRange) {
                sumoTimeRange = sumoData.timeRange;
                
                // Set up timeline for SUMO simulation time range
                // SUMO time is in seconds since simulation start (typically 0 to max arrival time)
                // We'll use a base date (today) and add seconds to it
                sumoBaseDate = new Date();
                sumoBaseDate.setHours(0, 0, 0, 0); // Start of day
                
                const startDate = new Date(sumoBaseDate.getTime() + sumoTimeRange.start * 1000);
                const endDate = new Date(sumoBaseDate.getTime() + sumoTimeRange.end * 1000);
                
                const startTime = Cesium.JulianDate.fromDate(startDate);
                const endTime = Cesium.JulianDate.fromDate(endDate);
                
                // Update clock
                viewer.clock.startTime = startTime;
                viewer.clock.stopTime = endTime;
                viewer.clock.currentTime = startTime;
                viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP; // Loop the simulation
                viewer.clock.shouldAnimate = true; // Auto-play simulation
                
                // Configure timeline
                timeline.zoomTo(startTime, endTime);
                timeline.makeLabel = (time, viewModel) => {
                    const date = Cesium.JulianDate.toDate(time);
                    const seconds = Math.floor((date.getTime() - sumoBaseDate.getTime()) / 1000);
                    return `${seconds}s`;
                };
                
                // Enable timeline scrubbing
                let scrubTimeout = null;
                timeline.scrubFunction = (date) => {
                    viewer.clock.currentTime = date;
                    
                    // Debounce: only update after user stops dragging for 200ms
                    if (scrubTimeout) {
                        clearTimeout(scrubTimeout);
                    }
                    scrubTimeout = setTimeout(() => {
                        handleSUMOTimeChange(date);
                    }, 200);
                };
                
                // Initialize custom time slider
                initializeSUMOTimeSlider(sumoTimeRange);
                
                // Hide Cesium timeline for SUMO mode
                if (timeline.container) {
                    timeline.container.style.display = 'none';
                }
                if (animation && animation.container) {
                    animation.container.style.display = 'none';
                }
                
                // Initial vehicle position update
                await handleSUMOTimeChange(startTime);
                
                console.log(`[SUMO Mode] Loaded SUMO simulation (${sumoTimeRange.start}s - ${sumoTimeRange.end}s)`);
            } else {
                console.error('[SUMO Mode] Failed to load SUMO data or time range');
            }
        } catch (error) {
            console.error('[SUMO Mode] Error loading SUMO visualization:', error);
        }
        
        // Enable shadows for SUMO mode
        if (scene.shadowMap) {
            scene.shadowMap.enabled = true;
        }
        updateShadowSettings(true);
        
        console.log('Switched to SUMO Simulation mode');
    }
    
    // Update UI visibility
    updateTimelineVisibility();
}

/**
 * Update timeline widget visibility based on mode
 */
function updateTimelineVisibility() {
    const viewer = getViewer();
    const timeline = viewer.timeline;
    const animation = viewer.animation;
    
    if (isRealTimeMode) {
        // Disable timeline controls in real-time mode (make them read-only)
        if (timeline.container) {
            timeline.container.style.pointerEvents = 'none';
            timeline.container.style.opacity = '0.5';
        }
        if (animation && animation.container) {
            animation.container.style.pointerEvents = 'none';
            animation.container.style.opacity = '0.5';
        }
    } else {
        // Show timeline controls in offline mode and SUMO mode
        if (timeline.container) {
            timeline.container.style.pointerEvents = 'auto';
            timeline.container.style.opacity = '1';
        }
        if (animation && animation.container) {
            animation.container.style.pointerEvents = 'auto';
            animation.container.style.opacity = '1';
        }
    }
}

/**
 * Initialize the time controller with Cesium timeline
 */
export function initializeTimeController() {
    const viewer = getViewer();
    const scene = viewer.scene;
    
    // Configure timeline - make sure it's visible and properly configured
    const timeline = viewer.timeline;
    
    // Set clock times first
    // Ensure endTime includes current time so clock button works
    const now = new Date();
    const startTime = Cesium.JulianDate.fromDate(TIME_CONFIG.startDate);
    // Make sure endTime is at least current time
    const endTime = Cesium.JulianDate.fromDate(
        TIME_CONFIG.endDate > now ? TIME_CONFIG.endDate : now
    );
    const currentTime = Cesium.JulianDate.fromDate(now);
    
    viewer.clock.startTime = startTime;
    viewer.clock.stopTime = endTime;
    viewer.clock.currentTime = currentTime;
    viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
    viewer.clock.multiplier = 1;
    viewer.clock.shouldAnimate = false; // Don't auto-animate by default
    
    // Configure animation widget clock button to jump to current time
    const animation = viewer.animation;
    if (animation && animation.viewModel) {
        // Continuously ensure stopTime includes current time to keep button enabled
        const keepClockButtonEnabled = () => {
            const now = new Date();
            const nowJulian = Cesium.JulianDate.fromDate(now);
            const stopTime = viewer.clock.stopTime;
            
            // Always keep stopTime at least 1 second ahead of current time
            if (Cesium.JulianDate.lessThan(stopTime, nowJulian)) {
                viewer.clock.stopTime = Cesium.JulianDate.addSeconds(nowJulian, 1, new Cesium.JulianDate());
            }
        };
        
        // Update stopTime periodically to keep button enabled
        setInterval(keepClockButtonEnabled, 1000); // Check every second
        
        // Hook into the clock button - try multiple approaches
        const hookClockButton = () => {
            // Method 1: Override the viewModel's clock click handler
            if (animation.viewModel._onClockClick) {
                animation.viewModel._onClockClick = () => {
                    jumpToCurrentTime();
                };
            }
            
            // Method 2: Override the viewModel's canAnimate property if it exists
            if (animation.viewModel) {
                const originalCanAnimate = Object.getOwnPropertyDescriptor(
                    Object.getPrototypeOf(animation.viewModel),
                    'canAnimate'
                );
                
                // Try to override canAnimate getter to always return true
                try {
                    Object.defineProperty(animation.viewModel, 'canAnimate', {
                        get: function() {
                            keepClockButtonEnabled(); // Ensure stopTime is updated
                            return true; // Always allow animation
                        },
                        configurable: true
                    });
                } catch (e) {
                    // Property might not be configurable, that's okay
                }
            }
            
            // Method 3: Find and hook into the button directly, and force enable it
            const buttons = animation.container?.querySelectorAll('button, .cesium-button');
            if (buttons) {
                buttons.forEach(button => {
                    // Check if this is the clock button by title, class, or data attribute
                    const title = button.getAttribute('title') || 
                                 button.getAttribute('data-cesium-title') || 
                                 button.getAttribute('data-title') || '';
                    const className = button.className || '';
                    
                    // Cesium clock button typically has "clock" in title or specific classes
                    if (title.toLowerCase().includes('clock') || 
                        title.toLowerCase().includes('current') ||
                        title.toLowerCase().includes('now') ||
                        className.includes('cesium-animation-clockButton')) {
                        
                        // Force enable the button and keep it enabled
                        button.disabled = false;
                        button.classList.remove('cesium-disabled');
                        button.style.pointerEvents = 'auto';
                        button.style.opacity = '1';
                        
                        // Override the disabled property to always return false
                        try {
                            Object.defineProperty(button, 'disabled', {
                                get: function() { return false; },
                                set: function(value) { 
                                    // Ignore attempts to disable
                                    if (value) {
                                        console.log('[TimeController] Prevented clock button from being disabled');
                                    }
                                },
                                configurable: true
                            });
                        } catch (e) {
                            // Property might not be configurable, use MutationObserver instead
                        }
                        
                        // Use MutationObserver to watch for disabled attribute changes
                        const observer = new MutationObserver((mutations) => {
                            mutations.forEach((mutation) => {
                                if (mutation.type === 'attributes' && mutation.attributeName === 'disabled') {
                                    if (button.disabled) {
                                        button.disabled = false;
                                        button.classList.remove('cesium-disabled');
                                    }
                                }
                                if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                                    if (button.classList.contains('cesium-disabled')) {
                                        button.classList.remove('cesium-disabled');
                                    }
                                }
                            });
                        });
                        
                        observer.observe(button, {
                            attributes: true,
                            attributeFilter: ['disabled', 'class']
                        });
                        
                        // Add click handler
                        button.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            keepClockButtonEnabled(); // Update stopTime before jumping
                            jumpToCurrentTime();
                        });
                        
                        // Periodically force enable the button (backup method)
                        setInterval(() => {
                            if (button && button.parentNode) {
                                button.disabled = false;
                                button.classList.remove('cesium-disabled');
                                button.style.pointerEvents = 'auto';
                                button.style.opacity = '1';
                            }
                        }, 200); // Check more frequently
                    }
                });
            }
        };
        
        // Hook immediately and also after delays (in case DOM isn't ready)
        hookClockButton();
        setTimeout(hookClockButton, 500);
        setTimeout(hookClockButton, 1500);
        setTimeout(hookClockButton, 3000);
    }
    
    // Start in real-time mode (timeline disabled)
    setDisplayMode('realtime');
    
    // Prevent imagery from disappearing when time changes
    // Set clock time on imagery providers to prevent time-based filtering
    if (viewer.imageryLayers) {
        for (let i = 0; i < viewer.imageryLayers.length; i++) {
            const layer = viewer.imageryLayers.get(i);
            if (layer.imageryProvider) {
                // Disable time-based imagery filtering for base maps
                // Most base maps should work regardless of clock time
                try {
                    if (layer.imageryProvider.clock) {
                        layer.imageryProvider.clock = viewer.clock;
                    }
                } catch (e) {
                    // Some providers don't support clock, that's okay
                }
            }
        }
    }
    
    // Listen to clock tick events
    viewer.clock.onTick.addEventListener(clockTickHandler);
    
    // Also listen to clock time changes
    viewer.clock.onTick.addEventListener(() => {
        // Ensure imagery stays visible
        if (viewer.imageryLayers) {
            for (let i = 0; i < viewer.imageryLayers.length; i++) {
                const layer = viewer.imageryLayers.get(i);
                if (layer && !layer.show) {
                    // Re-enable if it got disabled
                    layer.show = true;
                }
            }
        }
    });
    
    console.log('Time controller initialized - Starting in Real-time mode');
    console.log(`Time range: ${TIME_CONFIG.startDate.toISOString()} to ${TIME_CONFIG.endDate.toISOString()}`);
}

/**
 * Handle clock tick events
 * @param {Cesium.Clock} clock - The Cesium clock
 */
function clockTickHandler(clock) {
    // Handle time changes in offline mode (SUMO mode uses custom slider, not clock)
    // Throttle updates to avoid too frequent calls
    if (!isRealTimeMode && currentMode !== 'sumo') {
        // Only update every 2 seconds for offline mode
        const throttleMs = 2000;
        const now = Date.now();
        if (!clockTickHandler.lastUpdate || (now - clockTickHandler.lastUpdate) > throttleMs) {
            clockTickHandler.lastUpdate = now;
            
            // Handle offline mode time change
            const currentTime = Cesium.JulianDate.toDate(clock.currentTime);
            handleTimeChange(currentTime).catch(error => {
                console.error('[TimeController] Error in handleTimeChange:', error);
            });
        }
    }
}
clockTickHandler.lastUpdate = 0;

/**
 * Handle SUMO simulation time changes
 * @param {Cesium.JulianDate} julianDate - The current simulation time
 */
async function handleSUMOTimeChange(julianDate) {
    if (currentMode !== 'sumo') {
        return;
    }
    
    const sumoData = getSUMOData();
    if (!sumoData || !sumoBaseDate) {
        return;
    }
    
    // Convert Julian date to simulation time in seconds
    const currentDate = Cesium.JulianDate.toDate(julianDate);
    const simulationTime = Math.floor((currentDate.getTime() - sumoBaseDate.getTime()) / 1000);
    
    // Update vehicle positions
    const viewer = getViewer();
    updateVehiclePositions(simulationTime, sumoData.vehicles, sumoData.edgesMap, viewer);
}

/**
 * Handle time changes (from slider or clock)
 * @param {Date|Cesium.JulianDate} date - The new date/time
 */
async function handleTimeChange(date) {
    // Only process in offline mode
    if (!isOfflineMode) {
        return;
    }
    
    let jsDate;
    
    if (date instanceof Cesium.JulianDate) {
        jsDate = Cesium.JulianDate.toDate(date);
    } else {
        jsDate = date;
    }
    
    // Update visualization with historical data (async)
    await showHistoricalData(jsDate, selectedDate);
}

/**
 * Show historical data - tries dynamic first, then static
 * @param {Date} timestamp - The timestamp to display
 * @param {string} dateStr - Optional date string (YYYY-MM-DD) for date-specific schedule simulation
 */
export async function showHistoricalData(timestamp, dateStr = null) {
    // If date-specific data is selected, skip dynamic snapshots and go straight to schedule simulation
    if (dateStr) {
        if (GTFS_CONFIG.useStaticDataForHistorical) {
            await showStaticHistoricalData(timestamp, dateStr);
        } else {
            console.log(`No historical data available for ${timestamp.toISOString()}`);
            clearVehicles();
        }
        return;
    }
    
    // First try dynamic digital twin (collected snapshots from real-time mode)
    let data = getHistoricalData(timestamp);
    
    if (data) {
        console.log(`[Dynamic Digital Twin] Using collected snapshot from ${new Date(data.timestamp).toLocaleTimeString()}`);
        clearVehicles();
        data.vehicles.forEach(vehicle => {
            if (vehicle.position) {
                updateVehicleEntity({
                    id: vehicle.id,
                    position: vehicle.position,
                    vehicle: vehicle.vehicle
                });
            }
        });
        console.log(`Showing dynamic data for ${timestamp.toISOString()} (${data.vehicles.length} vehicles)`);
        return;
    }
    
    // Check if we have any dynamic snapshots
    if (!data) {
        const range = getHistoricalDataRange();
        if (range) {
            console.warn(`No dynamic snapshot for ${timestamp.toISOString()}, but have ${range.snapshotCount} snapshots from ${range.startTime.toLocaleString()} to ${range.endTime.toLocaleString()}`);
        }
    }
    
    // Fallback to static digital twin (snapshots, static file, or simulation)
    // Only if dateStr is not provided (if dateStr is provided, schedule simulation was already tried above)
    if (!dateStr && GTFS_CONFIG.useStaticDataForHistorical) {
        console.log(`[Static Digital Twin] Loading static data for ${timestamp.toISOString()}`);
        await showStaticHistoricalData(timestamp, null);
    } else if (!dateStr) {
        console.log(`No historical data available for ${timestamp.toISOString()}`);
        clearVehicles();
    }
    // If dateStr was provided, schedule simulation was already attempted above, so we're done
}

/**
 * Show historical data - wrapper that uses selected date if available
 * @param {Date} timestamp - The timestamp to display
 */
export async function showHistoricalDataWithDate(timestamp) {
    return showHistoricalData(timestamp);
}

/**
 * Set the selected date for date-specific schedule simulation
 * @param {string} dateStr - Date string in YYYY-MM-DD format, or null to clear
 */
export function setSelectedDate(dateStr) {
    selectedDate = dateStr;
    console.log(`[Time Controller] Selected date set to: ${dateStr || 'none'}`);
}

/**
 * Get the currently selected date
 * @returns {string|null} Selected date string or null
 */
export function getSelectedDate() {
    return selectedDate;
}

/**
 * Set the current time programmatically
 * @param {Date} date - The date to set
 */
export function setCurrentTime(date) {
    const viewer = getViewer();
    const julianDate = Cesium.JulianDate.fromDate(date);
    viewer.clock.currentTime = julianDate;
    handleTimeChange(date);
}

/**
 * Jump to current/real time
 * This function is called when the clock button is clicked
 */
export function jumpToCurrentTime() {
    const viewer = getViewer();
    const now = new Date();
    const nowJulian = Cesium.JulianDate.fromDate(now);
    
    // Always ensure stopTime includes current time (this enables the clock button)
    if (Cesium.JulianDate.lessThan(viewer.clock.stopTime, nowJulian)) {
        viewer.clock.stopTime = Cesium.JulianDate.addSeconds(nowJulian, 1, new Cesium.JulianDate());
    }
    
    // Set current time
    viewer.clock.currentTime = nowJulian;
    
    // Update timeline
    const timeline = viewer.timeline;
    if (isRealTimeMode) {
        timeline.zoomTo(nowJulian, nowJulian);
        // In real-time mode, switch back to real-time updates
        startGTFSUpdates();
    } else {
        // In offline mode, keep timeline range but jump to current time
        const startTime = viewer.clock.startTime;
        const stopTime = viewer.clock.stopTime;
        timeline.zoomTo(startTime, stopTime);
        // Update historical data for current time
        handleTimeChange(now);
    }
    
    console.log('Jumped to current time:', now.toLocaleString());
    console.log('Mode:', isRealTimeMode ? 'Real-time' : 'Offline');
}

/**
 * Enable/disable time animation
 * @param {boolean} enabled - Whether to enable animation
 */
export function setTimeAnimation(enabled) {
    const viewer = getViewer();
    if (enabled) {
        viewer.clock.shouldAnimate = true;
    } else {
        viewer.clock.shouldAnimate = false;
    }
}

/**
 * Set time multiplier (speed of time animation)
 * @param {number} multiplier - Time multiplier (1.0 = real-time, 2.0 = 2x speed, etc.)
 */
export function setTimeMultiplier(multiplier) {
    const viewer = getViewer();
    viewer.clock.multiplier = multiplier;
}

/**
 * Get current time
 * @returns {Date} Current time from the clock
 */
export function getCurrentTime() {
    const viewer = getViewer();
    return Cesium.JulianDate.toDate(viewer.clock.currentTime);
}

/**
 * Check if currently in offline mode
 * @returns {boolean} True if in offline mode
 */
export function isInOfflineMode() {
    return isOfflineMode;
}

/**
 * Get current display mode
 * @returns {string} 'realtime', 'offline', or 'analytical'
 */
export function getDisplayMode() {
    return currentMode;
}
