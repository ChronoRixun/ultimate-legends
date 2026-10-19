'use strict';
// The Display and Discord sections of the X-Men Legends page during a build: the builder merges its
// own keys into the port's xml2-fix.ini (read, change, replace), so the launcher writes nothing to it
// meanwhile. The controls are disabled while a build runs or starts, with a status line, and come back
// with what the file holds once it ends; a write the backend refuses (set-display-settings and
// set-presence-settings take the folder's patch hold) shows the error and goes back to the file. Other
// games' pages are not the builder's and stay as they are. The real display-view.js and
// presence-view.js run against fake backends; that the C++ refuses the write and leaves the file byte
// for byte is tools/dev/xml1_cdp.py's.

const assert = require('node:assert/strict');
const { page, test, Event } = require('./harness');

const REFUSED = 'X-Men Legends is being built in this folder.';

// What the views read of Xml1Port: whether a build runs or starts.
function port(options) {
    return Object.assign({
        status: { fix: { installed: true, version: '1.6.0' } },
        starting: null,
        building: false,
        isBuilding() { return this.building; }
    }, options);
}

function endBuild(p) {
    p.window.Xml1Port.building = false;
    p.window.Xml1Port.starting = null;
    p.window.dispatchEvent(new p.window.CustomEvent('ul-xml1-changed'));
}

function startBuild(p) {
    p.window.Xml1Port.building = true;
    p.window.dispatchEvent(new p.window.CustomEvent('ul-xml1-changed'));
}

// ---- Display ----

class DisplayBackend {
    constructor(values) {
        this.values = Object.assign({ Mode: null, Width: null, Height: null, Topmost: null, RunInBackground: null, FrameRate: null, VSync: null }, values);
        this.saves = [];
        this.refuse = null; // an error the next write answers with
    }

    handle(command, data) {
        if (command === 'get-display-settings') {
            return {
                supported: true, installed: true, fixInstalled: true, running: false, ini: 'D:\\Games\\X-Men Legends (Port)\\xml2-fix.ini',
                values: Object.assign({}, this.values),
                modes: [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }],
                desktop: { width: 2560, height: 1440, refresh: 144 }
            };
        }
        if (command === 'set-display-settings') {
            const sent = Object.assign({}, data.values);
            this.saves.push(sent);
            if (this.refuse) {
                const error = this.refuse;
                this.refuse = null;
                return { success: false, error };
            }
            Object.assign(this.values, sent);
            return { success: true, values: Object.assign({}, this.values) };
        }
        return null;
    }
}

async function openDisplay(gameId, values, options = {}) {
    const backend = new DisplayBackend(values);
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/display-view.js'], body: `<div id="${gameId}-display-panel"></div>`, backend });
    p.window.Xml1Port = port(options);
    p.window.DisplayView.render(gameId);
    await p.clock.advance(0);
    const panel = () => p.document.querySelector(`#${gameId}-display-panel`);
    const select = key => panel().querySelector(`select[data-key="${key}"]`);
    const toggle = (key, value) => panel().querySelector(`.ul-display-toggle[data-key="${key}"] .toggle-btn[data-value="${value}"]`);
    const shown = key => {
        const button = panel().querySelector(`.ul-display-toggle[data-key="${key}"] .toggle-btn.active`);
        return button ? button.dataset.value : null;
    };
    const choose = (key, value) => {
        select(key).value = value;
        select(key).dispatchEvent(new Event('change', { bubbles: true }));
    };
    const controls = () => panel().querySelectorAll('.ul-display-select, .ul-display-toggle .toggle-btn');
    const status = () => panel().querySelector('.ul-display-status');
    return { ...p, backend, panel, select, toggle, shown, choose, controls, status };
}

test('display (X-Men Legends): every control disabled while a build runs, nothing written', async () => {
    const t = await openDisplay('xml1', { Mode: 'windowed', Width: 1280, Height: 720 }, { building: true });
    assert.equal(t.controls().length, 4 + 4, 'four selects, two toggles');
    for (const control of t.controls()) assert.equal(control.disabled, true, `${control.tagName} ${control.dataset.key || control.dataset.value} disabled`);
    assert.equal(t.panel().querySelectorAll('.ul-display-row.is-disabled').length, 6, 'every row greyed');
    assert.equal(t.status().hidden, false);
    assert.match(t.status().textContent, /build is running/);

    t.toggle('Topmost', '1').click();
    t.choose('Mode', 'borderless'); // (a browser fires no change on a disabled select; the view ignores one anyway)
    await t.clock.advance(400);
    assert.deepEqual(t.backend.saves, [], 'nothing written during the build');
    assert.equal(t.shown('Topmost'), '0');
});

