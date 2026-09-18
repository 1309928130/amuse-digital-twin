/**
 * Plotting.
 *
 * The chart builders behind the "Plot your data" block on the Tools page. They
 * are plain element factories rather than a page: the charts sit inside the tools
 * page like any other block, so they need no root element, no navigation hooks and
 * no show/hide lifecycle.
 *
 * ## Everything here is a placeholder
 *
 * The three panels describe the charts that are intended — an XY plot, a radar
 * plot, and a sortable table — but none of them read real data yet. Each is drawn
 * with fixed sample values so the layout can be reviewed before the work of
 * wiring it up is committed to. The block says so rather than implying the charts
 * are live, because a chart that looks real but shows invented numbers is the
 * most misleading thing a viewer can render.
 *
 * The charts are hand-drawn SVG rather than a charting library. A library would
 * give more chart types for less code, but it would be another vendored
 * dependency to keep in step, for three charts whose requirements are known.
 */

/** Palette shared with the map layers, so a series keeps its colour across views. */
const SERIES = {
    a: '#4ec9a0',
    b: '#e0a44a',
    c: '#8ab4f8',
    d: '#e29090',
};

/** Placeholder XY series. Invented values, clearly labelled as such on the page. */
const SAMPLE_XY = (() => {
    const points = [];
    for (let i = 0; i <= 24; i += 1) {
        // Two series with deliberately different shapes: one rising and falling
        // through the day, one falling and recovering. Overlapping curves would
        // hide what the chart is able to show, which is the one thing a
        // placeholder is for. The variation keeps the lines from reading as axis
        // decoration.
        const t = i / 24;
        const wobble = Math.sin(i * 1.7) * 0.03;
        points.push({
            x: i,
            a: 0.42 + 0.44 * Math.sin(t * Math.PI * 1.1) + wobble,
            b: 0.74 - 0.34 * Math.sin(t * Math.PI * 1.35) + wobble,
        });
    }
    return points;
})();

/** Placeholder radar axes and series. */
const SAMPLE_RADAR = {
    axes: ['Sunlight', 'Wind', 'Heat', 'Pollution', 'Flow', 'Visibility'],
    series: [
        { label: 'Proposal 1', color: SERIES.a, values: [0.72, 0.41, 0.63, 0.35, 0.81, 0.68] },
        { label: 'Proposal 2', color: SERIES.b, values: [0.58, 0.67, 0.44, 0.72, 0.5, 0.6] },
    ],
};

/** Placeholder table rows. */
const SAMPLE_TABLE = [
    { id: 1, quality: 'Sunlight', value: 0.72, unit: 'fraction', proposal: 'Proposal 1' },
    { id: 2, quality: 'Wind speed', value: 2.77, unit: 'm/s', proposal: 'Proposal 1' },
    { id: 3, quality: 'Pollution', value: 0.41, unit: 'index', proposal: 'Proposal 1' },
    { id: 4, quality: 'Urban heat', value: 31.4, unit: '°C', proposal: 'Proposal 1' },
    { id: 5, quality: 'Pedestrian flow', value: 8420, unit: 'ped/day', proposal: 'Proposal 1' },
    { id: 6, quality: 'Visibility', value: 0.68, unit: 'index', proposal: 'Proposal 1' },
    { id: 7, quality: 'Sunlight', value: 0.58, unit: 'fraction', proposal: 'Proposal 2' },
    { id: 8, quality: 'Wind speed', value: 3.42, unit: 'm/s', proposal: 'Proposal 2' },
];

/**
 * Rows rendered before the table stops and asks.
 *
 * Rendering every row is what makes a data table freeze a browser, and the
 * failure is invisible until someone opens a large file on a weak machine. A cap
 * with an explicit "show more" keeps the cost bounded and, more importantly,
 * makes the truncation visible instead of silent.
 */
const TABLE_PAGE_SIZE = 200;

