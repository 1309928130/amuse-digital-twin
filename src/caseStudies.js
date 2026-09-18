/**
 * Case studies: the design-proposal picker.
 *
 * This page is not a place on the map but a choice between studies, so it takes
 * over the viewport the same way the document view does. The card grid is built
 * from `dataRegistry.getStudyList()`, which combines the built-in `PROPOSALS`
 * from `pageConfig.js` with any proposal the visitor added on the Tools page, and
 * is therefore the single source of truth for what proposals exist and which of
 * them has data behind it.
 *
 * Selecting a card publishes the choice on `#caseStudyState`, where the page
 * controller reads it when applying a page's layers. Only Proposal 1 and any
 * proposal with uploads have data, so a selection that cannot be honoured is
 * reported back to the user rather than silently rendering the default study's
 * results under another proposal's name.
 */

import { PROPOSALS, DEFAULT_PROPOSAL_ID, resolveStudy, getCaseStudyPages } from './pageConfig.js';
import { onDataRegistryChange } from './dataRegistry.js';
/** Currently requested study id (may name a proposal with no data). */
let requestedId = DEFAULT_PROPOSAL_ID;

/** Proposal whose snapshots are currently in the drill-down grid. */
let renderedStudy = null;

/** Callback invoked with the resolved study whenever the selection changes. */
let onStudyChange = null;

/** Callback invoked when a quality-page card is clicked. */
let onOpenPage = null;

/**
 * The proposals to show in the picker: the built-in three plus anything the
 * visitor added on the Tools page.
 *
 * A visitor-added proposal has no artwork of its own unless its author uploaded
 * some, in which case `thumbnail` is that image. With none, `thumbnail` is
 * `null` and the card renders an empty slot.
 *
 * It used to borrow the first proposal's picture, on the reasoning that a card
 * with a broken image reads as a bug. That was the wrong call: the picture in
 * this grid is a photograph of a *specific design*, so showing Proposal 1's
 * aerial view over a card labelled "Proposal X" states something false about
 * what the visitor is looking at. An empty slot is unmistakably "no image here"
 * where a borrowed one is mistaken for evidence. The name and the data badge
 * remain, so the card is still usable.
 *
 * @returns {Array<{id: string, label: string, note: string,
 *   thumbnail: string|null, hasData: boolean}>}
 */
