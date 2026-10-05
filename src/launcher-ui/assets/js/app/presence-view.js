// Discord section of a game's page: Rich Presence from the game's fix, the [Discord] section of
// its ini (xml2-fix.ini for the XML2 Fix, mua-controller-fix.ini for MUA Controller Fix). The fix
// shows the game on the player's Discord profile while it runs; every key defaults to on, and each
// toggle writes 1 or 0 on its own through the same WritePrivateProfileString semantics as the
// Display section, so the rest of the file stays.
//
// Nothing here is game-specific: the backend (fix/fix_ini.cpp) says which fix, file and switches a
// game has (the XML2 Fix shares the zone and the party, MUA Controller Fix the area and the hero),
// so another game whose fix gets the section only needs adding to SUPPORTED and to that table.
(function () {
    'use strict';

    // Games whose fix has a [Discord] section (fix_ini's table, fix::presence).
    const SUPPORTED = new Set(['xml2', 'xml1', 'mua', 'mua2']);
    // The main switch, then what it shares; the rest only count while it is on.
    const MAIN_KEY = 'Enabled';
    // Each switch the fixes have: its label and its note.
    const DETAILS = {
        ShowZone: ['presence.showZone', 'presence.showZoneBody'],
        ShowParty: ['presence.showParty', 'presence.showPartyBody'],
        ShowHero: ['presence.showHero', 'presence.showHeroBody']
    };
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
        return document.getElementById(`${gameId}-presence-panel`);
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

    // What this game's fix shares besides the main switch, in the backend's order (keys).
    function detailKeys(data) {
        const keys = data && Array.isArray(data.keys) ? data.keys : [MAIN_KEY, 'ShowZone', 'ShowParty'];
        return keys.filter(key => key !== MAIN_KEY && DETAILS[key]);
    }

    // true/false from the file; an absent key (null) or one the fix can't read as 0/1 is shown as
    // the default, which is on.
    function isOn(data, key) {
        const value = data && data.values ? data.values[key] : null;
        if (value === true || value === false) return value;
        const fallback = data && data.defaults ? data.defaults[key] : undefined;
        return fallback === undefined ? true : !!fallback;
    }

    // ---- markup ----

    function toggleHTML(key, on) {
        return `
            <div class="toggle-group small ul-display-toggle ul-presence-toggle" data-key="${escapeHtml(key)}" role="group">
                <button type="button" class="toggle-btn${on ? '' : ' active'}" data-value="0" aria-pressed="${on ? 'false' : 'true'}">${escapeHtml(t('presence.off'))}</button>
                <button type="button" class="toggle-btn${on ? ' active' : ''}" data-value="1" aria-pressed="${on ? 'true' : 'false'}">${escapeHtml(t('presence.on'))}</button>
            </div>`;
    }

    function rowHTML(key, label, description, on, extraClass) {
        return `
            <div class="ul-display-row ul-presence-row${extraClass ? ` ${extraClass}` : ''}" data-row="${escapeHtml(key)}">
                <div class="ul-display-info">
                    <span class="ul-display-label">${escapeHtml(label)}</span>
                    <span class="ul-display-description">${escapeHtml(description)}</span>
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
            <div class="ul-display ul-presence">
                <p class="ul-display-intro">${escapeHtml(t('presence.intro'))}</p>
                <div class="ul-display-status" hidden></div>
                <div class="ul-display-body">${emptyHTML(t('presence.loading'))}</div>
            </div>`;

        host.querySelector('.ul-display-body').addEventListener('click', event => onClick(gameId, event));
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
            s.data = await run('get-presence-settings', { game: backendId(gameId) });
        } catch (error) {
            reportError(error);
            return;
        }
        renderBody(gameId);
    }

    function renderBody(gameId) {
        const host = panel(gameId);
        if (!host) return;
        const body = host.querySelector('.ul-display-body');
        const data = getState(gameId).data;
        const fix = (data && data.fix) || t('presence.theFix');

        if (!data || !data.installed) {
            body.innerHTML = emptyHTML(t('presence.setUpFirst'));
            showStatus(gameId, '');
            return;
        }
        if (!data.fixInstalled) {
            body.innerHTML = emptyHTML(t('presence.installFix', { fix }));
            showStatus(gameId, '');
            return;
        }

        const details = detailKeys(data);
        const mainBody = details.includes('ShowHero') ? 'presence.enabledBodyHero' : 'presence.enabledBody';
        body.innerHTML = `
            ${rowHTML(MAIN_KEY, t('presence.enabled'), t(mainBody), isOn(data, MAIN_KEY), 'is-main')}
            ${details.map(key => rowHTML(key, t(DETAILS[key][0]), t(DETAILS[key][1]), isOn(data, key), 'is-sub')).join('')}
            <p class="ul-display-footer">${escapeHtml(t('presence.storedIn', { file: data.ini || data.file || '' }))}</p>`;
        syncRows(gameId);
        showStatus(gameId, data.running ? t('presence.appliesNextLaunch') : '', 'info');
    }

    // The toggles follow the values; the detail rows only count while presence is on.
    function syncRows(gameId) {
        const host = panel(gameId);
        const data = getState(gameId).data;
        if (!host || !data || !data.values) return;

        const enabled = isOn(data, MAIN_KEY);
        host.querySelectorAll('.ul-presence-toggle').forEach(group => {
            const on = isOn(data, group.dataset.key);
            group.querySelectorAll('.toggle-btn').forEach(button => {
                const active = (button.dataset.value === '1') === on;
                button.classList.toggle('active', active);
                button.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
        });
        detailKeys(data).forEach(key => {
            const row = host.querySelector(`.ul-presence-row[data-row="${key}"]`);
            if (!row) return;
            row.classList.toggle('is-disabled', !enabled);
            row.querySelectorAll('.toggle-btn').forEach(button => { button.disabled = !enabled; });
        });
    }

    // ---- saving ----

    function onClick(gameId, event) {
        const button = event.target.closest('.ul-presence-toggle .toggle-btn');
        if (!button || button.disabled) return;
        const group = button.closest('.ul-presence-toggle');
        queue(gameId, { [group.dataset.key]: button.dataset.value === '1' });
    }

    // Collects changes for a moment and writes them in one go; the rows follow right away.
    function queue(gameId, changes) {
        const s = getState(gameId);
        Object.assign(s.pending, changes);
        if (s.data && s.data.values) Object.assign(s.data.values, changes);
        syncRows(gameId);
        clearTimeout(s.timer);
        s.timer = setTimeout(() => flush(gameId), SAVE_DELAY);
    }

    async function flush(gameId) {
        const s = getState(gameId);
        const changes = s.pending;
        s.pending = {};
        s.timer = null;
        if (!Object.keys(changes).length) return;

        try {
            const result = await run('set-presence-settings', { game: backendId(gameId), values: changes });
            if (!result || !result.success) throw new Error((result && result.error) || t('presence.saveFailed'));
            // What the file holds now, unless newer edits are already waiting.
            if (s.data && result.values && !Object.keys(s.pending).length) {
                s.data.values = result.values;
                syncRows(gameId);
            }
        } catch (error) {
            reportError(error);
            load(gameId); // back to what the file says
        }
    }

    // Refresh when the game's page is opened: the fix may have been installed, or the file edited,
    // since the last look.
    document.addEventListener('click', event => {
        const item = event.target.closest && event.target.closest('.game-item[data-game]');
        if (item && SUPPORTED.has(backendId(item.dataset.game)) && panel(item.dataset.game)) {
            setTimeout(() => load(item.dataset.game), 0);
        }
    }, true);

    window.PresenceView = {
        supports: gameId => SUPPORTED.has(backendId(gameId)),
        render,
        reload: load
    };
})();
