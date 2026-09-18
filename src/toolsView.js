/**
 * Tools view.
 *
 * The Tools page is neither a place on the map nor a document to read: it is a
 * working surface for *other people's* data. Like the framework and case-study
 * pages it takes over the viewport, but unlike them its content is generated
 * here rather than fetched.
 *
 * ## The upload flow, and why it is ordered the way it is
 *
 * Results belong to a proposal, not to the platform, so the page asks for the
 * proposal first and the files second: **add a proposal, then add quality
 * results under it**. The alternative — a flat list of quality slots — would
 * have to invent a proposal for every file, and would make two results for the
 * same quality indistinguishable.
 *
 * Exactly one thing is live here: uploading. Every file is held in the browser
 * for the session, validated, and then read by the assessment pages through
 * `dataRegistry.js`. Nothing is transmitted, and nothing survives a reload,
 * which the page states rather than leaves the visitor to discover.
 */

import {
    QUALITIES,
    addStudy,
    clearProposalImage,
    clearUpload,
    filledSlotCount,
    getBuiltIn,
    getProposalImage,
    getSlotContent,
    getStudyList,
    getUpload,
    onDataRegistryChange,
    removeStudy,
    setProposalImage,
    setUpload,
    uploadCount,
} from './dataRegistry.js';
import { validateUpload } from './uploadValidation.js';
import { prepareProposalImage } from './imageStore.js';
import { buildToolsToc } from './docView.js';
import { buildPlotWarning, buildPlotPanels } from './plotting.js';
import { buildPartnerSection } from './partnerIntegrations.js';
import { gotoPage } from './pageController.js';
import { revealProposal } from './caseStudies.js';

/** @type {HTMLElement|null} */
let rootEl = null;

/**
 * The proposal whose quality slots are open, or null when none is.
 *
 * `undefined` means "the user has not chosen yet", which is why it is distinct
 * from null: the first render opens the first proposal for convenience, but a
 * null that came from clicking to collapse must be preserved, or the group would
 * spring back open.
 *
 * Held here rather than in the registry because it is a view concern: which
 * disclosure triangle happens to be expanded.
 *
 * @type {string|null|undefined}
 */
let expandedStudyId;

/**
 * Validation results, keyed `studyId::qualityId`.
 *
 * Kept separately from the registry because it describes the *upload attempt*
 * — the "checked, 3 warnings" line — whereas the registry holds only what was
 * accepted. A rejected file has a result here and nothing in the registry.
 *
 * @type {Map<string, import('./uploadValidation.js').Check>}
 */
const checks = new Map();

/**
 * The last message from a proposal-image attempt, or null when there is none.
 *
 * Module-level for the same reason `checks` is: a successful store triggers a
 * re-render, which rebuilds the slot from scratch, so a message written straight
 * into the old DOM would be discarded before it could be read. Only failures use
 * it — a success is self-evident from the preview appearing.
 *
 * @type {string|null}
 */
let imageNotice = null;

function checkKey(studyId, qualityId) {
    return `${studyId}::${qualityId}`;
}

/** Bytes as a short human-readable string. */
function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Proposal groups
// ---------------------------------------------------------------------------

/**
 * Build the "add a proposal" control.
 *
 * A proposal is only ever a name here. Everything else the platform needs to
 * know — which folder its results live in, whether it has data — follows from
 * the files uploaded under it, so asking for more would be asking the user to
 * repeat themselves.
 */
