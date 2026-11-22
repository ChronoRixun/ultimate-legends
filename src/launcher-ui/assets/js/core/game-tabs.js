// Tabs on a game's page (the X-Men Legends page today; TAB-MAP.md): a strip of chip buttons under the
// page's persistent header (Play, the test-mode badge, the attention strip) and one panel per tab. Panels
// stay mounted while hidden, so every section keeps rendering into its own host and keeps its focus
// restore; switching tabs only toggles `hidden`, as on the Support page.
//
// A game registers its tabs with define(): each tab says when it exists (`available`, e.g. Online only
// once the game is built). A tab whose panel has rendered but holds no control at all is hidden too ("no
// empty tabs": an empty-state sentence is not content), so a section that later hides its controls (Proton)
// takes its tab with it without a special case. Overview is the first tab ever opened; after that the tab
// the player last picked, remembered across restarts (localStorage). A state the game enters can pick a tab
// once (`override`: a build running or damaged opens Build & tools), never again until the state changes,
// and it is not remembered as the player's choice.
//
// Keys: the chips are plain buttons, so arrows and the pad's D-pad reach them through focus-nav.js; LT / RT
// on a pad (gamepad-nav.js) and Ctrl+PageUp / Ctrl+PageDown step through the visible tabs.
(function () {
    'use strict';

    const STORE_PREFIX = 'ul.gameTab.';
    const CONTROLS = 'button,input,select,textarea,a[href],[role="combobox"],[role="switch"]';

    const t = (key, vars) => (window.LauncherI18n ? window.LauncherI18n.t(key, vars) : key);
    const esc = value => String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // gameId -> { tabs: [{ id, label, available }], fallback, override, active, picked, lastState }
    const games = new Map();

    function storage() {
        try {
            return window.localStorage || null;
        } catch (_) {
            return null;
        }
    }

    function remembered(gameId) {
        try {
            const store = storage();
            return store ? store.getItem(STORE_PREFIX + gameId) : null;
        } catch (_) {
            return null;
        }
    }

    function remember(gameId, tabId) {
        try {
            const store = storage();
            if (store) store.setItem(STORE_PREFIX + gameId, tabId);
        } catch (_) {
            // A private window or a full store: the tab is only remembered for this session.
        }
    }

    // define(gameId, { tabs: [{ id, label (i18n key), available?: () => bool, always?: true (shown even with
    //                  nothing to use yet) }], fallback?: 'overview',
    //                  override?: () => ({ state, tab } | null) })
    function define(gameId, spec) {
        const tabs = (spec && Array.isArray(spec.tabs) ? spec.tabs : []).filter(tab => tab && tab.id);
        const fallback = spec.fallback || (tabs[0] && tabs[0].id) || '';
        const saved = remembered(gameId);
        games.set(gameId, {
            tabs,
            fallback,
            override: typeof spec.override === 'function' ? spec.override : null,
            onRefresh: typeof spec.onRefresh === 'function' ? spec.onRefresh : null,
            // What is shown, and what the player (or a state, once) asked for: a remembered tab that does
            // not exist yet (the page still loading) shows Overview and comes back when it appears.
            active: fallback,
            preferred: tabs.some(tab => tab.id === saved) ? saved : fallback,
            lastState: undefined
        });
    }

    function has(gameId) {
        return games.has(gameId);
    }

    function stripId(gameId) {
        return `${gameId}-tabs`;
    }

    function panelOf(gameId, tabId) {
        return document.getElementById(`${gameId}-panel-${tabId}`);
    }

    function chipOf(gameId, tabId) {
        return document.getElementById(`${gameId}-tab-${tabId}`);
    }

    // The strip's markup, for views.js (all chips; refresh() hides the ones that don't apply).
    function stripHTML(gameId) {
        const game = games.get(gameId);
        if (!game) return '';
        const chips = game.tabs.map(tab => {
            const on = tab.id === game.active;
            // Hidden until refresh() has checked it (views.js refreshes right after rendering).
            const shown = tab.id === game.fallback || on;
            return `<button type="button" class="chip game-tab${on ? ' active' : ''}" role="tab" id="${esc(gameId)}-tab-${esc(tab.id)}"
                data-game-tab="${esc(tab.id)}" data-game="${esc(gameId)}" aria-selected="${on ? 'true' : 'false'}"
                aria-controls="${esc(gameId)}-panel-${esc(tab.id)}"${shown ? '' : ' hidden'}>${esc(t(tab.label))}</button>`;
        }).join('');
        return `<div class="filter-chips game-tabs" role="tablist" id="${esc(stripId(gameId))}" data-game="${esc(gameId)}"
            aria-label="${esc(t('gameTabs.label'))}">${chips}</div>`;
    }

    // A panel's wrapper, for views.js: hidden unless it is the active tab.
    function panelHTML(gameId, tabId, inner) {
        const game = games.get(gameId);
        const on = !!game && game.active === tabId;
        return `<div class="game-tabpanel" role="tabpanel" id="${esc(gameId)}-panel-${esc(tabId)}" data-game-panel="${esc(tabId)}"
            aria-labelledby="${esc(gameId)}-tab-${esc(tabId)}"${on ? '' : ' hidden'}>${inner}</div>`;
    }

    // Whether a rendered panel has nothing to use: no button, field, picker or link. A panel whose sections
    // haven't rendered yet (empty hosts) counts as not empty, so a tab doesn't blink out while it loads.
    function isEmpty(panel) {
        if (!panel) return false;
        if (!String(panel.textContent || '').trim()) return false;
        return panel.querySelectorAll(CONTROLS).length === 0;
    }

    function isAvailable(gameId, tab) {
        let available = true;
        try {
            available = typeof tab.available === 'function' ? !!tab.available() : true;
        } catch (_) {
            available = true;
        }
        const panel = panelOf(gameId, tab.id);
        return available && !!panel && !isEmpty(panel);
    }

    function visibleTabs(gameId) {
        const game = games.get(gameId);
        if (!game) return [];
        return game.tabs.filter(tab => tab.id === game.fallback || (tab.always && !!panelOf(gameId, tab.id)) || isAvailable(gameId, tab)).map(tab => tab.id);
    }

    // Shows `tabId`'s panel and marks its chip. `user`: the player picked it (remembered).
    function select(gameId, tabId, { user = false, focus = false } = {}) {
        const game = games.get(gameId);
        if (!game || !game.tabs.some(tab => tab.id === tabId)) return false;
        const visible = visibleTabs(gameId);
        if (user && !visible.includes(tabId)) return false;
        game.preferred = tabId;
        if (user) remember(gameId, tabId);
        if (!visible.includes(tabId)) tabId = game.fallback;
        const previous = game.active;
        game.active = tabId;

        const focused = document.activeElement;
        for (const tab of game.tabs) {
            const on = tab.id === tabId;
            const chip = chipOf(gameId, tab.id);
            if (chip) {
                chip.classList.toggle('active', on);
                chip.setAttribute('aria-selected', on ? 'true' : 'false');
                chip.hidden = !visible.includes(tab.id);
            }
            const panel = panelOf(gameId, tab.id);
            if (panel) panel.hidden = !on;
        }
        // Focus never stays inside a panel that just closed: it goes to the tab that opened.
        const closed = previous !== tabId ? panelOf(gameId, previous) : null;
        const chip = chipOf(gameId, tabId);
        if (chip && (focus || (closed && focused && closed.contains(focused)))) chip.focus();
        if (previous !== tabId) {
            window.dispatchEvent(new CustomEvent('ul-game-tab-changed', { detail: { game: gameId, tab: tabId, user } }));
        }
        return true;
    }

    // Re-checks which tabs exist and applies a state's tab once when the game enters that state. Called by
    // the views whenever what they show may have changed (views.js wires the usual events).
    function refresh(gameId) {
        const game = games.get(gameId);
        if (!game) return;
        let wanted = null;
        if (game.override) {
            let result = null;
            try {
                result = game.override();
            } catch (_) {
                result = null;
            }
            const state = result && result.state !== undefined ? result.state : null;
            if (state !== game.lastState) {
                game.lastState = state;
                if (result && result.tab) wanted = result.tab;
            }
        }
        select(gameId, wanted || game.preferred);
        if (game.onRefresh) {
            try {
                game.onRefresh();
            } catch (error) {
                console.error('game tabs: refresh hook failed', error);
            }
        }
    }

    function refreshAll() {
        for (const gameId of games.keys()) refresh(gameId);
    }

    // The tabbed game page on screen, if any.
    function shownGame() {
        for (const gameId of games.keys()) {
            const page = document.getElementById(`${gameId}-page`);
            if (!page || !chipOf(gameId, games.get(gameId).fallback)) continue;
            if (page.style && page.style.display === 'none') continue;
            return gameId;
        }
        return null;
    }

    // LT / RT, Ctrl+PageUp / Ctrl+PageDown: the previous or next visible tab (wrapping), focusing its chip.
    function step(delta, gameId = shownGame()) {
        const game = gameId ? games.get(gameId) : null;
        if (!game) return false;
        const visible = visibleTabs(gameId);
        if (!visible.length) return false;
        const index = Math.max(0, visible.indexOf(game.active));
        const next = visible[(index + delta + visible.length) % visible.length];
        return select(gameId, next, { user: true, focus: true });
    }

    function onClick(event) {
        const chip = event.target && event.target.closest ? event.target.closest('[data-game-tab]') : null;
        if (!chip || !games.has(chip.dataset.game)) return;
        select(chip.dataset.game, chip.dataset.gameTab, { user: true });
    }

    function onKeyDown(event) {
        if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        if (event.key !== 'PageUp' && event.key !== 'PageDown') return;
        // A layer over the page (a message box, a popup) keeps its keys.
        if (window.FocusNav && typeof window.FocusNav.hasLayer === 'function' && window.FocusNav.hasLayer()) return;
        if (step(event.key === 'PageUp' ? -1 : 1)) {
            event.preventDefault();
            if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }
    }

    // After the views have handled the same event (they re-render first; this runs a moment later).
    let queued = false;
    function queueRefresh() {
        if (queued) return;
        queued = true;
        Promise.resolve().then(() => {
            queued = false;
            refreshAll();
        });
    }

    if (typeof document.addEventListener === 'function') {
        document.addEventListener('click', onClick);
        document.addEventListener('keydown', onKeyDown);
    }
    ['ul-xml1-changed', 'gameInstallationUpdated', 'ul-testmode-changed', 'ul-download-queue-changed', 'ul-section-rendered']
        .forEach(name => window.addEventListener(name, queueRefresh));
    // A section that renders on its own (a poll, a download) can empty or fill a panel.
    function observe() {
        const host = document.getElementById('game-pages');
        if (!host || typeof window.MutationObserver !== 'function' || host.dataset.tabsObserved) return;
        host.dataset.tabsObserved = 'true';
        new window.MutationObserver(queueRefresh).observe(host, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
        document.addEventListener('DOMContentLoaded', observe);
    } else {
        observe();
    }

    window.GameTabs = {
        define,
        has,
        stripHTML,
        panelHTML,
        select,
        refresh,
        refreshAll,
        queueRefresh,
        step,
        visibleTabs,
        shownGame,
        active: gameId => (games.get(gameId) || {}).active || null,
        preferred: gameId => (games.get(gameId) || {}).preferred || null,
        STORE_PREFIX
    };
})();
