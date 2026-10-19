// Browse games: the public game browser under Host / Join in the X-Men Legends page's Online section
// (launcher 0.4.0, contract v1.3). Hosts who turn on List my game publicly are listed by the broker
// (get-public-rooms fetches https://<broker>:10021/v1/rooms on a worker, the certificate pinned); each
// row says the room's name, its host, the mode and level, "N of 4", In progress, and has Join - exactly
// the code flow, with the row's code (online-view.js).
//
// Join is off on a row whose game is another build (its version_token isn't this folder's [Online]
// GameVersion), that is full, that needs a password, or that can't take a player now, with the reason
// on the row; and on every row while the Online section's own reason (a build, test mode, the game
// running...) holds. The list refreshes every 10 s while the page is visible, and on Refresh. What the
// broker sends is shown as text only, and a row without a valid code is left out.
//
// Keyboard and controller: Refresh and each row's Join are buttons in the Tab order; a refresh keeps the
// focus on the same row's Join (or on Refresh when that row is gone).
(function () {
    'use strict';

    const REFRESH_MS = 10000;
    // After a 429 or a 503, the next automatic refresh waits longer.
    const BACKOFF_MS = 30000;
    const FETCH_POLL_MS = 250;
    const MAX_ROWS = 50;
    const MODES = ['campaign', 'danger_room'];
    const ERRORS = ['unreachable', 'rate_limited', 'busy', 'bad_pin', 'bad_response'];

    const state = {};
    const escapeHtml = value => GameUtils.escapeHtml(value);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function t(key, variables) {
        return window.LauncherI18n ? window.LauncherI18n.t(key, variables) : key;
    }

    function run(command, payload) {
        return window.executeCommand(command, payload);
    }

    function getState(gameId) {
        if (!state[gameId]) {
            state[gameId] = { host: null, options: null, rooms: null, error: null, versionToken: '', fetching: false,
                lastFetch: 0, wait: REFRESH_MS, shown: '' };
        }
        return state[gameId];
    }

    function text(value, max) {
        const s = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
        return max && s.length > max ? `${s.slice(0, max - 1)}…` : s;
    }

    // A row of the broker's list as the page uses it, or null when it isn't one (no valid code).
    function readRoom(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const checked = window.OnlineView ? window.OnlineView.checkCode(raw.code) : { code: null };
        if (!checked.code) return null;
        const count = value => (Number.isInteger(value) && value >= 0 ? value : null);
        return {
            code: checked.code,
            name: text(raw.name, 48),
            host: text(raw.host_display_name, 32),
            mode: MODES.includes(raw.game_mode) ? raw.game_mode : null,
            zone: text(raw.zone, 200),
            versionToken: typeof raw.version_token === 'string' ? raw.version_token.trim() : '',
            players: count(raw.players),
            maxPlayers: count(raw.max_players) || null,
            inProgress: raw.in_progress === true,
            joinable: raw.joinable !== false,
            password: raw.password_protected === true
        };
    }

    // Why this row's Join is off, or null. With no GameVersion in this folder's ini nothing is compared
    // (the game itself still refuses another build: version_mismatch).
    function rowReason(room, versionToken) {
        if (versionToken && room.versionToken !== versionToken) return 'differentVersion';
        if (room.maxPlayers && room.players !== null && room.players >= room.maxPlayers) return 'full';
        if (room.password) return 'password';
        if (!room.joinable) return 'closed';
        return null;
    }

    // ---- markup ----

    function render(gameId, host, options) {
        const s = getState(gameId);
        s.host = host;
        s.options = options;
        s.shown = '';
        host.innerHTML = `
            <div class="ul-online-browse-head">
                <h4 class="ul-online-card-title" id="${escapeHtml(gameId)}-online-browse-title">${escapeHtml(t('online.browse.title'))}</h4>
                <button type="button" class="secondary-action xml1-small ul-online-browse-refresh">${escapeHtml(t('online.browse.refresh'))}</button>
            </div>
            <p class="ul-online-browse-status" role="status" aria-live="polite"></p>
            <ul class="ul-online-rooms" aria-labelledby="${escapeHtml(gameId)}-online-browse-title"></ul>`;
        host.querySelector('.ul-online-browse-refresh').addEventListener('click', () => refresh(gameId, true));
        host.querySelector('.ul-online-rooms').addEventListener('click', event => {
            const button = event.target.closest && event.target.closest('.ul-online-room-join');
            if (!button || button.disabled) return;
            const row = button.closest('.ul-online-room');
            if (row && s.options && s.options.join) s.options.join(row.dataset.code);
        });
        show(gameId);
    }

    function rowHTML(room, versionToken, blocked) {
        const reason = rowReason(room, versionToken);
        const name = room.name || (room.host ? t('online.browse.hostsGame', { name: room.host }) : t('online.browse.unnamed'));
        const level = window.OnlineZones ? window.OnlineZones.levelName(room.zone) : room.zone;
        const where = [room.mode ? t(`online.browse.mode.${room.mode}`) : '', level].filter(Boolean).join(' · ');
        const players = room.players === null ? ''
            : room.maxPlayers ? t('online.browse.players', { count: room.players, max: room.maxPlayers })
                : t('online.browse.playersPlain', { count: room.players });
        return `
            <li class="ul-online-room${reason ? ' is-off' : ''}" data-code="${escapeHtml(room.code)}" data-reason="${escapeHtml(reason || '')}">
                <div class="ul-online-room-main">
                    <span class="ul-online-room-name">${escapeHtml(name)}</span>
                    ${room.host ? `<span class="ul-online-room-host">${escapeHtml(t('online.browse.hostedBy', { name: room.host }))}</span>` : ''}
                    ${where ? `<span class="ul-online-room-where">${escapeHtml(where)}</span>` : ''}
                </div>
                <div class="ul-online-room-meta">
                    ${players ? `<span class="ul-online-room-players">${escapeHtml(players)}</span>` : ''}
                    ${room.inProgress ? `<span class="ul-online-room-badge">${escapeHtml(t('online.browse.inProgress'))}</span>` : ''}
                    ${reason ? `<span class="ul-online-room-reason">${escapeHtml(t(`online.browse.${reason}`))}</span>` : ''}
                    <button type="button" class="ul-online-primary ul-online-room-join" aria-label="${escapeHtml(t('online.browse.joinLabel', { name }))}"
                        ${reason || blocked ? 'disabled' : ''}>${escapeHtml(t('online.browse.join'))}</button>
                </div>
            </li>`;
    }

    // The status line and the rows, from the state; rebuilt only when they change, the focus kept on the
    // same row's Join.
    function show(gameId) {
        const s = getState(gameId);
        if (!s.host) return;
        const blocked = !!(s.options && s.options.blocked && s.options.blocked());
        const rooms = s.rooms || [];

        let status = '';
        let kind = '';
        if (s.error) {
            kind = 'error';
            status = s.error === 'unreachable'
                ? `${t('online.errors.broker_unreachable.title')}. ${t('online.errors.broker_unreachable.body')}`
                : s.error === 'bad_pin'
                    ? `${t('online.errors.tls_pin_mismatch.title')}. ${t('online.errors.tls_pin_mismatch.body')}`
                    : t(`online.browse.errors.${ERRORS.includes(s.error) ? s.error : 'bad_response'}`);
        } else if (s.rooms === null) {
            status = t('online.browse.loading');
        } else if (!rooms.length) {
            status = t('online.browse.empty');
        }

        const signature = JSON.stringify([status, kind, s.versionToken, blocked, rooms]);
        const refresh = s.host.querySelector('.ul-online-browse-refresh');
        refresh.disabled = s.fetching;
        refresh.setAttribute('aria-busy', s.fetching ? 'true' : 'false');
        refresh.textContent = t(s.fetching ? 'online.browse.refreshing' : 'online.browse.refresh');
        if (signature === s.shown) return;
        s.shown = signature;

        const line = s.host.querySelector('.ul-online-browse-status');
        line.textContent = status;
        line.hidden = !status;
        line.className = `ul-online-browse-status${kind ? ` is-${kind}` : ''}`;

        const list = s.host.querySelector('.ul-online-rooms');
        const focused = document.activeElement;
        const focusedRow = focused && focused.closest && focused.closest('.ul-online-room');
        const focusedCode = focusedRow && focusedRow.parentNode === list ? focusedRow.dataset.code : null;
        list.innerHTML = rooms.map(room => rowHTML(room, s.versionToken, blocked)).join('');
        list.hidden = !rooms.length;
        if (focusedCode) {
            const again = list.querySelector(`.ul-online-room[data-code="${focusedCode}"] .ul-online-room-join`);
            if (again && !again.disabled) again.focus();
            else if (!refresh.disabled) refresh.focus();
            else s.host.querySelector('.ul-online-browse-status').focus();
        }
    }

    // ---- fetching ----

    async function refresh(gameId, byHand) {
        const s = getState(gameId);
        if (s.fetching) return;
        s.fetching = true;
        s.lastFetch = Date.now();
        const focusRefresh = byHand && document.activeElement && document.activeElement.classList
            && document.activeElement.classList.contains('ul-online-browse-refresh');
        show(gameId);
        let answer = null;
        try {
            answer = await run('get-public-rooms', { game: gameId, refresh: true });
            while (answer && answer.fetching) {
                await sleep(FETCH_POLL_MS);
                answer = await run('get-public-rooms', { game: gameId, refresh: false });
            }
        } catch (error) {
            console.error('online: public rooms failed', error);
        }
        s.fetching = false;
        s.lastFetch = Date.now();

        const result = answer && answer.result;
        if (answer && typeof answer.versionToken === 'string') s.versionToken = answer.versionToken.trim();
        if (result && result.ok && Array.isArray(result.rooms)) {
            s.error = null;
            s.rooms = result.rooms.map(readRoom).filter(Boolean).slice(0, MAX_ROWS);
            s.wait = REFRESH_MS;
        } else {
            // The last list stays up under the error (a refresh that failed doesn't empty it).
            s.error = (result && result.error) || 'unreachable';
            s.wait = s.error === 'rate_limited' || s.error === 'busy' ? BACKOFF_MS : REFRESH_MS;
        }
        show(gameId);
        if (focusRefresh && s.host) {
            const button = s.host.querySelector('.ul-online-browse-refresh');
            if (button && !button.disabled) button.focus();
        }
    }

    // From the Online section's 500 ms tick: refresh when the list is on screen and its time has come.
    function tick(gameId, visible) {
        const s = getState(gameId);
        if (!s.host) return;
        const shown = visible && (!document.visibilityState || document.visibilityState === 'visible');
        if (shown && !s.fetching && (s.rooms === null && !s.error ? true : Date.now() - s.lastFetch >= s.wait)) {
            refresh(gameId, false);
        }
    }

    window.OnlineBrowse = {
        REFRESH_MS,
        render,
        show,
        tick,
        refresh,
        readRoom,
        rowReason
    };
})();