function buildAddProposal() {
    const wrap = document.createElement('div');
    wrap.className = 'tools-add';

    const form = document.createElement('form');
    form.className = 'tools-add-form';

    const label = document.createElement('label');
    label.className = 'tools-add-label';
    label.textContent = 'Add a proposal';
    label.htmlFor = 'toolsNewProposalName';
    form.appendChild(label);

    const row = document.createElement('div');
    row.className = 'tools-add-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'toolsNewProposalName';
    input.className = 'tools-input';
    input.placeholder = 'e.g. Proposal 4 — stepped massing';
    input.maxLength = 60;
    row.appendChild(input);

    const button = document.createElement('button');
    button.type = 'submit';
    button.className = 'tools-btn tools-btn-primary';
    button.textContent = 'Add proposal';
    row.appendChild(button);

    form.appendChild(row);

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const name = input.value.trim();
        if (!name) {
            input.focus();
            return;
        }
        const study = addStudy(name);
        expandedStudyId = study.id;
        input.value = '';
        render();
        // Focus the new group's first upload button so the flow continues
        // without hunting for where the proposal went.
        requestAnimationFrame(() => {
            const first = rootEl?.querySelector(
                `.tools-quality[data-study="${CSS.escape(study.id)}"] input[type="file"]`
            );
            if (first) first.focus();
        });
    });

    wrap.appendChild(form);
    return wrap;
}

/**
 * One quality row: what the slot expects, and the control to fill it.
 *
 * The row is where the whole "your data, in this viewer" idea has to become
 * concrete, so it names the format, the file the platform expects, and — once
 * something is loaded — what was actually found inside it.
 */
function buildQualityRow(study, quality) {
    const row = document.createElement('div');
    row.className = 'tools-quality';
    row.dataset.quality = quality.id;
    row.dataset.study = study.id;

    const existing = getUpload(study.id, quality.id);
    const builtIn = existing ? null : getBuiltIn(study.id, quality.id);
    const check = checks.get(checkKey(study.id, quality.id));
    row.dataset.state =
        existing || builtIn ? 'loaded' : check && !check.ok ? 'rejected' : 'empty';

    const head = document.createElement('div');
    head.className = 'tools-quality-head';

    const name = document.createElement('span');
    name.className = 'tools-quality-name';
    name.textContent = quality.label;
    head.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'tools-quality-meta';
    meta.textContent = `${quality.format} · ${quality.consumer}`;
    head.appendChild(meta);

    row.appendChild(head);

    const status = document.createElement('div');
    status.className = 'tools-quality-status';

    if (builtIn) {
        // Reads as loaded, because it is — but marked as shipped with the viewer
        // and with no Remove button. Offering removal would imply the visitor
        // could take the published data away, which they cannot: it is part of
        // the site, and the next reload would restore it.
        const dot = document.createElement('span');
        dot.className = 'tools-dot tools-dot-ok';
        status.appendChild(dot);

        const text = document.createElement('span');
        text.textContent = builtIn.name;
        status.appendChild(text);

        const tag = document.createElement('span');
        tag.className = 'tools-builtin-tag';
        tag.textContent = 'Built in';
        tag.title = 'Ships with the viewer and cannot be removed.';
        status.appendChild(tag);
    } else if (existing) {
        const dot = document.createElement('span');
        dot.className = 'tools-dot tools-dot-ok';
        status.appendChild(dot);

        const text = document.createElement('span');
        text.textContent = `${existing.name} (${formatSize(existing.size)})`;
        status.appendChild(text);

        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'tools-btn tools-btn-quiet';
        clear.textContent = 'Remove';
        clear.addEventListener('click', () => {
            clearUpload(study.id, quality.id);
            checks.delete(checkKey(study.id, quality.id));
            render();
        });
        status.appendChild(clear);
    } else if (check && !check.ok) {
        const dot = document.createElement('span');
        dot.className = 'tools-dot tools-dot-bad';
        status.appendChild(dot);

        const text = document.createElement('span');
        text.className = 'tools-reject';
        text.textContent = check.summary;
        status.appendChild(text);
    } else {
        const dot = document.createElement('span');
        dot.className = 'tools-dot tools-dot-idle';
        status.appendChild(dot);

        const text = document.createElement('span');
        text.className = 'tools-muted';
        text.textContent = `Expected under ${study.id}/${quality.file}`;
        status.appendChild(text);
    }

    row.appendChild(status);

    // The validation detail is the part a user needs to trust or fix a file,
    // so it is shown whenever there is something to say.
    if (check) {
        const detail = document.createElement('p');
        detail.className = check.ok ? 'tools-check tools-check-ok' : 'tools-check tools-check-bad';
        detail.textContent = `${check.ok ? 'Accepted' : 'Not accepted'} — ${check.summary}${
            check.detail ? `: ${check.detail}` : ''
        }`;
        row.appendChild(detail);

        (check.warnings || []).forEach((warning) => {
            const line = document.createElement('p');
            line.className = 'tools-check tools-check-warn';
            line.textContent = warning;
            row.appendChild(line);
        });
    }

    const picker = document.createElement('div');
    picker.className = 'tools-picker';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = quality.accept;
    fileInput.id = `toolsFile-${study.id}-${quality.id}`;
    fileInput.className = 'tools-file';

    const fileLabel = document.createElement('label');
    fileLabel.className = 'tools-btn';
    fileLabel.htmlFor = fileInput.id;
    fileLabel.textContent = existing ? 'Replace file' : 'Choose file';
    picker.appendChild(fileLabel);
    picker.appendChild(fileInput);

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;

        // Disable the control while validating so a slow parse cannot be
        // submitted twice, and so the row visibly reacts to the click.
        fileLabel.textContent = 'Checking…';
        fileLabel.classList.add('is-busy');

        const check = await validateUpload(quality.id, file);
        checks.set(checkKey(study.id, quality.id), check);

        if (check.ok) {
            setUpload(study.id, quality.id, file);
        } else {
            // A rejected file leaves any previously loaded one in place: losing
            // working data because a replacement was malformed would be hostile.
            fileInput.value = '';
        }
        render();
    });

    row.appendChild(picker);
    return row;
}

