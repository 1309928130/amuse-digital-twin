/**
 * Case studies: the design-proposal picker.
 *
 * This page is not a place on the map but a choice between studies, so it takes
 * over the viewport the same way the document view does. The card grid is built
 * from `PROPOSALS` in `pageConfig.js`, which is the single source of truth for
 * what proposals exist and which of them has data behind it.
 *
 * Selecting a card publishes the choice on `#caseStudyState`, where the page
 * controller reads it when applying a page's layers. Only one proposal has
 * assessment data today, so a selection that cannot be honoured is reported
 * back to the user rather than silently rendering the default study's results
 * under another proposal's name.
 */

import { PROPOSALS, DEFAULT_PROPOSAL_ID, resolveStudy, getCaseStudyPages } from './pageConfig.js';

/** Currently requested study id (may name a proposal with no data). */
let requestedId = DEFAULT_PROPOSAL_ID;

/** Callback invoked with the resolved study whenever the selection changes. */
let onStudyChange = null;

/** Callback invoked when a quality-page card is clicked. */
let onOpenPage = null;

/**
 * Build one proposal card.
 *
 * Uses a real `<button>` so the card is focusable and announced as a control;
 * `aria-pressed` carries the selected state for assistive tech.
 *
 * @param {import('./pageConfig.js').ProposalDef} proposal
 * @returns {HTMLButtonElement}
 */
function buildCard(proposal) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'case-card';
    card.dataset.proposalId = proposal.id;

    const thumb = document.createElement('div');
    thumb.className = 'case-thumb';

    const img = document.createElement('img');
    img.src = proposal.thumbnail;
    img.alt = `${proposal.label} — aerial view of the design proposal`;
    img.loading = 'lazy';
    thumb.appendChild(img);

    // Say plainly which study actually has results behind it.
    const badge = document.createElement('span');
    badge.className = proposal.hasData ? 'case-badge' : 'case-badge is-empty';
    badge.textContent = proposal.hasData ? 'Data available' : 'No data yet';
    thumb.appendChild(badge);

    const meta = document.createElement('div');
    meta.className = 'case-meta';

    const name = document.createElement('div');
    name.className = 'case-name';
    name.textContent = proposal.label;

    const note = document.createElement('div');
    note.className = 'case-note';
    note.textContent = proposal.note;

    meta.append(name, note);
    card.append(thumb, meta);
    return card;
}

/**
 * Build one quality-page card.
 *
 * A real `<button>` for keyboard and screen-reader support, with the snapshot
 * as the main affordance so the card reads as "go here" rather than as a label.
 *
 * @param {ReturnType<typeof getCaseStudyPages>[number]} page
 * @returns {HTMLButtonElement}
 */
function buildPageCard(page) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'page-card';
    card.dataset.pageId = page.id;

    const thumb = document.createElement('div');
    thumb.className = 'page-thumb';

    const img = document.createElement('img');
    img.src = page.thumbnail;
    img.alt = `${page.label} — snapshot of the assessment view`;
    // Eager: these are the point of the page, and lazy loading inside a
    // scrollable overlay can leave them blank until the user scrolls.
    img.loading = 'eager';
    // A missing snapshot should not leave a broken-image icon in the grid.
    img.addEventListener('error', () => {
        thumb.classList.add('is-missing');
        img.remove();
    });
    thumb.appendChild(img);

    if (page.placeholder) {
        const badge = document.createElement('span');
        badge.className = 'page-badge is-empty';
        badge.textContent = 'No data yet';
        thumb.appendChild(badge);
    }

    const meta = document.createElement('div');
    meta.className = 'page-meta';

    const name = document.createElement('div');
    name.className = 'page-name';
    name.textContent = page.label;

    const hint = document.createElement('div');
    hint.className = 'page-hint';
    hint.textContent = page.group;

    meta.append(name, hint);
    card.append(thumb, meta);
    return card;
}

/**
 * Build the drill-down grid of quality pages.
 *
 * Built once: the set of assessment pages is fixed, and only the selected
 * proposal changes, which `render()` handles.
 */
function buildPageGrid() {
    const grid = document.getElementById('casesPages');
    if (!grid || grid.dataset.wired) return;

    getCaseStudyPages().forEach((page) => grid.appendChild(buildPageCard(page)));

    grid.addEventListener('click', (event) => {
        const card = event.target.closest('.page-card');
        if (!card || !onOpenPage) return;
        onOpenPage(card.dataset.pageId);
    });

    grid.dataset.wired = 'true';
}

