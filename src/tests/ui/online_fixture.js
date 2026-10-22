'use strict';
// The Online section's tests' backend and page (online.test.js, online_browse.test.js): the real
// online-view.js, online-browse.js and GameUtils.launchGame (utils.js) on a fake backend that keeps the
// port's [Online] keys and online-status.json the way the C++ does (fix/online_launch.cpp's order):
//
// - launch-game { online: { mode, ... } }: accepted under the barrier (refused: running, test mode, a refusal
//   a test sets, a status file that can't be deleted - and then the four keys removed, never armed), the stale
//   status deleted; the "worker" then (at the next get-launch-outcome) checks the XML2 Fix after the update,
//   arms Host=broker with Public / RoomName, or JoinCode, and starts the game - or gives up as a test says,
//   removing the four keys again.
// - launch-game without `online`: the four keys removed, the stale status deleted (or refused when it can't
//   be), and Close on launch closes the launcher (online starts never do).
// - get-public-rooms: a list a test sets, one poll per fetch; nothing at all in offline mode.

const { page } = require('./harness');

const FOLDER = 'D:\\Games\\X-Men Legends (Port)';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// Contract v1.5's ten status error ids.
const ERRORS = ['broker_unreachable', 'broker_rejected', 'code_not_found', 'code_expired', 'room_full', 'room_closed',
    'version_mismatch', 'test_mode_on', 'tls_pin_mismatch', 'internal'];
const REQUIRED_FIX = '1.8.0';
const LAUNCH_KEYS = ['Host', 'Public', 'RoomName', 'JoinCode'];

// online_launch::check_fix: at least REQUIRED_FIX, whose own pre-releases count (1.8.0-beta.1, >=1.8.0-0).
function fixState(version) {
    if (version === null || version === undefined) return 'missing';
    if (!/^[0-9]+(\.[0-9]+)*(-[0-9A-Za-z.-]+)?$/.test(version)) return 'unknown';
    const a = version.split('-')[0].split('.').map(Number);
    const b = REQUIRED_FIX.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 'ok' : 'old';
    }
    return 'ok';
}

class Backend {
    constructor(options = {}) {
        this.installed = options.installed !== false;
        this.playable = options.playable !== false;
        // The build was made for online play (online_launch::build_supports_online: its stamp's requires.xml2fix
        // at least 1.8.0-0, or a GameVersion); false: a build from an older builder, which only a rebuild fixes.
        this.buildOnline = options.buildOnline !== false;
        this.fixInstalled = options.fixInstalled !== false;
        // The DLL's file version (null: none that reads; the DLL missing: fixInstalled false).
        this.fixVersion = options.fixVersion === undefined ? '1.8.0' : options.fixVersion;
        this.running = !!options.running;
        this.testMode = !!options.testMode;
        this.offline = !!options.offline;
        // Settings > Update channel. The tests before it was there expect Verify Files for an old fix: Beta's way.
        this.updateChannel = options.updateChannel || 'beta';
        this.closeOnLaunch = !!options.closeOnLaunch;
        this.launcherClosed = false;
        // The port's xml2-fix.ini [Online]: the builder's keys and whatever the launcher wrote.
        this.online = Object.assign({ Broker: 'broker.example:7777', BrokerPin: 'ab'.repeat(32), GameVersion: 'LC33' }, options.online || {});
        this.status = options.status === undefined ? null : options.status; // online-status.json, as parsed
        this.statusLocked = false; // online-status.json held open without delete sharing
        this.calls = [];
        this.starts = []; // the `online` of every launch-game that had one
        this.launches = [];
        this.refuse = null; // a reason the next online launch-game is refused with, at acceptance
        // What the next accepted online start's worker does: { reason, error, cleanupError } to give up so,
        // `fixAfterUpdate` the DLL version the update leaves.
        this.workerFails = null;
        this.fixAfterUpdate = undefined;
        this.pending = null; // the accepted start the worker hasn't finished
        this.outcomes = {};
        this.nextLaunch = 1;
        this.barrier = false;
        // The public room list (get-public-rooms): what the next fetch answers, the fetches made, and the
        // folder's [Online] GameVersion.
        this.versionToken = options.versionToken === undefined ? 'LC31' : options.versionToken;
        this.roomsResult = options.rooms === undefined ? { ok: true, error: null, status: 200, rooms: [], ts: 1 }
            : Array.isArray(options.rooms) ? { ok: true, error: null, status: 200, rooms: options.rooms, ts: 1 } : options.rooms;
        this.fetches = 0;
        this.fetching = false;
        this.lastRooms = null;
    }

    write(status) {
        this.status = Object.assign({ v: 1, code: null, players: 0, error: null, message: null, updated: '2026-10-19T12:00:00Z' }, status);
    }

    armed() {
        return LAUNCH_KEYS.filter(key => this.online[key] !== undefined);
    }