/**
 * A row of chips naming the qualities loaded for a study, or a short line
 * explaining that none are.
 *
 * Chips rather than prose because the useful reading is "is wind in there?", and
 * a list of names answers that faster than a sentence. The empty state is worded
 * for the case that actually produces it — a proposal whose name was saved but
 * whose files were cleared by a reload — rather than as a generic "no data",
 * which would leave the visitor wondering whether something had failed.
 *
 * @param {{id: string, label: string}} study
 * @param {number} loaded
 */
function buildLoadedSummary(study, loaded) {
    const wrap = document.createElement('div');
    wrap.className = 'tools-loaded';

    if (!loaded) {
        const none = document.createElement('span');
        none.className = 'tools-loaded-none';
        // A built-in proposal with no uploads is simply "no results"; a
        // visitor-added one with nothing loaded is the reload case, which is
        // worth saying plainly so it does not read as lost work.
        none.textContent = study.userAdded
            ? 'No results loaded. Uploaded files are cleared on reload.'
            : 'No results loaded.';
        wrap.appendChild(none);
        return wrap;
    }

    const label = document.createElement('span');
    label.className = 'tools-loaded-label';
    label.textContent = 'Loaded';
    wrap.appendChild(label);

    const list = document.createElement('div');
    list.className = 'tools-loaded-chips';

    QUALITIES.forEach((quality) => {
        const uploaded = getUpload(study.id, quality.id);
        const builtIn = uploaded ? null : getBuiltIn(study.id, quality.id);
        if (!uploaded && !builtIn) return;

        const chip = document.createElement('span');
        // Marked so the list distinguishes what the visitor brought from what the
        // site provides, which is the same distinction the rows below make.
        chip.className = builtIn
            ? 'tools-loaded-chip tools-loaded-chip-builtin'
            : 'tools-loaded-chip';
        chip.textContent = quality.label;
        if (builtIn) chip.title = 'Included with the viewer.';
        list.appendChild(chip);
    });

    wrap.appendChild(list);
    return wrap;
}

/**
 * What a built-in proposal contains, stated rather than offered for editing.
 *
 * Deliberately not a set of disabled file inputs: a greyed-out control still
 * reads as a control, and the visitor is left wondering what would enable it.
 * This is a list, not a form. It exists so someone can tell which qualities the
 * shipped example covers without opening every assessment page.
 *
 * @param {{id: string}} study
 */
