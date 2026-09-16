/**
 * Document view.
 *
 * Some navigation pages are reading pages rather than places — the framework
 * overview is a method description, not a location, so showing it over a 3D
 * globe adds nothing. Those pages hide the Cesium canvas and fill the viewport
 * with a document instead.
 *
 * ## Why Markdown at runtime
 *
 * The document is served from `framework/README.md`, a copy of the research
 * repo's README. Rendering it in the browser means there is no build step to
 * forget: edit the Markdown, reload, done. Keep the copy in step with
 * `npm run sync-docs` (see tools/sync-framework-doc.mjs); `npm run check-docs`
 * fails if it has drifted.
 *
 * `marked` is vendored into `src/vendor/marked.esm.js` rather than pulled from
 * a CDN so the page keeps working offline and on any static host.
 *
 * ## Two post-processing passes
 *
 * The document is written for GitHub and needs two adjustments for this viewer.
 * Both run on a detached element, never on the live tree, so the browser only
 * ever renders once:
 *
 *  1. **Asset paths.** The Markdown refers to `./figures/x.png`; the viewer
 *     serves the same files beside it in `framework/`. Relative URLs are
 *     rebased against the Markdown file's own URL.
 *  2. **External links.** Links open in a new tab so the viewer is not
 *     navigated away from.
 *
 * `marked` passes raw HTML through, which matters here: every figure in the
 * source document is a raw `<img>` inside a `<p align="center">` wrapper, not
 * Markdown image syntax.
 */

import { marked } from './vendor/marked.esm.js';

/** @type {HTMLElement|null} */
let rootEl = null;
/** @type {HTMLElement|null} */
let bodyEl = null;
/** @type {HTMLElement|null} Table of contents container in the right panel. */
let tocEl = null;

/** Cache of rendered documents, keyed by source path. */
const docCache = new Map();

marked.setOptions({ gfm: true, breaks: false });

/**
 * Rebase relative asset URLs and force external links into a new tab.
 *
 * Runs against a detached element so we never touch the live DOM twice.
 *
 * @param {HTMLElement} container
 * @param {string} sourceUrl URL the Markdown was fetched from
 */
function postProcess(container, sourceUrl) {
    // Resolve relative to the *document*, not the app root: assets sit beside
    // the Markdown (`framework/figures/x.png` for a `./figures/x.png` ref).
    const base = new URL(sourceUrl, window.location.href);

    container.querySelectorAll('img[src]').forEach((img) => {
        const src = img.getAttribute('src');
        if (!src || /^(https?:|data:)/i.test(src)) return;
        img.src = new URL(src, base).href;
        img.loading = 'lazy';
    });

    container.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href');
        if (!href) return;
        // In-page anchors are handled by the scroll interceptor below.
        if (href.startsWith('#')) return;
        if (/^https?:/i.test(href)) {
            a.target = '_blank';
            a.rel = 'noopener';
            return;
        }
        // Relative links (PDFs of the figures, mainly) also open in a new tab.
        try {
            a.href = new URL(href, base).href;
            a.target = '_blank';
            a.rel = 'noopener';
        } catch (_) {
            /* ignore malformed URLs */
        }
    });
}

/**
 * Give headings stable ids so the table of contents links resolve, and keep
 * them unique. `marked` (v12) does not emit ids of its own.
 *
 * @param {HTMLElement} container
 */
function addHeadingAnchors(container) {
    const used = new Map();
    container.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
        if (h.id) return;
        const base =
            (h.textContent || '')
                .toLowerCase()
                .trim()
                .replace(/[^a-z0-9\s-]/g, '')
                .replace(/\s+/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '') || 'section';
        const seen = used.get(base) || 0;
        used.set(base, seen + 1);
        h.id = seen === 0 ? base : `${base}-${seen}`;
    });
}

/**
 * Build the table of contents from the rendered headings.
 *
 * The TOC lives in the right parameter panel rather than inside the document,
 * so it stays put while the reader scrolls. It is derived from the same
 * headings the document was rendered from, which means it can never describe a
 * section that is not there.
 *
 * Headings are nested by level. `marked` does not guarantee a well-formed
 * outline (a document may jump h2 -> h4), so levels are tracked on a stack and
 * a skipped level is treated as one deeper rather than producing a broken tree.
 *
 * @param {HTMLElement} container The rendered article
 * @param {HTMLElement} tocEl     The <nav> to fill
 * @param {HTMLElement} scrollEl  Element that actually scrolls (for scroll-spy)
 */
