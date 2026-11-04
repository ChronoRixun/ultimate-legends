'use strict';
const assert = require('node:assert/strict');
const { page, test, settle } = require('./harness');

async function setup(acceptStart = false) {
    const calls = [];
    let state = { active: false, success: false };
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'core/focus-nav.js', 'app/muac-setup.js'],
        backend: { handle(command, data) {
            calls.push({ command, data });
            if (command === 'get-muac-setup') return { ...state };
            if (command === 'browse-folder') return 'C:\\Fixture\\Disc';
            if (command === 'browse-file') return 'C:\\Fixture\\Disc.iso';
            if (command === 'start-muac-setup') {
                if (acceptStart) { state = { active: true, success: false }; return { success: true }; }
                return { success: false, error: 'Choose a new or empty output folder.' };
            }
            if (command === 'cancel-muac-setup') { state = { active: true, cancelled: true }; return state; }
            return null;
        } } });
    await p.window.MuacSetup.show(); await settle();
    const control = act => p.document.querySelector(`[data-act="${act}"]`);
    const click = async act => { control(act).click(); await settle(); };
    return { ...p, calls, control, click, setState: value => { state = value; } };
}

test('MUAC setup: both disc pickers retain their values and restore focus', async () => {
    const p = await setup();
    await p.click('iso');
    assert.equal(p.document.querySelector('#muac-source').value, 'C:\\Fixture\\Disc.iso');
    await p.click('folder');
    assert.equal(p.document.querySelector('#muac-source').value, 'C:\\Fixture\\Disc');
    assert.equal(p.document.activeElement.dataset.act, 'folder');
});

test('MUAC setup: start refusal survives polling and does not show success', async () => {
    const p = await setup(); await p.click('iso'); await p.click('output'); await p.click('start');
    assert.match(p.document.querySelector('.muac-setup-error').textContent, /new or empty/);
    await p.clock.advance(1600); await settle();
    assert.match(p.document.querySelector('.muac-setup-error').textContent, /new or empty/);
    assert.ok(p.control('start')); assert.equal(p.control('done'), null);
});

test('MUAC setup: hiding a running job does not cancel it', async () => {
    const p = await setup(); p.setState({ active: true, phase: 'Copying', percent: 50 });
    await p.clock.advance(800); await settle();
    await p.click('hide');
    assert.equal(p.document.querySelector('#muac-setup-title'), null);
    assert.equal(p.calls.filter(c => c.command === 'cancel-muac-setup').length, 0);
    await p.window.MuacSetup.show(); await settle();
    assert.ok(p.control('cancel'));
});

test('MUAC setup: keyboard and pad can activate the folder picker', async () => {
    for (const source of ['key', 'pad']) {
        const p = await setup();
        p.window.FocusNav.setRectSource(() => ({ left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }));
        p.control('folder').focus(); p.window.FocusNav.press('Enter', source); await settle();
        assert.equal(p.document.querySelector('#muac-source').value, 'C:\\Fixture\\Disc');
    }
});

test('MUAC setup: Start and completion keep focus on a live control', async () => {
    const p = await setup(true); await p.click('iso'); await p.click('output');
    p.control('start').focus(); await p.click('start');
    assert.equal(p.document.activeElement, p.control('cancel'));
    p.setState({ active: false, success: true });
    await p.clock.advance(800); await settle();
    assert.equal(p.document.activeElement, p.control('done'));
});

test('MUAC setup: cancelling moves focus off the disabled cancel button', async () => {
    const p = await setup(true); await p.click('iso'); await p.click('output'); await p.click('start');
    p.control('cancel').focus(); await p.click('cancel');
    assert.ok(p.control('cancel').disabled);
    assert.equal(p.document.activeElement, p.control('hide'));
});

test('MUAC setup: cleanup overrides stale copy progress until the job ends', async () => {
    const p = await setup(true); await p.click('iso'); await p.click('output'); await p.click('start');
    p.setState({ active: true, cancelled: true, cleaning: true, message: 'Copying', percent: 35 });
    await p.clock.advance(800); await settle();
    assert.equal(p.document.querySelector('.muac-setup-progress').textContent, 'Cleaning up...');
    assert.ok(p.control('cancel').disabled);
    assert.equal(p.control('start'), null);
    p.setState({ active: false, cancelled: true, error: 'Setup cancelled.' });
    await p.clock.advance(800); await settle();
    assert.ok(p.control('start'));
    assert.equal(p.control('done'), null);
});
