/**
 * Custom Time Slider for SUMO Simulation
 * Provides better control over SUMO simulation time than the Cesium timeline
 */

import { getViewer } from './cesiumViewer.js';
import { updateVehiclePositions, getSUMOData } from './sumoVisualization.js';

let sumoTimeRange = null; // { start: number, end: number } in seconds
let currentSimulationTime = 0; // Current time in seconds
let isPlaying = false;
let animationFrameId = null;
let playbackSpeed = 1; // 1x, 2x, 4x, etc.

// DOM elements
let sliderElement = null;
let timeRangeInput = null;
let timeDisplay = null;
let playPauseBtn = null;
let resetBtn = null;
let speedBtn = null;

/**
 * Initialize the SUMO time slider
 * @param {Object} timeRange - Time range object with start and end in seconds
 */
export function initializeSUMOTimeSlider(timeRange) {
    sumoTimeRange = timeRange;
    currentSimulationTime = timeRange.start;
    
    // Get DOM elements
    sliderElement = document.getElementById('sumoTimeSlider');
    timeRangeInput = document.getElementById('sumoTimeRange');
    timeDisplay = document.getElementById('sumoTimeDisplay');
    playPauseBtn = document.getElementById('sumoPlayPauseBtn');
    resetBtn = document.getElementById('sumoResetBtn');
    speedBtn = document.getElementById('sumoSpeedBtn');
    
    if (!sliderElement || !timeRangeInput || !timeDisplay) {
        console.error('[SUMO Time Slider] Required DOM elements not found');
        return;
    }
    
    // Set up slider range
    timeRangeInput.min = timeRange.start;
    timeRangeInput.max = timeRange.end;
    timeRangeInput.value = timeRange.start;
    timeRangeInput.step = 1;
    
    // Update display
    updateTimeDisplay(currentSimulationTime);
    
    // Set up event listeners
    timeRangeInput.addEventListener('input', handleSliderInput);
    timeRangeInput.addEventListener('change', handleSliderChange);
    
    if (playPauseBtn) {
        playPauseBtn.addEventListener('click', togglePlayPause);
    }
    
    if (resetBtn) {
        resetBtn.addEventListener('click', resetSimulation);
    }
    
    if (speedBtn) {
        speedBtn.addEventListener('click', toggleSpeed);
    }
    
    // Show the slider
    sliderElement.classList.add('visible');
    
    console.log(`[SUMO Time Slider] Initialized with range ${timeRange.start}s - ${timeRange.end}s`);
}

/**
 * Update the time display
 * @param {number} time - Time in seconds
 */
function updateTimeDisplay(time) {
    if (timeDisplay) {
        const minutes = Math.floor(time / 60);
        const seconds = Math.floor(time % 60);
        const hours = Math.floor(minutes / 60);
        const displayMinutes = minutes % 60;
        
        if (sumoTimeRange) {
            const totalMinutes = Math.floor(sumoTimeRange.end / 60);
            const totalHours = Math.floor(totalMinutes / 60);
            const totalDisplayMinutes = totalMinutes % 60;
            const totalSeconds = Math.floor(sumoTimeRange.end % 60);
            
            // Show current time and range: "HH:MM:SS / HH:MM:SS (XXXs / YYYs)"
            if (hours > 0 || totalHours > 0) {
                timeDisplay.textContent = `${hours.toString().padStart(2, '0')}:${displayMinutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')} / ${totalHours.toString().padStart(2, '0')}:${totalDisplayMinutes.toString().padStart(2, '0')}:${totalSeconds.toString().padStart(2, '0')} (${Math.floor(time)}s / ${Math.floor(sumoTimeRange.end)}s)`;
            } else {
                timeDisplay.textContent = `${displayMinutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')} / ${totalDisplayMinutes.toString().padStart(2, '0')}:${totalSeconds.toString().padStart(2, '0')} (${Math.floor(time)}s / ${Math.floor(sumoTimeRange.end)}s)`;
            }
        } else {
            // Fallback if range not available
            if (hours > 0) {
                timeDisplay.textContent = `${hours.toString().padStart(2, '0')}:${displayMinutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')} (${Math.floor(time)}s)`;
            } else {
                timeDisplay.textContent = `${displayMinutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')} (${Math.floor(time)}s)`;
            }
        }
    }
}

/**
 * Handle slider input (while dragging)
 * @param {Event} e - Input event
 */
function handleSliderInput(e) {
    const time = parseFloat(e.target.value);
    if (isNaN(time)) return;
    
    currentSimulationTime = time;
    updateTimeDisplay(time);
    updateVehiclePositionsFromSlider(time);
}

/**
 * Handle slider change (when released)
 * @param {Event} e - Change event
 */
function handleSliderChange(e) {
    const time = parseFloat(e.target.value);
    if (isNaN(time)) return;
    
    currentSimulationTime = time;
    updateTimeDisplay(time);
    updateVehiclePositionsFromSlider(time);
}

