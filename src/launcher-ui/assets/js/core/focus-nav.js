// Keyboard and controller navigation for the whole launcher: the arrow keys move the focus to the
// nearest control in that direction (spatial navigation), Enter or Space presses it, Escape or
// Backspace closes the popup on top or goes back to the previous page. A Steam Deck drives it through
// Steam Input's desktop layout (the D-pad sends arrow keys), and any Xbox-style pad through the Gamepad
// API (gamepad-nav.js, which sends the same keys through press()).
//
// - Inside a toggle group (OFF / ON), Left and Right switch the value; at either end they stay put.
// - A <select> is picked in place: Enter or Space starts, Up / Down (or Left / Right) step through its
//   options, Enter keeps the choice (one change event) and Escape puts the old one back. Chromium 113's
//   own dropdown can't be opened from script, and a pad's keys could not drive it anyway.
// - In a text field Left / Right move the caret (and leave the field at either end), Backspace deletes.
// - A <details>' summary is a control: the arrows reach it, Enter / Space / A open and close it.
// - A popup (the message box, the setup flow, the X-Men Legends wizard and uninstall dialog, the card
//   menu...) keeps the focus while it is open: the arrows and Tab stay inside it, it gets the focus when
//   it opens, and the control that opened it gets it back when it closes.
// - On a page change made from the keyboard the focus follows into the new page, and Back returns to
//   the control that had it there.
// - html[data-nav="keys"] is set while the keyboard or a pad is in use (the focus ring, main.css) and
//   cleared by the mouse or a touch.
(function () {
    'use strict';

    // What is open on top of the page, from the bottom up when several are.
    const LAYERS = '#message-box, .game-settings-backdrop, .component-selection-backdrop, .setup-flow-backdrop, .library-card-menu';
    // The control Escape presses to close a layer, first match wins (the card menu has none: views.js
    // closes it on Escape itself).
    const CLOSE_CONTROLS = ['[data-escape]', '.popup-close', '[data-act="cancel"]', '.btn-cancel', '.btn-setup-cancel', '.launch-redist-cancel-btn', '.redist-popup-close-btn'];
    // Not the first thing a layer focuses: closing it, or something that can't be undone.
    const NOT_FIRST = '.popup-close, .is-danger, .btn-uninstall, .reset-btn';
    const CANDIDATES = 'a, button, input, select, textarea, summary, [tabindex]';
    const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);
    const DIRECTIONS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    // The same action from the keyboard and from a pad this close together is one press seen twice
    // (Steam Input sending arrow keys while the Gamepad API also sees the pad).
    const ECHO_MS = 100;
    const HISTORY_LIMIT = 20;
    // Up and Down never cross between the sidebar and the page (Up at the top of a page would jump to
    // a sidebar item off to the side); Left and Right do. Controls in neither (the progress bar) are
    // reached from both.
    const REGIONS = '.sidebar, .content-area';
    // What tells a re-rendered control for the one it replaced (with its tag and first class).
    const IDENTITY = ['id', 'data-game', 'data-op', 'data-key', 'data-value', 'data-act', 'data-filter', 'data-idx', 'data-row', 'data-field', 'data-option', 'data-choice'];

    const stack = []; // open layers: { element, opener, sawActive }
    const fading = new WeakSet(); // closed layers still on screen for their fade-out
    const history = []; // pages to go back to
    const lastFocus = {}; // page id -> the element that last had the focus on it
    let currentPage = null;
    let lastFocused = null; // the element that last had the focus, anywhere
    let goingBack = false;
    // A page's focus taken before its main control ([data-autofocus], a game's Play) was rendered.
    let provisional = null; // { page, element, until }
    const PROVISIONAL_MS = 2000;
    let picking = null; // the <select> being picked: { select, original }
    let padMuted = false;
    const lastAction = { key: { action: null, at: -Infinity }, pad: { action: null, at: -Infinity } };
    let rectOf = defaultRect;

    // ---- what can have the focus ----

    function connected(element) {
        for (let node = element; node; node = node.parentNode) {
            if (node === document) return true;
        }
        return false;
    }

    function contains(outer, inner) {
        for (let node = inner; node; node = node.parentNode) {
            if (node === outer) return true;
        }
        return false;
    }

    // Structural checks (hidden, inert, display: none up the tree) work without layout too; in the launcher
    // the browser also says whether the element has a box at all.
    function isVisible(element) {
        if (!element || !connected(element)) return false;
        for (let node = element; node && node.nodeType === 1; node = node.parentNode) {
            if (node.hidden || node.hasAttribute('inert') || (node.style && node.style.display === 'none')) return false;
        }
        if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) return false;
        if (typeof window.getComputedStyle === 'function' && window.getComputedStyle(element).visibility === 'hidden') return false;
        return true;
    }

    // A <details>' own summary (its first one) opens and closes it: the browser focuses it without a tabindex.
    function isDetailsSummary(element) {
        const parent = element.parentNode;
        if (element.tagName !== 'SUMMARY' || !parent || parent.tagName !== 'DETAILS') return false;
        return Array.from(parent.childNodes).find(node => node.nodeType === 1 && node.tagName === 'SUMMARY') === element;
    }

    function isFocusable(element) {
        if (!element || element.nodeType !== 1 || element.disabled) return false;
        const tabindex = element.getAttribute('tabindex');
        if (tabindex !== null && parseInt(tabindex, 10) < 0) return false;
        const tag = element.tagName;
        if (isDetailsSummary(element)) return isVisible(element);
        if (tag === 'A' && !element.hasAttribute('href') && tabindex === null) return false;
        if (tag === 'INPUT' && (element.getAttribute('type') || '').toLowerCase() === 'hidden') return false;
        if (!['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(tag) && tabindex === null) return false;
        return isVisible(element);
    }

    function all(root, selector) {
        return Array.from(root.querySelectorAll(selector));
    }

    function focusables(root) {
        return all(root, CANDIDATES).filter(isFocusable);
    }

    function isTextField(element) {
        if (!element) return false;
        if (element.tagName === 'TEXTAREA') return true;
        return element.tagName === 'INPUT' && TEXT_TYPES.has((element.getAttribute('type') || '').toLowerCase());
    }

    // ---- layers ----

    function isOpen(entry) {
        const element = entry.element;
        if (element.id === 'message-box') return element.classList.contains('visible') && isVisible(element);
        if (!isVisible(element)) return false;
        // Popups that fade out keep display: flex for a moment after losing .active.
        if (element.classList.contains('active')) entry.sawActive = true;
        return !(entry.sawActive && !element.classList.contains('active'));
    }

    function topLayer() {
        return stack.length ? stack[stack.length - 1].element : null;
    }

    function firstIn(root) {
        const list = focusables(root);
        return list.find(element => element.hasAttribute('data-autofocus'))
            || list.find(element => !element.matches(NOT_FIRST) && !element.hasAttribute('readonly'))
            || list[0] || null;
    }

    // ---- pages ----

    function activePage() {
        return all(document, '.page-section').find(isVisible) || null;
    }

    function pageId(page) {
        return page ? page.id.replace(/-page$/, '') : null;
    }

    function pageDefault(page) {
        let remembered = page && lastFocus[pageId(page)];
        // The page was rendered again since (the Library is, on every visit): the same control.
        if (remembered && !connected(remembered)) remembered = sameControl(remembered, page);
        if (remembered && isFocusable(remembered) && contains(page, remembered)) return remembered;
        if (page) {
            const list = focusables(page);
            const first = list.find(element => element.hasAttribute('data-autofocus')) || byPosition(list)[0];
            if (first) return first;
        }
        return document.querySelector('.sidebar .nav-item.active') || document.querySelector('.sidebar .game-item.active');
    }

    function byPosition(elements) {
        return elements
            .map((element, index) => ({ element, index, rect: rectOf(element) }))
            .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left) || (a.index - b.index))
            .map(item => item.element);
    }

    function navigate(id) {
        const item = document.getElementById(id) || document.querySelector(`.game-item[data-game="${id}"]`);
        if (item) item.click();
    }

    // ---- focus ----

    function focus(element) {
        if (!element) return false;
        element.focus({ preventScroll: true });
        if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return document.activeElement === element;
    }

    // Where the focus is, if it is somewhere it can be used from.
    function current() {
        const element = document.activeElement;
        if (!element || element === document.body || element === document.documentElement || !isFocusable(element)) return null;
        const layer = topLayer();
        if (layer && !contains(layer, element)) return null;
        return element;
    }

    function scope() {
        return topLayer() || document.body;
    }

    // With no layer open, nothing inside one either (a popup fading out) nor the window's title bar.
    function candidates() {
        const layer = topLayer();
        return focusables(scope()).filter(element => layer || !element.closest(`.title-bar, ${LAYERS}`));
    }

    // ---- spatial navigation ----

    function defaultRect(element) {
        let rect = element.getBoundingClientRect();
        // A visually hidden input (the mods' switches) stands for its label.
        if (!rect.width && !rect.height && element.closest('label')) rect = element.closest('label').getBoundingClientRect();
        return rect;
    }

    function gap(a1, a2, b1, b2) {
        return Math.max(0, b1 - a2, a1 - b2);
    }

    // The candidate nearest `from` in `direction` ('up', 'down', 'left', 'right'): it must lie past
    // from's edge on that side, and the score is the distance along the direction plus twice the
    // sideways gap, so a control in line beats a nearer one off to the side. Going down, a control
    // inside `from` (a card's button) comes first, if it starts below from's top.
    // candidates: [{ element, rect }]; `inside(element)` says whether one is inside from.
    function pick(from, list, direction, inside = () => false) {
        const vertical = direction === 'up' || direction === 'down';
        let best = null;
        let bestScore = Infinity;
        let bestInside = false;
        for (const candidate of list) {
            const r = candidate.rect;
            const within = direction === 'down' && inside(candidate.element);
            let distance;
            if (direction === 'down') distance = within ? r.top - from.top : r.top - from.bottom;
            else if (direction === 'up') distance = from.top - r.bottom;
            else if (direction === 'right') distance = r.left - from.right;
            else distance = from.left - r.right;
            // Past the edge, give or take a pixel of overlap; one inside must start below from's top.
            if (within ? distance <= 0 : distance < -1) continue;
            const sideways = vertical ? gap(from.left, from.right, r.left, r.right) : gap(from.top, from.bottom, r.top, r.bottom);
            const score = Math.max(0, distance) + 2 * sideways;
            if ((within && !bestInside) || (within === bestInside && score < bestScore)) {
                best = candidate.element;
                bestScore = score;
                bestInside = within;
            }
        }
        return best;
    }

    function move(direction) {
        const from = current();
        if (!from) return focus(topLayer() ? firstIn(topLayer()) : pageDefault(activePage()));
        const list = candidates()
            .filter(element => element !== from && !contains(element, from))
            .map(element => ({ element, rect: rectOf(element) }));
        const region = from.closest(REGIONS);
        const reachable = direction === 'left' || direction === 'right' || !region
            ? list
            : list.filter(candidate => [region, null].includes(candidate.element.closest(REGIONS)));
        const next = pick(rectOf(from), reachable, direction, element => contains(from, element));
        if (next) return focus(next);
        // Nothing further that way: show more of a long page or popup instead.
        if (direction === 'up' || direction === 'down') scrollFrom(from, direction === 'down' ? 1 : -1);
        return false;
    }

    function scrollFrom(element, sign) {
        for (let node = element.parentNode; node && node.nodeType === 1; node = node.parentNode) {
            if (typeof node.scrollBy !== 'function' || !(node.scrollHeight > node.clientHeight)) continue;
            const overflow = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(node).overflowY : '';
            if (overflow !== 'auto' && overflow !== 'scroll') continue;
            node.scrollBy({ top: sign * node.clientHeight * 0.4, behavior: 'smooth' });
            return;
        }
    }

    // ---- toggles and selects ----

    function toggleStep(button, direction) {
        const list = all(button.parentNode, '.toggle-btn');
        const next = list[list.indexOf(button) + (direction === 'right' ? 1 : -1)];
        if (!next || next.disabled) return;
        next.click();
        focus(next);
    }

    function startPicking(select) {
        picking = { select, original: select.value };
        select.classList.add('is-picking');
        select.setAttribute('aria-expanded', 'true');
    }

    function stopPicking(keep) {
        if (!picking) return;
        const { select, original } = picking;
        picking = null;
        select.classList.remove('is-picking');
        select.removeAttribute('aria-expanded');
        if (!keep) {
            select.value = original;
        } else if (select.value !== original) {
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function pickStep(direction) {
        const select = picking.select;
        const options = Array.from(select.options).filter(option => !option.disabled);
        const index = options.findIndex(option => option.value === select.value);
        const next = options[index + (direction === 'down' || direction === 'right' ? 1 : -1)];
        if (next) select.value = next.value;
    }

    // ---- actions ----

    // Enter or Space on the focused control. Native controls activate themselves on a real key press;
    // a pad's key (synthetic) and a div standing in for a button need the click.
    function activate(element, event) {
        const tag = element.tagName;
        const synthetic = !event.isTrusted;
        if (tag === 'SELECT') {
            if (picking && picking.select === element) stopPicking(true);
            else startPicking(element);
            return true;
        }
        if (isTextField(element)) return false;
        if (tag === 'BUTTON' || (tag === 'INPUT' && ['button', 'submit', 'reset'].includes((element.getAttribute('type') || '').toLowerCase()))) {
            if (!synthetic) return false;
            element.click();
            return true;
        }
        if (tag === 'INPUT') {
            // A checkbox or radio: Space toggles it natively, Enter doesn't.
            if (!synthetic && event.key === ' ') return false;
            element.click();
            return true;
        }
        if (tag === 'A' && !synthetic && event.key === 'Enter') return false;
        element.click();
        return true;
    }

    function closeLayer(layer) {
        for (const selector of CLOSE_CONTROLS) {
            const control = all(layer, selector).find(element => isVisible(element) && !element.disabled);
            if (control) {
                control.click();
                return true;
            }
        }
        return false;
    }

    function back() {
        if (!history.length) return false;
        const id = history.pop();
        goingBack = true;
        navigate(id);
        sync();
        goingBack = false;
        return true;
    }

    // LB / RB: the previous or next sidebar page (Home, Library, Downloads, Support, Settings),
    // wrapping; a game's page counts as the Library's place.
    function section(delta) {
        const items = all(document, '.sidebar .nav-item').filter(isVisible);
        if (!items.length) return;
        let index = items.findIndex(item => item.classList.contains('active'));
        if (index < 0) index = Math.max(0, items.findIndex(item => item.id === 'library'));
        const next = items[(index + delta + items.length) % items.length];
        setNavMode(true);
        next.click();
        sync();
        focus(next);
    }

    function openMenu(element) {
        const rect = element.getBoundingClientRect();
        const Mouse = window.MouseEvent || Event;
        element.dispatchEvent(new Mouse('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: Math.round(rect.left + rect.width / 2),
            clientY: Math.round(rect.top + rect.height / 2)
        }));
    }

    function actionOf(event) {
        const key = event.key;
        if (DIRECTIONS[key]) return DIRECTIONS[key];
        if (key === 'Enter' || key === ' ' || key === 'Spacebar') return 'activate';
        if (key === 'Escape' || key === 'Esc' || key === 'Backspace') return 'back';
        if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) return 'menu';
        if (key === 'Tab') return 'tab';
        return null;
    }

    // A press already handled from the other source a moment ago: drop it. Seen once, the pad is
    // ignored from then on: the keyboard events Steam Input sends drive the browser's own controls too.
    function isEcho(action, source) {
        const now = Date.now();
        const other = lastAction[source === 'pad' ? 'key' : 'pad'];
        lastAction[source] = { action, at: now };
        if (other.action !== action || now - other.at > ECHO_MS) return false;
        if (!padMuted) {
            padMuted = true;
            console.info('FocusNav: the pad also arrives as keys; using the keys only');
        }
        return true;
    }

    function onKeyDown(event) {
        if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
        const action = actionOf(event);
        if (!action) return;
        const source = event.ulSource === 'pad' ? 'pad' : 'key';
        if (source === 'pad' && padMuted) return;
        if (action !== 'tab' && !(source === 'key' && padMuted) && isEcho(action, source)) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        setNavMode(true);
        sync();
        if (handle(action, event)) {
            event.preventDefault();
            event.stopPropagation();
        }
    }

    // true when the key was used (the browser and the page's own listeners don't see it then).
    function handle(action, event) {
        const element = current();
        const layer = topLayer();

        if (picking) {
            if (!element || element !== picking.select) stopPicking(true);
            else if (action === 'back' || action === 'activate') {
                stopPicking(action === 'activate');
                return true;
            } else if (DIRECTIONS[event.key]) {
                pickStep(action);
                return true;
            } else {
                stopPicking(true);
            }
        }

        if (action === 'tab') {
            if (!layer) return false;
            const list = focusables(layer);
            if (!list.length) return true;
            const index = list.indexOf(element);
            const next = event.shiftKey
                ? list[index <= 0 ? list.length - 1 : index - 1]
                : list[index < 0 || index === list.length - 1 ? 0 : index + 1];
            focus(next);
            return true;
        }

        if (action === 'back') {
            if (event.key === 'Backspace' && isTextField(element)) return false;
            if (layer) return closeLayer(layer);
            return back();
        }

        if (action === 'menu') {
            if (!element) return false;
            openMenu(element);
            return true;
        }

        if (action === 'activate') {
            if (!element) return false;
            return activate(element, event);
        }

        // An arrow.
        if (element && isTextField(element) && (action === 'left' || action === 'right')) {
            const length = String(element.value || '').length;
            const start = element.selectionStart;
            const end = element.selectionEnd;
            const atEdge = typeof start !== 'number' || (start === end && (action === 'left' ? start === 0 : end === length));
            if (!atEdge) return false;
        }
        if (element && (action === 'left' || action === 'right') && element.classList.contains('toggle-btn') && element.parentNode && element.parentNode.classList.contains('toggle-group')) {
            toggleStep(element, action);
            return true;
        }
        move(action);
        return true;
    }

    // ---- keeping up with the page ----

    // Layers opening and closing, and the page changing. Run on every DOM change in the launcher (a
    // MutationObserver) and before every key.
    function sync() {
        // Closed layers leave the stack; the control that opened the top one gets the focus back.
        let closed = null;
        for (let i = stack.length - 1; i >= 0; i--) {
            if (!isOpen(stack[i])) {
                if (stack[i].sawActive && isVisible(stack[i].element)) fading.add(stack[i].element);
                closed = closed || stack[i];
                stack.splice(i, 1);
            }
        }

        // New layers join it, in document order, opened from whatever had the focus.
        const known = new Set(stack.map(entry => entry.element));
        let opened = null;
        document.querySelectorAll(LAYERS).forEach(element => {
            if (known.has(element)) return;
            if (fading.has(element)) {
                if (isVisible(element) && !element.classList.contains('active')) return;
                fading.delete(element);
            }
            const entry = { element, opener: null, sawActive: false };
            if (!isOpen(entry)) return;
            const focused = document.activeElement;
            entry.opener = focused && focused !== document.body && isVisible(focused) && !contains(element, focused) ? focused : null;
            // Opened as another closed (the card menu's Uninstall asking first): back to that one's opener.
            if (!entry.opener && closed) entry.opener = closed.opener;
            stack.push(entry);
            opened = entry;
        });

        if (opened) {
            if (!contains(opened.element, document.activeElement)) focus(firstIn(opened.element));
        } else if (closed) {
            const focused = document.activeElement;
            const lost = !focused || focused === document.body || !isFocusable(focused) || contains(closed.element, focused);
            if (lost) {
                const layer = topLayer();
                const target = closed.opener && isFocusable(closed.opener) && (!layer || contains(layer, closed.opener))
                    ? closed.opener
                    : layer ? firstIn(layer) : pageDefault(activePage());
                focus(target);
            }
        }

        const page = activePage();
        const id = pageId(page);
        if (id && id !== currentPage) {
            const previous = currentPage;
            if (currentPage && !goingBack && history[history.length - 1] !== currentPage) {
                history.push(currentPage);
                if (history.length > HISTORY_LIMIT) history.shift();
            }
            currentPage = id;
            // From the keyboard, the focus follows a page change it was left behind by.
            provisional = null;
            if (previous && isNavMode() && !topLayer()) {
                const focused = document.activeElement;
                if (!focused || focused === document.body || !isFocusable(focused) || goingBack) {
                    const target = pageDefault(page);
                    focus(target);
                    if (!goingBack && !(target && target.hasAttribute('data-autofocus'))) {
                        provisional = { page, element: document.activeElement, until: Date.now() + PROVISIONAL_MS };
                    }
                }
            }
        }

        // The page's main control has appeared and the focus hasn't moved since: there instead.
        if (provisional) {
            const untouched = page === provisional.page && document.activeElement === provisional.element && Date.now() <= provisional.until;
            const main = untouched && focusables(page).find(element => element.hasAttribute('data-autofocus'));
            if (main) focus(main);
            if (main || !untouched) provisional = null;
        }

        if (isNavMode()) recover();
    }

    function identity(element) {
        const first = (element.getAttribute('class') || '').split(/\s+/).filter(Boolean)[0] || '';
        return [element.tagName, first, ...IDENTITY.map(name => element.getAttribute(name))].join('|');
    }

    function sameControl(element, root) {
        const wanted = identity(element);
        return focusables(root || document.body).find(candidate => identity(candidate) === wanted) || null;
    }

    // A list rendered again (Downloads, the Home rows, a section's rows) takes the focused control
    // with it: the focus goes to the control that replaced it.
    function recover() {
        const focused = document.activeElement;
        if (!lastFocused || connected(lastFocused) || (focused && focused !== document.body && connected(focused))) return;
        const replacement = sameControl(lastFocused, topLayer() || activePage());
        if (replacement) focus(replacement);
    }

    function onFocusIn(event) {
        const element = event.target;
        if (!element || element.nodeType !== 1) return;
        lastFocused = element;
        const layer = topLayer();
        if (layer && !contains(layer, element)) {
            const inside = firstIn(layer);
            if (inside && inside !== element) focus(inside);
            return;
        }
        const page = element.closest && element.closest('.page-section');
        if (page) lastFocus[pageId(page)] = element;
    }

    function onFocusOut(event) {
        if (picking && event.target === picking.select) stopPicking(true);
    }

    function isNavMode() {
        return document.documentElement.getAttribute('data-nav') === 'keys';
    }

    function setNavMode(on) {
        if (on) document.documentElement.setAttribute('data-nav', 'keys');
        else document.documentElement.removeAttribute('data-nav');
    }

    // A key press as the keyboard would send it (gamepad-nav.js): the page's own Escape listeners see
    // it too. source 'pad' marks it for the echo check.
    function press(key, source = 'pad') {
        const target = document.activeElement || document.body;
        const Keyboard = window.KeyboardEvent || Event;
        const event = new Keyboard('keydown', { key, bubbles: true, cancelable: true });
        event.ulSource = source;
        target.dispatchEvent(event);
    }

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    ['mousedown', 'pointerdown', 'touchstart'].forEach(type => {
        document.addEventListener(type, () => setNavMode(false), true);
    });
    if (typeof window.MutationObserver === 'function') {
        const start = () => {
            new MutationObserver(sync).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
            sync();
        };
        if (document.body) start();
        else document.addEventListener('DOMContentLoaded', start);
    }

    window.FocusNav = {
        pick,
        press,
        section,
        sync,
        isFocusable,
        // Tests (no layout there): where each element is.
        setRectSource(fn) {
            rectOf = fn || defaultRect;
        },
        isPadMuted: () => padMuted
    };
})();
