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
 * Which arrangement to render: the original card grid, or the row bands.
 *
 * `'rows'` puts each proposal and its snapshots together in one band and shows
 * every proposal at once; `'grid'` is the original three-up picker with a single
 * drill-down below.
 *
 * The default depends on the screen. A wide screen has room for three proposal
 * cards side by side and a drill-down below them, and the reader can take in the
 * whole picker at once; a phone cannot, so the row layout — where each proposal
 * is a self-contained band read in sequence — is the sensible starting point
 * there. The chosen layout is then remembered, so an explicit choice always
 * outweighs the device default rather than being reset on the next visit.
 */
const LAYOUT_KEY = 'casesLayout';

/** Width at or below which the row layout is the default. Matches the phone
 *  breakpoint used for the panel and the case-studies styles, so the layout
 *  switch and the CSS agree on what counts as a small screen. */
const PHONE_MAX_WIDTH = 720;

let layout = 'grid';
/** True once a layout has been explicitly chosen, which suppresses the default. */
let layoutChosen = false;

/** The layout a screen of this width should start in. */
function defaultLayoutFor(width) {
    return width <= PHONE_MAX_WIDTH ? 'rows' : 'grid';
}

function loadLayout() {
    try {
        const saved = sessionStorage.getItem(LAYOUT_KEY);
        if (saved === 'rows' || saved === 'grid') {
            layout = saved;
            layoutChosen = true;
            return;
        }
    } catch (_) {
        // Private mode or storage disabled: fall through to the device default.
    }
    layout = defaultLayoutFor(window.innerWidth);
}

function saveLayout() {
    try {
        sessionStorage.setItem(LAYOUT_KEY, layout);
    } catch (_) {
        // Non-fatal: the choice simply does not survive a reload.
    }
}
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
    // The contents list points here in the grid layout, where there are no row
    // bands. Assigning it in both layouts is what lets one contents list serve
    // either arrangement without knowing which is showing.
    card.id = anchorFor(proposal.id);

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
 * DOM id for a proposal's element, in whichever layout is showing.
 *
 * One place so the contents list and the rendered markup cannot disagree: the
 * list was pointing at `proposal-proposal-1` while the band carried
 * `proposal-proposal-1` and the card carried nothing at all in the grid layout,
 * so the entry silently jumped nowhere.
 *
 * @param {string} studyId
 * @returns {string}
 */
function anchorFor(studyId) {
    return `proposal-${studyId}`;
}

/**
 * Build one proposal band: a full-width header row, then that proposal's
 * quality snapshots underneath.
 *
 * The header is the select button, so clicking anywhere along the row activates
 * the proposal, and the snapshots sit inside the same bordered box to make the
 * ownership obvious — the point of this layout is that a proposal and its
 * results are read as one unit.
 *
 * @param {ReturnType<typeof getCaseStudyProposals>[number]} proposal
 * @returns {HTMLElement}
 */
function buildRow(proposal) {
    const row = document.createElement('div');
    row.className = 'cases-row';
    row.dataset.proposalId = proposal.id;
    // Lets the right-panel contents list link straight to this band. Uses the
    // shared helper so the id matches what the list points at.
    row.id = anchorFor(proposal.id);

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'cases-row-head';
    head.dataset.proposalId = proposal.id;
    head.setAttribute('aria-pressed', 'false');

    const thumb = document.createElement('div');
    thumb.className = 'cases-row-thumb';
    if (proposal.thumbnail) {
        const img = document.createElement('img');
        img.src = proposal.thumbnail;
        img.alt = `${proposal.label} — view of the design proposal`;
        img.loading = 'lazy';
        // A stored image can be evicted (storage cleared, or a quota eviction),
        // so a broken source falls back to the same empty slot as having none.
        img.addEventListener('error', () => {
            img.remove();
            thumb.classList.add('is-missing');
        });
        thumb.appendChild(img);
    } else {
        thumb.classList.add('is-missing');
    }

    const meta = document.createElement('div');
    meta.className = 'cases-row-meta';

    const name = document.createElement('div');
    name.className = 'cases-row-name';
    name.textContent = proposal.label;

    // The data badge moves from the thumbnail onto the name line here: at row
    // width it sits next to the label it qualifies, instead of over a small
    // image where it would be unreadable.
    const badge = document.createElement('span');
    badge.className = proposal.hasData ? 'case-badge' : 'case-badge is-empty';
    badge.textContent = proposal.hasData ? 'Data available' : 'No data yet';
    name.appendChild(badge);

    const note = document.createElement('div');
    note.className = 'cases-row-note';
    note.textContent = proposal.note;

    meta.append(name, note);
    head.append(thumb, meta);

    const pages = document.createElement('div');
    pages.className = 'cases-row-pages';
    pages.append(...getCaseStudyPages(proposal.id).map(buildPageCard));

    row.append(head, pages);
    return row;
}

/**
 * Fill the container with one band per proposal.
 *
 * Every proposal shows its snapshots at once, which is the point of this
 * layout: the qualities can be compared across proposals by scrolling, rather
 * than one proposal at a time through the drill-down.
 */
