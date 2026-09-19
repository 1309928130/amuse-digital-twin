/**
 * Hour-of-day controls for the macroscopic pedestrian flow network.
 *
 * Three controls, all driving the same thing -- which hour the flow layer is
 * coloured by:
 *
 *  - a slider from 00:00 to 23:00, plus an "All day" position that restores the
 *    daily totals the page showed before this existed;
 *  - a Play button that steps through the 24 hours on a loop, so the day can be
 *    watched rather than scrubbed;
 *  - a 24-bar chart of the network total, with the current hour marked, which
 *    gives the slider somewhere to point -- without it a reader sees colours
 *    change but cannot tell a peak from a lull.
 *
 * ## Why the slider has 25 positions
 *
 * The range runs 0-24, with 24 meaning "All day" rather than an hour that does
 * not exist. A separate checkbox would be more explicit, but it would also add a
 * second control for one boolean, and the reviewer asked for a slider. The
 * end-stop is labelled, and the Reset button returns to it, so the position is
 * discoverable rather than a secret state.
 *
 * ## Why the chart is hand-drawn SVG
 *
 * The panel already draws its legends as inline markup rather than pulling in a
 * charting library, and a 24-bar series is simple enough that a library would be
 * more code than the bars themselves. It also has to inherit the panel's light
 * and dark themes, which is easier when the colours are set from CSS variables.
 */

import {
    applyHour,
    networkHourTotals,
    networkPeakHour,
    isNetworkFlowEnabled,
    HOUR_ALL_DAY,
} from './pedFlowVisualization.js';

/** Play interval, in milliseconds. Slow enough to read each hour's pattern. */
const PLAY_INTERVAL_MS = 900;

let hour = HOUR_ALL_DAY;
let playing = false;
let playTimer = null;
let wired = false;

/**
 * True when the panel's controls should be visible.
 *
 * Only the flow pages draw the network, so the controls are meaningless
 * elsewhere. Toggled from `pageController` as pages change.
 *
 * @param {boolean} show Whether to show the hour controls.
 */
export function setHourControlsVisible(show) {
    const range = document.getElementById('flowHourRange');
    const play = document.getElementById('flowHourPlay');
    const reset = document.getElementById('flowHourReset');
    for (const el of [range, play, reset]) {
        if (el) el.disabled = !show;
    }
    if (!show) stopPlaying();
}

/**
 * Wire the controls, once.
 *
 * Called from `initHourControls`, which the app runs after the DOM exists. All
 * three controls share one `setHour` path, so the slider, the Play loop and the
 * Reset button cannot disagree about what is displayed.
 */
function wire() {
    if (wired) return;
    wired = true;

    const range = document.getElementById('flowHourRange');
    const play = document.getElementById('flowHourPlay');
    const reset = document.getElementById('flowHourReset');

    if (range) {
        range.addEventListener('input', () => {
            // Dragging the slider takes over from Play: otherwise the loop would
            // fight the pointer and the value would snap back every 900 ms.
            stopPlaying();
            const raw = Number(range.value);
            setHour(raw >= 24 ? HOUR_ALL_DAY : raw);
        });
    }
    if (play) {
        play.addEventListener('click', () => {
            if (playing) stopPlaying();
            else startPlaying();
        });
    }
    if (reset) {
        reset.addEventListener('click', () => {
            stopPlaying();
            setHour(HOUR_ALL_DAY);
        });
    }
}

/** Begin stepping through the hours. Wraps from 23 back to 00. */
function startPlaying() {
    if (playing) return;
    playing = true;
    updatePlayButton();
    // Starting from "All day" would show one confusing frame before the first
    // tick, so the first hour is applied immediately.
    if (hour === HOUR_ALL_DAY) setHour(0, { fromPlay: true });
    playTimer = window.setInterval(() => {
        if (!isNetworkFlowEnabled()) {
            stopPlaying();
            return;
        }
        const next = hour === HOUR_ALL_DAY ? 0 : (hour + 1) % 24;
        setHour(next, { fromPlay: true });
    }, PLAY_INTERVAL_MS);
}

/** Stop the loop and reset the button's label. */
function stopPlaying() {
    if (playTimer !== null) {
        window.clearInterval(playTimer);
        playTimer = null;
    }
    if (playing) {
        playing = false;
        updatePlayButton();
    }
}

