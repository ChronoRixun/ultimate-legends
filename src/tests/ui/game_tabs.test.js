'use strict';
// The X-Men Legends page's tabs (core/game-tabs.js, the X-Men Legends definition in app/xml1-view.js,
// views.js gameDetailsHTML; TAB-MAP.md with Owen's decisions of 2026-11-11): six tabs under a persistent
// header (Play, test-mode badge, attention strip), Overview first ever and then the last tab picked -
// remembered across a restart -, tabs that exist only once the game is built, "no empty tabs", a state
// that opens Build & tools once, the strip's actions and Details, For testers folding the test switches,
// LT / RT and Ctrl+PageUp / Ctrl+PageDown, focus never left in a closed panel, and every new string in
// en / fr / es. The real views run against a fake backend; layout is checked separately (screenshots).

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { page, test, settle, KeyboardEvent } = require('./harness');

const PORT = 'D:\\Games\\X-Men Legends (Port)';
const SCRIPTS = ['core/utils.js', 'core/i18n.js', 'core/focus-nav.js', 'core/gamepad-nav.js', 'core/game-tabs.js',
    'app/display-view.js', 'app/remastered-view.js', 'app/dxvk-view.js', 'app/presence-view.js', 'app/test-mode-view.js',
    'app/mods-view.js', 'app/xml1-port.js', 'app/xml1-view.js', 'app/views.js'];