test('display (X-Men Legends): a build starting counts too', async () => {
    const t = await openDisplay('xml1', {}, { starting: Promise.resolve() });
    for (const control of t.controls()) assert.equal(control.disabled, true);
    assert.match(t.status().textContent, /build is running/);
});

test('display (X-Men Legends): enabled again when the build ends, with what the file holds now', async () => {
    const t = await openDisplay('xml1', { Mode: 'windowed', Width: 1280, Height: 720 });
    for (const control of t.controls()) assert.equal(control.disabled, false, 'no build: enabled');
    assert.equal(t.status().hidden, true);

    startBuild(t);
    for (const control of t.controls()) assert.equal(control.disabled, true, 'a build started: disabled');
    assert.match(t.status().textContent, /build is running/);

    // The builder's merge, or the finish step's [Display] defaults, changed the file meanwhile.
    Object.assign(t.backend.values, { Mode: 'fullscreen', Width: 0, Height: 0, Topmost: true });
    endBuild(t);
    await t.clock.advance(0);
    assert.equal(t.select('Mode').value, 'fullscreen', 'the file read again');
    assert.equal(t.shown('Topmost'), '1');
    assert.equal(t.select('Mode').disabled, false);
    assert.equal(t.toggle('Topmost', '0').disabled, false);
    assert.equal(t.select('Resolution').disabled, true, 'Fullscreen: the resolution row stays off as before');
    assert.equal(t.status().hidden, true, 'the status line goes');

    t.choose('Mode', 'windowed');
    assert.equal(t.select('Resolution').disabled, false);
    await t.clock.advance(400);
    assert.deepEqual(t.backend.saves, [{ Mode: 'windowed' }], 'writes again');
});

test('display (X-Men Legends): a refused write shows the error and goes back to the file', async () => {
    const t = await openDisplay('xml1', { Mode: 'windowed', Width: 1280, Height: 720, Topmost: false });
    // The builder took the folder between the page's look and the write.
    t.backend.refuse = REFUSED;
    t.toggle('Topmost', '1').click();
    t.choose('Mode', 'borderless');
    assert.equal(t.shown('Topmost'), '1');
    await t.clock.advance(400);
    assert.deepEqual(t.backend.saves, [{ Topmost: true, Mode: 'borderless' }]);
    assert.equal(t.toasts.length, 1, 'the refusal is shown');
    assert.equal(t.toasts[0][0], REFUSED);
    assert.equal(t.shown('Topmost'), '0', 'the toggle shows the file again');
    assert.equal(t.select('Mode').value, 'windowed', 'and the mode');
});

test('display (X-Men Legends II): not the builder\'s folder, not disabled', async () => {
    const t = await openDisplay('xml2', { Mode: 'windowed', Width: 1280, Height: 720 }, { building: true });
    for (const control of t.controls()) assert.equal(control.disabled, false);
    assert.equal(t.status().hidden, true);
    t.toggle('Topmost', '1').click();
    await t.clock.advance(400);
    assert.deepEqual(t.backend.saves, [{ Topmost: true }]);
});

// ---- Discord ----

class PresenceBackend {
    constructor(values, keys = ['Enabled', 'ShowZone', 'ShowParty']) {
        this.keys = keys;
        this.values = Object.fromEntries(keys.map(key => [key, null]));
        Object.assign(this.values, values);
        this.saves = [];
        this.refuse = null;
    }

    handle(command, data) {
        if (command === 'get-presence-settings') {
            return {
                supported: true, installed: true, fixInstalled: true, running: false,
                fix: 'XML2 Fix', file: 'xml2-fix.ini', ini: 'D:\\Games\\X-Men Legends (Port)\\xml2-fix.ini', keys: this.keys.slice(),
                values: Object.assign({}, this.values),
                defaults: Object.fromEntries(this.keys.map(key => [key, true]))
            };
        }
        if (command === 'set-presence-settings') {
            const sent = Object.assign({}, data.values);
            this.saves.push(sent);
            if (this.refuse) {
                const error = this.refuse;
                this.refuse = null;
                return { success: false, error };
            }
            Object.assign(this.values, sent);
            return { success: true, values: Object.assign({}, this.values) };
        }
        return null;
    }
}