function buildBuiltInList(study) {
    const wrap = document.createElement('div');
    wrap.className = 'tools-builtin';

    const lede = document.createElement('p');
    lede.className = 'tools-builtin-lede';
    lede.textContent =
        'This proposal ships with the viewer, so its results are already loaded and there is ' +
        'nothing to upload. The qualities it covers:';
    wrap.appendChild(lede);

    const list = document.createElement('ul');
    list.className = 'tools-builtin-list';

    QUALITIES.forEach((quality) => {
        const builtIn = getBuiltIn(study.id, quality.id);
        const item = document.createElement('li');
        item.className = builtIn ? 'is-present' : 'is-absent';

        const name = document.createElement('span');
        name.className = 'tools-builtin-name';
        name.textContent = quality.label;
        item.appendChild(name);

        const mark = document.createElement('span');
        mark.className = builtIn ? 'tools-builtin-yes' : 'tools-builtin-no';
        // Says which it is in words as well as in colour, so the distinction
        // survives a colour-blind reader and a monochrome print.
        mark.textContent = builtIn ? 'included' : 'not included';
        item.appendChild(mark);

        list.appendChild(item);
    });

    wrap.appendChild(list);

    const note = document.createElement('p');
    note.className = 'tools-builtin-note';
    note.textContent =
        'Nothing to upload here. Pick it on the Case studies page to see its results in ' +
        'context, or open any assessment page from the bar above.';
    wrap.appendChild(note);

    return wrap;
}

/**
 * The optional cover image for a visitor-added proposal.
 *
 * Offered because a proposal's card in the case-studies picker is how it is
 * presented to anyone else looking at the page, and without an image that card is
 * an empty slot. It is optional: an empty slot is honest, a wrong picture is not.
 *
 * The image is downscaled before storage (see `imageStore.js`) and stored as a
 * data URL, so unlike the uploads it *does* survive a reload. That difference is
 * stated on the control, because the visitor has just been told elsewhere that
 * uploads are not saved and would otherwise reasonably assume this is not either.
 *
 * @param {{id: string, label: string}} study
 */
function buildImageSlot(study) {
    const wrap = document.createElement('div');
    wrap.className = 'tools-image';

    const head = document.createElement('div');
    head.className = 'tools-image-head';

    const title = document.createElement('span');
    title.className = 'tools-image-title';
    title.textContent = 'Proposal image';
    head.appendChild(title);

    const optional = document.createElement('span');
    optional.className = 'tools-image-optional';
    optional.textContent = 'optional';
    head.appendChild(optional);

    wrap.appendChild(head);

    const caption = document.createElement('p');
    caption.className = 'tools-image-caption';
    caption.textContent =
        'Shown on this proposal’s card in Case studies. Without one the card shows an empty ' +
        'slot rather than another proposal’s picture. Saved in this browser, so it survives ' +
        'a reload — unlike the result files above.';
    wrap.appendChild(caption);

    const current = getProposalImage(study.id);

    const row = document.createElement('div');
    row.className = 'tools-image-row';

    const preview = document.createElement('div');
    preview.className = current ? 'tools-image-preview' : 'tools-image-preview is-empty';
    if (current) {
        const img = document.createElement('img');
        img.src = current;
        img.alt = `Image for ${study.label}`;
        preview.appendChild(img);
    }
    row.appendChild(preview);

    const controls = document.createElement('div');
    controls.className = 'tools-image-controls';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/webp';
    fileInput.id = `toolsImage-${study.id}`;
    fileInput.className = 'tools-file';

    const pick = document.createElement('label');
    pick.className = 'tools-btn';
    pick.htmlFor = fileInput.id;
    pick.textContent = current ? 'Replace image' : 'Choose image';
    controls.appendChild(pick);
    controls.appendChild(fileInput);

    // Shown under the controls, and the only place this row reports anything:
    // an image can fail to store for a reason worth naming (too large), so a
    // silent failure would be the wrong behaviour here.
    const feedback = document.createElement('p');
    feedback.className = 'tools-image-feedback';

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;

        pick.textContent = 'Processing…';
        pick.classList.add('is-busy');
        feedback.textContent = '';
        feedback.className = 'tools-image-feedback';

        const prepared = await prepareProposalImage(file);
        if (!prepared.ok) {
            feedback.classList.add('is-bad');
            feedback.textContent = prepared.error;
            pick.textContent = current ? 'Replace image' : 'Choose image';
            pick.classList.remove('is-busy');
            fileInput.value = '';
            return;
        }

        const stored = setProposalImage(study.id, prepared.dataUrl);
        // A storage failure is not fatal: the image is in memory and will show
        // until the tab closes. Saying so is better than pretending it saved.
        imageNotice = stored.ok ? null : stored.error;
        render();
    });

    if (current) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'tools-btn tools-btn-quiet';
        clear.textContent = 'Remove image';
        clear.addEventListener('click', () => {
            clearProposalImage(study.id);
            imageNotice = null;
            render();
        });
        controls.appendChild(clear);
    }

    row.appendChild(controls);
    wrap.appendChild(row);

    // The message is held on the module so it survives the re-render that follows
    // a successful store, in the same way the validation messages do.
    const notice = imageNotice;
    if (notice) {
        feedback.classList.add('is-bad');
        feedback.textContent = notice;
    }

    wrap.appendChild(feedback);
    return wrap;
}