function buildToc(container, tocEl, scrollEl) {
    const all = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'));

    // A lone <h1> is the document's title, not a section — listing it would
    // make the first TOC entry just repeat the page heading. Deeper headings
    // are always kept.
    const headings = all.filter((h, i) => !(i === 0 && h.tagName === 'H1'));

    tocEl.innerHTML = '';
    if (!headings.length) {
        tocEl.innerHTML = '<div class="toc-empty">This document has no sections.</div>';
        return;
    }

    const rootList = document.createElement('ul');
    rootList.className = 'toc-list';

    // Stack of { level, list } — `list` is where children of that level go.
    const stack = [{ level: 0, list: rootList }];

    for (const heading of headings) {
        const level = Number(heading.tagName[1]); // h3 -> 3

        // Walk up until the stack top is a strict ancestor level.
        while (stack.length > 1 && stack[stack.length - 1].level >= level) {
            stack.pop();
        }

        const item = document.createElement('li');
        item.className = `toc-item toc-level-${level}`;

        const link = document.createElement('a');
        link.className = 'toc-link';
        link.href = `#${heading.id}`;
        // Heading markup can wrap the text in nested elements and include
        // surrounding whitespace (the document title is an aligned <h1> with
        // newlines inside), so collapse runs of whitespace for a tidy label.
        link.textContent = (heading.textContent || '').replace(/\s+/g, ' ').trim();
        link.dataset.target = heading.id;
        item.appendChild(link);

        stack[stack.length - 1].list.appendChild(item);

        // Always push a fresh sublist slot; it is only used if deeper headings
        // follow, and empty lists are pruned below.
        const sublist = document.createElement('ul');
        sublist.className = 'toc-list';
        item.appendChild(sublist);
        stack.push({ level, list: sublist });
    }

    // Remove unused sublists so the indentation borders do not draw for
    // headings that turned out to be leaves.
    rootList.querySelectorAll('ul.toc-list').forEach((ul) => {
        if (!ul.children.length) ul.remove();
    });

    tocEl.appendChild(rootList);

    // --- Interaction -------------------------------------------------------
    // Bound once per element, not per rebuild: `openDoc` re-runs the TOC build
    // on every navigation, and re-adding the listener stacked duplicates whose
    // stale closures (holding a previous article) called preventDefault() and
    // then found no matching heading, so clicks did nothing.
    if (!tocEl.dataset.wired) {
        tocEl.dataset.wired = '1';
        tocEl.addEventListener('click', (event) => {
            const link = event.target.closest('a.toc-link');
            if (!link) return;
            event.preventDefault();
            const scroller = getTocScroller();
            const article = getTocArticle();
            if (!scroller || !article) return;
            const target = article.querySelector(`#${CSS.escape(link.dataset.target)}`);
            if (!target) return;

            // Scroll the document container explicitly rather than relying on
            // `scrollIntoView`, which picks its own ancestor and lands the
            // heading under the document bar. The small offset clears the bar.
            const offset =
                target.getBoundingClientRect().top -
                scroller.getBoundingClientRect().top +
                scroller.scrollTop;
            scroller.scrollTo({ top: Math.max(0, offset - 16), behavior: 'smooth' });
        });
    }

    attachTocScrollSpy(tocEl, scrollEl);
}

/** The document body element, resolved fresh so it survives re-renders. */
function getTocArticle() {
    return bodyEl ? bodyEl.querySelector('article.doc') : null;
}

/** The element that actually scrolls the document. */
function getTocScroller() {
    return bodyEl;
}

/**
 * Highlight the TOC entry for the section currently at the top of the reader.
 *
 * Uses a scroll listener plus a throttled measurement rather than
 * IntersectionObserver: the headings are all children of one scrolling element,
 * so "which heading is above the fold" is a single cheap calculation and is
 * easier to reason about than a set of observer callbacks firing out of order.
 *
 * @param {HTMLElement} tocEl
 * @param {HTMLElement} scrollEl
 */
function attachTocScrollSpy(tocEl, scrollEl) {
    if (scrollEl.__tocSpyCleanup) scrollEl.__tocSpyCleanup();

    const links = Array.from(tocEl.querySelectorAll('a.toc-link'));
    let queued = false;

    const update = () => {
        queued = false;

        // Resolve the article live: the cached fragment is re-inserted on each
        // navigation, so a captured reference would point at a detached tree.
        const article = getTocArticle();
        if (!article) return;

        // Measure against the scroller's own viewport edge, not the article's.
        // The article travels with the content, so using its rect made the
        // threshold drift as the reader scrolled and the highlight went stale.
        const viewportTop = scrollEl.getBoundingClientRect().top;
        // The threshold sits slightly below the top edge so a heading counts as
        // "current" once it has settled, not while it is still arriving.
        const threshold = viewportTop + 80;

        // Only consider headings that still have a TOC entry, so the document
        // title being excluded from the list cannot become the active row.
        const known = new Set(links.map((l) => l.dataset.target));

        let activeId = null;
        for (const heading of article.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
            if (!known.has(heading.id)) continue;
            if (heading.getBoundingClientRect().top <= threshold) {
                activeId = heading.id;
            } else {
                break;
            }
        }
        if (!activeId) activeId = links.length ? links[0].dataset.target : null;

        links.forEach((link) => {
            link.classList.toggle('is-active', link.dataset.target === activeId);
        });
    };

    const onScroll = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(update);
    };

    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();

    scrollEl.__tocSpyCleanup = () => {
        scrollEl.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
        scrollEl.__tocSpyCleanup = null;
    };
}

