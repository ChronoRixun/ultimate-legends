'use strict';
// The opt-in DXVK renderer (app/dxvk-view.js; backend commands/dxvk_commands.cpp, logic display/dxvk.cpp
// with its native tests): off by default, nothing downloaded until the player turns it on AND confirms a
// box that names the source and size, the download's progress and Cancel, Off removing it, the player's
// own d3d8/d3d9 blocking it, Proton (its own DXVK), offline without the saved download, a build running,
// and a failure shown as the backend says it. No network: the backend is a fake.

const assert = require('node:assert/strict');
const { page, test, settle } = require('./harness');

class Backend {
    constructor(state = {}) {
        this.state = Object.assign({ supported: true, installed: true, wine: false, offline: false, version: '3.1.1',
            url: 'https://github.com/doitsujin/dxvk/releases/download/v3.1.1/dxvk-3.1.1.tar.gz', size: 18041512,
            files: 'none', wanted: false, cached: false, running: false, busy: false, phase: '', done: 0, total: 0, error: '' }, state);
        this.calls = [];
        this.steps = []; // states the job goes through on the next polls after set-dxvk on
    }

    handle(command, data) {
        this.calls.push({ command, data });
        if (command === 'get-dxvk-state') {
            if (this.steps.length) Object.assign(this.state, this.steps.shift());
            return Object.assign({}, this.state);
        }
        if (command === 'set-dxvk') {
            if (this.refuse) return { success: false, error: this.refuse };
            if (data.enabled) {
                Object.assign(this.state, { busy: true, phase: 'download', done: 0, total: this.state.size, wanted: true });
                this.steps = [{ done: 9020756 }, { phase: 'verify' }, { phase: 'install' },
                    { busy: false, phase: '', files: 'ours', cached: true }];
            } else {
                Object.assign(this.state, { files: 'none', wanted: false });
            }
            return { success: true };
        }
        if (command === 'cancel-dxvk') {
            this.steps = [{ busy: false, phase: '', files: 'none', wanted: false }];
            return { success: true };
        }
        return null;
    }

    sent(command) {
        return this.calls.filter(call => call.command === command).map(call => call.data);
    }
}

async function open(state, { choice = 1, building = false, game = 'xml1' } = {}) {
    const backend = new Backend(state);
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/dxvk-view.js'], backend, body: `<div id="${game}-dxvk-panel"></div>` });
    p.window.Xml1Port = { starting: false, isBuilding: () => building };
    p.window.showMessageBox = async (...args) => {
        p.messages.push(args);
        return choice;
    };
    p.window.DxvkView.render(game);
    await settle();
    const $ = selector => p.document.querySelector(`#${game}-dxvk-panel ${selector}`);
    const on = () => $('.ul-dxvk-toggle .toggle-btn[data-value="1"]');
    const off = () => $('.ul-dxvk-toggle .toggle-btn[data-value="0"]');
    const status = () => $('.ul-dxvk-status').textContent;
    return { ...p, backend, $, on, off, status };
}

test('DXVK: off by default, says what it downloads and from where, nothing sent on opening', async () => {
    const p = await open();
    assert.equal(p.off().classList.contains('active'), true);
    assert.equal(p.on().classList.contains('active'), false);
    assert.equal(p.on().disabled, false);
    assert.match(p.$('.ul-display-label').textContent, /Use DXVK \(Vulkan\) renderer/);
    assert.match(p.$('.ul-display-description').textContent, /Downloads DXVK 3\.1\.1 from its official GitHub release/);
    assert.match(p.$('.ul-display-footer').textContent, /github\.com\/doitsujin\/dxvk.*SHA-256.*32-bit d3d8\.dll and d3d9\.dll/);
    assert.match(p.status(), /Off/);
    assert.deepEqual(p.backend.sent('set-dxvk'), []);
});

test('DXVK: On asks first (source and size); Cancel downloads nothing', async () => {
    const p = await open({}, { choice: 0 });
    p.on().click();
    await settle();
    assert.equal(p.messages.length, 1);
    assert.match(p.messages[0][0], /Download DXVK 3\.1\.1\?/);
    assert.match(p.messages[0][1], /dxvk-3\.1\.1\.tar\.gz \(17\.2\d? MB\) from github\.com\/doitsujin\/dxvk/);
    assert.deepEqual(p.backend.sent('set-dxvk'), []);
    assert.equal(p.off().classList.contains('active'), true);
});

test('DXVK: confirmed, it downloads with progress, checks, installs and says it is on', async () => {
    const p = await open();
    p.on().click();
    await settle();
    assert.deepEqual(p.backend.sent('set-dxvk').map(data => ({ ...data })), [{ game: 'xml1', enabled: true }]);
    assert.match(p.status(), /Downloading DXVK 3\.1\.1\.\.\. 50%/);
    assert.ok(p.$('.ul-dxvk-bar'));
    assert.ok(p.$('[data-op="cancel"]'), 'Cancel while it works');
    assert.equal(p.$('.ul-dxvk-toggle'), null);
    await p.clock.advance(500);
    await settle();
    assert.match(p.status(), /Checking the download/);
    await p.clock.advance(500);
    await settle();
    assert.match(p.status(), /Installing/);
    await p.clock.advance(1000);
    await settle();
    assert.match(p.status(), /DXVK 3\.1\.1 is on/);
    assert.equal(p.on().classList.contains('active'), true);
    assert.equal(p.off().disabled, false);
    const polls = p.backend.sent('get-dxvk-state').length;
    await p.clock.advance(5000);
    assert.equal(p.backend.sent('get-dxvk-state').length, polls, 'no polling once it is done');
});

