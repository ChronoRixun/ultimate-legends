// Online section of the X-Men Legends page (launcher 0.4.0, with Legends Classic 0.3.0 and XML2 Fix 1.8.0):
// online play without ini edits or the Connect by IP box. One PC hosts (Host a game), the others join with the
// code it gets (Join a game); the launcher <-> XML2 Fix contract (v1.5) is the binding part:
//
// - Host and Join are launch-game { online: { mode, code, public, roomName } }: the backend owns the start from
//   there (fix/online_launch.hpp) - the barrier, the stale online-status.json deleted, the patch update, the
//   XML2 Fix checked again (at least the requiredFix get-online-status sends), and only then [Online]
//   Host=broker (with Public / RoomName) or JoinCode written, right before the process; a start that is
//   refused, cancelled or fails removes them again. The page follows it with get-launch-outcome. A normal
//   Play removes all four, so a normal start never opens a room. Broker / BrokerPin are the builder's.
// - While the game runs the section reads online-status.json (get-online-status, every 500 ms) and shows
//   its state: Connecting..., then (the game up, the room not open until Play Online in the game) where to
//   go, the room's code (XXXX-XXXX, Copy) and its players ("N of 4" with max_players) for a host; Looking
//   for the game..., Found it for a joiner; and every error id of the contract in plain words - also when
//   the first the page reads of it is `ended` carrying the error.
// - Host can list the game publicly (contract v1.3: Public=1 and an optional RoomName, written with
//   Host=broker); the room card says Public or Private, and the code goes on the clipboard by itself
//   when it first appears. Browse games (online-browse.js) lists the public rooms; its Join is the
//   code flow with the row's code.
// - Host and Join are off, with the reason, while the port is not built, a build or an XML2 Fix update
//   holds the folder (Xml1Port, as for Display / Discord / Test mode), the folder's XML2 Fix is older than
//   requiredFix (on the Beta update channel Verify Files updates it; on Stable, which has no such fix until
//   Legends Classic 0.3.0 is final, Open Update channel leads to Beta) or its version can't be read (Verify
//   Files), Test mode is on (the fix refuses online play then;
//   Turn test mode off is right there), or the game is already running. In offline mode they stay on, with
//   a note, and ask to restart the launcher online (guardOnline) before anything is written or fetched.
//
// Like the rest of the page it has no controller navigation of its own (core/focus-nav.js drives it when
// present): buttons, one text field and the help's summary in the Tab order, Enter in the field joins, a
// focus ring shows where the keyboard is (main.css), and the focus moves to what replaced a control that
// went away (the code's Copy, Try again, Host / the field). Notes are plain text, never focus stops.
(function () {
    'use strict';

    const SUPPORTED = new Set(['xml1']);
    const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const CODE_LENGTH = 8;
    const ROOM_NAME_LENGTH = 32;
    const STATES = ['connecting', 'room', 'joined', 'in_game', 'ended', 'error'];
    // The status error ids of contract v1.5 (room_closed: the room exists but takes nobody right now; room_full:
    // all its places taken). Any other id gets the generic text with the id.
    const ERRORS = ['broker_unreachable', 'broker_rejected', 'code_not_found', 'code_expired', 'room_full', 'room_closed',
        'version_mismatch', 'test_mode_on', 'tls_pin_mismatch', 'internal'];
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
                lastRole: null, dismissed: null, loads: 0, isPublic: false, outcomeAsked: false };
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

    // A room name as the contract takes it: trimmed, at most 32 printable ASCII characters, no ';' (a
    // comment in the ini) or '"' (the profile API drops quotes) - online_rules::normalise_room_name.
    // { name } or { error: 'chars' | 'long' }.
    function checkRoomName(text) {
        const name = String(text || '').replace(/^[ \t]+|[ \t]+$/g, '');
        if (name.length > ROOM_NAME_LENGTH) return { error: 'long' };
        if (/[^\x20-\x7e]|[;"]/.test(name)) return { error: 'chars' };
        return { name };
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
            message: typeof raw.message === 'string' && raw.message ? raw.message : null,
            // v1.3: whether the room is listed publicly, and its name.
            isPublic: typeof raw.public === 'boolean' ? raw.public : null,
            roomName: typeof raw.room_name === 'string' ? raw.room_name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64) : null
        };
    }

    // ---- why Host and Join are off ----

    function port() {
        return window.Xml1Port || null;
    }

    // The XML2 Fix online play needs, as the backend says (online_launch::required_fix: the one number, also
    // the one launch-game checks the DLL against right before the process).
    function requiredFix(gameId) {
        const data = getState(gameId).data;
        return (data && typeof data.requiredFix === 'string' && data.requiredFix) || '';
    }

    function offline() {
        return !!window.IS_OFFLINE;
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
        if (!data.fixInstalled || data.fixState === 'missing') return { key: 'online.blocked.noFix', variables: { fix: data.fix || 'XML2 Fix' } };
        // The DLL in the folder, read by the backend: too old for rooms, or no version to tell. On Stable no
        // release has rooms yet (until Legends Classic 0.3.0 is final): the way there is the Beta channel, not
        // Verify Files. On Beta, Verify Files installs the beta fix.
        if (data.fixState === 'old' && data.updateChannel === 'stable') return { key: 'online.blocked.needsBeta', action: 'open-update-channel' };
        if (data.fixState === 'old') return { key: 'online.blocked.fixOld', variables: { required: requiredFix(gameId), version: data.fixVersion || '' } };
        if (data.fixState !== 'ok') return { key: 'online.blocked.fixUnknown', variables: { required: requiredFix(gameId) } };
        if (queue && typeof queue.isAnyBlockingActive === 'function' && queue.isAnyBlockingActive()) {
            return { key: 'online.blocked.otherUpdating' };
        }
        if (testModeOn(gameId, data)) return { key: 'online.blocked.testMode', action: 'test-mode-off' };
        if (running(gameId, data)) return { key: 'online.blocked.running' };
        return null;
    }

    // ---- markup ----

    // The help's notes, in order: joining a campaign under way, a solo story segment, public games and what
    // they show of you, then the rest.
    const HELP_NOTES = ['lateJoin', 'soloSegment', 'public', 'publicIp', 'noPorts', 'sameVersion', 'keepOpen', 'lan', 'testMode'];

    // The help's body: drawn again when the number of the XML2 Fix it names arrives (the first status).
    function helpBodyHTML(gameId) {
        const steps = ['host', 'share', 'join', 'inGame'].map(step => `<li>${escapeHtml(t(`online.help.steps.${step}`))}</li>`).join('');
        const notes = HELP_NOTES.map(note => `<li data-note="${escapeHtml(note)}">${escapeHtml(t(`online.help.${note}`, { required: requiredFix(gameId) }))}</li>`).join('');
        const errors = ERRORS.map(id => `
            <div class="ul-online-help-error" data-error="${escapeHtml(id)}">
                <dt>${escapeHtml(t(`online.errors.${id}.title`))}</dt>
                <dd>${escapeHtml(t(`online.errors.${id}.body`, { required: requiredFix(gameId) }))}</dd>
            </div>`).join('');
        return `
                    <ol class="ul-online-help-steps">${steps}</ol>
                    <ul class="ul-online-help-notes">${notes}</ul>
                    <h4 class="ul-online-help-heading">${escapeHtml(t('online.help.errorsTitle'))}</h4>
                    <dl class="ul-online-help-errors">${errors}</dl>`;
    }

    function helpHTML(gameId) {
        // (tabindex: a summary is focusable by itself in Chromium, but core/focus-nav.js only moves to the
        // controls it knows; Enter / Space / a pad's A open and close it.)
        return `
            <details class="ul-online-help">
                <summary tabindex="0">${escapeHtml(t('online.help.title'))}</summary>
                <div class="ul-online-help-body" data-required="${escapeHtml(requiredFix(gameId))}">${helpBodyHTML(gameId)}</div>
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
                    <button type="button" class="secondary-action xml1-small ul-online-open-channel" hidden>${escapeHtml(t('online.openUpdateChannel'))}</button>
                </div>
                <p class="xml1-note ul-online-offline" hidden>${escapeHtml(t('online.offline'))}</p>
                <div class="ul-online-idle">
                    <div class="ul-online-card ul-online-host">
                        <h4 class="ul-online-card-title">${escapeHtml(t('online.host.title'))}</h4>
                        <p class="ul-online-card-body">${escapeHtml(t('online.host.body'))}</p>
                        <div class="ul-online-public">
                            <span class="ul-online-public-label" id="${escapeHtml(gameId)}-online-public-label">${escapeHtml(t('online.host.public'))}</span>
                            <div class="toggle-group small ul-online-public-toggle" role="group" aria-labelledby="${escapeHtml(gameId)}-online-public-label">
                                <button type="button" class="toggle-btn active" data-value="0" aria-pressed="true">${escapeHtml(t('testMode.off'))}</button>
                                <button type="button" class="toggle-btn" data-value="1" aria-pressed="false">${escapeHtml(t('testMode.on'))}</button>
                            </div>
                        </div>
                        <p class="ul-online-public-note">${escapeHtml(t('online.host.publicNote'))}</p>
                        <p class="ul-online-ip-note">${escapeHtml(t('online.publicIp'))}</p>
                        <input type="text" class="xml1-input ul-online-room-name-input" id="${escapeHtml(gameId)}-online-room-name"
                            aria-label="${escapeHtml(t('online.host.roomName'))}" aria-describedby="${escapeHtml(gameId)}-online-room-name-error"
                            placeholder="${escapeHtml(t('online.host.roomNamePlaceholder'))}" maxlength="${ROOM_NAME_LENGTH}"
                            autocomplete="off" spellcheck="false" disabled>
                        <div class="ul-online-room-name-error" id="${escapeHtml(gameId)}-online-room-name-error" role="alert" hidden></div>
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
                <section class="ul-online-browse"></section>
                <div class="ul-online-session" tabindex="-1" hidden></div>
                ${helpHTML(gameId)}
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
        host.querySelector('.ul-online-open-channel').addEventListener('click', () => {
            if (window.UpdateChannel) window.UpdateChannel.openSetting();
        });
        host.querySelector('.ul-online-public-toggle').addEventListener('click', event => {
            const button = event.target.closest && event.target.closest('.toggle-btn');
            if (!button || button.disabled) return;
            s.isPublic = button.dataset.value === '1';
            sync(gameId);
        });
        host.querySelector('.ul-online-room-name-input').addEventListener('input', () => showRoomNameError(gameId, false));
        host.querySelector('.ul-online-room-name-input').addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                start(gameId, 'host');
            }
        });
        if (window.OnlineBrowse) {
            window.OnlineBrowse.render(gameId, host.querySelector('.ul-online-browse'), {
                join: room => joinCode(gameId, room.code, { inProgress: room.inProgress }),
                blocked: () => !!getState(gameId).session || !!blocked(gameId),
                offline
            });
        }
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

    // The inline error under the room name: shown as it is typed (the field's maxlength keeps it to 32).
    function showRoomNameError(gameId) {
        const host = panel(gameId);
        if (!host) return null;
        const input = host.querySelector('.ul-online-room-name-input');
        const box = host.querySelector('.ul-online-room-name-error');
        const checked = checkRoomName(input.value);
        const show = !!checked.error && getState(gameId).isPublic;
        box.hidden = !show;
        box.textContent = show ? t('online.host.roomNameError', { length: ROOM_NAME_LENGTH }) : '';
        input.classList.toggle('is-invalid', show);
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
            await followLaunch(gameId);
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
        if (window.OnlineBrowse) window.OnlineBrowse.tick(gameId, visible(gameId) && !s.session);
        if (s.session && !s.session.outcome) {
            load(gameId);
        } else if (visible(gameId) && Date.now() - s.lastIdleRefresh >= IDLE_REFRESH_MS) {
            load(gameId);
        } else {
            sync(gameId);
        }
    }

    // An accepted start, until the backend has started the game or given up (get-launch-outcome): started,
    // the session follows the game and its status; given up, it says why (the keys are already removed). A
    // cancelled update is the player's own choice: back to Host / Join, unless the keys could not be removed.
    async function followLaunch(gameId) {
        const s = getState(gameId);
        const session = s.session;
        if (!session || session.launched || session.outcome || !session.launch) return;
        let answer = null;
        try {
            answer = await run('get-launch-outcome', { launch: session.launch });
        } catch (error) {
            console.error('online: launch outcome failed', error);
            return;
        }
        if (s.session !== session || !answer || answer.state === 'pending') return;
        if (answer.state === 'failed') {
            if (answer.reason === 'update_cancelled' && !answer.cleanupError) {
                s.lastRole = session.role;
                s.session = null;
                return;
            }
            session.outcome = { kind: 'start_failed', reason: answer.reason || 'launch_failed', message: answer.error || '', cleanup: answer.cleanupError || '' };
            return;
        }
        // launched (or a later start replaced it: the game and its status say the rest).
        session.launched = true;
        session.launchedAt = Date.now();
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
            // `ended` keeps the first error of the session (contract v1.5): the page may have missed the
            // `error` state between two reads, and the explanation must not be lost with it.
            if (status.state === 'error' || (status.state === 'ended' && status.error)) {
                session.outcome = { kind: 'error', error: status.error || 'internal', message: status.message };
            } else if (status.state === 'ended') {
                session.outcome = { kind: 'ended' };
            }
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
        host.querySelector('.ul-online-open-channel').hidden = !(reason && reason.action === 'open-update-channel');
        host.querySelectorAll('.ul-online-host-button, .ul-online-join-button, .ul-online-code-input, .ul-online-public-toggle .toggle-btn').forEach(control => {
            control.disabled = !!reason;
        });
        // List my game publicly, and the room name it goes with (only a public room has one).
        host.querySelectorAll('.ul-online-public-toggle .toggle-btn').forEach(button => {
            const active = (button.dataset.value === '1') === !!s.isPublic;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        host.querySelector('.ul-online-room-name-input').disabled = !!reason || !s.isPublic;
        showRoomNameError(gameId);
        host.querySelectorAll('.ul-online-card').forEach(card => card.classList.toggle('is-disabled', !!reason));
        host.dataset.blocked = reason ? reason.key.split('.').pop() : '';

        // Offline mode: Host, Join and Refresh stay, and ask to restart the launcher online first.
        host.querySelector('.ul-online-offline').hidden = !offline() || live;
        const helpBody = host.querySelector('.ul-online-help-body');
        if (helpBody && helpBody.dataset.required !== requiredFix(gameId)) {
            helpBody.innerHTML = helpBodyHTML(gameId);
            helpBody.dataset.required = requiredFix(gameId);
        }

        const focused = document.activeElement;
        const hadFocus = !!focused && !!focused.closest && !!focused.closest(`#${gameId}-online-panel`);
        idle.hidden = live;
        sessionBox.hidden = !live;
        // Browse games sits under Host / Join, and goes with them while a session runs.
        const browse = host.querySelector('.ul-online-browse');
        browse.hidden = live;
        if (window.OnlineBrowse) window.OnlineBrowse.show(gameId);
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
        const status = session.status;
        const isPublic = status && status.isPublic !== null ? status.isPublic : !!session.isPublic;
        const roomName = status && status.roomName !== null ? status.roomName : session.roomName || '';
        // The code goes on the clipboard by itself the first time it shows (not for a room the page took up
        // after a launcher restart: that would overwrite the clipboard out of the blue).
        if (session.role === 'host' && code && !session.outcome && !session.adopted && session.autoCopied !== code) {
            session.autoCopied = code;
            copyText(displayCode(code)).then(copied => {
                session.copiedNote = copied;
                if (copied && s.session === session) {
                    s.shown = '';
                    sync(gameId);
                }
            });
        }
        const signature = JSON.stringify([current, code, session.seenRunning, session.players, session.maxPlayers, isPublic, roomName, !!session.copiedNote,
            session.outcome && session.outcome.error, session.outcome && session.outcome.reason, session.outcome && session.outcome.message,
            session.outcome && session.outcome.cleanup]);
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
                    ${escapeHtml(id ? t(`online.errors.${id}.body`, { required: requiredFix(gameId) }) : t('online.errors.unknown.body'))}
                    ${outcome.message ? `<div class="ul-online-error-detail">${escapeHtml(t('online.errorDetail', { message: outcome.message }))}</div>` : ''}
                </div>
                ${id === 'test_mode_on' ? `<button type="button" class="secondary-action xml1-small ul-online-testmode-off">${escapeHtml(t('testMode.turnOff'))}</button>` : ''}`;
        } else if (outcome && outcome.kind === 'start_failed') {
            kind = 'error';
            const key = `online.startFailed.${outcome.reason}`;
            const variables = { error: outcome.message || '', required: requiredFix(gameId) };
            line = has(key) ? t(key, variables) : t('online.startFailed.launch_failed', { error: outcome.message || outcome.reason || '' });
            // (The details line when the text doesn't already carry the backend's error.)
            if (outcome.message && has(key) && !t(key, { error: '\u0001' }).includes('\u0001')) {
                body += `<div class="ul-online-error-detail">${escapeHtml(t('online.errorDetail', { message: outcome.message }))}</div>`;
            }
            // The [Online] keys could not be removed after the start gave up: a later start from Steam or the
            // exe would still open (or join) that room.
            if (outcome.cleanup) {
                body += `<div class="xml1-note is-error ul-online-cleanup">${escapeHtml(t('online.startFailed.cleanup', { error: outcome.cleanup }))}</div>`;
            }
            if (outcome.reason === 'test_mode_on') {
                body += `<button type="button" class="secondary-action xml1-small ul-online-testmode-off">${escapeHtml(t('testMode.turnOff'))}</button>`;
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
                    <div class="ul-online-room-line">
                        <span class="ul-online-visibility is-${isPublic ? 'public' : 'private'}">${escapeHtml(t(isPublic ? 'online.visibility.public' : 'online.visibility.private'))}</span>
                        ${roomName ? `<span class="ul-online-room-title">${escapeHtml(roomName)}</span>` : ''}
                        <span class="ul-online-visibility-note">${escapeHtml(t(isPublic ? 'online.visibility.publicNote' : 'online.visibility.privateNote'))}</span>
                    </div>
                    <span class="ul-online-code-label">${escapeHtml(t('online.code.label'))}</span>
                    <div class="ul-online-code-row">
                        <span class="ul-online-code" data-code="${escapeHtml(code)}">${escapeHtml(displayCode(code))}</span>
                        ${outcome ? '' : `<button type="button" class="ul-online-primary ul-online-copy">${escapeHtml(t('online.code.copy'))}</button>`}
                    </div>
                    ${outcome || !session.copiedNote ? '' : `<p class="ul-online-copied" role="status">${escapeHtml(t('online.code.autoCopied'))}</p>`}
                    ${outcome ? '' : `<p class="ul-online-code-hint">${escapeHtml(t('online.code.hint'))}</p>`}
                    ${players !== null && !outcome ? `<p class="ul-online-players${session.playersChanged ? ' is-new' : ''}" aria-live="polite" data-players="${escapeHtml(players)}">${escapeHtml(playersText(players, session.maxPlayers))}</p>` : ''}
                </div>`;
        } else if (session.role === 'join' && session.code && !outcome) {
            codeHTML = `<p class="ul-online-join-code">${escapeHtml(t('online.join.joining', { code: displayCode(session.code) }))}</p>`;
            // A public game already under way (its row said In progress): the game takes the joiner in at the
            // next level change, from its Joined Game screen.
            if (session.inProgress && (!session.status || session.status.state !== 'in_game')) {
                codeHTML += `<p class="xml1-note ul-online-late-join">${escapeHtml(t('online.join.lateJoin'))}</p>`;
            }
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

    // The Clipboard API, else the old copy command; true when it worked.
    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (_) {
            // (Selecting the text moves the focus: it goes back where it was, so an automatic copy never
            // takes it from a keyboard or controller user.)
            const focused = document.activeElement;
            const area = document.createElement('textarea');
            area.value = text;
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            let copied = false;
            try {
                area.select();
                copied = document.execCommand('copy');
            } catch (__) {
                copied = false;
            }
            area.remove();
            if (focused && focused !== document.body && typeof focused.focus === 'function') focused.focus();
            return !!copied;
        }
    }

    async function copy(gameId) {
        const session = getState(gameId).session;
        const code = session && ((session.status && session.status.code) || session.code);
        if (!code) return;
        const text = displayCode(code);
        const copied = await copyText(text);
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

    // Join from Browse games: the code flow with the row's code (it goes in the code field too, so Try
    // again has it). `inProgress`: the row said the game is under way (the session then says when the
    // game takes the player in).
    function joinCode(gameId, code, extra = {}) {
        const host = panel(gameId);
        const checked = checkCode(code);
        if (!host || !checked.code) return;
        host.querySelector('.ul-online-code-input').value = displayCode(checked.code);
        getState(gameId).codeTried = false;
        showCodeError(gameId);
        start(gameId, 'join', checked.code, extra);
    }

    // Host or Join: the game started as this section's (launch-game { online }), after the launch's own
    // checks and prompts. The backend writes the [Online] keys right before the process and removes them
    // when the start doesn't happen; the page shows what it answered, then what became of the start
    // (followLaunch) and the game's status (follow).
    async function start(gameId, role, code, extra = {}) {
        const s = getState(gameId);
        if (s.session && !s.session.outcome) return;
        if (blocked(gameId)) {
            sync(gameId);
            return;
        }
        // Offline mode: nothing is written or fetched; the player may restart the launcher online.
        if (offline()) {
            if (typeof window.guardOnline === 'function') await window.guardOnline();
            sync(gameId);
            return;
        }

        // A public room's name, checked like the backend checks it (online_rules::normalise_room_name).
        let roomName = '';
        if (role === 'host' && s.isPublic) {
            const checked = showRoomNameError(gameId);
            if (!checked || checked.error) {
                const input = panel(gameId).querySelector('.ul-online-room-name-input');
                if (input && !input.disabled) input.focus();
                return;
            }
            roomName = checked.name;
        }

        const session = { role, code: role === 'join' ? code : null, launch: null, launched: false, launchedAt: 0, seenRunning: false,
            status: null, players: null, maxPlayers: null, playersChanged: false, outcome: null, readsFrom: Infinity,
            isPublic: role === 'host' && !!s.isPublic, roomName, autoCopied: null, copiedNote: false, inProgress: role === 'join' && !!extra.inProgress };
        s.session = session;
        s.lastRole = role;
        sync(gameId);

        const online = role === 'host' ? { mode: 'host', public: session.isPublic, roomName: session.roomName } : { mode: 'join', code };
        let answer = null;
        try {
            answer = await GameUtils.launchGame(backendId(gameId), gameId, { online });
        } catch (error) {
            // GameUtils has told the player why (another game updating, no folder set...).
            console.error('online: start failed', error);
        }
        if (s.session !== session) return;

        if (!answer || answer.accepted !== true) {
            const reason = answer && answer.reason;
            if (reason === 'bad_code' || reason === 'bad_room_name') {
                s.session = null;
                sync(gameId);
                if (reason === 'bad_code') showCodeError(gameId);
                else showRoomNameError(gameId);
                return;
            }
            if (!reason || reason === 'cancelled') {
                // Stopped before the start (the redist prompt, a launch already queued): back to Host / Join.
                s.session = null;
                sync(gameId);
                load(gameId);
                return;
            }
            session.outcome = { kind: 'start_failed', reason, message: answer.error || '', cleanup: answer.cleanupError || '' };
            sync(gameId);
            load(gameId);
            return;
        }
        // Accepted: the stale status is gone (only what is read from now on counts); the worker updates,
        // checks the XML2 Fix, writes the keys and starts the game - followLaunch hears how that went.
        session.launch = answer.launch;
        session.readsFrom = s.loads + 1;
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
        requiredFix,
        ERRORS,
        normaliseCode,
        checkCode,
        checkRoomName,
        displayCode,
        readStatus
    };
})();