/** Rows currently rendered in the table. Distinct from the cap for that reason. */
let tableRowLimit = TABLE_PAGE_SIZE;

/** Which column the placeholder table is sorted by, and which way. */
let tableSort = { column: 'quality', ascending: true };

/**
 * Build one panel, with a consistent heading, note and body across the three.
 *
 * Shared so the three charts cannot drift into different title sizes or spacing,
 * the same reason the Tools page has a single block builder.
 *
 * @param {{id: string, title: string, format: string, note: string}} panel
 */
function buildPanel(panel) {
    const section = document.createElement('section');
    section.className = 'plot-panel';
    section.dataset.panel = panel.id;

    const head = document.createElement('div');
    head.className = 'plot-panel-head';

    const title = document.createElement('h3');
    title.className = 'plot-panel-title';
    title.textContent = panel.title;
    head.appendChild(title);

    const badge = document.createElement('span');
    badge.className = 'tool-badge tool-badge-planned';
    badge.textContent = 'Placeholder';
    head.appendChild(badge);

    section.appendChild(head);

    const note = document.createElement('p');
    note.className = 'plot-panel-note';
    note.textContent = panel.note;
    section.appendChild(note);

    const format = document.createElement('p');
    format.className = 'plot-panel-format';
    format.textContent = panel.format;
    section.appendChild(format);

    const body = document.createElement('div');
    body.className = 'plot-panel-body';
    section.appendChild(body);

    return { section, body };
}

/** SVG element helper, so the chart builders read as structure not boilerplate. */
function svgEl(name, attrs = {}) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, String(value)));
    return el;
}

/**
 * The placeholder XY plot: a line per series over a labelled grid.
 *
 * Dimensions are in SVG user units and scaled by the viewBox, so the chart stays
 * crisp on any display without measuring the container.
 */
