/**
 * Partner integrations.
 *
 * The Data broker block's working surface: a way for someone with their own API
 * to try it against the viewer, plus a route to talk to us about a proper
 * integration.
 *
 * ## Why bring-your-own-key and not a stored key
 *
 * The viewer is a static site with no server. That has a consequence worth being
 * blunt about: anything the page can read, any visitor can read. A key shipped in
 * the bundle, or put in `localStorage`, is not a secret — it is a value the page
 * hands to whoever opens DevTools. Storing it "locally" does not change that,
 * because the page that reads it is itself public.
 *
 * So the key here is **the visitor's own**, entered by them, kept in memory for
 * the life of the page and never written to storage. It is used to make their
 * requests from their browser, with their credentials, and it is discarded when
 * they close the tab. We never hold it, so there is nothing for us to leak.
 *
 * This is the honest version of the feature. The dishonest version — a key the
 * site owns, reachable by anyone — would look the same in the UI and be a
 * liability, so the block says plainly whose key it is.
 *
 * ## Why a test button rather than just a field
 *
 * A failed external request from a browser is silent by design: the page cannot
 * read the reason. It cannot distinguish "no CORS header", "bad key", "wrong
 * URL" or "server down" — the fetch simply rejects with an opaque error. Without
 * a diagnostic the visitor is left guessing between four very different fixes.
 *
 * The test reports what the browser *can* see and names the likely cause. It
 * cannot tell them definitively, because no browser can, so it says what it
 * observed and what each observation usually means.
 */

/**
 * The in-memory holding area for the visitor's credentials.
 *
 * Deliberately not `sessionStorage` or `localStorage`. Even session-scoped
 * storage survives a reload, and a key that outlives the page is a key that can
 * be read by a later script on the same origin. Memory means it is gone when the
 * tab closes, which is what the copy promises.
 *
 * Not exported: nothing outside this module should read the key, so nothing
 * outside can accidentally put it in a URL, a log or the DOM.
 */
const credentials = {
    endpoint: '',
    key: '',
};

/** Results of the last test, kept so a re-render does not lose them. */
let lastTest = null;

/**
 * The addresses a partner can write to.
 *
 * Both are offered rather than one being picked: the project address is the right
 * channel for an institution, and the personal one is what actually reaches a
 * person. A form that goes nowhere would be worse than no form.
 */
const CONTACTS = [
    {
        label: 'Project',
        address: 'info@xcarcity.nl',
        note: 'For institutional enquiries about integrating a partner dataset.',
    },
    {
        label: 'Direct',
        address: 'c1309928130@gmail.com',
        note: 'For anything you would rather discuss with a person directly.',
    },
];

/**
 * The external feeds the viewer already knows about.
 *
 * `state` is the honest description of where the data actually comes from, which
 * matters more here than whether a feature "exists": the transit layer shows real
 * vehicles, but on the deployed site they come from a snapshot committed to the
 * bundle, not a live feed. A visitor watching buses that never move deserves to
 * know that rather than assume the site is broken.
 */
const FEEDS = [
    {
        id: 'gtfs',
        label: 'GTFS — public transport',
        state: 'integrated',
        summary: 'Vehicles on the map, filtered to the Zuidas area.',
        detail:
            'Live updates need a proxy on your own machine, because OVapi does not allow ' +
            'requests straight from a browser (no CORS header). The deployed site therefore ' +
            'falls back to a snapshot bundled with the viewer: the vehicles are real, but ' +
            'they are frozen at the time the snapshot was taken. Run the proxy locally to ' +
            'see them move.',
    },
];

/** The test states, as a closed set so the renderer cannot invent one. */
const TEST_RESULT = {
    idle: 'idle',
    running: 'running',
    ok: 'ok',
    blocked: 'blocked',
    denied: 'denied',
    failed: 'failed',
};

