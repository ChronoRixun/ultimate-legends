// Online section of the X-Men Legends page (launcher 0.4.0, with Legends Classic 0.3.0): online play
// without ini edits or the Connect by IP box. One PC hosts (Host a game), the others join with the
// code it gets (Join a game); the launcher <-> XML2 Fix contract (v1.1) is the binding part:
//
// - Host writes [Online] Host=broker and removes JoinCode, Join writes JoinCode=<code> and removes Host
//   (prepare-online-start, key by key through fix_ini like the other sections); a normal Play removes
//   both (launch-game, for every start that isn't this section's own), so a normal start never opens
//   a room. Broker / BrokerPin are the builder's: never written.
// - Before every start the backend deletes a leftover online-status.json; while the game runs the
//   section reads it (get-online-status, every 500 ms) and shows its state: Connecting..., then (the game
//   up, the room not open until Play Online in the game) where to go, the room's
//   code (XXXX-XXXX, Copy) and its players ("N of 4" with max_players) for a host; Looking for the game..., Found it for a joiner;
//   and every error id of the contract in plain words.
// - Host and Join are off, with the reason, while the port is not built, a build or an XML2 Fix update
//   holds the folder (Xml1Port, as for Display / Discord / Test mode), Test mode is on (the fix refuses
//   online play then; Turn test mode off is right there), or the game is already running.
//
// Like the rest of the page it has no controller navigation of its own: buttons and one text field in
// the Tab order, Enter in the field joins, a focus ring shows where the keyboard is (main.css), and the
// focus moves to what replaced a control that went away (the code's Copy, Try again, Host / the field).
(function () {
    'use strict';

    const SUPPORTED = new Set(['xml1']);
    const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const CODE_LENGTH = 8;
    const STATES = ['connecting', 'room', 'joined', 'in_game', 'ended', 'error'];
    const ERRORS = ['broker_unreachable', 'broker_rejected', 'code_not_found', 'code_expired', 'room_full',
        'version_mismatch', 'test_mode_on', 'tls_pin_mismatch', 'internal'];
    // The first XML2 Fix that reads [Online] Host / JoinCode and writes online-status.json: the one that
    // ships with Legends Classic 0.3.0 (contract v1.1). Named in the update hints and in the note for an
    // older fix in the folder.
    // TODO(release): set to that fix's version when Legends Classic 0.3.0 is released; 1.7.0 is a placeholder.
    const REQUIRED_FIX = '1.7.0';
    const POLL_MS = 500;
    // While nothing of this section runs, the page still follows the game starting or closing, a build
    // and the file (less often).
    const IDLE_REFRESH_MS = 2000;
    // How long the game may take to show up once the launch (its patch update included) is done.
    const START_GRACE_MS = 20000;

    const state = {};
    const escapeHtml = value => GameUtils.escapeHtml(value);

    function t(key, variables) {
        return window.LauncherI18n ? window.LauncherI18n.t(key, variables) : key;
    }

    function has(key) {
        return t(key) !== key;
    }

    function backendId(gameId) {
        return (GameUtils.getGameMapping && GameUtils.getGameMapping(gameId)) || gameId;
    }

    function run(command, payload) {
        return window.executeCommand(command, payload);
    }

    function panel(gameId) {
        return document.getElementById(`${gameId}-online-panel`);
    }

    function getState(gameId) {
        if (!state[gameId]) {
            state[gameId] = { data: null, session: null, timer: null, loading: null, lastIdleRefresh: 0, codeTried: false, shown: '',
                lastRole: null, dismissed: null, loads: 0 };
        }
        return state[gameId];
    }

    // ---- codes ----

    // What the player typed or pasted, as the contract reads it: upper case, without spaces or dashes
    // (any kind of dash a chat app may turn "-" into).
    function normaliseCode(text) {
        return String(text || '').toUpperCase().replace(/[\s\-‐-―−]/g, '');
    }

    // { code } when it is one, else { error: 'empty' | 'short' | 'long' | 'chars', count, chars }.
    function checkCode(text) {
        const code = normaliseCode(text);
        const wrong = [...new Set([...code].filter(c => !ALPHABET.includes(c)))];
        if (wrong.length) return { error: 'chars', chars: wrong.join(' ') };
        if (!code.length) return { error: 'empty' };
        if (code.length < CODE_LENGTH) return { error: 'short', count: code.length };
        if (code.length > CODE_LENGTH) return { error: 'long', count: code.length };
        return { code };
    }

    function displayCode(code) {
        const text = String(code || '');
        return text.length === CODE_LENGTH ? `${text.slice(0, 4)}-${text.slice(4)}` : text;
    }

    // ---- what the fix says ----

    // online-status.json's object as the page uses it, or null when it is not one of the contract's.
    function readStatus(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        if (typeof raw.v !== 'number' || raw.v < 1 || !STATES.includes(raw.state)) return null;
        if (raw.role !== 'host' && raw.role !== 'join') return null;
        return {
            role: raw.role,
            state: raw.state,
            code: typeof raw.code === 'string' && checkCode(raw.code).code ? checkCode(raw.code).code : null,
            // Everyone in the room, the host included (host alone = 1); max_players (v1.1) the game's limit.
            players: Number.isInteger(raw.players) && raw.players >= 0 ? raw.players : null,
            maxPlayers: Number.isInteger(raw.max_players) && raw.max_players > 0 ? raw.max_players : null,
            error: typeof raw.error === 'string' && raw.error ? raw.error : null,
            message: typeof raw.message === 'string' && raw.message ? raw.message : null
        };
    }

    // ---- why Host and Join are off ----

    function port() {
        return window.Xml1Port || null;
    }

    // The folder's XML2 Fix when it is older than REQUIRED_FIX ("1.6.0" < "1.7.0"), else null (also when
    // it has no version to compare).
    function fixTooOld() {
        const p = port();
        const version = p && p.status && p.status.fix && p.status.fix.installed ? p.status.fix.version : null;
        if (!version) return null;
        const parts = text => String(text).split('.').map(part => parseInt(part, 10) || 0);
        const have = parts(version);
        const need = parts(REQUIRED_FIX);
        for (let i = 0; i < need.length; i++) {
            if ((have[i] || 0) !== need[i]) return (have[i] || 0) < need[i] ? version : null;
        }
        return null;
    }

    // "3 players in the room", or "3 of 4 players in the room" when the fix says how many fit.
    function playersText(players, max) {
        if (max) return t(players === 1 ? 'online.players.oneOf' : 'online.players.manyOf', { count: players, max });
        return t(players === 1 ? 'online.players.one' : 'online.players.many', { count: players });
    }

    function testModeOn(gameId, data) {
        const view = window.TestModeView;
        const shown = view && typeof view.isOn === 'function' ? view.isOn(gameId) : null;
        return shown === null || shown === undefined ? !!(data && data.testMode) : !!shown;
    }

    function running(gameId, data) {
        const manager = window.GameStateManager;
        const known = manager && typeof manager.getGameState === 'function' ? manager.getGameState(gameId) : null;
        return !!(data && data.running) || !!(known && known.isRunning);
    }

    // { key, action } of the first thing in the way, or null when Host and Join can start.
    function blocked(gameId) {
        const data = getState(gameId).data;
        const p = port();
        const queue = window.DownloadQueueManager;
        if (!data) return { key: 'online.loading' };
        // A build running or starting holds the folder; so does the port's patch work (the XML2 Fix
        // being installed or updated), queued or running.
        if (p && (p.starting || p.isBuilding())) return { key: 'online.blocked.building' };
        if (p && ((typeof p.isWorking === 'function' && p.isWorking()) || (typeof p.patchQueued === 'function' && p.patchQueued()))) {
            return { key: 'online.blocked.updating' };
        }
        if (!data.installed) return { key: 'online.blocked.notSetUp' };
        if (!data.playable) return { key: 'online.blocked.notBuilt' };
        if (!data.fixInstalled) return { key: 'online.blocked.noFix', variables: { fix: data.fix || 'XML2 Fix' } };
        if (queue && typeof queue.isAnyBlockingActive === 'function' && queue.isAnyBlockingActive()) {
            return { key: 'online.blocked.otherUpdating' };
        }
        if (testModeOn(gameId, data)) return { key: 'online.blocked.testMode', action: 'test-mode-off' };
        if (running(gameId, data)) return { key: 'online.blocked.running' };
        return null;
    }

    // ---- markup ----

    function helpHTML() {
        const steps = ['host', 'share', 'join', 'inGame'].map(step => `<li>${escapeHtml(t(`online.help.steps.${step}`))}</li>`).join('');
        const notes = ['noPorts', 'sameVersion', 'lan', 'testMode'].map(note => `<li>${escapeHtml(t(`online.help.${note}`))}</li>`).join('');
        const errors = ERRORS.map(id => `
            <div class="ul-online-help-error" data-error="${escapeHtml(id)}">
                <dt>${escapeHtml(t(`online.errors.${id}.title`))}</dt>
                <dd>${escapeHtml(t(`online.errors.${id}.body`, { required: REQUIRED_FIX }))}</dd>
            </div>`).join('');
        return `
            <details class="ul-online-help">
                <summary>${escapeHtml(t('online.help.title'))}</summary>
                <div class="ul-online-help-body">
                    <ol class="ul-online-help-steps">${steps}</ol>
                    <ul class="ul-online-help-notes">${notes}</ul>
                    <h4 class="ul-online-help-heading">${escapeHtml(t('online.help.errorsTitle'))}</h4>
                    <dl class="ul-online-help-errors">${errors}</dl>
                </div>
            </details>`;
    }

    function render(gameId) {
        const host = panel(gameId);
        if (!host) return;
        const s = getState(gameId);
        s.shown = '';

        host.innerHTML = `
            <div class="ul-display ul-online">
                <p class="ul-display-intro">${escapeHtml(t('online.intro'))}</p>
                <div class="xml1-note is-warn ul-online-blocked" role="status" hidden>
                    <span class="ul-online-blocked-text"></span>
                    <button type="button" class="secondary-action xml1-small ul-online-testmode-off" hidden>${escapeHtml(t('testMode.turnOff'))}</button>
                </div>
                <div class="xml1-note is-warn ul-online-fix" hidden></div>
                <div class="ul-online-idle">
                    <div class="ul-online-card ul-online-host">
                        <h4 class="ul-online-card-title">${escapeHtml(t('online.host.title'))}</h4>
                        <p class="ul-online-card-body">${escapeHtml(t('online.host.body'))}</p>
                        <div class="ul-online-card-actions">
                            <button type="button" class="ul-online-primary ul-online-host-button">${escapeHtml(t('online.host.button'))}</button>
                        </div>
                    </div>
                    <div class="ul-online-card ul-online-join">
                        <h4 class="ul-online-card-title">${escapeHtml(t('online.join.title'))}</h4>
                        <p class="ul-online-card-body">${escapeHtml(t('online.join.body'))}</p>
                        <div class="ul-online-card-actions">
                            <input type="text" class="xml1-input ul-online-code-input" id="${escapeHtml(gameId)}-online-code"
                                aria-label="${escapeHtml(t('online.join.label'))}" aria-describedby="${escapeHtml(gameId)}-online-code-error"
                                placeholder="${escapeHtml(t('online.join.placeholder'))}" maxlength="32"
                                autocomplete="off" autocapitalize="characters" spellcheck="false">
                            <button type="button" class="ul-online-primary ul-online-join-button">${escapeHtml(t('online.join.button'))}</button>
                        </div>
                        <div class="ul-online-code-error" id="${escapeHtml(gameId)}-online-code-error" role="alert" hidden></div>
                    </div>
                </div>
                <div class="ul-online-session" tabindex="-1" hidden></div>
                ${helpHTML()}
            </div>`;

        host.querySelector('.ul-online-host-button').addEventListener('click', () => start(gameId, 'host'));
        host.querySelector('.ul-online-join-button').addEventListener('click', () => join(gameId));
        const input = host.querySelector('.ul-online-code-input');
        input.addEventListener('input', () => showCodeError(gameId));
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                join(gameId);
            }
        });
        // A valid code is shown the way the host sees it once the field is left.
        input.addEventListener('blur', () => {
            const checked = checkCode(input.value);
            if (checked.code) input.value = displayCode(checked.code);
        });
        host.querySelector('.ul-online-testmode-off').addEventListener('click', () => turnTestModeOff(gameId));
        host.querySelector('.ul-online-session').addEventListener('click', event => onSessionClick(gameId, event));

        if (!s.timer) s.timer = setInterval(() => tick(gameId), POLL_MS);
        sync(gameId);
        load(gameId);
    }

    // The inline error under the code field: a character no code has, or too many, as soon as it is
    // typed; too short or empty only once Join was pressed.
    function showCodeError(gameId) {
        const host = panel(gameId);
        if (!host) return null;
        const input = host.querySelector('.ul-online-code-input');
        const box = host.querySelector('.ul-online-code-error');
        const checked = checkCode(input.value);
        const s = getState(gameId);
        const show = checked.error && (s.codeTried || checked.error === 'chars' || checked.error === 'long');
        box.hidden = !show;
        box.textContent = show ? t(`online.codeError.${checked.error}`, { count: checked.count, length: CODE_LENGTH, chars: checked.chars }) : '';
        input.classList.toggle('is-invalid', !!show);
        input.setAttribute('aria-invalid', show ? 'true' : 'false');
        return checked;
    }

    // ---- loading and polling ----

    function visible(gameId) {
        const page = document.getElementById(`${gameId}-page`);
        return !page || page.style.display !== 'none';
    }

    function load(gameId) {
        const s = getState(gameId);
        if (s.loading) return s.loading;
        const sequence = ++s.loads;
        s.loading = (async () => {
            let data;
            try {
                data = await run('get-online-status', { game: backendId(gameId) });
            } catch (error) {
                console.error('online: status failed', error);
                return;
            }
            s.data = data;
            s.lastIdleRefresh = Date.now();
            follow(gameId, sequence);
            sync(gameId);
        })().finally(() => {
            s.loading = null;
        });
        return s.loading;
    }

    function tick(gameId) {
        const s = getState(gameId);
        if (!panel(gameId)) return;
        if (s.session && !s.session.outcome) {
            load(gameId);
        } else if (visible(gameId) && Date.now() - s.lastIdleRefresh >= IDLE_REFRESH_MS) {
            load(gameId);
        } else {
            sync(gameId);
        }
    }

    // What the latest status means for the session: the fix's state, the game starting, closing, or
    // never showing up. A game already running with a room of its own (the launcher restarted while
    // hosting, say) is taken up as a session.
    function follow(gameId, sequence) {
        const s = getState(gameId);
        const data = s.data || {};
        const status = readStatus(data.status);
        let session = s.session;

        // (Not one the player has dismissed with OK: only a newer state of it.)
        if (!session && data.running && status && !['ended', 'error'].includes(status.state) && JSON.stringify(data.status) !== s.dismissed) {
            session = s.session = { role: status.role, code: status.code, adopted: true, launched: true, launchedAt: Date.now(),
                seenRunning: true, status: null, players: null, maxPlayers: null, playersChanged: false, outcome: null, readsFrom: 0 };
        }
        if (!session || session.outcome) return;

        // Only what was read after the start's stale status was deleted (a read already under way when
        // Host or Join was pressed may still hold an earlier room).
        if (status && status.role === session.role && session.launched && sequence >= session.readsFrom) {
            // The count of a room that exists (connecting has none yet).
            const counted = ['room', 'joined', 'in_game'].includes(status.state) && status.players !== null;
            session.playersChanged = counted && session.players !== null && status.players !== session.players;
            if (counted) {
                session.players = status.players;
                session.maxPlayers = status.maxPlayers;
            }
            session.status = status;
            if (status.state === 'error') session.outcome = { kind: 'error', error: status.error || 'internal', message: status.message };
            else if (status.state === 'ended') session.outcome = { kind: 'ended' };
        }
        if (session.outcome || !session.launched) return;

        if (data.running) {
            session.seenRunning = true;
        } else if (session.seenRunning) {
            // Closed without writing `ended` (or before the page read it).
            session.outcome = { kind: 'closed' };
        } else if (session.launchedAt && Date.now() - session.launchedAt > START_GRACE_MS) {
            session.outcome = { kind: 'not_started' };
        }
    }

    // ---- showing it ----

    // Host / Join, the reason they are off, and the session: from the state, without rebuilding the
    // code field (what's typed and the focus stay).
    function sync(gameId) {
        const host = panel(gameId);
        if (!host) return;
        const s = getState(gameId);
        const idle = host.querySelector('.ul-online-idle');
        const sessionBox = host.querySelector('.ul-online-session');
        const note = host.querySelector('.ul-online-blocked');
        const live = !!s.session;

        const reason = live ? null : blocked(gameId);
        note.hidden = !reason || reason.key === 'online.loading';
        // (Only when it changes: a live region read out again on every poll is noise.)
        const reasonText = reason ? t(reason.key, reason.variables) : '';
        const reasonBox = host.querySelector('.ul-online-blocked-text');
        if (reasonBox.textContent !== reasonText) reasonBox.textContent = reasonText;
        const off = host.querySelector('.ul-online-testmode-off');
        off.hidden = !(reason && reason.action === 'test-mode-off');
        off.disabled = !!(port() && (port().starting || port().isBuilding()));
        host.querySelectorAll('.ul-online-host-button, .ul-online-join-button, .ul-online-code-input').forEach(control => {
            control.disabled = !!reason;
        });
        host.querySelectorAll('.ul-online-card').forEach(card => card.classList.toggle('is-disabled', !!reason));
        host.dataset.blocked = reason ? reason.key.split('.').pop() : '';

        // An XML2 Fix too old for online play: said, not blocked (the version is the release's, the
        // folder's may be read before an update lands).
        const old = fixTooOld();
        const fixNote = host.querySelector('.ul-online-fix');
        const fixText = old ? t('online.fixOld', { required: REQUIRED_FIX, version: old }) : '';
        fixNote.hidden = !old || live;
        if (fixNote.textContent !== fixText) fixNote.textContent = fixText;

        const focused = document.activeElement;
        const hadFocus = !!focused && !!focused.closest && !!focused.closest(`#${gameId}-online-panel`);
        idle.hidden = live;
        sessionBox.hidden = !live;
        if (live) renderSession(gameId, sessionBox);
        else s.shown = '';

        // A control that went away (Host pressed, the session block redrawn, Try again) hands the focus
        // to what took its place, never to nothing.
        if (hadFocus && !focusable(document.activeElement)) {
            const next = live
                ? sessionBox.querySelector('.ul-online-copy, .ul-online-again') || sessionBox
                : (s.session === null && s.lastRole === 'join' ? host.querySelector('.ul-online-code-input') : host.querySelector('.ul-online-host-button'));
            if (next && !next.disabled) next.focus();
            else if (live) sessionBox.focus();
            else {
                const fallback = host.querySelector('.ul-online-help summary');
                if (fallback) fallback.focus();
            }
        }
    }

    // In the page and not inside a hidden part of it.
    function focusable(element) {
        if (!element || element.disabled) return false;
        let node = element;
        for (; node && node !== document; node = node.parentNode) {
            if (node.hidden) return false;
        }
        return node === document;
    }

    // phase -> what the session block shows.
    function phase(session) {
        if (session.outcome) return session.outcome.kind;
        const status = session.status;
        const stateName = status ? status.state : 'connecting';
        return `${session.role}:${stateName}`;
    }

    function renderSession(gameId, box) {
        const s = getState(gameId);
        const session = s.session;
        const current = phase(session);
        const code = (session.status && session.status.code) || (session.role === 'host' ? session.code : null) || null;
        const signature = JSON.stringify([current, code, session.seenRunning, session.players, session.maxPlayers, session.outcome && session.outcome.error, session.outcome && session.outcome.reason]);
        if (signature === s.shown) return;
        const focusedInside = !!document.activeElement && !!document.activeElement.closest && document.activeElement.closest('.ul-online-session') === box;
        const keepCopy = focusedInside && document.activeElement.classList.contains('ul-online-copy');
        s.shown = signature;

        let body = '';
        let line = '';
        let kind = 'info';
        const outcome = session.outcome;
        if (outcome && outcome.kind === 'error') {
            const id = ERRORS.includes(outcome.error) ? outcome.error : null;
            kind = 'error';
            line = id ? t(`online.errors.${id}.title`) : t('online.errors.unknown.title', { id: outcome.error });
            body = `
                <div class="xml1-note is-error ul-online-error" data-error="${escapeHtml(outcome.error)}">
                    ${escapeHtml(id ? t(`online.errors.${id}.body`, { required: REQUIRED_FIX }) : t('online.errors.unknown.body'))}
                    ${outcome.message ? `<div class="ul-online-error-detail">${escapeHtml(t('online.errorDetail', { message: outcome.message }))}</div>` : ''}
                </div>
                ${id === 'test_mode_on' ? `<button type="button" class="secondary-action xml1-small ul-online-testmode-off">${escapeHtml(t('testMode.turnOff'))}</button>` : ''}`;
        } else if (outcome && outcome.kind === 'start_failed') {
            kind = 'error';
            const key = `online.startFailed.${outcome.reason}`;
            line = has(key) ? t(key, { error: outcome.message || '' }) : t('online.startFailed.write_failed', { error: outcome.message || outcome.reason || '' });
            if (outcome.reason === 'test_mode_on') {
                body = `<button type="button" class="secondary-action xml1-small ul-online-testmode-off">${escapeHtml(t('testMode.turnOff'))}</button>`;
            }
        } else if (outcome) {
            kind = outcome.kind === 'not_started' ? 'error' : 'info';
            line = t(`online.phase.${outcome.kind === 'not_started' ? 'notStarted' : outcome.kind}`);
        } else {
            // The room opens when the player enters Play Online in the game, not at game start (contract
            // v1.2): until then the status stays `connecting`, so once the game runs the page says where
            // to go. `in_game`: the session runs over the room, the lobby included.
            const name = session.status ? session.status.state : 'connecting';
            const waiting = name === 'connecting' || (session.role === 'host' && name !== 'in_game' && !code);
            const menu = session.seenRunning ? 'OpenMenu' : 'Connecting';
            if (session.role === 'host') line = t(name === 'in_game' ? 'online.phase.hostInGame' : waiting ? `online.phase.host${menu}` : 'online.phase.hostRoom');
            else line = t(name === 'in_game' ? 'online.phase.joinInGame' : name === 'joined' ? 'online.phase.joinJoined' : `online.phase.join${menu}`);
        }

        // The host's code, large, while its room is open (in the game too: friends can still join).
        let codeHTML = '';
        if (session.role === 'host' && code && (!outcome || outcome.kind !== 'error')) {
            const players = session.players;
            codeHTML = `
                <div class="ul-online-code-block">
                    <span class="ul-online-code-label">${escapeHtml(t('online.code.label'))}</span>
                    <div class="ul-online-code-row">
                        <span class="ul-online-code" data-code="${escapeHtml(code)}">${escapeHtml(displayCode(code))}</span>
                        ${outcome ? '' : `<button type="button" class="ul-online-primary ul-online-copy">${escapeHtml(t('online.code.copy'))}</button>`}
                    </div>
                    ${outcome ? '' : `<p class="ul-online-code-hint">${escapeHtml(t('online.code.hint'))}</p>`}
                    ${players !== null && !outcome ? `<p class="ul-online-players${session.playersChanged ? ' is-new' : ''}" aria-live="polite" data-players="${escapeHtml(players)}">${escapeHtml(playersText(players, session.maxPlayers))}</p>` : ''}
                </div>`;
        } else if (session.role === 'join' && session.code && !outcome) {
            codeHTML = `<p class="ul-online-join-code">${escapeHtml(t('online.join.joining', { code: displayCode(session.code) }))}</p>`;
        }

        const busy = !outcome && (!session.status || ['connecting'].includes(session.status.state));
        const buttons = outcome
            ? `<div class="ul-online-session-actions">
                    <button type="button" class="ul-online-primary ul-online-again">${escapeHtml(t(kind === 'error' ? 'online.again' : 'online.done'))}</button>
                </div>`
            : '';

        box.dataset.phase = current;
        box.dataset.role = session.role;
        box.innerHTML = `
            <div class="ul-online-phase is-${kind}${busy ? ' is-busy' : ''}" role="status" aria-live="polite">
                ${busy ? '<span class="ul-online-spinner" aria-hidden="true"></span>' : ''}
                <span class="ul-online-phase-text">${escapeHtml(line)}</span>
            </div>
            ${codeHTML}
            ${body}
            ${buttons}`;

        if (focusedInside) {
            const next = (keepCopy && box.querySelector('.ul-online-copy')) || box.querySelector('.ul-online-copy, .ul-online-again') || box;
            next.focus();
        }
    }

    // ---- actions ----

    function onSessionClick(gameId, event) {
        const target = event.target.closest && event.target.closest('button');
        if (!target || target.disabled) return;
        if (target.classList.contains('ul-online-copy')) copy(gameId);
        else if (target.classList.contains('ul-online-again')) back(gameId);
        else if (target.classList.contains('ul-online-testmode-off')) turnTestModeOff(gameId);
    }

    // Back to Host / Join (the code typed for a join is still in its field), with what the game and the
    // file say now: the focus then goes to Host or the code field.
    async function back(gameId) {
        const s = getState(gameId);
        const focused = document.activeElement;
        const hadFocus = !!focused && !!focused.closest && !!focused.closest(`#${gameId}-online-panel`);
        s.lastRole = s.session ? s.session.role : null;
        s.session = null;
        s.dismissed = s.data && s.data.status ? JSON.stringify(s.data.status) : null;
        sync(gameId);
        await load(gameId);
        const host = panel(gameId);
        if (hadFocus && host) {
            const next = s.lastRole === 'join' ? host.querySelector('.ul-online-code-input') : host.querySelector('.ul-online-host-button');
            if (next && !next.disabled) next.focus();
        }
    }

    async function copy(gameId) {
        const session = getState(gameId).session;
        const code = session && ((session.status && session.status.code) || session.code);
        if (!code) return;
        const text = displayCode(code);
        let copied = false;
        try {
            await navigator.clipboard.writeText(text);
            copied = true;
        } catch (_) {
            const area = document.createElement('textarea');
            area.value = text;
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            try {
                area.select();
                copied = document.execCommand('copy');
            } catch (__) {
                copied = false;
            }
            area.remove();
        }
        window.showToast(copied ? t('online.code.copied', { code: text }) : t('online.code.copyFailed', { code: text }), copied ? 'success' : 'error');
    }

    async function turnTestModeOff(gameId) {
        if (!window.TestModeView || typeof window.TestModeView.turnOff !== 'function') return;
        await window.TestModeView.turnOff(gameId);
        await load(gameId);
    }

    function join(gameId) {
        const host = panel(gameId);
        if (!host) return;
        const s = getState(gameId);
        s.codeTried = true;
        const checked = showCodeError(gameId);
        const input = host.querySelector('.ul-online-code-input');
        if (!checked || !checked.code) {
            if (input && !input.disabled) input.focus();
            return;
        }
        input.value = displayCode(checked.code);
        start(gameId, 'join', checked.code);
    }

    // Host or Join: the [Online] key written (and a stale status deleted) right before the start, after
    // the launch's own checks and prompts, then the game started as this section's (launch-game
    // { online: true }) and its status followed.
    async function start(gameId, role, code) {
        const s = getState(gameId);
        if (s.session && !s.session.outcome) return;
        if (blocked(gameId)) {
            sync(gameId);
            return;
        }

        const session = { role, code: role === 'join' ? code : null, launched: false, launchedAt: 0, seenRunning: false,
            status: null, players: null, maxPlayers: null, playersChanged: false, outcome: null, readsFrom: Infinity };
        s.session = session;
        s.lastRole = role;
        sync(gameId);

        let refused = null;
        let started = false;
        try {
            started = await GameUtils.launchGame(backendId(gameId), gameId, {
                online: true,
                beforeLaunch: async () => {
                    const result = await run('prepare-online-start', { game: backendId(gameId), mode: role, code: code || '' });
                    if (!result || !result.success) {
                        refused = result || { reason: 'write_failed', error: '' };
                        return false;
                    }
                    session.launched = true;
                    session.readsFrom = s.loads + 1;
                    return true;
                }
            });
        } catch (error) {
            // GameUtils has told the player why (another game updating, no folder set...).
            console.error('online: start failed', error);
        }
        if (s.session !== session) return;

        if (refused) {
            if (refused.reason === 'bad_code') {
                s.session = null;
                sync(gameId);
                showCodeError(gameId);
                return;
            }
            session.outcome = { kind: 'start_failed', reason: refused.reason, message: refused.error };
            sync(gameId);
            load(gameId);
            return;
        }
        if (!started || !session.launched) {
            // Cancelled before the start (the redist prompt) or refused before it: back to Host / Join.
            s.session = null;
            sync(gameId);
            load(gameId);
            return;
        }
        session.launchedAt = Date.now();
        load(gameId);
    }

    function syncAll() {
        SUPPORTED.forEach(gameId => {
            if (panel(gameId)) sync(gameId);
        });
    }

    function reloadAll() {
        SUPPORTED.forEach(gameId => {
            if (panel(gameId)) load(gameId);
        });
    }

    // Refresh when the game's page is opened and when a build, a Verify or an uninstall has finished;
    // a build or patch work starting or ending, test mode switched, and the download queue moving
    // turn Host and Join on or off.
    document.addEventListener('click', event => {
        const item = event.target.closest && event.target.closest('.game-item[data-game]');
        if (item && SUPPORTED.has(backendId(item.dataset.game)) && panel(item.dataset.game)) {
            setTimeout(() => load(item.dataset.game), 0);
        }
    }, true);
    window.addEventListener('gameInstallationUpdated', reloadAll);
    window.addEventListener('ul-xml1-changed', syncAll);
    window.addEventListener('ul-testmode-changed', syncAll);
    window.addEventListener('ul-download-queue-changed', syncAll);

    window.OnlineView = {
        supports: gameId => SUPPORTED.has(backendId(gameId)),
        render,
        reload: load,
        REQUIRED_FIX,
        normaliseCode,
        checkCode,
        displayCode,
        readStatus
    };
})();