/**
 * Trim the document's own hand-written "Table of Contents" section.
 *
 * The right panel now carries a generated TOC, so keeping the Markdown one
 * would present the same list twice in one viewport. The section is removed
 * from the *viewer* only — the source README keeps it, because it is still the
 * right thing to have when the file is read on GitHub.
 *
 * Detected structurally ("a heading whose text is Table of Contents, drop
 * everything until the next heading of the same or higher rank") rather than by
 * line number, so edits above it cannot silently break the match.
 *
 * @param {HTMLElement} container
 */
function dropInlineTableOfContents(container) {
    const headings = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    const marker = headings.find((h) => /^table of contents$/i.test((h.textContent || '').trim()));
    if (!marker) return;

    const rank = Number(marker.tagName[1]);
    const doomed = [marker];

    let node = marker.nextElementSibling;
    while (node) {
        const isHeading = /^H[1-6]$/.test(node.tagName);
        if (isHeading && Number(node.tagName[1]) <= rank) break;
        doomed.push(node);
        node = node.nextElementSibling;
    }

    doomed.forEach((el) => el.remove());

    // Drop empty paragraphs left behind, but never one holding a figure.
    container.querySelectorAll('p').forEach((p) => {
        if (!p.textContent.trim() && !p.querySelector('img')) p.remove();
    });
}

/** One-time DOM wiring. Safe to call repeatedly. */
export function initializeDocView() {
    rootEl = document.getElementById('docView');
    if (!rootEl) return;

    bodyEl = document.getElementById('docViewBody');
    tocEl = document.getElementById('docToc');

    // In-page links should scroll within the document rather than navigate.
    if (bodyEl && !bodyEl.dataset.wired) {
        bodyEl.dataset.wired = '1';
        bodyEl.addEventListener('click', (event) => {
            const anchor = event.target.closest('a[href^="#"]');
            if (!anchor) return;
            const raw = anchor.getAttribute('href');
            if (!raw || raw === '#') return;
            const id = decodeURIComponent(raw.slice(1));
            const target = bodyEl.querySelector(`#${CSS.escape(id)}`);
            if (!target) return;
            event.preventDefault();
            // Same explicit scroll as the TOC, so both paths land identically.
            const offset =
                target.getBoundingClientRect().top -
                bodyEl.getBoundingClientRect().top +
                bodyEl.scrollTop;
            bodyEl.scrollTo({ top: Math.max(0, offset - 16), behavior: 'smooth' });
        });
    }
}

/** True when the document view is currently covering the viewport. */
export function isDocViewOpen() {
    return !!rootEl && !rootEl.hidden;
}

/** Hide the document view and reveal the map again. */
export function closeDoc() {
    if (!rootEl) return;
    rootEl.hidden = true;
}

/**
 * Show a document, fetching and rendering it on first use.
 *
 * The document is dismissed by navigating to any other page — `pageController`
 * calls `closeDoc()` from its non-document branch — so there is no in-view
 * close control. `title` is accepted for call-site readability but unused:
 * the document carries its own heading.
 *
 * @param {{ source: string, title?: string }} options
 * @returns {Promise<void>}
 */
export async function openDoc({ source } = {}) {
    if (!rootEl) return;

    rootEl.hidden = false;

    // Restore the cached fragment immediately when we have it.
    if (docCache.has(source)) {
        if (bodyEl) {
            bodyEl.innerHTML = docCache.get(source);
            rebuildToc();
        }
        return;
    }

    if (bodyEl) bodyEl.innerHTML = '<div class="doc-view-loading">Loading…</div>';

    try {
        const res = await fetch(source, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const markdown = await res.text();

        const html = marked.parse(markdown);

        // Build off-screen so post-processing is not visible mid-flight.
        const staging = document.createElement('div');
        staging.innerHTML = html;
        addHeadingAnchors(staging);
        dropInlineTableOfContents(staging);
        postProcess(staging, source);

        const article = document.createElement('article');
        article.className = 'doc';
        while (staging.firstChild) article.appendChild(staging.firstChild);

        const fragment = article.outerHTML;
        docCache.set(source, fragment);

        // Guard against a slow fetch resolving after the reader navigated away.
        if (!rootEl.hidden && bodyEl) {
            bodyEl.innerHTML = '';
            bodyEl.appendChild(article);
            rebuildToc();
        }
    } catch (error) {
        console.error('[DocView] Failed to load', source, error);
        if (tocEl) {
            tocEl.innerHTML = '<div class="toc-empty">Contents unavailable.</div>';
        }
        if (bodyEl) {
            bodyEl.innerHTML =
                '<div class="doc-view-loading">' +
                'The document could not be loaded from <code>' +
                source +
                '</code>.</div>';
        }
    }
}

/**
 * Rebuild the table of contents from whatever is currently in the document
 * body. Called whenever the rendered article changes.
 */
function rebuildToc() {
    if (!tocEl || !bodyEl) return;
    const article = bodyEl.querySelector('article.doc');
    if (!article) {
        tocEl.innerHTML = '<div class="toc-empty">Open the document to build the contents.</div>';
        return;
    }
    buildToc(article, tocEl, bodyEl);
}