/**
 * Test the entered endpoint and report what the browser could actually see.
 *
 * A GET rather than a HEAD: several APIs reject HEAD outright, and a rejection
 * would be attributed to the key when the method was the problem. The response
 * body is not read, only its status, so a large payload is not pulled down.
 *
 * `mode: 'cors'` is explicit. In the default mode a browser may quietly perform a
 * no-cors request and return an opaque response with status 0, which looks like a
 * failure but is not one — being explicit means an opaque result is reported as a
 * CORS problem rather than a mystery.
 *
 * @param {string} endpoint
 * @param {string} key
 * @param {(result: {state: string, message: string}) => void} report
 */
async function testConnection(endpoint, key, report) {
    const trimmed = endpoint.trim();
    if (!trimmed) {
        report({ state: TEST_RESULT.failed, message: 'Enter an endpoint URL first.' });
        return;
    }

    // Require an explicit scheme. Without one, `new URL()` resolves the value
    // against the current page, so a typo like `api.example.org` silently becomes
    // a request to this site and comes back 404 — which then gets reported as "the
    // endpoint is wrong", sending the visitor to debug an API they never reached.
    // Nothing legitimate here is a relative path: the point is to reach an
    // external host.
    if (!/^https?:\/\//i.test(trimmed)) {
        report({
            state: TEST_RESULT.failed,
            message:
                'Include the scheme, so the URL starts with https:// (or http:// for a ' +
                'local server). Without it the address is treated as a path on this site.',
        });
        return;
    }

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch (_) {
        report({ state: TEST_RESULT.failed, message: 'That does not parse as a URL.' });
        return;
    }

    // A plain-HTTP endpoint cannot be called from an HTTPS page: the browser
    // blocks it as mixed content before CORS is even considered. Worth catching
    // here because the resulting error is otherwise indistinguishable from a
    // network failure.
    if (
        parsed.protocol === 'http:' &&
        window.location.protocol === 'https:' &&
        parsed.hostname !== 'localhost' &&
        parsed.hostname !== '127.0.0.1'
    ) {
        report({
            state: TEST_RESULT.failed,
            message:
                'This page is served over HTTPS, so a browser will refuse a plain-HTTP ' +
                'endpoint as mixed content. Use an https:// URL.',
        });
        return;
    }

    report({ state: TEST_RESULT.running, message: 'Requesting…' });

    /** @type {RequestInit} */
    const init = {
        method: 'GET',
        mode: 'cors',
        cache: 'no-store',
        // Only attach a header if there is a key: sending an empty Authorization
        // makes some APIs reject the request outright, which would look like a
        // wrong key rather than an absent one.
        headers: key.trim() ? { Authorization: `Bearer ${key.trim()}` } : {},
    };

    try {
        const response = await fetch(parsed.href, init);

        if (response.ok) {
            report({
                state: TEST_RESULT.ok,
                message: `Reached the endpoint (HTTP ${response.status}). The browser could read the response, so this API allows requests from this page.`,
            });
            return;
        }

        if (response.status === 401 || response.status === 403) {
            report({
                state: TEST_RESULT.denied,
                message: `The API answered HTTP ${response.status}. It is reachable and allows this page, but it rejected the credentials — check the key, or whether it belongs in a different header.`,
            });
            return;
        }

        report({
            state: TEST_RESULT.failed,
            message: `The API answered HTTP ${response.status}. The request reached it, so CORS is not the problem — the endpoint or its parameters are.`,
        });
    } catch (error) {
        // A rejected fetch tells the page almost nothing: the browser withholds
        // the reason on purpose, so a CORS failure, a DNS failure and an offline
        // network all arrive here looking the same.
        //
        // A TypeScript-style note for future maintainers: there is no way to
        // widen this. `error` may be an abort, a network error or a CORS block,
        // and the only lever is what is already known about the request.
        const origin = window.location.origin;
        report({
            state: TEST_RESULT.blocked,
            message:
                `The request did not complete. The usual cause is CORS: the API has to send ` +
                `an Access-Control-Allow-Origin header naming this page's origin (${origin}), ` +
                `and if it does not, the browser discards the response and reports only a ` +
                `generic failure. It can also mean the host is unreachable or the network is ` +
                `offline. This cannot be fixed from the page — it needs a change on the API's ` +
                `side, or a proxy in between.`,
        });
    }
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

/** A labelled text input, with the label tied to the field for accessibility. */
function buildField(id, label, placeholder, { secret = false } = {}) {
    const wrap = document.createElement('label');
    wrap.className = 'partner-field';
    wrap.htmlFor = id;

    const text = document.createElement('span');
    text.className = 'partner-field-label';
    text.textContent = label;
    wrap.appendChild(text);

    const input = document.createElement('input');
    input.type = secret ? 'password' : 'text';
    input.id = id;
    input.className = 'partner-input';
    input.placeholder = placeholder;
    // Not `autocomplete="off"`: password managers ignore it, and offering to save
    // a partner's API key is arguably useful. The field is never persisted by
    // this page either way.
    input.spellcheck = false;
    wrap.appendChild(input);

    return { wrap, input };
}

/**
 * The bring-your-own-key surface.
 *
 * @param {() => void} rerender Called after a test so the result is shown. Passed
 *   in rather than imported so this module stays free of the Tools page's
 *   render loop, which would be a cycle.
 */
function buildKeyPanel(rerender) {
    const panel = document.createElement('div');
    panel.className = 'partner-panel';

    const title = document.createElement('h4');
    title.className = 'partner-panel-title';
    title.textContent = 'Try your own API';
    panel.appendChild(title);

    const lede = document.createElement('p');
    lede.className = 'partner-panel-lede';
    lede.textContent =
        'Enter an endpoint and a key to check whether it can be read from a browser. ' +
        'Nothing is sent anywhere except to that API, and nothing is saved.';
    panel.appendChild(lede);

    const endpoint = buildField(
        'partnerEndpoint',
        'Endpoint URL',
        'https://api.example.org/v1/measurements'
    );
    endpoint.input.value = credentials.endpoint;
    endpoint.input.addEventListener('input', () => {
        credentials.endpoint = endpoint.input.value;
    });
    panel.appendChild(endpoint.wrap);

    const key = buildField('partnerKey', 'API key', 'Paste your key', { secret: true });
    key.input.value = credentials.key;
    key.input.addEventListener('input', () => {
        credentials.key = key.input.value;
    });
    panel.appendChild(key.wrap);

    // Stated as a promise rather than a disclaimer, and placed before the button
    // so it is read before a key is entered rather than after.
    const promises = document.createElement('ul');
    promises.className = 'partner-promises';
    [
        'Your key is kept in memory for this page only. It is never written to storage, ' +
            'never sent to us, and is gone when you close the tab.',
        'It is your key making the request from your browser, so you are using your own ' +
            'quota and your own permissions.',
        'The API has to allow requests from a web page. Many do not, and no key changes ' +
            'that — the test below will tell you which case you are in.',
    ].forEach((line) => {
        const item = document.createElement('li');
        item.textContent = line;
        promises.appendChild(item);
    });
    panel.appendChild(promises);

    const actions = document.createElement('div');
    actions.className = 'partner-actions';

    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'tools-btn tools-btn-primary';
    test.textContent = 'Test connection';
    test.addEventListener('click', async () => {
        test.disabled = true;
        lastTest = { state: TEST_RESULT.running, message: 'Requesting…' };
        rerender();

        await testConnection(credentials.endpoint, credentials.key, (result) => {
            lastTest = result;
            rerender();
        });

        const button = document.querySelector('#toolsView .partner-panel .tools-btn-primary');
        if (button) button.disabled = false;
    });
    actions.appendChild(test);

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'tools-btn';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => {
        credentials.endpoint = '';
        credentials.key = '';
        lastTest = null;
        rerender();
    });
    actions.appendChild(clear);

    panel.appendChild(actions);

    if (lastTest && lastTest.state !== TEST_RESULT.idle) {
        const result = document.createElement('p');
        result.className = `partner-result partner-result-${lastTest.state}`;
        // `role="status"` so a screen reader announces the outcome, which is the
        // only feedback that the button did anything.
        result.setAttribute('role', 'status');
        result.textContent = lastTest.message;
        panel.appendChild(result);
    }

    return panel;
}