function memoryStorage() {
    const map = new Map();
    return { map, getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
}

class Backend {
    constructor({ state = 'ready', testMode = false } = {}) {
        this.state = state;
        this.testMode = testMode;
        this.build = null;
    }

    status() {
        if (this.state === 'not-setup') {
            return { install: '', exists: false, state: 'not-setup', build: null, xml2: { setUp: true },
                fix: { installed: false, ok: false, version: '', required: '1.11.0' }, builder: { installed: true, version: '0.6.0' } };
        }
        const building = this.state === 'building';
        return { install: PORT, iso: 'D:\\Discs\\xml1.iso', isoExists: true, cacheHasDisc: true, exists: true, isInstalled: this.state === 'ready',
            state: building ? 'building' : this.state, xml2: { setUp: true },
            build: { stamp: this.state !== 'incomplete', building: this.state === 'incomplete', game: true, contentVersion: 38 },
            fix: { installed: true, version: '1.12.0.0', required: '1.11.0', ok: true },
            builder: { installed: true, version: '0.6.0', classicConversation: true }, classicConversation: true,
            work: building ? { id: 7, command: 'build', active: true, exitCode: -1 } : null };
    }

    handle(command, data) {
        const installed = this.state !== 'not-setup';
        switch (command) {
            case 'get-xml1-status': return this.status();
            case 'get-xml1-build':
            case 'get-xml1-job':
                return this.state === 'building'
                    ? { id: 7, command: 'build', active: true, finished: false, stages: [{ id: 'levels', title: 'Converting levels' }], stage: 'levels', overall: 42, etaS: 600, notices: [], errors: [], logTail: [] }
                    : null;
            case 'get-display-settings':
                return { supported: true, installed, fixInstalled: installed, running: false, ini: `${PORT}\\xml2-fix.ini`,
                    values: { Mode: 'borderless' }, modes: [{ width: 1280, height: 800 }], desktop: { width: 1280, height: 800, refresh: 60 } };
            case 'get-remastered-settings':
                return { supported: true, installed, fixInstalled: installed, available: true, requiredFix: '1.12.0', values: {} };
            case 'get-dxvk-state':
                return { supported: true, installed, wine: false, offline: false, version: '3.1.1', size: 18041512, files: 'none',
                    wanted: false, cached: false, running: false, busy: false, phase: '', done: 0, total: 0, error: '' };
            case 'get-presence-settings':
                return { supported: true, installed, fixInstalled: installed, running: false, keys: ['Enabled'], values: { Enabled: null }, defaults: { Enabled: true } };
            case 'get-test-mode-settings':
                return { supported: true, installed, fixInstalled: installed, running: false, keys: ['ForgeEverywhere', 'Hotkeys'],
                    values: { ForgeEverywhere: this.testMode ? true : null, Hotkeys: null }, defaults: { ForgeEverywhere: false, Hotkeys: false } };
            case 'get-mods':
                return { supported: true, installed, folder: `${PORT}\\mods`, mods: [] };
            default:
                return null;
        }
    }
}

async function open(options = {}) {
    const backend = new Backend(options);
    const p = page({ scripts: SCRIPTS, backend, storage: options.storage || memoryStorage() });
    await p.window.Xml1Port.refresh();
    p.window.AppViews.renderGamePages();
    await settle();
    await p.clock.advance(10);
    await settle();
    const $ = selector => p.document.querySelector(selector);
    const tabs = p.window.GameTabs;
    const shown = () => [...tabs.visibleTabs('xml1')];
    const chip = id => $(`#xml1-tab-${id}`);
    const panel = id => $(`#xml1-panel-${id}`);
    const change = async state => {
        backend.state = state;
        // A build that ended: the port's last job is no longer active.
        if (state !== 'building' && p.window.Xml1Port.build) p.window.Xml1Port.build = null;
        await p.window.Xml1Port.refresh();
        await settle();
    };
    return { ...p, backend, $, tabs, shown, chip, panel, change };
}

test('game tabs: six tabs under Play, Overview first, one panel shown, chips are buttons with tab roles', async () => {
    const p = await open();
    const strip = p.$('#xml1-tabs');
    assert.equal(strip.getAttribute('role'), 'tablist');
    const ids = strip.querySelectorAll('[data-game-tab]').map(chip => chip.dataset.gameTab);
    assert.deepEqual(ids, ['overview', 'online', 'options', 'characters', 'mods', 'build']);
    // OnlineView / ModelsView are not loaded here: a tab without its panel does not show.
    assert.deepEqual(p.shown(), ['overview', 'options', 'mods', 'build']);
    assert.equal(p.tabs.active('xml1'), 'overview');
    assert.equal(p.chip('overview').getAttribute('aria-selected'), 'true');
    assert.equal(p.chip('overview').tagName, 'BUTTON');
    assert.equal(p.panel('overview').hidden, false);
    ['options', 'mods', 'build'].forEach(id => assert.equal(p.panel(id).hidden, true, id));
    // The persistent header (Play's group, the badge host, the strip) is outside every panel.
    for (const id of ['xml1-button-group', 'xml1-testmode-badge', 'xml1-attention']) {
        assert.ok(p.$(`#${id}`), id);
        assert.equal(p.$(`#${id}`).closest('.game-tabpanel'), null, id);
    }
    // Hosts keep their ids, in the tab TAB-MAP gives them.
    assert.ok(p.panel('options').querySelector('#xml1-display-panel'));
    assert.ok(p.panel('options').querySelector('#xml1-remastered-panel'));
    assert.ok(p.panel('options').querySelector('#xml1-dxvk-panel'));
    assert.ok(p.panel('options').querySelector('#xml1-presence-panel'));
    assert.ok(p.panel('options').querySelector('#xml1-appearance-panel'));
    assert.ok(p.panel('build').querySelector('#xml1-build-panel'));
    assert.ok(p.panel('build').querySelector('details#xml1-testers #xml1-testmode-panel'));
    assert.ok(p.panel('overview').querySelector('.detail-panel-grid'));
});

test('game tabs: picking a tab shows only its panel and is remembered across a launcher restart', async () => {
    const storage = memoryStorage();
    const p = await open({ storage });
    p.chip('mods').click();
    assert.equal(p.tabs.active('xml1'), 'mods');
    assert.equal(p.panel('mods').hidden, false);
    assert.equal(p.panel('overview').hidden, true);
    assert.equal(p.chip('mods').classList.contains('active'), true);
    assert.equal(storage.getItem('ul.gameTab.xml1'), 'mods');

    const again = await open({ storage });
    assert.equal(again.tabs.active('xml1'), 'mods');
    assert.equal(again.panel('mods').hidden, false);
});

test('game tabs: not set up shows Overview and Build & tools only; the rest appear once the game is built', async () => {
    const storage = memoryStorage();
    storage.setItem('ul.gameTab.xml1', 'options');
    const p = await open({ state: 'not-setup', storage });
    assert.deepEqual(p.shown(), ['overview', 'build']);
    ['options', 'mods'].forEach(id => assert.equal(p.chip(id).hidden, true, id));
    assert.equal(p.tabs.active('xml1'), 'overview');
    // The strip carries Set up, above the tabs.
    const strip = p.$('#xml1-attention');
    assert.equal(strip.hidden, false);
    assert.ok(strip.querySelector('[data-act="setup"]'));
    assert.match(strip.textContent, /Set up/);
    // A hidden tab can't be picked.
    assert.equal(p.tabs.select('xml1', 'mods', { user: true }), false);

    await p.change('ready');
    assert.deepEqual(p.shown(), ['overview', 'options', 'mods', 'build']);
    assert.equal(p.$('#xml1-attention').hidden, true);
    // The remembered tab was kept while it couldn't show, but a state change (not set up -> ready) has no
    // tab of its own, so the player's choice comes back.
    assert.equal(p.tabs.active('xml1'), 'options');
});

test('game tabs: a build, damage or an unfinished build opens Build & tools once; the player can leave it', async () => {
    const p = await open();
    p.chip('mods').click();
    await p.change('building');
    assert.equal(p.tabs.active('xml1'), 'build');
    // The strip: pill, progress, Cancel build and Show progress; the Build panel doesn't repeat them.
    const strip = p.$('#xml1-attention');
    assert.equal(strip.hidden, false);
    assert.ok(strip.querySelector('.xml1-progress'));
    assert.ok(strip.querySelector('[data-act="cancel-build"]'));
    assert.ok(strip.querySelector('[data-act="show-progress"]'));
    const build = p.$('#xml1-build-panel');
    assert.equal(build.querySelector('.xml1-state'), null);
    assert.equal(build.querySelector('.xml1-progress'), null);
    assert.equal(build.querySelector('[data-act="cancel-build"]'), null);

    // The player picks another tab: the same state does not pull them back.
    p.chip('mods').click();
    p.window.dispatchEvent(new p.window.CustomEvent('ul-xml1-changed'));
    await settle();
    p.tabs.refreshAll();
    assert.equal(p.tabs.active('xml1'), 'mods');
    // Remembered: the player's pick, never the state's.
    assert.equal(p.window.localStorage.getItem('ul.gameTab.xml1'), 'mods');

    await p.change('ready');
    assert.equal(p.tabs.active('xml1'), 'mods');
    assert.equal(strip.hidden, true);
    assert.ok(p.$('#xml1-build-panel .xml1-state.is-ready'), 'the Build panel has its own state line again');

    await p.change('incomplete');
    assert.equal(p.tabs.active('xml1'), 'build');
    assert.ok(strip.querySelector('[data-act="resume"]'));
    assert.equal(p.$('#xml1-build-panel [data-act="resume"]'), null);
    p.chip('overview').click();
    strip.querySelector('[data-goto-tab="build"]').click();
    assert.equal(p.tabs.active('xml1'), 'build');
    assert.equal(p.document.activeElement, p.chip('build'), 'Details moves the focus to the tab it opened');
});

test('game tabs: Damaged shows Repair and Details in the strip, over any tab', async () => {
    const p = await open();
    p.chip('options').click();
    p.window.Xml1Port.verify = { state: 'damaged', files: 100, groups: [{ code: 'missing', count: 2, files: ['a.igb', 'b.igb'] }] };
    p.window.Xml1Port.emit();
    await settle();
    assert.equal(p.tabs.active('xml1'), 'build');
    const strip = p.$('#xml1-attention');
    assert.ok(strip.querySelector('.xml1-state.is-damaged'));
    assert.ok(strip.querySelector('[data-act="rebuild"]'));
    assert.ok(strip.querySelector('[data-goto-tab="build"]'));
    assert.ok(p.$('#xml1-build-panel .xml1-verify'), 'the details stay in Build & tools');
    p.chip('options').click();
    assert.equal(strip.hidden, false, 'the strip stays above whatever tab is open');
});

test('game tabs: a tab whose panel rendered with nothing to use is hidden ("no empty tabs")', async () => {
    const p = await open();
    assert.ok(p.shown().includes('mods'));
    const host = p.$('#xml1-mods-panel');
    host.innerHTML = '<div class="ul-display-empty">Set up the game first.</div>';
    p.tabs.refreshAll();
    assert.ok(!p.shown().includes('mods'));
    assert.equal(p.chip('mods').hidden, true);
    // A panel that hasn't rendered yet (empty host) is not "empty": no blinking while it loads.
    host.innerHTML = '';
    p.tabs.refreshAll();
    assert.ok(p.shown().includes('mods'));
});

test('game tabs: Ctrl+PageDown / Ctrl+PageUp and LT / RT step through the visible tabs, wrapping', async () => {
    const p = await open();
    const press = key => p.document.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }));
    press('PageDown');
    assert.equal(p.tabs.active('xml1'), 'options');
    assert.equal(p.document.activeElement, p.chip('options'));
    press('PageDown');
    press('PageDown');
    assert.equal(p.tabs.active('xml1'), 'build');
    press('PageDown');
    assert.equal(p.tabs.active('xml1'), 'overview', 'wraps');
    press('PageUp');
    assert.equal(p.tabs.active('xml1'), 'build');
    // Without Ctrl, PageDown is the page's (scrolling), not the tabs'.
    p.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    assert.equal(p.tabs.active('xml1'), 'build');

    // The pad: buttons 6 / 7 (LT / RT) are PrevTab / NextTab; LB / RB stay the sidebar's.
    const step = (pads, now) => [...p.window.GamepadNav.step(pads, now)];
    const pad = buttons => [{ connected: true, buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: buttons.includes(i), value: buttons.includes(i) ? 1 : 0 })), axes: [0, 0] }];
    assert.deepEqual(step(pad([7]), 1000), ['NextTab']);
    assert.deepEqual(step(pad([]), 1100), []);
    assert.deepEqual(step(pad([6]), 1200), ['PrevTab']);
    assert.deepEqual(step(pad([]), 1300), []);
    assert.deepEqual(step(pad([4]), 1400), ['PrevSection']);
});

