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
        Watermark: '0', CaptureMouse: '0', ControllerSupport: '1', OnlineService: 'openspy' }
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function harness() {
    let controls = [], interval, onChange;
    const readQueue = [];
    const status = {};
    const body = {
        set innerHTML(markup) {
            // Track replacement controls and their actual rendered disabled attributes.
            controls = [...markup.matchAll(/<select\b([^>]*)>/g)].map(match => {
                const attributes = match[1];
                const key = /data-muac-setting="([^"]+)"/.exec(attributes)[1];
                const control = {
                    disabled: /\bdisabled\b/.test(attributes),
                    dataset: { muacSetting: key }, value: fixture.values[key],
                    focus() {}, closest() { return this; }
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
            return readQueue.length ? readQueue.shift()() : Promise.resolve(structuredClone(fixture));
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
    assert.equal(controls.length, 8, 'The initial fixture must render all eight controls');
    return {
        readQueue,
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
    assert.equal(disabledAfterSave, false, 'A failed save must restore controls while an older poll is pending');
    assert.equal(app.disabled(), false, 'An unchanged poll result must not leave controls disabled');
}

async function failedRecoveryRead() {
    const app = await harness();
    app.readQueue.push(() => Promise.reject(new Error('Fixture refresh failure')));
    await app.save();
    assert.equal(app.disabled(), false, 'A failed recovery read must not leave controls disabled');
}

(async () => {
    let failures = 0;
    for (const [name, test] of [['pending refresh / failed save', pendingRefresh], ['failed recovery read', failedRecoveryRead]]) {
        try { await test(); console.log(`PASS ${name}`); }
        catch (error) { ++failures; console.error(`FAIL ${name}: ${error.message}`); }
    }
    process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