async function openPresence(gameId, values, options = {}, keys) {
    const backend = new PresenceBackend(values, keys);
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/presence-view.js'], body: `<div id="${gameId}-presence-panel"></div>`, backend });
    p.window.Xml1Port = port(options);
    p.window.PresenceView.render(gameId);
    await p.clock.advance(0);
    const panel = () => p.document.querySelector(`#${gameId}-presence-panel`);
    const toggle = (key, value) => panel().querySelector(`.ul-presence-toggle[data-key="${key}"] .toggle-btn[data-value="${value}"]`);
    const shown = key => {
        const button = panel().querySelector(`.ul-presence-toggle[data-key="${key}"] .toggle-btn.active`);
        return button ? button.dataset.value : null;
    };
    const buttons = () => panel().querySelectorAll('.ul-presence-toggle .toggle-btn');
    const status = () => panel().querySelector('.ul-display-status');
    return { ...p, backend, panel, toggle, shown, buttons, status };
}

test('discord (X-Men Legends): every toggle disabled while a build runs, nothing written', async () => {
    const t = await openPresence('xml1', {}, { building: true });
    assert.equal(t.buttons().length, 6);
    for (const button of t.buttons()) assert.equal(button.disabled, true);
    assert.equal(t.panel().querySelectorAll('.ul-presence-row.is-disabled').length, 3, 'every row greyed');
    assert.match(t.status().textContent, /build is running/);
    t.toggle('Enabled', '0').click();
    await t.clock.advance(400);
    assert.deepEqual(t.backend.saves, []);
    assert.equal(t.shown('Enabled'), '1');
});

test('discord (X-Men Legends): enabled again when the build ends; the details still follow the main switch', async () => {
    const t = await openPresence('xml1', { Enabled: true });
    for (const button of t.buttons()) assert.equal(button.disabled, false, 'no build: enabled');

    startBuild(t);
    for (const button of t.buttons()) assert.equal(button.disabled, true, 'a build started: disabled');
    assert.match(t.status().textContent, /build is running/);

    t.backend.values.Enabled = false; // the file as the builder left it
    endBuild(t);
    await t.clock.advance(0);
    assert.equal(t.shown('Enabled'), '0', 'the file read again');
    assert.equal(t.toggle('Enabled', '1').disabled, false, 'the main switch back');
    assert.equal(t.toggle('ShowZone', '1').disabled, true, 'presence off: the details stay off as before');
    assert.equal(t.status().hidden, true);

    t.toggle('Enabled', '1').click();
    assert.equal(t.toggle('ShowZone', '0').disabled, false);
    await t.clock.advance(400);
    assert.deepEqual(t.backend.saves, [{ Enabled: true }], 'writes again');
});

test('discord (X-Men Legends): a refused write shows the error and goes back to the file', async () => {
    const t = await openPresence('xml1', {});
    t.backend.refuse = REFUSED;
    t.toggle('ShowParty', '0').click();
    assert.equal(t.shown('ShowParty'), '0');
    await t.clock.advance(400);
    assert.deepEqual(t.backend.saves, [{ ShowParty: false }]);
    assert.equal(t.toasts.length, 1);
    assert.equal(t.toasts[0][0], REFUSED);
    assert.equal(t.shown('ShowParty'), '1', 'the toggle shows the file again');
});

test('discord (X-Men Legends II, MUA): not the builder\'s folder, not disabled', async () => {
    for (const [gameId, keys] of [['xml2'], ['mua', ['Enabled', 'ShowZone', 'ShowHero']], ['mua2', ['Enabled', 'ShowZone', 'ShowHero']]]) {
        const t = await openPresence(gameId, {}, { building: true }, keys);
        for (const button of t.buttons()) assert.equal(button.disabled, false, `${gameId}: enabled`);
        assert.equal(t.status().hidden, true);
        t.toggle('Enabled', '0').click();
        await t.clock.advance(400);
        assert.deepEqual(t.backend.saves, [{ Enabled: false }], `${gameId}: written`);
    }
});