/** The feeds the viewer already reads, described by where the data comes from. */
function buildFeedList() {
    const list = document.createElement('div');
    list.className = 'partner-feeds';

    FEEDS.forEach((feed) => {
        const row = document.createElement('div');
        row.className = 'partner-feed';

        const head = document.createElement('div');
        head.className = 'partner-feed-head';

        const name = document.createElement('span');
        name.className = 'partner-feed-name';
        name.textContent = feed.label;
        head.appendChild(name);

        const badge = document.createElement('span');
        badge.className = 'tool-badge tool-badge-available';
        badge.textContent = feed.state === 'integrated' ? 'Integrated' : feed.state;
        head.appendChild(badge);

        row.appendChild(head);

        const summary = document.createElement('p');
        summary.className = 'partner-feed-summary';
        summary.textContent = feed.summary;
        row.appendChild(summary);

        const detail = document.createElement('p');
        detail.className = 'partner-feed-detail';
        detail.textContent = feed.detail;
        row.appendChild(detail);

        list.appendChild(row);
    });

    return list;
}

/** How to reach us about integrating a dataset. */
function buildContactPanel() {
    const panel = document.createElement('div');
    panel.className = 'partner-panel';

    const title = document.createElement('h4');
    title.className = 'partner-panel-title';
    title.textContent = 'Integrate a dataset';
    panel.appendChild(title);

    const lede = document.createElement('p');
    lede.className = 'partner-panel-lede';
    lede.textContent =
        'If you hold data you would like shown here — a sensor network, a survey, an ' +
        'operator feed — get in touch and we can work out what it would take. Some ' +
        'sources need a small piece of server-side work we do not have yet, so it is ' +
        'worth talking before you spend time on a format.';
    panel.appendChild(lede);

    const list = document.createElement('div');
    list.className = 'partner-contacts';

    CONTACTS.forEach((contact) => {
        const row = document.createElement('div');
        row.className = 'partner-contact';

        const label = document.createElement('span');
        label.className = 'partner-contact-label';
        label.textContent = contact.label;
        row.appendChild(label);

        const link = document.createElement('a');
        link.className = 'partner-contact-link';
        // A pre-filled subject so replies arrive already sorted, which matters
        // when the same address also receives unrelated mail.
        link.href = `mailto:${contact.address}?subject=${encodeURIComponent(
            'Digital twin — dataset integration'
        )}`;
        link.textContent = contact.address;
        row.appendChild(link);

        const note = document.createElement('span');
        note.className = 'partner-contact-note';
        note.textContent = contact.note;
        row.appendChild(note);

        list.appendChild(row);
    });

    panel.appendChild(list);
    return panel;
}

/**
 * Everything the Data broker block shows once it is a working surface.
 *
 * @param {() => void} rerender
 * @returns {DocumentFragment}
 */
export function buildPartnerSection(rerender) {
    const frag = document.createDocumentFragment();

    const copy = document.createElement('p');
    copy.className = 'tools-block-lede';
    copy.textContent =
        'A translation step between what other people’s systems produce and what the ' +
        'viewer reads. Two parts are useful now: checking whether your own API can be ' +
        'reached from a browser at all, and talking to us about a proper integration.';
    frag.appendChild(copy);

    frag.appendChild(buildFeedList());
    frag.appendChild(buildKeyPanel(rerender));
    frag.appendChild(buildContactPanel());

    return frag;
}
