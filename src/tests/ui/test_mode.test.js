'use strict';
// The X-Men Legends page's Test mode section and its badge next to Play (launcher 0.3.2): the toggles
// show the [TestMode] keys of the port's xml2-fix.ini, a toggle writes its own key only, the badge
// is there exactly while either switch is on, and Turn test mode off writes both off at once. The
// real test-mode-view.js runs against a fake backend that keeps the two keys the way the C++ does
// (test_mode_settings: absent = off; any other key refused). That the rest of the file stays byte
// for byte is the real WritePrivateProfileString's job: tools/dev/test_mode_cdp.py checks it.

const assert = require('node:assert/strict');
const { page, test } = require('./harness');

const INI = 'D:\\Games\\X-Men Legends (Port)\\xml2-fix.ini';
const KEYS = ['ForgeEverywhere', 'Hotkeys'];

class Backend {
    constructor(values, { fixInstalled = true, running = false } = {}) {
        this.values = Object.assign({ ForgeEverywhere: null, Hotkeys: null }, values);
        this.fixInstalled = fixInstalled;
        this.running = running;
        this.saves = [];
        this.refuse = null; // an error the next write answers with (the builder holding the folder, say)
    }

    handle(command, data) {
        if (command === 'get-test-mode-settings') {
            return {
                supported: true, installed: true, fixInstalled: this.fixInstalled, running: this.running,
                fix: 'XML2 Fix', file: 'xml2-fix.ini', ini: this.fixInstalled ? INI : undefined, keys: KEYS.slice(),
                values: this.fixInstalled ? Object.assign({}, this.values) : { ForgeEverywhere: null, Hotkeys: null },
                defaults: { ForgeEverywhere: false, Hotkeys: false }
            };
        }
        if (command === 'set-test-mode-settings') {
            const sent = Object.assign({}, data.values);
            this.saves.push(sent);
            if (this.refuse) {
                const error = this.refuse;
                this.refuse = null;
                return { success: false, error, values: Object.assign({}, this.values) };
            }
            if (Object.keys(sent).some(key => !KEYS.includes(key))) return { success: false, error: 'Unknown test mode setting' };
            Object.assign(this.values, sent);
            return { success: true, values: Object.assign({}, this.values) };
        }
        return null;
    }
}

async function open(values, options = {}, port = {}) {
    const backend = new Backend(values, options);
    const body = `
        <div id="xml1-page">
            <div class="button-group" id="xml1-button-group"><div class="left-buttons"><button class="play-button" id="xml1-play-button">Play</button></div></div>
            <div class="ul-testmode-badge-host" id="xml1-testmode-badge" hidden></div>
            <div id="xml1-testmode-panel"></div>
        </div>`;
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/test-mode-view.js'], body, backend });
    // What the view reads of Xml1Port: the folder's fix and whether a build runs or starts.
    p.window.Xml1Port = Object.assign({
        status: { fix: { installed: true, version: '1.6.0' } },
        starting: null,
        building: false,
        isBuilding() { return this.building; }
    }, port);
    p.window.TestModeView.render('xml1');
    await p.clock.advance(0);

    const $ = selector => p.document.querySelector(selector);
    const panel = () => $('#xml1-testmode-panel');
    const shown = key => {
        const button = panel().querySelector(`.ul-testmode-toggle[data-key="${key}"] .toggle-btn.active`);
        return button ? button.dataset.value : null;
    };
    const toggle = (key, value) => panel().querySelector(`.ul-testmode-toggle[data-key="${key}"] .toggle-btn[data-value="${value}"]`);
    const badge = () => $('#xml1-testmode-badge');
    const badgeShown = () => !badge().hidden && !!badge().querySelector('.ul-testmode-badge');
    const status = () => panel().querySelector('.ul-display-status');
    return { ...p, backend, $, panel, shown, toggle, badge, badgeShown, status };
}