test('game tabs: focus inside a panel that closes moves to the tab that opened', async () => {
    const p = await open();
    p.chip('mods').click();
    const button = p.panel('mods').querySelector('button');
    assert.ok(button);
    button.focus();
    p.tabs.step(1);
    assert.equal(p.tabs.active('xml1'), 'build');
    assert.equal(p.document.activeElement, p.chip('build'));
});

test('game tabs: For testers folds the test switches in Build & tools and opens when a switch is on', async () => {
    const off = await open();
    assert.equal(off.$('#xml1-testers').open, false);
    const on = await open({ testMode: true });
    on.window.TestModeView.render('xml1');
    await settle();
    on.tabs.refreshAll();
    assert.equal(on.$('#xml1-testers').open, true);
    assert.equal(on.$('#xml1-testmode-badge').hidden, false, 'the badge by Play still says so');
});

test('game tabs: Build & tools says updates follow the channel and leads to it; Appearance is in Display & options', async () => {
    const p = await open();
    let opened = 0;
    p.window.UpdateChannel = { status: { channel: 'beta' }, channel: () => 'beta', openSetting: () => { opened++; } };
    p.window.Xml1View.render('xml1');
    const updates = p.$('#xml1-build-panel .xml1-updates');
    assert.ok(updates);
    assert.match(updates.textContent, /Updates follow your channel: Beta/);
    updates.querySelector('[data-op="open-channel"]').click();
    assert.equal(opened, 1);
    assert.ok(p.$('#xml1-appearance-panel [data-option="classicConversation"]'));
    assert.equal(p.$('#xml1-build-panel [data-option="classicConversation"]'), null);
});

