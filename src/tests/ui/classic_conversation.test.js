// Builder support comes from native status. Exercise the real page, wizard, preference
// command and all shared build entry points; native tests cover the version/CLI contract.
'use strict';
const assert = require('node:assert/strict');
const { page, test, settle } = require('./harness');

async function open({ supported = true, installed = true, enabled = false, fixOk = true } = {}) {
    const calls = [];
    const status = { state: 'ready', install: 'C:\\Games\\LC', exists: true, isInstalled: true,
        iso: 'C:\\Owned\\XML1.iso', isoExists: true, movies: true, keepCache: true, classicConversation: enabled,
        xml2: { setUp: true }, build: { stamp: true, game: true }, fix: { installed: true, ok: fixOk, version: '1.8.1', required: '1.11.0-beta.1' },
        builder: { installed, classicConversation: supported, version: supported ? '0.6.0-beta.2' : '0.6.0-beta.1' } };
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'core/focus-nav.js', 'app/xml1-port.js', 'app/xml1-view.js', 'app/xml1-setup.js'],
        body: '<div id="xml1-build-panel"></div>', offline: true,
        backend: { handle(command, data) {
            calls.push({ command, data });
            switch (command) {
                case 'get-xml1-status': return status;
                case 'xml1-folder': return { exists: true, builder: true, fix: true, updating: false };
                case 'xml1-update-fix': return { started: false, code: 'L_OFFLINE' };
                case 'xml1-info': return { success: true, id: 8 };
                case 'get-xml1-job': return { finished: true, exitCode: 0, result: { info: {
                    iso: { known: true }, xml2: {}, out: { state: 'absent' } } } };
                case 'xml1-build-start': return { success: true, id: 7 };
                case 'get-xml1-build': return null;
                case 'xml1-free-space': return { free: 20 * 1024 ** 3 };
                case 'set-game-property': status.classicConversation = data.value === 'true'; return null;
                default: return null;
            }
        } } });
    await p.window.Xml1Port.refresh();
    return { ...p, calls, status, port: p.window.Xml1Port, box: () => p.document.querySelector('#xml1-build-panel [data-option="classicConversation"]') };
}

test('Classic conversation: hidden for beta.1 or no installed builder even if an update supports it', async () => {
    for (const options of [{ supported: false }, { installed: false }]) {
        const p = await open(options);
        p.status.builder.latest = { version: '0.6.0-beta.2' };
        p.window.Xml1View.render('xml1');
        assert.equal(p.box(), null);
    }
});

test('Classic conversation: defaults off, explains rebuild, saves on change and preserves focus on refresh', async () => {
    const p = await open();
    assert.equal(p.box().checked, false);
    assert.match(p.document.querySelector('.xml1-appearance').textContent, /Classic conversation box \(XML1 look\)/);
    assert.match(p.document.querySelector('.xml1-appearance').textContent, /Rebuild to apply/);
    assert.equal(p.document.querySelector('.xml1-appearance select'), null);
    p.box().focus(); p.box().checked = true; p.box().dispatchEvent(new p.window.Event('change')); await settle();
    assert.equal(p.box().checked, true);
    assert.equal(p.document.activeElement, p.box());
    assert.deepEqual(JSON.parse(JSON.stringify(p.calls.find(call => call.command === 'set-game-property').data)),
        { game: 'xml1', suffix: 'classic-conversation', value: 'true' });
    await p.port.refresh();
    assert.equal(p.document.activeElement, p.box());
    assert.equal(p.box().checked, true);
    p.box().checked = false; p.box().dispatchEvent(new p.window.Event('change')); await settle();
    assert.equal(p.status.classicConversation, false);
});

test('Classic conversation: keyboard and controller activate the in-page checkbox once', async () => {
    for (const source of ['key', 'pad']) {
        const p = await open();
        p.window.FocusNav.setRectSource(() => ({ left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }));
        // Supply the checkbox's browser default action (the harness's click only dispatches).
        const input = p.box();
        input.addEventListener('click', () => {
            input.checked = !input.checked;
            input.dispatchEvent(new p.window.Event('change'));
        });
        input.focus(); p.window.FocusNav.press('Enter', source); await settle();
        assert.equal(p.box().checked, true);
        assert.equal(p.calls.filter(call => call.command === 'set-game-property').length, 1);
    }
});

test('Classic conversation: rebuild and resume carry the saved choice; off is explicitly forwarded', async () => {
    for (const enabled of [false, true]) {
        const p = await open({ enabled });
        await p.port.resume();
        assert.equal(p.calls.find(call => call.command === 'xml1-build-start').data.classicConversation, enabled);
    }
});

test('Classic conversation: returning to an older builder keeps the preference without sending its unsupported option', async () => {
    const p = await open({ supported: false, enabled: true });
    await p.port.resume();
    assert.equal(p.calls.find(call => call.command === 'xml1-build-start').data.classicConversation, false);
    assert.equal(p.status.classicConversation, true);
});

test('Classic conversation: appearance control is disabled during a build and does not write preferences', async () => {
    const p = await open();
    p.port.build = { active: true, command: 'build', stages: [] };
    p.window.Xml1View.render('xml1');
    assert.equal(p.box().disabled, true);
    p.box().click(); await p.port.setClassicConversation(true);
    assert.equal(p.calls.filter(call => call.command === 'set-game-property').length, 0);
});

test('Classic conversation: setup check offers and forwards the option only with a supported installed builder', async () => {
    for (const supported of [false, true]) {
        const p = await open({ supported });
        await p.window.Xml1Setup.show();
        p.document.querySelector('.xml1-setup [data-act="check"]').click();
        await p.clock.until(() => p.document.querySelector('.xml1-setup [data-act="build"]'), 5000, 'disc check');
        const box = p.document.querySelector('.xml1-setup [data-option="classicConversation"]');
        assert.equal(!!box, supported);
        if (box) { box.checked = true; box.dispatchEvent(new p.window.Event('change')); await settle(); }
        p.document.querySelector('.xml1-setup [data-act="build"]').click();
        await p.clock.until(() => p.calls.some(call => call.command === 'xml1-build-start'), 5000, 'build');
        assert.equal(p.calls.find(call => call.command === 'xml1-build-start').data.classicConversation, supported);
    }
});

test('Refused rebuild: an installed but incompatible XML2 Fix has an explicit install recovery action', async () => {
    const p = await open({ fixOk: false });
    assert.ok(p.document.querySelector('#xml1-build-panel [data-act="install-fix"]'));
    assert.match(p.document.querySelector('.xml1-note.is-warn').textContent, /1\.11\.0-beta\.1/);
});


test('Early cancelled rebuild: UI respects the native completed-build recovery and still offers Resume after a write', async () => {
    for (const state of ['ready', 'incomplete']) {
        const p = await open();
        p.status.state = state;
        p.status.isInstalled = state === 'ready';
        p.status.build.building = state === 'incomplete';
        const job = { id: 9, command: 'build', finished: true, active: false, exitCode: 5 };
        p.port.build = job; p.port.watched.add(job.id);
        await p.port.onWorkFinished(job);
        assert.equal(p.port.state(), state);
        assert.equal(p.port.cardLabel(), state === 'ready' ? null : p.window.LauncherI18n.t('xml1.resume'));
        assert.equal(!!p.document.querySelector('#xml1-build-panel [data-act="resume"]'), state === 'incomplete');
        assert.equal(p.document.querySelector('#xml1-build-panel [data-act="install-fix"]'), null);
    }
});