test('test mode: the toggles show the file; absent and unreadable values are off', async () => {
    let t = await open({ ForgeEverywhere: true, Hotkeys: null });
    assert.equal(t.panel().querySelectorAll('.ul-testmode-row').length, 2);
    assert.equal(t.shown('ForgeEverywhere'), '1', 'ForgeEverywhere=1 shows ON');
    assert.equal(t.shown('Hotkeys'), '0', 'no Hotkeys key shows OFF');
    assert.equal(t.panel().querySelector('.ul-testmode-row[data-row="ForgeEverywhere"] .ul-display-label').textContent, 'Forge at every Xtraction point');
    assert.equal(t.panel().querySelector('.ul-testmode-row[data-row="Hotkeys"] .ul-display-label').textContent, 'Test hotkeys F8/F9/F10');
    assert.match(t.panel().querySelector('.ul-testmode-online').textContent, /turns online play off/, 'the online note is on the section');
    assert.match(t.panel().querySelector('.ul-display-footer').textContent, /xml2-fix\.ini/);
    assert.equal(t.badgeShown(), true, 'one switch on: the badge');

    t = await open({ ForgeEverywhere: false, Hotkeys: 'maybe' });
    assert.equal(t.shown('ForgeEverywhere'), '0');
    assert.equal(t.shown('Hotkeys'), '0', 'a value the fix can not read as 0/1 shows the default, OFF');
    assert.equal(t.badgeShown(), false, 'nothing on: no badge');
    assert.deepEqual(t.backend.saves, [], 'opening the page writes nothing');
});

test('test mode: a toggle writes its own key only, once, after the save delay', async () => {
    const t = await open({});
    t.toggle('Hotkeys', '1').click();
    assert.equal(t.shown('Hotkeys'), '1', 'the toggle follows at once');
    assert.deepEqual(t.backend.saves, [], 'not saved yet (250 ms)');
    await t.clock.advance(400);
    assert.deepEqual(t.backend.saves, [{ Hotkeys: true }], 'Hotkeys alone: ForgeEverywhere is not written');
    assert.equal(t.backend.values.ForgeEverywhere, null, 'ForgeEverywhere stays absent');
    assert.equal(t.shown('Hotkeys'), '1', 'and the file says so');
});

test('test mode: the badge appears with the first switch on and goes with the last one off', async () => {
    const t = await open({});
    assert.equal(t.badgeShown(), false);
    t.toggle('ForgeEverywhere', '1').click();
    assert.equal(t.badgeShown(), true, 'shown at the click, before the save');
    assert.match(t.badge().textContent, /Test mode on/);
    assert.match(t.badge().textContent, /Online play is off/);
    await t.clock.advance(400);
    t.toggle('Hotkeys', '1').click();
    await t.clock.advance(400);
    assert.equal(t.badgeShown(), true);

    t.toggle('ForgeEverywhere', '0').click();
    await t.clock.advance(400);
    assert.equal(t.badgeShown(), true, 'Hotkeys still on: still shown');
    t.toggle('Hotkeys', '0').click();
    assert.equal(t.badgeShown(), false, 'both off: gone at the click');
    await t.clock.advance(400);
    assert.deepEqual(t.backend.saves, [{ ForgeEverywhere: true }, { Hotkeys: true }, { ForgeEverywhere: false }, { Hotkeys: false }]);
    assert.equal(t.badgeShown(), false);
});

test('test mode: Turn test mode off writes both off at once and hands the focus to Play', async () => {
    const t = await open({ ForgeEverywhere: true, Hotkeys: true });
    const off = t.badge().querySelector('.ul-testmode-off');
    assert.equal(off.tagName, 'BUTTON');
    off.focus(); // a keyboard or controller user on the button
    off.click();
    assert.equal(t.badgeShown(), false, 'the badge goes at the click');
    await t.clock.advance(0);
    assert.deepEqual(t.backend.saves, [{ ForgeEverywhere: false, Hotkeys: false }], 'one write, no save delay');
    assert.deepEqual(t.backend.values, { ForgeEverywhere: false, Hotkeys: false });
    assert.equal(t.shown('ForgeEverywhere'), '0');
    assert.equal(t.shown('Hotkeys'), '0');
    assert.equal(t.document.activeElement && t.document.activeElement.id, 'xml1-play-button', 'focus lands on Play');
});