/**
 * One proposal and its quality slots.
 *
 * Rendered as a disclosure rather than an always-open block because a visitor
 * with several proposals would otherwise scroll past slots for results they are
 * not working on. The count in the summary line is what makes the collapsed
 * state useful: "3 of 6" says at a glance what is still missing.
 */
function buildStudyGroup(study) {
    // Counts what is present, including the results a built-in proposal ships
    // with, so a complete proposal reads as complete rather than as needing
    // everything uploaded by hand.
    const loaded = filledSlotCount(study.id);
    const uploaded = uploadCount(study.id);
    const group = document.createElement('section');
    group.className = 'tools-study';
    group.dataset.study = study.id;

    const expanded = expandedStudyId === study.id;
    group.dataset.expanded = String(expanded);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tools-study-toggle';
    toggle.setAttribute('aria-expanded', String(expanded));

    const chevron = document.createElement('span');
    chevron.className = 'tools-chevron';
    chevron.textContent = expanded ? '\u25BE' : '\u25B8';
    toggle.appendChild(chevron);

    const name = document.createElement('span');
    name.className = 'tools-study-name';
    name.textContent = study.label;
    toggle.appendChild(name);

    const count = document.createElement('span');
    count.className = 'tools-study-count';
    count.textContent = `${loaded} of ${QUALITIES.length} results`;
    toggle.appendChild(count);

    if (study.builtIn) {
        // Says where the results come from, so a visitor does not expect to be
        // able to remove or replace them.
        const flag = document.createElement('span');
        flag.className = 'tools-study-flag tools-study-flag-builtin';
        flag.textContent = 'Included';
        flag.title = 'All results ship with the viewer and cannot be removed.';
        toggle.appendChild(flag);
    } else if (!study.hasData) {
        const flag = document.createElement('span');
        flag.className = 'tools-study-flag';
        flag.textContent = 'No data';
        toggle.appendChild(flag);
    }

    toggle.addEventListener('click', () => {
        expandedStudyId = expanded ? null : study.id;
        render();
    });

    group.appendChild(toggle);

    // Which qualities are actually loaded, listed on the group itself.
    //
    // The "3 of 6" count on the toggle says how many, but not which, so on a
    // collapsed group there was no way to tell whether wind was in there or
    // still missing without opening it. This answers that at a glance, and also
    // distinguishes a proposal that has real results from one that has only a
    // name saved — the latter being what a visitor sees after a reload, since
    // files do not survive one.
    group.appendChild(buildLoadedSummary(study, loaded));

    if (study.userAdded) {
        const note = document.createElement('p');
        note.className = 'tools-study-note';
        note.textContent = study.note;
        group.appendChild(note);
    }

    if (expanded) {
        const body = document.createElement('div');
        body.className = 'tools-study-body';

        if (study.builtIn) {
            // A built-in proposal gets no upload controls at all. Offering a
            // "Choose file" button next to results that ship with the viewer
            // invites a visitor to try to replace or extend them, which is not
            // possible: the files are part of the site, and the next reload
            // restores them. What the row is good for is saying what is in there,
            // so that is all it does — see `buildBuiltInList`.
            body.appendChild(buildBuiltInList(study));
        } else {
            const hint = document.createElement('p');
            hint.className = 'tools-study-hint';
            hint.textContent =
                'Add the results you have. A slot left empty is not an error — the pages that ' +
                'need it stay hidden, and the rest still render.';
            body.appendChild(hint);

            body.appendChild(buildImageSlot(study));

            QUALITIES.forEach((quality) => body.appendChild(buildQualityRow(study, quality)));
        }

        if (study.userAdded) {
            const actions = document.createElement('div');
            actions.className = 'tools-study-actions';

            const show = document.createElement('button');
            show.type = 'button';
            show.className = 'tools-btn';
            show.textContent = 'Show the proposal';
            show.title = 'Open this proposal in Case studies';
            show.addEventListener('click', () => {
                // Switch page first, then select: `gotoPage` is async because it
                // animates the camera and swaps layers, and revealing a card in
                // an overlay that is not on screen yet would scroll the wrong
                // thing. Selecting the study is the last thing that happens, so
                // the case-studies footer already names it when it appears.
                gotoPage('cases').then(() => revealProposal(study.id));
            });
            actions.appendChild(show);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'tools-btn tools-btn-danger';
            remove.textContent = 'Remove this proposal';
            remove.addEventListener('click', () => {
                // Discarding uploaded results is irreversible, so confirm and
                // name the consequence rather than relying on "are you sure".
                // Counts uploads only: this can only be reached for a
                // visitor-added proposal, which has no built-in results.
                const ok = window.confirm(
                    uploaded
                        ? `Remove "${study.label}" and its ${uploaded} uploaded result${
                              uploaded === 1 ? '' : 's'
                          }? This cannot be undone.`
                        : `Remove "${study.label}"?`
                );
                if (!ok) return;
                removeStudy(study.id);
                if (expandedStudyId === study.id) expandedStudyId = null;
                render();
            });
            actions.appendChild(remove);
            body.appendChild(actions);
        }

        group.appendChild(body);
    }

    return group;
}