function buildRows() {
    const grid = document.getElementById('casesGrid');
    if (!grid) return;

    grid.replaceChildren(...getCaseStudyProposals().map(buildRow));

    // Clicks land on either the row header or a snapshot card, so both are
    // resolved from one listener on the container, which survives rebuilds.
    if (!grid.dataset.rowsWired) {
        grid.addEventListener('click', (event) => {
            const pageCard = event.target.closest('.page-card');
            if (pageCard && onOpenPage) {
                onOpenPage(pageCard.dataset.pageId);
                return;
            }
            const head = event.target.closest('.cases-row-head');
            if (!head) return;
            requestedId = head.dataset.proposalId;
            render();
        });
        grid.dataset.rowsWired = 'true';
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

    if (layout === 'rows') {
        // The band for the active study is highlighted; the rest stay visible
        // and readable, since all of them are on screen at once here.
        grid.querySelectorAll('.cases-row').forEach((row) => {
            const isActive = row.dataset.proposalId === study.requested;
            row.classList.toggle('is-active', isActive);
            const head = row.querySelector('.cases-row-head');
            if (head) head.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    } else {
        grid.querySelectorAll('.case-card').forEach((card) => {
            const isActive = card.dataset.proposalId === study.requested;
            card.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    }

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
    // In the row layout there is no drill-down at all: every band already
    // carries its own snapshots, so one would repeat a grid that is on screen.
    const drill = document.getElementById('casesDrill');
    if (drill) {
        drill.hidden = layout === 'rows' || !study.requested;
        const drillLabel = document.getElementById('casesDrillName');
        if (drillLabel) {
            drillLabel.textContent = proposal ? proposal.label : study.requested;
        }
    }

    // Snapshots belong to the selected proposal, so the grid is rebuilt rather
    // than re-labelled. Keyed on the requested study, not the effective one:
    // a proposal with no data must show empty slots, not Proposal 1's results.
    //
    // Only needed in the grid layout. In the row layout every proposal's
    // snapshots are built together with its band, so there is nothing to swap
    // when the selection changes.
    if (layout === 'grid' && study.requested !== renderedStudy) {
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

    loadLayout();
    wireLayoutSwitch();
    watchViewport();
    applyLayout();

    // The listener is attached once, but the cards are rebuilt on every change
    // to the registry: a proposal added on the Tools page has to appear here, and
    // so does the "Data available" badge once its first file is uploaded.
    //
    // Bound on the container, which survives rebuilds. In the row layout a
    // second listener handles the headers and snapshot cards; both are attached
    // once and each ignores markup that is not its own, so neither needs to be
    // torn down when the layout changes underneath it.
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

/** Replace every proposal card with the current study list, in the current layout. */
function rebuildPicker() {
    const grid = document.getElementById('casesGrid');
    if (!grid) return;
    if (layout === 'rows') {
        buildRows();
    } else {
        grid.innerHTML = '';
        getCaseStudyProposals().forEach((proposal) => grid.appendChild(buildCard(proposal)));
    }
}

/**
 * Put the chosen layout into effect on the section, and rebuild the contents.
 *
 * The class drives the CSS; the rebuild is what changes the markup, since the
 * two layouts are different elements rather than one element re-styled.
 */
function applyLayout() {
    const section = document.getElementById('caseStudies');
    if (section) section.classList.toggle('cases-rows', layout === 'rows');
    rebuildPicker();
    renderedStudy = null;
    syncLayoutSwitch();
}

/** Reflect the current layout in the switch's pressed states. */
function syncLayoutSwitch() {
    const rowsBtn = document.getElementById('casesLayoutRows');
    const gridBtn = document.getElementById('casesLayoutGrid');
    if (rowsBtn) rowsBtn.setAttribute('aria-pressed', String(layout === 'rows'));
    if (gridBtn) gridBtn.setAttribute('aria-pressed', String(layout === 'grid'));
}

/** Bind the layout switch, once. */
function wireLayoutSwitch() {
    const rowsBtn = document.getElementById('casesLayoutRows');
    const gridBtn = document.getElementById('casesLayoutGrid');
    if (rowsBtn && !rowsBtn.dataset.wired) {
        rowsBtn.dataset.wired = 'true';
        rowsBtn.addEventListener('click', () => setCaseStudiesLayout('rows'));
    }
    if (gridBtn && !gridBtn.dataset.wired) {
        gridBtn.dataset.wired = 'true';
        gridBtn.addEventListener('click', () => setCaseStudiesLayout('grid'));
    }
    syncLayoutSwitch();
}

/**
 * Switch between the row and grid layouts, persist it, and re-render.
 *
 * Exported so the switch can be driven from the UI or the console while the two
 * are being compared. Passing nothing toggles.
 *
 * @param {'rows'|'grid'} [next]
 */
export function setCaseStudiesLayout(next) {
    const target = next === 'rows' || next === 'grid' ? next : layout === 'rows' ? 'grid' : 'rows';
    if (target === layout) return;
    layout = target;
    // Marked as chosen even when it happens to match the device default: the
    // point is that a person decided, so a later viewport change must not
    // silently reverse it.
    layoutChosen = true;
    saveLayout();
    applyLayout();
    render();
}

/**
 * Follow the device default again after a viewport change.
 *
 * Only does anything when the visitor has not chosen a layout themselves, so a
 * deliberate choice survives rotating a phone or resizing a window. Called on
 * resize, which is the only way the breakpoint can be crossed without a reload.
 */
function followDeviceDefault() {
    if (layoutChosen) return;
    const next = defaultLayoutFor(window.innerWidth);
    if (next === layout) return;
    layout = next;
    applyLayout();
    render();
}

/** Watch for the viewport crossing the breakpoint, so the default tracks it. */
function watchViewport() {
    window.addEventListener('resize', () => {
        // Cheap: `followDeviceDefault` returns immediately once a choice has
        // been made, so this does not re-render on every resize event.
        followDeviceDefault();
    });
}

/** The layout currently in use, so callers can label a toggle correctly. */
export function getCaseStudiesLayout() {
    return layout;
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

    // The two layouts mark the target differently: a card, or a row band. Both
    // are scrolled to and outlined, since the point is to find the proposal the
    // visitor asked to see rather than to know which element type it is.
    const card =
        grid.querySelector(`.case-card[data-proposal-id="${CSS.escape(id)}"]`) ||
        grid.querySelector(`.cases-row[data-proposal-id="${CSS.escape(id)}"]`);
    if (!card) return;

    card.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // A transient class rather than a persistent one: the pressed state already
    // marks the card as selected, and this is only to catch the eye during the
    // movement caused by the scroll above.
    card.classList.add('is-revealed');
    window.setTimeout(() => card.classList.remove('is-revealed'), 1600);
}

/**
 * Build the right panel's contents list for this page.
 *
 * Lists the proposals, not their quality pages: the qualities are already laid
 * out as snapshot cards inside each band, and naming all of them here would
 * produce a list longer than the page it describes. One entry per proposal is
 * what makes the list useful for jumping between studies.
 *
 * Rebuilt rather than built once, because proposals can be added on the Tools
 * page and the list has to include them.
 *
 * @param {HTMLElement} tocEl    The <nav> in the right panel
 * @param {HTMLElement} scrollEl The element that actually scrolls
 */
export function buildCaseStudiesToc(tocEl, scrollEl) {
    if (!tocEl) return;

    const proposals = getCaseStudyProposals();
    if (!proposals.length) {
        tocEl.innerHTML = '<div class="toc-empty">No proposals yet.</div>';
        return;
    }

    // Grouped by heading rather than rendered flat: the entries sit under the
    // same "Design proposals" label the page uses, so the panel and the page
    // read as the same structure.
    const list = document.createElement('ul');
    list.className = 'toc-list';

    proposals.forEach((proposal) => {
        const item = document.createElement('li');
        item.className = 'toc-item toc-level-2';

        const link = document.createElement('a');
        link.className = 'toc-link';
        link.href = `#${anchorFor(proposal.id)}`;
        link.textContent = proposal.label;
        // Points at whatever element carries the proposal's id, which differs by
        // layout: a row band in the row view, a card in the grid view. Resolved
        // through `anchorFor` so the two cannot drift apart.
        link.dataset.target = anchorFor(proposal.id);
        // Marks a proposal with no results, matching the badge on its band, so
        // the panel does not imply every entry has something behind it.
        if (!proposal.hasData) {
            const flag = document.createElement('span');
            flag.className = 'toc-flag';
            flag.textContent = 'no data';
            link.appendChild(flag);
        }

        item.appendChild(link);
        list.appendChild(item);
    });

    tocEl.innerHTML = '';
    tocEl.appendChild(list);

    // Bound once per element: the list is rebuilt whenever a proposal is added,
    // and re-adding the listener would stack duplicates that each scroll the
    // page on a single click.
    if (!tocEl.dataset.casesWired) {
        tocEl.dataset.casesWired = 'true';
        tocEl.addEventListener('click', (event) => {
            const link = event.target.closest('a.toc-link');
            if (!link) return;
            const target = document.getElementById(link.dataset.target);
            if (!target) return;
            event.preventDefault();

            // Scrolled by hand rather than with `scrollIntoView`: the target is
            // inside the overlay's own scroller, and `scrollIntoView` walks up
            // to the nearest scrollable ancestor and can move the page behind
            // the overlay as well.
            const scroller = scrollEl || document.getElementById('caseStudies');
            if (!scroller) return;
            const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
            scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + offset - 14), behavior: 'smooth' });

            // Selecting the proposal on the way in: the row (or card) is
            // highlighted and the assessment pages switch to it, which is what
            // clicking the proposal itself does.
            const id = target.dataset.proposalId;
            if (id) {
                requestedId = id;
                render();
            }
        });
    }
}

/**
 * Show or hide the picker.
 * @param {boolean} visible
 */
export function setCaseStudiesVisible(visible) {
    const section = document.getElementById('caseStudies');
    if (section) section.hidden = !visible;
}