/**
 * Update vehicle positions based on slider time
 * @param {number} time - Simulation time in seconds
 */
function updateVehiclePositionsFromSlider(time) {
    const sumoData = getSUMOData();
    if (!sumoData) {
        console.warn('[SUMO Time Slider] No SUMO data available');
        return;
    }
    
    const viewer = getViewer();
    if (!viewer) {
        console.warn('[SUMO Time Slider] No viewer available');
        return;
    }
    
    // Update vehicle positions
    updateVehiclePositions(time, sumoData.vehicles, sumoData.edgesMap, viewer);
    
    // Debug: log occasionally to verify updates are happening
    if (!updateVehiclePositionsFromSlider._lastLog || (time - updateVehiclePositionsFromSlider._lastLog) > 30) {
        console.log(`[SUMO Time Slider] Updated to time ${time.toFixed(1)}s`);
        updateVehiclePositionsFromSlider._lastLog = time;
    }
}

/**
 * Toggle play/pause
 */
function togglePlayPause() {
    isPlaying = !isPlaying;
    
    if (playPauseBtn) {
        if (isPlaying) {
            playPauseBtn.textContent = '⏸ Pause';
            playPauseBtn.classList.remove('pause');
            startAnimation();
        } else {
            playPauseBtn.textContent = '▶ Play';
            playPauseBtn.classList.add('pause');
            stopAnimation();
        }
    }
}

/**
 * Start animation loop
 */
function startAnimation() {
    if (animationFrameId) {
        return; // Already animating
    }
    
    let lastTime = performance.now();
    
    function animate(currentTime) {
        if (!isPlaying) {
            animationFrameId = null;
            return;
        }
        
        const deltaTime = (currentTime - lastTime) / 1000; // Convert to seconds
        lastTime = currentTime;
        
        // Update simulation time based on playback speed
        const timeStep = deltaTime * playbackSpeed;
        currentSimulationTime = Math.min(
            sumoTimeRange.end,
            currentSimulationTime + timeStep
        );
        
        // Update slider and display
        if (timeRangeInput) {
            timeRangeInput.value = currentSimulationTime;
        }
        updateTimeDisplay(currentSimulationTime);
        updateVehiclePositionsFromSlider(currentSimulationTime);
        
        // Stop if we've reached the end
        if (currentSimulationTime >= sumoTimeRange.end) {
            isPlaying = false;
            if (playPauseBtn) {
                playPauseBtn.textContent = '▶ Play';
                playPauseBtn.classList.add('pause');
            }
            animationFrameId = null;
            return;
        }
        
        animationFrameId = requestAnimationFrame(animate);
    }
    
    animationFrameId = requestAnimationFrame(animate);
}

/**
 * Stop animation loop
 */
function stopAnimation() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
}

/**
 * Reset simulation to start
 */
function resetSimulation() {
    stopAnimation();
    isPlaying = false;
    currentSimulationTime = sumoTimeRange.start;
    
    if (timeRangeInput) {
        timeRangeInput.value = currentSimulationTime;
    }
    updateTimeDisplay(currentSimulationTime);
    updateVehiclePositionsFromSlider(currentSimulationTime);
    
    if (playPauseBtn) {
        playPauseBtn.textContent = '▶ Play';
        playPauseBtn.classList.add('pause');
    }
}

/**
 * Toggle playback speed (1x -> 2x -> 4x -> 1x)
 */
function toggleSpeed() {
    playbackSpeed = playbackSpeed * 2;
    if (playbackSpeed > 4) {
        playbackSpeed = 1;
    }
    
    if (speedBtn) {
        speedBtn.textContent = `${playbackSpeed}x`;
    }
}

/**
 * Hide the SUMO time slider
 */
export function hideSUMOTimeSlider() {
    if (sliderElement) {
        sliderElement.classList.remove('visible');
    }
    stopAnimation();
    isPlaying = false;
}

/**
 * Show the SUMO time slider
 */
export function showSUMOTimeSlider() {
    if (sliderElement) {
        sliderElement.classList.add('visible');
    }
}

/**
 * Get current simulation time
 * @returns {number} Current time in seconds
 */
export function getCurrentSUMOTime() {
    return currentSimulationTime;
}

/**
 * Set simulation time programmatically
 * @param {number} time - Time in seconds
 */
export function setSUMOTime(time) {
    if (!sumoTimeRange) {
        return;
    }
    
    currentSimulationTime = Math.max(
        sumoTimeRange.start,
        Math.min(sumoTimeRange.end, time)
    );
    
    if (timeRangeInput) {
        timeRangeInput.value = currentSimulationTime;
    }
    updateTimeDisplay(currentSimulationTime);
    updateVehiclePositionsFromSlider(currentSimulationTime);
}