/**
 * The current state of the proposal set, as a sentence.
 *
 * Shown above the groups because it is the one thing a visitor needs to
 * understand before uploading anything: proposals live in the browser, so a
 * reload clears them. Saying it once here is clearer than repeating a caveat
 * inside every group.
 */
/**
 * The current state of the proposal set, as a sentence.
 *
 * Shown above the groups because the two kinds of state here persist
 * differently, and a visitor needs to know which is which before relying on
 * either: proposal names are kept in this browser between visits, uploaded files
 * are not kept at all. Saying it once here is clearer than repeating a caveat
 * inside every group.
 */
function buildLedger(studies) {
    const wrap = document.createElement('div');
    wrap.className = 'tools-ledger';

    // Counts only what the visitor brought, not what the site ships with: the
    // point of this line is the persistence warning, and warning about files that
    // cannot be lost would be noise.
    const total = studies.reduce((sum, s) => sum + uploadCount(s.id), 0);
    const builtInCount = studies.filter((s) => s.builtIn).length;

    const line = document.createElement('p');
    line.className = 'tools-ledger-line';

    const persistence = builtInCount
        ? ' The proposal that ships with the viewer is kept as it is; anything you add ' +
          'yourself is read in your browser only and is cleared on reload, so keep the ' +
          'originals.'
        : ' Proposal names are remembered in this browser, but the uploaded files are not ' +
          '— a reload clears the results, so keep the originals.';

    line.textContent = total
        ? `${total} uploaded result${total === 1 ? '' : 's'} across ${studies.length} proposal${
              studies.length === 1 ? '' : 's'
          }.${persistence}`
        : `Uploads are read in your browser and never sent to a server.${persistence}`;
    wrap.appendChild(line);

    return wrap;
}