test('DXVK: Off removes it; turning it on again with the saved download asks nothing', async () => {
    const p = await open({ files: 'ours', wanted: true, cached: true });
    p.off().click();
    await settle();
    assert.deepEqual(p.backend.sent('set-dxvk').map(data => ({ ...data })), [{ game: 'xml1', enabled: false }]);
    assert.equal(p.off().classList.contains('active'), true);
    p.on().click();
    await settle();
    assert.equal(p.messages.length, 0, 'already downloaded and checked: no second question');
    assert.equal(p.backend.sent('set-dxvk').length, 2);
});

test('DXVK: Cancel stops the download', async () => {
    const p = await open();
    p.on().click();
    await settle();
    p.$('[data-op="cancel"]').click();
    await settle();
    assert.equal(p.backend.sent('cancel-dxvk').length, 1);
    assert.equal(p.off().classList.contains('active'), true);
});

test('DXVK: the player\'s own d3d8/d3d9, Proton, offline without the download and a running build block On', async () => {
    const foreign = await open({ files: 'foreign' });
    assert.equal(foreign.on().disabled, true);
    assert.equal(foreign.off().disabled, true, 'nothing of ours to remove');
    assert.match(foreign.status(), /Another d3d8\.dll or d3d9\.dll .* never replaces it/);

    const proton = await open({ wine: true });
    assert.equal(proton.on().disabled, true);
    assert.match(proton.status(), /Proton already runs this game through its own DXVK/);
    const protonOurs = await open({ wine: true, files: 'ours' });
    assert.equal(protonOurs.off().disabled, false, 'files of ours can still be removed under Proton');

    const offline = await open({ offline: true });
    assert.equal(offline.on().disabled, true);
    assert.match(offline.status(), /Offline/);
    const offlineCached = await open({ offline: true, cached: true });
    assert.equal(offlineCached.on().disabled, false);

    const building = await open({}, { building: true });
    assert.equal(building.on().disabled, true);
    assert.match(building.status(), /being built/);

    const running = await open({ files: 'ours', running: true });
    assert.equal(running.off().disabled, true);
    assert.match(running.status(), /Close the game/);
});

test('DXVK: a rebuild that swept it out puts it back once from the checked download, without asking', async () => {
    const p = await open({ wanted: true, cached: true });
    assert.deepEqual(p.backend.sent('set-dxvk').map(data => ({ ...data })), [{ game: 'xml1', enabled: true }]);
    assert.equal(p.messages.length, 0);
    await p.clock.advance(3000);
    await settle();
    assert.match(p.status(), /DXVK 3\.1\.1 is on/);
    // Only once a session: a restore that fails is not retried in a loop.
    const failing = await open({ wanted: true, cached: true });
    failing.backend.refuse = 'Close the game first: its files are in use.';
    failing.backend.steps = [];
    await settle();
    failing.window.DxvkView.reload('xml1');
    await settle();
    assert.ok(failing.backend.sent('set-dxvk').length <= 1);
    // Not while a build runs, and not without the saved download.
    const duringBuild = await open({ wanted: true, cached: true }, { building: true });
    assert.deepEqual(duringBuild.backend.sent('set-dxvk'), []);
    const notCached = await open({ wanted: true, cached: false });
    assert.deepEqual(notCached.backend.sent('set-dxvk'), []);
    assert.match(notCached.status(), /no longer in the game folder/);
});

test('DXVK: a failure and an unset-up game say so', async () => {
    const failed = await open({ error: 'The DXVK 3.1.1 download did not match its pinned SHA-256, so it was deleted and nothing was installed.' });
    assert.match(failed.status(), /did not match its pinned SHA-256/);
    assert.equal(failed.$('.ul-dxvk-status').classList.contains('is-error'), true);
    const refused = await open();
    refused.backend.refuse = 'Close the game first: its files are in use.';
    refused.on().click();
    await settle();
    assert.deepEqual(refused.toasts.map(toast => toast[0]), ['Close the game first: its files are in use.']);
    const absent = await open({ installed: false });
    assert.equal(absent.$('.ul-dxvk-toggle'), null);
    assert.match(absent.document.querySelector('#xml1-dxvk-panel').textContent, /Set up the game first/);
});

test('DXVK: offered on both XML2-engine games and nowhere else', async () => {
    const p = await open({}, { game: 'xml2' });
    assert.ok(p.on());
    assert.equal(p.window.DxvkView.supports('xml1'), true);
    assert.equal(p.window.DxvkView.supports('xml2'), true);
    for (const other of ['mua', 'mua2', 'muac']) assert.equal(p.window.DxvkView.supports(other), false);
});