test('game tabs: the other game pages keep one stacked page with the compact header', async () => {
    const p = await open();
    const xml2 = p.$('#xml2-page');
    assert.ok(xml2);
    assert.equal(xml2.classList.contains('is-tabbed'), false);
    // (Its sections are checked in the rendered preview: the tiny DOM stops parsing at the banner's
    // url("...") inline style.)
    assert.equal(p.document.getElementById('xml2-tabs'), null);
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'launcher-ui', 'assets', 'css', 'main.css'), 'utf8');
    assert.match(css, /\.game-page \.hero-section \{\s*height: 150px;/);
    assert.match(css, /\.game-page \.hero-section \.game-meta-row \{\s*display: none;/);
    assert.match(css, /\.game-tabs \{\s*position: sticky;/);
});

test('game tabs: every tab and DXVK string exists in en, fr and es', () => {
    const p = page({ scripts: ['core/i18n.js'], backend: { handle: () => null } });
    const i18n = p.window.LauncherI18n;
    for (const group of ['gameTabs', 'dxvk']) {
        for (const key of Object.keys(collect(group))) {
            i18n.setLanguage('en');
            const english = i18n.t(`${group}.${key}`);
            assert.notEqual(english, `${group}.${key}`);
            for (const language of ['fr', 'es']) {
                i18n.setLanguage(language);
                const value = i18n.t(`${group}.${key}`);
                // Translated (the fallback would be the English text), except the words both share.
                assert.ok(value !== english || key === 'mods', `${language} ${group}.${key}`);
            }
        }
    }
    i18n.setLanguage('en');
});

// The keys of a string group, read from i18n.js's English block.
function collect(group) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'launcher-ui', 'assets', 'js', 'core', 'i18n.js'), 'utf8');
    const start = source.indexOf(`            ${group}: {`);
    assert.ok(start >= 0, group);
    const end = source.indexOf('\n            },', start);
    const keys = {};
    for (const match of source.slice(start, end).matchAll(/^\s{16}([A-Za-z]+):/gm)) keys[match[1]] = true;
    assert.ok(Object.keys(keys).length > 5, group);
    return keys;
}