/** Reflect whether the loop is running, matching the app's other play buttons. */
function updatePlayButton() {
    const play = document.getElementById('flowHourPlay');
    if (!play) return;
    play.textContent = playing ? '❚❚ Pause' : '▶ Play';
    play.setAttribute('aria-pressed', playing ? 'true' : 'false');
}

/**
 * Show a given hour, updating the map and every control that reflects it.
 *
 * @param {number|string} next Hour 0-23, or `HOUR_ALL_DAY`.
 * @param {Object} [opts]
 * @param {boolean} [opts.fromPlay] Set when the Play loop is the caller, so the
 *   slider is moved without stopping the loop.
 */
export function setHour(next, opts = {}) {
    hour = next;
    const allDay = next === HOUR_ALL_DAY;

    const range = document.getElementById('flowHourRange');
    if (range) range.value = allDay ? '24' : String(next);

    const value = document.getElementById('flowHourValue');
    if (value) value.textContent = allDay ? 'All day' : `${String(next).padStart(2, '0')}:00`;

    const summary = isNetworkFlowEnabled() ? applyHour(next) : null;
    updateChart(allDay ? null : next, summary);
    if (!opts.fromPlay) updatePlayButton();
}

/**
 * Draw the 24-hour network profile, marking the hour on display.
 *
 * @param {number|null} marked Hour to mark, or null for the all-day view.
 * @param {Object|null} summary Result of `applyHour`, for the caption.
 */
function updateChart(marked, summary) {
    const bars = document.getElementById('flowHourChartBars');
    const marker = document.getElementById('flowHourChartMarker');
    const caption = document.getElementById('flowHourChartCaption');
    if (!bars) return;

    const totals = networkHourTotals();
    const max = Math.max(...totals, 1);
    const peak = networkPeakHour();

    // 240 units wide over 24 bars leaves 10 units each, with a 2-unit gap so the
    // bars stay distinct at this size.
    const step = 10;
    const barW = 7;
    const baseY = 46;
    const usableH = 42;

    let svg = '';
    for (let h = 0; h < 24; h++) {
        const t = totals[h] / max;
        const height = Math.max(t > 0 ? 1.5 : 0, t * usableH);
        const x = h * step + (step - barW) / 2;
        const y = baseY - height;
        const isMarked = marked === h;
        // Amber marks the hour being shown; the peak hour keeps a lighter tint
        // when it is not selected, so the two are distinguishable at once.
        const fill = isMarked ? '#FFD54F' : (h === peak ? 'rgba(255,213,79,0.42)' : 'rgba(255,255,255,0.30)');
        svg += `<rect x="${x}" y="${y.toFixed(1)}" width="${barW}" height="${height.toFixed(1)}" fill="${fill}" rx="1"></rect>`;
    }
    bars.innerHTML = svg;

    if (marker) {
        if (marked === null) {
            marker.style.display = 'none';
        } else {
            marker.style.display = '';
            const cx = marked * step + step / 2;
            marker.setAttribute('x1', String(cx));
            marker.setAttribute('x2', String(cx));
        }
    }

    if (caption) {
        const peakText = `busiest hour ${String(peak).padStart(2, '0')}:00`;
        if (marked === null) {
            const total = totals.reduce((a, b) => a + b, 0);
            caption.textContent = `Whole day: ${formatCompact(total)} ped. ${peakText}.`;
        } else {
            caption.textContent = `${String(marked).padStart(2, '0')}:00 — ${formatCompact(totals[marked])} ped/h network-wide. ${peakText}.`;
        }
    }
}

/**
 * Compact number formatting for the chart caption.
 *
 * @param {number} x Value.
 * @returns {string} e.g. `1.2M`, `54k`, `742`.
 */
function formatCompact(x) {
    if (!Number.isFinite(x)) return '—';
    if (Math.abs(x) >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
    if (Math.abs(x) >= 1e3) return `${(x / 1e3).toFixed(0)}k`;
    return x.toFixed(0);
}

/**
 * Prepare the controls for a freshly loaded flow layer.
 *
 * Resets to the all-day view, which is what the page showed before the hour
 * control existed, and redraws the chart now that totals are available.
 */
export function resetHourControls() {
    wire();
    stopPlaying();
    hour = HOUR_ALL_DAY;
    setHour(HOUR_ALL_DAY);
}

/** Stop any running loop. Called when leaving the flow pages. */
export function disposeHourControls() {
    stopPlaying();
}