function buildXyChart() {
    const W = 640;
    const H = 300;
    const pad = { top: 18, right: 18, bottom: 34, left: 44 };

    const svg = svgEl('svg', {
        class: 'plot-svg',
        viewBox: `0 0 ${W} ${H}`,
        role: 'img',
        'aria-label': 'Placeholder line chart of two assessment series over time',
    });

    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    // Grid and value axis: 0.0 to 1.0 is a plausible normalised range.
    for (let tick = 0; tick <= 4; tick += 1) {
        const value = tick / 4;
        const y = pad.top + plotH * (1 - value);
        svg.appendChild(
            svgEl('line', {
                x1: pad.left,
                y1: y,
                x2: W - pad.right,
                y2: y,
                class: 'plot-grid',
            })
        );
        const label = svgEl('text', {
            x: pad.left - 8,
            y: y + 4,
            class: 'plot-axis-label',
            'text-anchor': 'end',
        });
        label.textContent = value.toFixed(2);
        svg.appendChild(label);
    }

    // Hour axis: label every sixth hour so the ticks do not collide.
    SAMPLE_XY.forEach((point) => {
        if (point.x % 6 !== 0) return;
        const x = pad.left + (point.x / 24) * plotW;
        const label = svgEl('text', {
            x,
            y: H - pad.bottom + 18,
            class: 'plot-axis-label',
            'text-anchor': 'middle',
        });
        label.textContent = `${String(point.x).padStart(2, '0')}:00`;
        svg.appendChild(label);
    });

    const seriesFor = (key) =>
        SAMPLE_XY.map((point) => {
            const x = pad.left + (point.x / 24) * plotW;
            const y = pad.top + plotH * (1 - point[key]);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');

    Object.entries({ a: SERIES.a, b: SERIES.b }).forEach(([key, color]) => {
        svg.appendChild(
            svgEl('polyline', { points: seriesFor(key), fill: 'none', stroke: color, 'stroke-width': 2 })
        );
    });

    // Axis titles, so the placeholder says what the real chart would show.
    const xTitle = svgEl('text', {
        x: pad.left + plotW / 2,
        y: H - 4,
        class: 'plot-axis-title',
        'text-anchor': 'middle',
    });
    xTitle.textContent = 'Hour of day';
    svg.appendChild(xTitle);

    return svg;
}

/**
 * The placeholder radar plot: one closed polygon per series across shared axes.
 *
 * Drawn with the same viewBox approach as the XY chart. Values are normalised to
 * the outer ring, which is what a radar plot does by definition.
 */
function buildRadarChart() {
    const W = 360;
    const H = 320;
    const cx = W / 2;
    const cy = H / 2 + 6;
    const radius = 118;

    const svg = svgEl('svg', {
        class: 'plot-svg',
        viewBox: `0 0 ${W} ${H}`,
        role: 'img',
        'aria-label': 'Placeholder radar chart comparing two proposals across six qualities',
    });

    const { axes, series } = SAMPLE_RADAR;
    const angleFor = (i) => (i / axes.length) * Math.PI * 2 - Math.PI / 2;

    // Concentric rings, so a value can be read off by proportion.
    [0.25, 0.5, 0.75, 1].forEach((ring) => {
        svg.appendChild(
            svgEl('circle', {
                cx,
                cy,
                r: radius * ring,
                class: ring === 1 ? 'plot-radar-ring-outer' : 'plot-radar-ring',
            })
        );
    });

    // Spokes and axis labels.
    axes.forEach((axis, i) => {
        const angle = angleFor(i);
        svg.appendChild(
            svgEl('line', {
                x1: cx,
                y1: cy,
                x2: cx + Math.cos(angle) * radius,
                y2: cy + Math.sin(angle) * radius,
                class: 'plot-radar-spoke',
            })
        );
        const label = svgEl('text', {
            x: cx + Math.cos(angle) * (radius + 18),
            y: cy + Math.sin(angle) * (radius + 18) + 4,
            class: 'plot-axis-label',
            'text-anchor': Math.abs(Math.cos(angle)) < 0.3 ? 'middle' : Math.cos(angle) > 0 ? 'start' : 'end',
        });
        label.textContent = axis;
        svg.appendChild(label);
    });

    series.forEach((entry) => {
        const points = entry.values
            .map((value, i) => {
                const angle = angleFor(i);
                const r = radius * Math.max(0, Math.min(1, value));
                return `${(cx + Math.cos(angle) * r).toFixed(1)},${(cy + Math.sin(angle) * r).toFixed(1)}`;
            })
            .join(' ');
        svg.appendChild(
            svgEl('polygon', {
                points,
                fill: entry.color,
                'fill-opacity': 0.16,
                stroke: entry.color,
                'stroke-width': 2,
            })
        );
    });

    return svg;
}

/** The legend shared by the charts, naming the two placeholder series. */
function buildLegend() {
    const wrap = document.createElement('div');
    wrap.className = 'plot-legend';

    Object.entries({ 'Series A': SERIES.a, 'Series B': SERIES.b }).forEach(([label, color]) => {
        const item = document.createElement('span');
        item.className = 'plot-legend-item';

        const swatch = document.createElement('span');
        swatch.className = 'plot-legend-swatch';
        swatch.style.background = color;
        item.appendChild(swatch);

        const text = document.createElement('span');
        text.textContent = label;
        item.appendChild(text);

        wrap.appendChild(item);
    });

    return wrap;
}

/**
 * The placeholder table, sortable, with a render cap.
 *
 * Sorting works here even though the data is invented, because the sort control
 * is the part whose behaviour is worth agreeing on before the real table is
 * built — and it costs nothing, since the placeholder rows are real objects.
 */
function buildTablePanel(body) {
    const sorted = [...SAMPLE_TABLE].sort((a, b) => {
        const left = a[tableSort.column];
        const right = b[tableSort.column];
        const comparison =
            typeof left === 'number' && typeof right === 'number'
                ? left - right
                : String(left).localeCompare(String(right));
        return tableSort.ascending ? comparison : -comparison;
    });

    const shown = sorted.slice(0, tableRowLimit);

    const wrap = document.createElement('div');
    wrap.className = 'plot-table-wrap';

    const table = document.createElement('table');
    table.className = 'plot-table';

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['quality', 'value', 'unit', 'proposal'].forEach((column) => {
        const th = document.createElement('th');
        th.scope = 'col';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'plot-sort';
        button.textContent = column;
        button.setAttribute('aria-sort',
            tableSort.column === column
                ? tableSort.ascending
                    ? 'ascending'
                    : 'descending'
                : 'none'
        );
        if (tableSort.column === column) button.classList.add('is-active');

        button.addEventListener('click', () => {
            // Clicking the active column flips the direction; a new column
            // starts ascending, which is the least surprising default.
            if (tableSort.column === column) {
                tableSort = { column, ascending: !tableSort.ascending };
            } else {
                tableSort = { column, ascending: true };
            }
            render();
        });

        th.appendChild(button);
        headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);

    const tbody = document.createElement('tbody');
    shown.forEach((row) => {
        const tr = document.createElement('tr');
        [row.quality, row.value, row.unit, row.proposal].forEach((value) => {
            const td = document.createElement('td');
            td.textContent = String(value);
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    body.appendChild(wrap);

    const footer = document.createElement('div');
    footer.className = 'plot-table-footer';

    const count = document.createElement('span');
    count.className = 'plot-table-count';
    count.textContent =
        sorted.length > shown.length
            ? `Showing ${shown.length} of ${sorted.length} rows.`
            : `Showing all ${sorted.length} rows.`;
    footer.appendChild(count);

    if (sorted.length > shown.length) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'tools-btn';
        more.textContent = 'Show more';
        more.addEventListener('click', () => {
            tableRowLimit += TABLE_PAGE_SIZE;
            render();
        });
        footer.appendChild(more);
    }

    body.appendChild(footer);
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

/**
 * The placeholder notice.
 *
 * Exported separately from the charts so the caller can place it above them. It
 * has to come before anything chart-shaped: a reader who glances at a plot and
 * moves on should have already seen that the numbers are invented.
 *
 * @returns {HTMLElement}
 */
export function buildPlotWarning() {
    const warning = document.createElement('p');
    warning.className = 'tools-note plot-warning';
    warning.textContent =
        'Not built yet. The charts below are drawn from fixed sample values so the layout ' +
        'can be reviewed; they do not read your results, and the numbers are not ' +
        'measurements of anything.';
    return warning;
}

/**
 * The three chart panels, ready to append.
 *
 * Returned as a fragment rather than a wrapper element: the Tools page already
 * provides the block's body, and an extra div between them would be an element
 * existing only to be styled around.
 *
 * @returns {DocumentFragment}
 */
export function buildPlotPanels() {
    const frag = document.createDocumentFragment();

    frag.appendChild(buildLegend());

    const xy = buildPanel({
        id: 'xy',
        title: 'XY plot',
        format: 'Line or scatter, one series per column',
        note:
            'For anything measured over a continuous axis — an hour of the day, a distance, ' +
            'a temperature. The sample shows two series over 24 hours.',
    });
    xy.body.appendChild(buildXyChart());
    frag.appendChild(xy.section);

    const radar = buildPanel({
        id: 'radar',
        title: 'Radar plot',
        format: 'One polygon per proposal across shared axes',
        note:
            'For comparing proposals across several qualities at once, where the shape ' +
            'matters more than any single number.',
    });
    radar.body.appendChild(buildRadarChart());
    frag.appendChild(radar.section);

    const table = buildPanel({
        id: 'table',
        title: 'Table',
        format: 'Sortable columns, capped row count',
        note:
            'For reading exact values. Rows are rendered in pages so a large result cannot ' +
            'freeze the browser, and the cap is shown rather than applied silently.',
    });
    buildTablePanel(table.body);
    frag.appendChild(table.section);

    return frag;
}