    disarm() {
        LAUNCH_KEYS.forEach(key => delete this.online[key]);
    }

    refused(reason, error, disarm) {
        if (disarm) this.disarm();
        this.barrier = false;
        return { accepted: false, reason, error: error || `refused: ${reason}`, cleanupError: '' };
    }

    launch(data) {
        this.launches.push(JSON.parse(JSON.stringify(data)));
        const online = data.online && typeof data.online === 'object' ? data.online : null;
        if (online) this.starts.push(JSON.parse(JSON.stringify(online)));
        if (online) {
            if (online.mode === 'join') {
                const code = String(online.code || '').toUpperCase().replace(/[\s-]/g, '');
                if (code.length !== 8 || [...code].some(c => !ALPHABET.includes(c))) return this.refused('bad_code', 'bad code', false);
            } else if (online.mode === 'host') {
                const name = String(online.roomName || '').trim();
                if (name.length > 32 || /[^\x20-\x7e]|[;"]/.test(name)) return this.refused('bad_room_name', 'bad name', false);
            } else {
                return this.refused('bad_mode', 'bad mode', false);
            }
            if (this.offline) return this.refused('offline', 'offline', false);
        }
        if (this.barrier) return { accepted: false, reason: 'already_running', error: 'busy', cleanupError: '' };
        this.barrier = true;
        if (online) {
            if (this.running) return this.refused('running', 'running', false);
            if (this.refuse) {
                const reason = this.refuse;
                this.refuse = null;
                return this.refused(reason, `refused: ${reason}`, true);
            }
            if (this.testMode) return this.refused('test_mode_on', 'test mode', true);
            if (!this.buildOnline) return this.refused('build_too_old', 'This X-Men Legends build is older than the XML2 Fix: rebuild it to play online.', true);
        } else {
            this.disarm();
        }
        if (this.statusLocked) return this.refused('status_locked', 'online-status.json could not be deleted (in use).', !!online);
        this.status = null; // the stale online-status.json
        const id = this.nextLaunch++;
        this.outcomes[id] = { state: 'pending' };
        this.pending = { id, online };
        // (Play's start isn't followed by the page: its worker is done at once.)
        if (!online) this.finishPending();
        return { accepted: true, launch: id };
    }

    // The worker: the update, the DLL checked again, the keys armed, the process.
    finishPending() {
        const job = this.pending;
        if (!job) return;
        this.pending = null;
        const giveUp = (reason, error, cleanupError = '') => {
            if (job.online && !cleanupError) this.disarm();
            this.barrier = false;
            this.outcomes[job.id] = { state: 'failed', reason, error, cleanupError };
        };
        if (this.workerFails) {
            const fail = this.workerFails;
            this.workerFails = null;
            giveUp(fail.reason, fail.error || '', fail.cleanupError || '');
            return;
        }
        if (job.online) {
            if (this.fixAfterUpdate !== undefined) this.fixVersion = this.fixAfterUpdate;
            const state = fixState(this.fixInstalled ? (this.fixVersion === null ? '' : this.fixVersion) : null);
            if (state !== 'ok') {
                giveUp(state === 'old' ? 'fix_too_old' : state === 'unknown' ? 'fix_unknown' : 'no_fix', `the fix is ${this.fixVersion}`);
                return;
            }
            const o = job.online;
            if (o.mode === 'host') {
                // online_rules::changes_for: Host, Public, the RoomName of a public room; JoinCode removed.
                const name = String(o.roomName || '').trim();
                this.online.Host = 'broker';
                this.online.Public = o.public === true ? '1' : '0';
                if (o.public === true && name) this.online.RoomName = name;
                else delete this.online.RoomName;
                delete this.online.JoinCode;
            } else {
                this.online.JoinCode = String(o.code).toUpperCase().replace(/[\s-]/g, '');
                delete this.online.Host;
                delete this.online.Public;
                delete this.online.RoomName;
            }
        } else if (this.closeOnLaunch) {
            this.launcherClosed = true; // online_launch::close_after_start: normal starts only
        }
        this.barrier = false; // (the exit watchdog's, in the launcher: a test starts one game at a time)
        this.outcomes[job.id] = { state: 'launched' };
    }

    handle(command, data) {
        this.calls.push(command);
        switch (command) {
            case 'get-online-status':
                return {
                    supported: true, installed: this.installed, fixInstalled: this.installed && this.fixInstalled,
                    fixVersion: this.installed && this.fixInstalled ? (this.fixVersion === null ? '' : this.fixVersion) : null,
                    fixState: fixState(this.installed && this.fixInstalled ? (this.fixVersion === null ? '' : this.fixVersion) : null),
                    requiredFix: REQUIRED_FIX, updateChannel: this.updateChannel, offline: this.offline,
                    playable: this.installed && this.playable, buildOnline: this.installed && this.playable && this.buildOnline,
                    running: this.running, testMode: this.testMode,
                    fix: 'XML2 Fix', file: 'xml2-fix.ini', ini: `${FOLDER}\\xml2-fix.ini`,
                    values: Object.fromEntries(LAUNCH_KEYS.map(key => [key, this.online[key] === undefined ? null : this.online[key]])),
                    status: this.status === null ? null : JSON.parse(JSON.stringify(this.status)),
                    statusUnreadable: false
                };
            case 'launch-game':
                return this.launch(data || {});
            case 'get-launch-outcome': {
                if (this.pending && this.pending.id === data.launch) this.finishPending();
                const outcome = this.outcomes[data.launch] || { state: 'unknown' };
                return Object.assign({ launch: data.launch, reason: '', error: '', cleanupError: '' }, outcome);
            }
            case 'get-public-rooms':
                if (this.offline) {
                    return { supported: true, offline: true, fetching: false, host: 'broker.example', versionToken: this.versionToken, result: null };
                }
                // A fetch takes one poll: the call that starts it answers fetching, the next one the result.
                if (data.refresh && !this.fetching) {
                    this.fetching = true;
                    this.fetches++;
                    return { supported: true, fetching: true, host: 'broker.example', versionToken: this.versionToken, result: this.lastRooms };
                }
                if (this.fetching) {
                    this.fetching = false;
                    this.lastRooms = JSON.parse(JSON.stringify(this.roomsResult));
                }
                return { supported: true, fetching: false, host: 'broker.example', versionToken: this.versionToken, result: this.lastRooms };
            case 'get-update-progress':
                return { active: false, progress: 100, message: 'Complete' };
            case 'get-game-property':
                return data && data.suffix === 'install' ? FOLDER : '';
            case 'get-property':
                return null;
            case 'get-missing-redists-for-game':
                return { checked: true, missing: [] };
            default:
                return null;
        }
    }
}

async function open(options = {}, port = {}) {
    const backend = new Backend(options);
    const body = `
        <div id="xml1-page">
            <div class="button-group" id="xml1-button-group"><div class="left-buttons"><button class="play-button" id="xml1-play-button">Play</button></div></div>
            <div id="xml1-online-panel"></div>
        </div>`;
    const p = page({ scripts: options.scripts || ['core/utils.js', 'core/i18n.js', 'app/online-browse.js', 'app/online-view.js'], body, backend,
        offline: !!options.offline });
    p.window.ProgressManager = { show() {}, update() {}, hide() {} };
    // What the view reads of Xml1Port: a build running or starting, patch work in the folder.
    p.window.Xml1Port = Object.assign({
        starting: null,
        building: false,
        working: false,
        isBuilding() { return this.building; },
        isWorking() { return this.working || !!this.starting; },
        patchQueued() { return false; }
    }, port);
    const clipboard = [];
    p.window.navigator.clipboard.writeText = async text => { clipboard.push(text); };
    if (options.testModeView) p.window.TestModeView = options.testModeView;
    if (options.language) p.window.LauncherI18n.setLanguage(options.language);
    if (options.beforeRender) options.beforeRender(p.window);
    p.window.OnlineView.render('xml1');
    await p.clock.advance(0);

    const $ = selector => p.document.querySelector(`#xml1-online-panel ${selector}`);
    const text = selector => ($(selector) ? $(selector).textContent.replace(/\s+/g, ' ').trim() : null);
    const visible = selector => {
        for (let node = $(selector); node; node = node.parentNode) {
            if (node.hidden) return false;
            if (node.id === 'xml1-online-panel') return true;
        }
        return false;
    };
    const input = () => $('.ul-online-code-input');
    const type = value => {
        input().value = value;
        input().dispatchEvent(new p.window.Event('input', { bubbles: true }));
    };
    const key = name => {
        const event = new p.window.Event('keydown', { bubbles: true });
        event.key = name;
        input().dispatchEvent(event);
    };
    const phase = () => text('.ul-online-phase-text');
    const blockedText = () => (visible('.ul-online-blocked') ? text('.ul-online-blocked-text') : null);
    const controls = () => [$('.ul-online-host-button'), $('.ul-online-join-button'), input()];
    return { ...p, backend, clipboard, $, text, visible, input, type, key, phase, blockedText, controls };
}

// Host pressed and the game handed to launch-game; `running` makes the game show up.
async function host(t, { running = true } = {}) {
    t.$('.ul-online-host-button').click();
    await t.clock.advance(1500); // the launch's progress poll and its 1 s settle
    if (running) t.backend.running = true;
    await t.clock.advance(600);
}

async function joinWith(t, code, { running = true } = {}) {
    t.type(code);
    t.$('.ul-online-join-button').click();
    await t.clock.advance(1500);
    if (running) t.backend.running = true;
    await t.clock.advance(600);
}

module.exports = { FOLDER, ALPHABET, ERRORS, REQUIRED_FIX, LAUNCH_KEYS, Backend, open, host, joinWith };
