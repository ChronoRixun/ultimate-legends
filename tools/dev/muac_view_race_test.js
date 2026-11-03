// Regression tests for MUAC settings recovery. No CEF, game, registry or INI access.
// Run from any directory: node tools/dev/muac_view_race_test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.resolve(__dirname, '../../src/launcher-ui/assets/js/app/muac-view.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const fixture = {
    installed: true, runtimeReady: true, running: false, missing: [], modes: ['800x600'],
    values: { Mode: 'windowed', Resolution: '800x600', FrameLimit: '60', VSync: '0',
        Watermark: '0', CaptureMouse: '0', ControllerSupport: '1', RunInBackground: '1', OnlineService: 'openspy' }
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function harness(online = 'openspy') {
    let controls = [], interval, onChange, focused, markup;
    const readQueue = [];
    const status = {};
    const body = {
        set innerHTML(value) {
            markup = value;
            // Track replacement controls and their actual rendered disabled attributes.
            controls = [...markup.matchAll(/<select\b([^>]*)>/g)].map(match => {
                const attributes = match[1];
                const key = /data-muac-setting="([^"]+)"/.exec(attributes)[1];
                const control = {
                    disabled: /\bdisabled\b/.test(attributes),
                    dataset: { muacSetting: key }, value: fixture.values[key],
                    focus() { focused = this; }, closest() { return this; }
                };
                return control;
            });
        }
    };
    const panel = {
        querySelector(selector) {
            if (selector === '.ul-display-body') return body;
            if (selector === '.ul-display-status') return status;
            const key = /data-muac-setting="([^"]+)"/.exec(selector)?.[1];
            return controls.find(control => control.dataset.muacSetting === key);
        },
        querySelectorAll: () => controls,
        getClientRects: () => [{}],
        addEventListener(name, callback) { if (name === 'change') onChange = callback; }
    };
    const window = {
        LauncherI18n: { t: key => key }, addEventListener() {},
        executeCommand(name) {
            if (name === 'set-muac-settings') return Promise.resolve({ success: false, error: 'Fixture write failure' });
            assert.equal(name, 'get-muac-settings');
            const response = structuredClone(fixture);
            response.values.OnlineService = online;
            return readQueue.length ? readQueue.shift()() : Promise.resolve(response);
        }
    };
    vm.runInNewContext(source, {
        window,
        document: { getElementById: () => panel, addEventListener() {} },
        GameUtils: { escapeHtml: value => String(value) },
        setInterval: callback => { interval = callback; }, setTimeout
    }, { filename: sourcePath });
    window.MuacView.render();
    await tick();
    assert.equal(controls.length, 9, 'The initial fixture must render all nine controls');
    return {
        readQueue,
        markup: () => markup,
        focused: () => controls.includes(focused) && focused.dataset.muacSetting,
        poll: () => interval(),
        disabled: () => controls.some(control => control.disabled),
        save: () => {
            const control = controls.find(item => item.dataset.muacSetting === 'VSync');
            control.value = '1';
            return onChange({ target: control });
        }
    };
}

async function pendingRefresh() {
    const app = await harness();
    const pending = deferred();
    app.readQueue.push(() => pending.promise);
    const poll = app.poll();
    await app.save();
    const disabledAfterSave = app.disabled();
    pending.resolve(structuredClone(fixture));
    await poll;
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(disabledAfterSave, false, 'A failed save must restore controls while an older poll is pending');
    assert.equal(app.disabled(), false, 'An unchanged poll result must not leave controls disabled');
    assert.equal(app.focused(), 'VSync', 'Failed save must restore focus to the replacement control');
}

async function failedRecoveryRead() {
    const app = await harness();
    app.readQueue.push(() => Promise.reject(new Error('Fixture refresh failure')));
    await app.save();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(app.disabled(), false, 'A failed recovery read must not leave controls disabled');
    assert.equal(app.focused(), 'VSync', 'Failed recovery must restore focus');
}

async function customService() {
    const app = await harness('custom');
    assert.match(app.markup(), /value="custom" selected>muac.customService<\/option>/);
}

(async () => {
    let failures = 0;
    for (const [name, test] of [['pending refresh / failed save', pendingRefresh], ['failed recovery read', failedRecoveryRead], ['custom server label', customService]]) {
        try { await test(); console.log(`PASS ${name}`); }
        catch (error) { ++failures; console.error(`FAIL ${name}: ${error.message}`); }
    }
    process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
