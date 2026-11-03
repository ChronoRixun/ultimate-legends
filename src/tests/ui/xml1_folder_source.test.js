'use strict';
const assert = require('node:assert/strict');
const { page, test, settle } = require('./harness');

async function setup(xml2 = true) {
    const calls = [];
    let picked = 'C:\\Owned\\XML1-recomp';
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'core/focus-nav.js', 'app/xml1-setup.js'], offline: true,
        backend: { handle(command, data) {
            calls.push({ command, data });
            if (command === 'browse-folder') return picked;
            if (command === 'browse-file') return 'C:\\Owned\\XML1.xiso';
            if (command === 'xml1-free-space') return { free: 20 * 1024 ** 3 };
            return null;
        } } });
    p.window.Xml1Port = {
        status: { state: 'not-setup', iso: '', defaultOut: 'C:\\Games\\LC', xml2: { setUp: xml2, path: 'C:\\Games\\XML2' }, builder: { installed: true, version: 'fixture' } },
        refresh: async () => {}, isBuilding: () => false, noticesOf: () => [],
        runJob: async (command, data) => {
            calls.push({ command, data });
            return { exitCode: 0, result: { info: { iso: { known: true, source_kind: 'folder', verified: true, verified_files: 252 },
                xml2: { files: 10, language: 'en' }, out: { state: 'absent' } } } };
        },
        startBuild: async data => { calls.push({ command: 'xml1-build-start', data }); return { success: true }; }
    };
    await p.window.Xml1Setup.show(); await settle();
    const control = action => p.document.querySelector(`.xml1-setup [data-act="${action}"]`);
    const click = async action => { assert.ok(control(action), action); control(action).click(); await settle(); };
    return { ...p, calls, control, click, pick: value => { picked = value; } };
}

test('XML1 folder source: picker next to ISO forwards the folder unchanged to info and build', async () => {
    const p = await setup();
    assert.ok(p.control('browse-iso')); assert.ok(p.control('browse-source-folder'));
    assert.match(p.document.querySelector('.xml1-setup').textContent, /X-Men Legends II.*PC/);
    await p.click('browse-source-folder');
    assert.equal(p.document.querySelector('[data-field="iso"]').value, 'C:\\Owned\\XML1-recomp');
    assert.equal(p.document.activeElement.dataset.act, 'browse-source-folder');
    await p.click('check');
    assert.equal(p.calls.find(call => call.command === 'xml1-info').data.iso, 'C:\\Owned\\XML1-recomp');
    assert.match(p.document.querySelector('.xml1-setup').textContent, /verified.*252/i);
    await p.click('build');
    assert.equal(p.calls.find(call => call.command === 'xml1-build-start').data.iso, 'C:\\Owned\\XML1-recomp');
});

test('XML1 folder source: cancelled picker keeps the previous ISO and XML2 is still required', async () => {
    const p = await setup(false); await p.click('browse-iso'); p.pick(null); await p.click('browse-source-folder');
    assert.equal(p.document.querySelector('[data-field="iso"]').value, 'C:\\Owned\\XML1.xiso');
    assert.equal(p.control('check').disabled, true);
    assert.equal(p.calls.filter(call => call.command === 'xml1-info').length, 0);
});

test('XML1 folder source: keyboard and controller activation reach the folder picker', async () => {
    for (const source of ['key', 'pad']) {
        const p = await setup(); const button = p.control('browse-source-folder'); assert.ok(button);
        p.window.FocusNav.setRectSource(() => ({ left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }));
        button.focus(); p.window.FocusNav.press('Enter', source); await settle();
        assert.equal(p.calls.filter(call => call.command === 'browse-folder').length, 1);
        assert.equal(p.document.querySelector('[data-field="iso"]').value, 'C:\\Owned\\XML1-recomp');
    }
});
