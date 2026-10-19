'use strict';
// The Online section's tests' backend and page (online.test.js, online_browse.test.js): the real
// online-view.js, online-browse.js, online-zones.js and GameUtils.launchGame (utils.js) on a fake backend
// that keeps the port's [Online] keys and online-status.json the way the C++ does (online_settings /
// online_rules: Host=broker with Public and RoomName, or JoinCode, the others removed; a stale status
// deleted before a Host or Join start; launch-game removing all four for every start without `online`),
// and answers get-public-rooms with a list a test sets, one poll per fetch.

const { page } = require('./harness');

const FOLDER = 'D:\\Games\\X-Men Legends (Port)';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ERRORS = ['broker_unreachable', 'broker_rejected', 'code_not_found', 'code_expired', 'room_full',
    'version_mismatch', 'test_mode_on', 'tls_pin_mismatch', 'internal'];

class Backend {
    constructor(options = {}) {
        this.installed = options.installed !== false;
        this.playable = options.playable !== false;
        this.fixInstalled = options.fixInstalled !== false;
        this.running = !!options.running;
        this.testMode = !!options.testMode;
        // The port's xml2-fix.ini [Online]: the builder's keys and whatever the launcher wrote.
        this.online = Object.assign({ Broker: 'broker.example:7777', BrokerPin: 'ab'.repeat(32) }, options.online || {});
        this.status = options.status === undefined ? null : options.status; // online-status.json, as parsed
        this.calls = [];
        this.prepares = [];
        this.launches = [];
        this.refuse = null; // a reason the next prepare-online-start answers with
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

    handle(command, data) {
        this.calls.push(command);
        switch (command) {
            case 'get-online-status':
                return {
                    supported: true, installed: this.installed, fixInstalled: this.installed && this.fixInstalled,
                    playable: this.installed && this.playable, running: this.running, testMode: this.testMode,
                    fix: 'XML2 Fix', file: 'xml2-fix.ini', ini: `${FOLDER}\\xml2-fix.ini`,
                    values: { Host: this.online.Host === undefined ? null : this.online.Host, JoinCode: this.online.JoinCode === undefined ? null : this.online.JoinCode },
                    status: this.status === null ? null : JSON.parse(JSON.stringify(this.status)),
                    statusUnreadable: false
                };
            case 'prepare-online-start': {
                this.prepares.push(Object.assign({}, data));
                if (this.refuse) {
                    const reason = this.refuse;
                    this.refuse = null;
                    return { success: false, reason, error: `refused: ${reason}` };
                }
                if (this.running) return { success: false, reason: 'running', error: 'running' };
                if (this.testMode) return { success: false, reason: 'test_mode_on', error: 'test mode' };
                if (data.mode === 'host') {
                    // online_rules::changes_for: Host, Public, the RoomName of a public room; JoinCode removed.
                    const name = String(data.roomName || '').trim();
                    if (name.length > 32 || /[^\x20-\x7e]|[;"]/.test(name)) return { success: false, reason: 'bad_room_name', error: 'bad name' };
                    this.online.Host = 'broker';
                    this.online.Public = data.public === true ? '1' : '0';
                    if (data.public === true && name) this.online.RoomName = name;
                    else delete this.online.RoomName;
                    delete this.online.JoinCode;
                } else if (data.mode === 'join') {
                    const code = String(data.code).toUpperCase().replace(/[\s-]/g, '');
                    if (code.length !== 8 || [...code].some(c => !ALPHABET.includes(c))) return { success: false, reason: 'bad_code', error: 'bad code' };
                    this.online.JoinCode = code;
                    delete this.online.Host;
                    delete this.online.Public;
                    delete this.online.RoomName;
                } else {
                    return { success: false, reason: 'bad_mode', error: 'bad mode' };
                }
                this.status = null; // the stale online-status.json
                return { success: true, values: { Host: this.online.Host || null, JoinCode: this.online.JoinCode || null }, code: this.online.JoinCode };
            }
            case 'launch-game':
                this.launches.push(Object.assign({}, data));
                if (data.online !== true) {
                    delete this.online.Host;
                    delete this.online.Public;
                    delete this.online.RoomName;
                    delete this.online.JoinCode;
                    this.status = null;
                }
                return null;
            case 'get-public-rooms':
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
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/online-zones.js', 'app/online-browse.js', 'app/online-view.js'], body, backend });
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

module.exports = { FOLDER, ALPHABET, ERRORS, Backend, open, host, joinWith };