test('test mode: Turn test mode off leaves an absent key absent', async () => {
    const t = await open({ ForgeEverywhere: true });
    t.badge().querySelector('.ul-testmode-off').click();
    await t.clock.advance(0);
    assert.deepEqual(t.backend.saves, [{ ForgeEverywhere: false }]);
    assert.equal(t.backend.values.Hotkeys, null);
});

test('test mode: the controls are buttons a keyboard or controller reaches (Tab, Enter / Space)', async () => {
    const t = await open({ Hotkeys: true });
    const controls = [...t.panel().querySelectorAll('.ul-testmode-toggle .toggle-btn'), t.badge().querySelector('.ul-testmode-off')];
    assert.equal(controls.length, 5);
    for (const control of controls) {
        assert.equal(control.tagName, 'BUTTON');
        assert.equal(control.getAttribute('type'), 'button');
        assert.equal(control.hasAttribute('tabindex'), false, 'in the Tab order where it stands');
        assert.equal(control.disabled, false);
    }
    assert.equal(t.toggle('Hotkeys', '1').getAttribute('aria-pressed'), 'true');
    assert.equal(t.toggle('Hotkeys', '0').getAttribute('aria-pressed'), 'false');
});

test('test mode: no writes while a build runs; a refused write goes back to the file', async () => {
    const t = await open({}, {}, { building: true });
    assert.equal(t.toggle('ForgeEverywhere', '1').disabled, true, 'toggles disabled during a build');
    assert.match(t.status().textContent, /build is running/);
    t.toggle('ForgeEverywhere', '1').click();
    await t.clock.advance(400);
    assert.deepEqual(t.backend.saves, []);

    t.window.Xml1Port.building = false;
    t.window.dispatchEvent(new t.window.CustomEvent('ul-xml1-changed'));
    assert.equal(t.toggle('ForgeEverywhere', '1').disabled, false, 'enabled again when it ends');
    assert.equal(t.status().hidden, true);

    // The builder took the folder between the page's look and the write: the backend refuses.
    t.backend.refuse = 'X-Men Legends is being built in this folder.';
    t.toggle('ForgeEverywhere', '1').click();
    assert.equal(t.badgeShown(), true);
    await t.clock.advance(400);
    assert.equal(t.toasts.length, 1, 'the refusal is shown');
    assert.equal(t.shown('ForgeEverywhere'), '0', 'the toggle shows the file again');
    assert.equal(t.badgeShown(), false, 'and the badge with it');
});

test('test mode: an older XML2 Fix is named; no fix, no toggles and no badge', async () => {
    let t = await open({ Hotkeys: true }, {}, { status: { fix: { installed: true, version: '1.5.0' } } });
    assert.equal(t.status().hidden, false);
    assert.match(t.status().textContent, /needs XML2 Fix 1\.6\.0 or later; this folder has 1\.5\.0/);
    for (const version of ['1.6.0', '1.6.1', '1.10.0', '2.0']) {
        t = await open({}, {}, { status: { fix: { installed: true, version } } });
        assert.equal(t.status().hidden, true, `${version} is new enough`);
    }

    t = await open({}, { fixInstalled: false });
    assert.equal(t.panel().querySelectorAll('.ul-testmode-row').length, 0);
    assert.match(t.panel().querySelector('.ul-display-empty').textContent, /Install the XML2 Fix/);
    assert.equal(t.badgeShown(), false);
});

test('test mode: the game running: changes apply at its next start', async () => {
    const t = await open({}, { running: true });
    assert.match(t.status().textContent, /next time you start it/);
});
