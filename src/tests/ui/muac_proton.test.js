'use strict';
const assert = require('node:assert/strict');
const { page, test, settle } = require('./harness');

async function open(wine, dgvoodooPresent = false) {
    const calls = [];
    const state = { installed: true, runtimeReady: true, wine, dgvoodooPresent, values: {
        Mode: 'windowed', Resolution: '1280x800', FrameLimit: '60', VSync: '1', Watermark: '0',
        ControllerSupport: '1', RunInBackground: '1', CaptureMouse: '0', OnlineService: 'openspy'
    } };
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/muac-view.js'],
        body: '<div id="muac-options-panel"></div>', backend: { handle(command, data) {
            calls.push({ command, data });
            if (command === 'get-muac-settings') return { ...state };
            if (command === 'set-muac-settings') return { ...state, success: true };
            return null;
        } } });
    p.window.MuacSetup = { showUpdate: () => calls.push({ command: 'update-popup' }) };
    p.window.MuacView.render(); await settle();
    return { ...p, calls, state };
}

test('MUAC Proton: wrapper settings are hidden while other options remain usable', async () => {
    const p = await open(true);
    for (const key of ['Mode', 'Resolution', 'FrameLimit', 'VSync', 'Watermark'])
        assert.ok(!p.document.querySelector(`[data-muac-setting="${key}"]`), key);
    for (const key of ['ControllerSupport', 'RunInBackground', 'CaptureMouse', 'OnlineService'])
        assert.ok(p.document.querySelector(`[data-muac-setting="${key}"]`), key);
    assert.doesNotMatch(p.document.querySelector('[data-row="RunInBackground"]').textContent, /windowed|borderless/i);
    assert.match(p.window.GameUtils.getGameConfig('muac').credits, /DXVK\/Proton under Wine/);
    assert.match(p.document.querySelector('#muac-options-panel').textContent, /Your Steam Deck \/ Proton handles display mode/);
    const control = p.document.querySelector('[data-muac-setting="ControllerSupport"]');
    control.value = '0'; control.dispatchEvent(new p.window.Event('change', { bubbles: true })); await settle();
    assert.ok(p.calls.some(c => c.command === 'set-muac-settings' && c.data.values.ControllerSupport === '0'));
});

test('MUAC Proton: inherited D3D9 offers Update and refresh clears the advice', async () => {
    const p = await open(true, true);
    p.document.getElementById('muac-options-panel').getClientRects = () => [{}];
    assert.match(p.document.querySelector('#muac-options-panel').textContent, /D3D9.dll/);
    const action = p.document.querySelector('[data-muac-proton-update]');
    assert.ok(action); action.click(); await settle();
    assert.ok(p.calls.some(c => c.command === 'update-popup'));
    p.state.dgvoodooPresent = false;
    await p.clock.advance(3100); await settle();
    assert.equal(p.document.querySelector('[data-muac-proton-update]'), null);
});

test('MUAC native Windows: all graphics settings remain available', async () => {
    const p = await open(false, true);
    for (const key of ['Mode', 'Resolution', 'FrameLimit', 'VSync', 'Watermark'])
        assert.ok(p.document.querySelector(`[data-muac-setting="${key}"]`), key);
    assert.equal(p.document.querySelector('[data-muac-proton-update]'), null);
});
