// Test mode section of the X-Men Legends page, and its badge next to Play: the XML2 Fix's [TestMode]
// switches (1.6.0 on) in the port's xml2-fix.ini, for testers who would otherwise edit the file by
// hand (on a Steam Deck, say). Both default to off; each toggle writes 1 or 0 on its own through the
// same WritePrivateProfileString semantics as the Display and Discord sections, so every other key
// and section of the file stays. While either is on the fix refuses online play, so the page says so,
// and the badge next to Play shows it with a one-click Turn test mode off.
//
// The toggles are plain buttons, like the Discord section's: Tab / Shift+Tab or the arrow keys (a
// controller, through focus-nav.js) reach them, Left / Right, Enter or Space switch them, and so do a
// click or a tap; the focus ring shows where the keyboard is (main.css).
(function () {
    'use strict';

    // Games whose fix has a [TestMode] section the launcher offers (fix_ini's table, fix::test_mode).
    const SUPPORTED = new Set(['xml1']);
    const KEYS = ['ForgeEverywhere', 'Hotkeys'];
    // Each switch: its label and its note.
    const DETAILS = {
        ForgeEverywhere: ['testMode.forgeEverywhere', 'testMode.forgeEverywhereBody'],
        Hotkeys: ['testMode.hotkeys', 'testMode.hotkeysBody']
    };
    // The first XML2 Fix that reads [TestMode].
    const REQUIRED_FIX = '1.6.0';
    const SAVE_DELAY = 250;

    const state = {};
    const escapeHtml = value => GameUtils.escapeHtml(value);

    function t(key, variables) {
        return window.LauncherI18n ? window.LauncherI18n.t(key, variables) : key;
    }

    function backendId(gameId) {
        return (GameUtils.getGameMapping && GameUtils.getGameMapping(gameId)) || gameId;
    }

    function run(command, payload) {
        return window.executeCommand(command, payload);
    }

    function panel(gameId) {
        return document.getElementById(`${gameId}-testmode-panel`);
    }

    function badgeHost(gameId) {
        return document.getElementById(`${gameId}-testmode-badge`);
    }

    function getState(gameId) {
        if (!state[gameId]) {
            state[gameId] = { data: null, pending: {}, timer: null };
        }
        return state[gameId];
    }

    function reportError(error) {
        console.error(error);
        window.showToast(String((error && error.message) || error), 'error');
    }

    // true only for a key the file has as on; absent (null) or a value the fix can't read as 0/1 is
    // the default, off.
    function isOn(data, key) {
        const value = data && data.values ? data.values[key] : null;
        return value === true;
    }

    function anyOn(data) {
        return !!(data && data.fixInstalled && KEYS.some(key => isOn(data, key)));
    }

    // A build running or starting in the folder: the builder merges the ini, so nothing else writes it.
    function building() {
        const port = window.Xml1Port;
        return !!(port && (port.starting || port.isBuilding()));
    }

    // "1.5.0" < "1.6.0"; null when the folder's fix has no version to compare.
    function fixTooOld() {
        const port = window.Xml1Port;
        const version = port && port.status && port.status.fix && port.status.fix.installed ? port.status.fix.version : null;
        if (!version) return null;
        const parts = text => String(text).split('.').map(part => parseInt(part, 10) || 0);
        const have = parts(version);
        const need = parts(REQUIRED_FIX);
        for (let i = 0; i < need.length; i++) {
            if ((have[i] || 0) !== need[i]) return (have[i] || 0) < need[i] ? version : null;
        }
        return null;
    }

    // ---- markup ----

    function toggleHTML(key, on) {
        return `
            <div class="toggle-group small ul-display-toggle ul-testmode-toggle" data-key="${escapeHtml(key)}" role="group" aria-label="${escapeHtml(t(DETAILS[key][0]))}">
                <button type="button" class="toggle-btn${on ? '' : ' active'}" data-value="0" aria-pressed="${on ? 'false' : 'true'}">${escapeHtml(t('testMode.off'))}</button>
                <button type="button" class="toggle-btn${on ? ' active' : ''}" data-value="1" aria-pressed="${on ? 'true' : 'false'}">${escapeHtml(t('testMode.on'))}</button>
            </div>`;
    }

    function rowHTML(key, on) {
        return `
            <div class="ul-display-row ul-testmode-row" data-row="${escapeHtml(key)}">
                <div class="ul-display-info">
                    <span class="ul-display-label">${escapeHtml(t(DETAILS[key][0]))}</span>
                    <span class="ul-display-description">${escapeHtml(t(DETAILS[key][1]))}</span>
                </div>
                <div class="ul-display-control">${toggleHTML(key, on)}</div>
            </div>`;
    }

    function emptyHTML(text) {
        return `<div class="ul-display-empty">${escapeHtml(text)}</div>`;
    }

    function render(gameId) {
        const host = panel(gameId);
        if (!host) return;

        host.innerHTML = `
            <div class="ul-display ul-testmode">
                <p class="ul-display-intro">${escapeHtml(t('testMode.intro'))}</p>
                <div class="xml1-note is-warn ul-testmode-online">${escapeHtml(t('testMode.onlineOff'))}</div>
                <div class="ul-display-status" hidden></div>
                <div class="ul-display-body">${emptyHTML(t('testMode.loading'))}</div>
            </div>`;

        host.querySelector('.ul-display-body').addEventListener('click', event => onClick(gameId, event));
        renderBadge(gameId);
        load(gameId);
    }

    function showStatus(gameId, text, kind) {
        const status = panel(gameId) && panel(gameId).querySelector('.ul-display-status');
        if (!status) return;
        status.hidden = !text;
        status.textContent = text || '';
        status.className = `ul-display-status${kind ? ` is-${kind}` : ''}`;
    }

    async function load(gameId) {
        const s = getState(gameId);
        try {
            s.data = await run('get-test-mode-settings', { game: backendId(gameId) });
        } catch (error) {
            reportError(error);
            return;
        }
        // Edits not saved yet win over what the file said a moment ago.
        if (s.data && s.data.values) Object.assign(s.data.values, s.pending);
        renderBody(gameId);
    }

    function renderBody(gameId) {
        const host = panel(gameId);
        if (!host) return;
        const body = host.querySelector('.ul-display-body');
        const data = getState(gameId).data;
        const fix = (data && data.fix) || 'XML2 Fix';

        if (!data || !data.installed) {
            body.innerHTML = emptyHTML(t('testMode.setUpFirst'));
        } else if (!data.fixInstalled) {
            body.innerHTML = emptyHTML(t('testMode.installFix', { fix }));
        } else {
            body.innerHTML = `
                ${KEYS.map(key => rowHTML(key, isOn(data, key))).join('')}
                <p class="ul-display-footer">${escapeHtml(t('testMode.storedIn', { file: data.ini || data.file || '' }))}</p>`;
        }
        sync(gameId);
    }

    // The toggles, the status line and the badge follow the values and the build.
    function sync(gameId) {
        const host = panel(gameId);
        const data = getState(gameId).data;
        if (host && data && data.fixInstalled) {
            const busy = building();
            host.querySelectorAll('.ul-testmode-toggle').forEach(group => {
                const on = isOn(data, group.dataset.key);
                group.querySelectorAll('.toggle-btn').forEach(button => {
                    const active = (button.dataset.value === '1') === on;
                    button.classList.toggle('active', active);
                    button.setAttribute('aria-pressed', active ? 'true' : 'false');
                    button.disabled = busy;
                });
            });
            host.querySelectorAll('.ul-testmode-row').forEach(row => row.classList.toggle('is-disabled', busy));

            const old = fixTooOld();
            if (busy) showStatus(gameId, t('testMode.buildRunning'), 'info');
            else if (old) showStatus(gameId, t('testMode.needsNewerFix', { required: REQUIRED_FIX, version: old }), 'error');
            else showStatus(gameId, data.running ? t('testMode.appliesNextLaunch') : '', 'info');
        } else {
            showStatus(gameId, '');
        }
        renderBadge(gameId);
    }

    // Next to Play: shown while either switch is on.
    function renderBadge(gameId) {
        const host = badgeHost(gameId);
        if (!host) return;
        const on = anyOn(getState(gameId).data);
        if (!on) {
            const focused = document.activeElement;
            const hadFocus = !!focused && !!focused.closest && focused.closest(`#${gameId}-testmode-badge`) === host;
            host.hidden = true;
            host.innerHTML = '';
            // A keyboard or controller user who pressed Turn test mode off lands on Play, not on nothing.
            if (hadFocus) {
                const group = document.getElementById(`${gameId}-button-group`);
                const next = group && [...group.querySelectorAll('button')].find(button => !button.disabled);
                if (next) next.focus();
            }
            return;
        }
        if (host.hidden || !host.querySelector('.ul-testmode-off')) {
            host.innerHTML = `
                <div class="ul-testmode-badge" role="status">
                    <span class="ul-testmode-badge-dot" aria-hidden="true"></span>
                    <span class="ul-testmode-badge-text">
                        <span class="ul-testmode-badge-title">${escapeHtml(t('testMode.badge'))}</span>
                        <span class="ul-testmode-badge-note">${escapeHtml(t('testMode.badgeOnline'))}</span>
                    </span>
                    <button type="button" class="secondary-action xml1-small ul-testmode-off">${escapeHtml(t('testMode.turnOff'))}</button>
                </div>`;
            host.querySelector('.ul-testmode-off').addEventListener('click', () => turnOff(gameId));
            host.hidden = false;
        }
        host.querySelector('.ul-testmode-off').disabled = building();
    }

    // ---- saving ----

    function onClick(gameId, event) {
        const button = event.target.closest('.ul-testmode-toggle .toggle-btn');
        if (!button || button.disabled) return;
        const group = button.closest('.ul-testmode-toggle');
        queue(gameId, { [group.dataset.key]: button.dataset.value === '1' });
    }

    // Collects changes for a moment and writes them in one go; the rows and the badge follow right away.
    function queue(gameId, changes) {
        const s = getState(gameId);
        Object.assign(s.pending, changes);
        if (s.data && s.data.values) Object.assign(s.data.values, changes);
        sync(gameId);
        clearTimeout(s.timer);
        s.timer = setTimeout(() => flush(gameId), SAVE_DELAY);
    }

    // Both switches off, written at once: only the keys that are not already off (an absent key is off
    // and stays absent).
    function turnOff(gameId) {
        const s = getState(gameId);
        const values = (s.data && s.data.values) || {};
        const changes = {};
        KEYS.forEach(key => {
            if (values[key] !== null && values[key] !== undefined && values[key] !== false) changes[key] = false;
        });
        if (!Object.keys(changes).length) return Promise.resolve();
        queue(gameId, changes);
        clearTimeout(s.timer);
        return flush(gameId);
    }

    async function flush(gameId) {
        const s = getState(gameId);
        const changes = s.pending;
        s.pending = {};
        s.timer = null;
        if (!Object.keys(changes).length) return;

        try {
            const result = await run('set-test-mode-settings', { game: backendId(gameId), values: changes });
            if (!result || !result.success) throw new Error((result && result.error) || t('testMode.saveFailed'));
            // What the file holds now, unless newer edits are already waiting.
            if (s.data && result.values && !Object.keys(s.pending).length) {
                s.data.values = result.values;
                sync(gameId);
            }
        } catch (error) {
            reportError(error);
            await load(gameId); // back to what the file says
        }
    }

    function reloadAll() {
        SUPPORTED.forEach(gameId => {
            if (panel(gameId) || badgeHost(gameId)) load(gameId);
        });
    }

    // Refresh when the game's page is opened (the file may have been edited, or the fix installed,
    // since the last look) and when a build, a Verify or an uninstall has finished.
    document.addEventListener('click', event => {
        const item = event.target.closest && event.target.closest('.game-item[data-game]');
        if (item && SUPPORTED.has(backendId(item.dataset.game)) && panel(item.dataset.game)) {
            setTimeout(() => load(item.dataset.game), 0);
        }
    }, true);
    window.addEventListener('gameInstallationUpdated', reloadAll);
    // A build starting or ending enables or disables the toggles.
    window.addEventListener('ul-xml1-changed', () => {
        SUPPORTED.forEach(gameId => {
            if (getState(gameId).data) sync(gameId);
        });
    });

    window.TestModeView = {
        supports: gameId => SUPPORTED.has(backendId(gameId)),
        render,
        reload: load,
        turnOff
    };
})();