/**
 * The Data broker block's working surface.
 *
 * The conversion half is still unbuilt, and deliberately so: which conversions
 * are worth having depends on the formats partners actually bring, and guessing
 * at them would produce a converter nobody needs. What is useful before then is
 * checking whether a partner's API can be reached from a browser at all — which
 * is a question with a definite answer and a common, confusing failure mode —
 * and a route to talk to us. Both live in `partnerIntegrations.js`.
 */
function buildBrokerBody() {
    const body = document.createElement('div');
    body.className = 'tools-block-body';
    body.appendChild(buildPartnerSection(() => render()));
    return body;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * One tool block on the Tools page.
 *
 * Every tool is rendered through this, so the title level, badge position and
 * spacing are identical across them. That is the point: when the blocks were
 * hand-built individually, the upload block ended up as a full-width section
 * with a heading while the broker was a small card in a grid, and the two read
 * as different levels of importance despite being peers. One builder removes the
 * possibility of that drift returning.
 *
 * @param {{id: string, title: string, status: 'available'|'partial'|'planned'}} block
 */
function buildToolBlock(block) {
    const section = document.createElement('section');
    section.className = 'tools-block';
    section.dataset.block = block.id;

    const head = document.createElement('div');
    head.className = 'tools-block-head';

    const title = document.createElement('h2');
    title.className = 'tools-block-title';
    title.textContent = block.title;
    head.appendChild(title);

    // Three states rather than two: something can work in part, and collapsing
    // that into "available" would overstate it while "not built yet" would
    // understate a feature that genuinely runs.
    const BADGE = {
        available: { text: 'Available', className: 'tool-badge-available' },
        partial: { text: 'Partly built', className: 'tool-badge-partial' },
        planned: { text: 'Not built yet', className: 'tool-badge-planned' },
    };
    const badgeSpec = BADGE[block.status] || BADGE.planned;

    const badge = document.createElement('span');
    badge.className = `tool-badge ${badgeSpec.className}`;
    badge.textContent = badgeSpec.text;
    head.appendChild(badge);

    section.appendChild(head);
    return section;
}

/** Render the whole page into the viewport. */
function render() {
    if (!rootEl) return;

    // Preserve scroll across re-renders: every upload triggers one, and jumping
    // back to the top after adding a file would make the page feel broken.
    const scrollTop = rootEl.scrollTop;

    rootEl.innerHTML = '';

    const inner = document.createElement('div');
    inner.className = 'tools-inner';

    const head = document.createElement('header');
    head.className = 'tools-head';

    const h2 = document.createElement('h2');
    h2.textContent = 'Tools';
    head.appendChild(h2);

    const lede = document.createElement('p');
    lede.textContent =
        'This viewer ships with the assessments built for the Zuidas case. These tools are ' +
        'for results produced elsewhere — your own simulations, your own study area — so ' +
        'they can be read in the same environment rather than in isolation.';
    head.appendChild(lede);

    inner.appendChild(head);

    const studies = getStudyList();
    // Defaulting to the first study is only for the very first render. It has to
    // be distinguishable from "the user collapsed everything", which also leaves
    // this null — otherwise collapsing a group would immediately reopen it, and
    // the page would look like it ignores the click.
    if (expandedStudyId === undefined && studies.length) {
        expandedStudyId = studies[0].id;
    }

    // --- 1. Visualise your own assessment results (live) ---
    const uploadBlock = buildToolBlock({
        id: 'upload',
        title: 'Visualize your own assessment results',
        status: 'available',
    });

    const uploadBody = document.createElement('div');
    uploadBody.className = 'tools-block-body';

    const uploadLede = document.createElement('p');
    uploadLede.className = 'tools-block-lede';
    uploadLede.textContent =
        'Results belong to a proposal, so add the proposal first and then the qualities you ' +
        'have for it. Each file is parsed in your browser and shown on the matching ' +
        'assessment page; a proposal with no uploads stays marked as having no data.';
    uploadBody.appendChild(uploadLede);
    uploadBody.appendChild(buildLedger(studies));
    uploadBody.appendChild(buildAddProposal());

    const list = document.createElement('div');
    list.className = 'tools-studies';
    studies.forEach((study) => list.appendChild(buildStudyGroup(study)));
    uploadBody.appendChild(list);
    uploadBlock.appendChild(uploadBody);

    inner.appendChild(uploadBlock);

    // --- 2. Plot your data ---
    const plotBlock = buildToolBlock({
        id: 'plot',
        title: 'Plot your data',
        status: 'available',
    });

    const plotBody = document.createElement('div');
    plotBody.className = 'tools-block-body';

    const plotLede = document.createElement('p');
    plotLede.className = 'tools-block-lede';
    plotLede.textContent =
        'Charts for the results loaded above, for the cases where a chart answers a question ' +
        'the map cannot: how a value is distributed, how two variables compare, how one ' +
        'location differs from another.';
    plotBody.appendChild(plotLede);
    // The charts are a placeholder, so the banner comes before them: a reader
    // glancing at a chart should not have to scroll to find out the numbers are
    // invented. See `plotting.js`.
    plotBody.appendChild(buildPlotWarning());
    plotBody.appendChild(buildPlotPanels());
    plotBlock.appendChild(plotBody);
    inner.appendChild(plotBlock);

    // --- 3. Data broker ---
    const brokerBlock = buildToolBlock({
        id: 'broker',
        title: 'Data broker',
        // Partly available: the key check and the contact route work, the format
        // conversion does not. Marked "Partly" rather than "Available" because a
        // visitor who reads the badge and nothing else should not expect a
        // converter to be here.
        status: 'partial',
    });
    brokerBlock.appendChild(buildBrokerBody());
    inner.appendChild(brokerBlock);

    // Stated plainly rather than buried: a visitor should not have to infer from
    // the badges what works.
    const note = document.createElement('p');
    note.className = 'tools-note';
    note.textContent =
        'Uploaded results are read in your browser and are not published anywhere, so they ' +
        'cannot be shared by link. Proposal names survive a reload; the uploaded files do ' +
        'not, and are cleared when the tab is closed. A key entered in the data broker is ' +
        'held in memory only and is gone the same way.';
    inner.appendChild(note);

    rootEl.appendChild(inner);
    rootEl.scrollTop = scrollTop;

    // The contents list is rebuilt from what was just rendered, never from a
    // remembered shape: blocks are added and removed as tools are built, and a
    // contents entry pointing at a block that is no longer there would scroll
    // nowhere. Rebuilt after the DOM is in place so the headings exist to read.
    buildToolsToc(rootEl, document.getElementById('toolsToc'));
}

/** Cache the root and render once. */
export function initializeToolsView() {
    rootEl = document.getElementById('toolsView');
    if (!rootEl) return;

    // Any change to the registry — from here or elsewhere — redraws the page, so
    // the ledger and the counts cannot drift from the data.
    onDataRegistryChange(() => {
        if (rootEl && !rootEl.hidden) render();
    });

    render();
}

/** Show the tools page. */
export function openTools() {
    if (!rootEl) return;
    rootEl.hidden = false;
    // Rebuilt on open so it reflects uploads made since it was last visible.
    render();
}

/** Hide it again. Called by the controller when navigating to any other page. */
export function closeTools() {
    if (!rootEl) return;
    rootEl.hidden = true;
}
