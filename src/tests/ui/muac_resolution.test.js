'use strict';
const assert = require('node:assert/strict');
const { page, test, settle } = require('./harness');

test('MUAC resolution: 4K without the 0.1.2 guard is explained and disabled; choosing 1080p recovers', async () => {
    const calls = [];
    const state = { installed: true, runtimeReady: true, resolutionSupported: false,
        modes: ['800x600', '1280x720', '1920x1080'], values: {
            Mode: 'borderless', Resolution: '3840x2160', FrameLimit: '60', VSync: '1', Watermark: '0',
            ControllerSupport: '1', RunInBackground: '1', CaptureMouse: '0', OnlineService: 'openspy'
        } };
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/muac-view.js'],
        body: '<div id="muac-options-panel"></div>', backend: { handle(command, data) {
            calls.push({ command, data });
            if (command === 'set-muac-settings') {
                state.values.Resolution = data.values.Resolution;
                state.resolutionSupported = true;
                return { ...state, success: true };
            }
            if (command === 'get-muac-settings') return { ...state };
            return null;
        } } });
    p.window.MuacView.render(); await settle();
    let select = p.document.querySelector('#muac-Resolution');
    assert.equal(select.value, '3840x2160');
    const invalid = select.querySelector('option[value="3840x2160"]');
    assert.ok(invalid.disabled);
    assert.match(invalid.textContent, /needs MUA Classic Fix 0\.1\.2/);
    assert.match(p.document.querySelector('.ul-display-status').textContent, /original sizes.*0\.1\.2 or newer/);
    assert.equal(calls.filter(c => c.command === 'set-muac-settings').length, 0);
    select.value = '1920x1080';
    select.dispatchEvent(new p.window.Event('change', { bubbles: true })); await settle();
    select = p.document.querySelector('#muac-Resolution');
    assert.equal(select.value, '1920x1080');
    assert.ok(!select.querySelector('option[value="3840x2160"]'));
    assert.doesNotMatch(p.document.querySelector('.ul-display-status').textContent, /original sizes/);
    assert.equal(calls.filter(c => c.command === 'set-muac-settings').length, 1);
});

test('MUAC resolution: with the 0.1.2 guard a saved 4K value is a normal choice', async () => {
    const state = { installed: true, runtimeReady: true, resolutionSupported: true, resolutionGuard: true,
        modes: ['1920x1080', '2560x1440', '3840x2160'], values: {
            Mode: 'windowed', Resolution: '3840x2160', FrameLimit: '60', VSync: '1', Watermark: '0',
            ControllerSupport: '1', RunInBackground: '1', CaptureMouse: '0', OnlineService: 'openspy'
        } };
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/muac-view.js'],
        body: '<div id="muac-options-panel"></div>', backend: { handle(command) {
            return command === 'get-muac-settings' ? { ...state } : null;
        } } });
    p.window.MuacView.render(); await settle();
    const select = p.document.querySelector('#muac-Resolution');
    assert.equal(select.value, '3840x2160');
    assert.ok(!select.querySelector('option[value="3840x2160"]').disabled);
    assert.doesNotMatch(p.document.querySelector('.ul-display-status').textContent, /original sizes/);
});