/**
 * Update the pressed state, the footer explanation, and any active-study
 * labels in the DOM.
 */
function render() {
    const grid = document.getElementById('casesGrid');
    if (!grid) return;

    const study = resolveStudy(requestedId);

    grid.querySelectorAll('.case-card').forEach((card) => {
        const isActive = card.dataset.proposalId === study.requested;
        card.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });

    const proposal = PROPOSALS.find((p) => p.id === study.requested);
    const foot = document.getElementById('casesFoot');
    if (foot) {
        if (study.substituted) {
            // Be explicit about the substitution: the user asked for a study
            // with no results, and the pages are still showing another one.
            const effective = PROPOSALS.find((p) => p.id === study.effective);
            foot.innerHTML =
                `<b>${proposal ? proposal.label : study.requested}</b> has no assessment data yet, ` +
                `so the pages above still show <b>${effective ? effective.label : study.effective}</b>. ` +
                'Add results under <code>simulation_data/' +
                `${study.requested}/</code> and they will be picked up here.`;
        } else {
            foot.innerHTML =
                `<b>${proposal ? proposal.label : study.effective}</b> is the active study. ` +
                'Every assessment page reads its datasets.';
        }
    }

    // Expose the active study where other modules can read it, and echo it into
    // the right-panel section that stays visible on this page.
    const state = document.getElementById('caseStudyState');
    if (state) {
        state.dataset.requested = study.requested;
        state.dataset.effective = study.effective;
        state.dataset.substituted = String(study.substituted);
    }

    const activeLabel = document.getElementById('caseStudyActive');
    if (activeLabel) {
        const effective = PROPOSALS.find((p) => p.id === study.effective);
        activeLabel.textContent = effective ? effective.label : study.effective;
        activeLabel.dataset.substituted = String(study.substituted);
    }

    // Reveal the drill-down only once a proposal is chosen, and name that
    // proposal in the heading so it is clear which study's pages are listed.
    const drill = document.getElementById('casesDrill');
    if (drill) {
        drill.hidden = !study.requested;
        const drillLabel = document.getElementById('casesDrillName');
        if (drillLabel) {
            drillLabel.textContent = proposal ? proposal.label : study.requested;
        }
    }

    if (onStudyChange) onStudyChange(study);
}

/**
 * Initialise the picker.
 *
 * Idempotent: the grids are only built once, so repeated page visits do not
 * duplicate cards or re-register listeners.
 *
 * @param {{
 *   onStudyChange?: (study: {requested: string, effective: string, substituted: boolean}) => void,
 *   onOpenPage?: (pageId: string) => void
 * }} [options]
 */
export function initializeCaseStudies(options = {}) {
    onStudyChange = options.onStudyChange || null;
    onOpenPage = options.onOpenPage || null;

    const grid = document.getElementById('casesGrid');
    if (!grid) return;

    if (!grid.dataset.wired) {
        PROPOSALS.forEach((proposal) => grid.appendChild(buildCard(proposal)));

        grid.addEventListener('click', (event) => {
            const card = event.target.closest('.case-card');
            if (!card) return;
            requestedId = card.dataset.proposalId;
            render();
        });

        grid.dataset.wired = 'true';
    }

    buildPageGrid();
    render();
}

/**
 * The study id that should actually be read when loading data.
 *
 * Exported for the per-proposal data loading that comes next: when each
 * proposal has its own results, the modules that fetch simulation data call
 * this to decide which folder to read from, so the fallback rule stays in one
 * place instead of being re-derived per module.
 *
 * @returns {string}
 */
export function getActiveStudyId() {
    return resolveStudy(requestedId).effective;
}

/**
 * The study id the user asked for, which may not be the one being shown.
 *
 * Distinct from {@link getActiveStudyId} so the UI can explain the difference
 * when a selection has no data behind it.
 *
 * @returns {string}
 */
export function getRequestedStudyId() {
    return requestedId;
}

/**
 * Programmatically select a study (used to restore a saved selection).
 * @param {string} id
 */
export function setActiveStudy(id) {
    requestedId = id;
    render();
}

/**
 * Show or hide the picker.
 * @param {boolean} visible
 */
export function setCaseStudiesVisible(visible) {
    const section = document.getElementById('caseStudies');
    if (section) section.hidden = !visible;
}