function getCaseStudyProposals() {
    const registry = typeof window !== 'undefined' ? window.__dataRegistry : null;
    if (!registry) return PROPOSALS;

    const builtInIds = new Set(PROPOSALS.map((p) => p.id));

    return registry.getStudyList().map((study) => {
        if (builtInIds.has(study.id)) {
            const original = PROPOSALS.find((p) => p.id === study.id);
            return { ...original, hasData: registry.studyHasData(study.id) };
        }
        return {
            id: study.id,
            label: study.label,
            note: study.note,
            // The visitor's own image, or nothing. Never someone else's.
            thumbnail: registry.getProposalImage(study.id) || null,
            hasData: registry.studyHasData(study.id),
        };
    });
}

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

    if (proposal.thumbnail) {
        const img = document.createElement('img');
        img.src = proposal.thumbnail;
        img.alt = `${proposal.label} — view of the design proposal`;
        img.loading = 'lazy';
        // A stored image can be dropped by the browser (storage cleared, or a
        // quota eviction), so a broken source falls back to the same empty slot
        // as having no image at all rather than showing a broken-image icon.
        img.addEventListener('error', () => {
            img.remove();
            thumb.classList.add('is-missing');
        });
        thumb.appendChild(img);
    } else {
        // No image for this proposal. The card still names it and still says
        // whether it has results, which is what the picker is for.
        thumb.classList.add('is-missing');
    }

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

    if (page.thumbnail) {
        const img = document.createElement('img');
        img.src = page.thumbnail;
        img.alt = `${page.label} — snapshot of the assessment view`;
        // Eager: these are the point of the page, and lazy loading inside a
        // scrollable overlay can leave them blank until the user scrolls.
        img.loading = 'eager';
        // No snapshot for this proposal: fall back to the empty slot rather
        // than leaving a broken-image icon in the grid.
        img.addEventListener('error', () => {
            img.remove();
            thumb.classList.add('is-missing');
        });
        thumb.appendChild(img);
    } else {
        // No capture exists for this proposal. The card stays — the page is
        // still part of the workflow — but it reads as empty, not as another
        // proposal's result.
        thumb.classList.add('is-missing');
        card.classList.add('is-empty');
    }

    if (!page.thumbnail || page.placeholder) {
        const badge = document.createElement('span');
        badge.className = 'page-badge is-empty';
        badge.textContent = page.thumbnail ? 'No data yet' : 'Not run yet';
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
 * Build the drill-down grid of quality pages for one proposal.
 *
 * Rebuilt on every proposal change: the snapshots are per proposal, so the
 * grid cannot be built once and reused. The click listener lives on the grid
 * itself, which survives the rebuild, so it is bound only once.
 *
 * @param {string} studyId Proposal whose snapshots to show.
 */
function buildPageGrid(studyId) {
    const grid = document.getElementById('casesPages');
    if (!grid) return;

    grid.replaceChildren(...getCaseStudyPages(studyId).map(buildPageCard));

    if (!grid.dataset.wired) {
        grid.addEventListener('click', (event) => {
            const card = event.target.closest('.page-card');
            if (!card || !onOpenPage) return;
            onOpenPage(card.dataset.pageId);
        });
        grid.dataset.wired = 'true';
    }
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

    // Looked up across every study, not just the built-in ones, so the footer
    // can name a proposal the visitor added by upload.
    const proposal = getCaseStudyProposals().find((p) => p.id === study.requested);
    const label = proposal ? proposal.label : study.requested;
    const foot = document.getElementById('casesFoot');
    if (foot) {
        if (study.substituted) {
            // Honest about what is on screen: the picker selection stands, but
            // the assessment pages behind it have no results of their own yet.
            foot.innerHTML =
                `<b>${label}</b> has no assessment data yet, ` +
                'so the pages above are empty rather than showing another proposal’s results. ' +
                'Add results to it on the <b>Tools</b> page, or run the assessments and add ' +
                'them under <code>simulation_data/' +
                `${study.requested}/</code> to fill them in.`;
        } else {
            foot.innerHTML =
                `<b>${label}</b> is the active study. ` +
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
        // Name the *requested* proposal, not the effective study. The cards
        // beside this label show that proposal's own snapshots — empty when it
        // has no results — so echoing "Proposal 1" here would contradict them.
        activeLabel.textContent = proposal ? proposal.label : study.requested;
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

    // Snapshots belong to the selected proposal, so the grid is rebuilt rather
    // than re-labelled. Keyed on the requested study, not the effective one:
    // a proposal with no data must show empty slots, not Proposal 1's results.
    if (study.requested !== renderedStudy) {
        buildPageGrid(study.requested);
        renderedStudy = study.requested;
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

    // The listener is attached once, but the cards are rebuilt on every change
    // to the registry: a proposal added on the Tools page has to appear here, and
    // so does the "Data available" badge once its first file is uploaded.
    if (!grid.dataset.wired) {
        grid.addEventListener('click', (event) => {
            const card = event.target.closest('.case-card');
            if (!card) return;
            requestedId = card.dataset.proposalId;
            render();
        });
        grid.dataset.wired = 'true';

        onDataRegistryChange(() => {
            // A study may have been removed while it was the requested one, in
            // which case fall back rather than render a study that is gone.
            const ids = getCaseStudyProposals().map((p) => p.id);
            if (!ids.includes(requestedId)) requestedId = DEFAULT_PROPOSAL_ID;
            rebuildPicker();
            render();
        });
    }

    rebuildPicker();
    renderedStudy = null;
    render();
}

/** Replace every proposal card with the current study list. */
function rebuildPicker() {
    const grid = document.getElementById('casesGrid');
    if (!grid) return;
    grid.innerHTML = '';
    getCaseStudyProposals().forEach((proposal) => grid.appendChild(buildCard(proposal)));
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
 * Select a proposal, scroll its card into view, and draw attention to it.
 *
 * Used by the "Show the proposal" button on the Tools page, which exists because
 * a proposal's results and its presentation in the case-studies picker are two
 * different places in the app and there was no way to get from one to the other.
 * Landing on the page without the card being visible would leave the visitor to
 * hunt for the proposal they just asked to see, so the card is scrolled to and
 * briefly outlined.
 *
 * @param {string} id
 */
export function revealProposal(id) {
    setActiveStudy(id);

    const grid = document.getElementById('casesGrid');
    if (!grid) return;

    const card = grid.querySelector(`.case-card[data-proposal-id="${CSS.escape(id)}"]`);
    if (!card) return;

    card.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // A transient class rather than a persistent one: the pressed state already
    // marks the card as selected, and this is only to catch the eye during the
    // movement caused by the scroll above.
    card.classList.add('is-revealed');
    window.setTimeout(() => card.classList.remove('is-revealed'), 1600);
}

/**
 * Show or hide the picker.
 * @param {boolean} visible
 */
export function setCaseStudiesVisible(visible) {
    const section = document.getElementById('caseStudies');
    if (section) section.hidden = !visible;
}
