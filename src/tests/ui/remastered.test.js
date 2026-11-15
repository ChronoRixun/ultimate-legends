'use strict';
const assert = require('node:assert/strict');
const { page, test, Event, settle } = require('./harness');

async function open(values = {}, available = true) {
    const backend = {
        values: { ...values }, saves: [], available, refuse: false, deferred: null,
        handle(command, payload) {
            if (command === 'get-remastered-settings') return {
                installed: true, fixInstalled: true, available: this.available, requiredFix: '1.12.0', values: { ...this.values }
            };
            if (command === 'set-remastered-settings') {
                this.saves.push({ ...payload.values });
                const finish = () => {
                    if (this.refuse) return { success: false, error: 'Folder is busy' };
                    Object.assign(this.values, payload.values);
                    return { success: true, values: { ...this.values } };
                };
                return this.deferred ? this.deferred.then(finish) : finish();
            }
            throw new Error(command);
        }
    };
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/remastered-view.js'], backend,
        body: '<div id="xml1-remastered-panel"></div>' });
    p.window.Xml1Port = { starting: false, building: false, isBuilding() { return this.building; } };
    // Production uses the shared in-page combobox, whose own tests exercise
    // keyboard/Escape behavior. Verify this view explicitly requests enhancement.
    let enhanced = 0;
    p.window.LauncherDropdowns = { enhance() { enhanced++; } };
    p.window.RemasteredView.render('xml1');
    await settle();
    const select = key => p.document.querySelector(`#xml1-remastered-panel select[data-key="${key}"]`);
    const choose = (key, value) => {
        select(key).value = value;
        select(key).dispatchEvent(new Event('change', { bubbles: true }));
    };
    return { ...p, backend, select, choose, enhanced: () => enhanced };
}

test('Remastered: opening keeps absent keys absent and requests the in-page picker', async () => {
    const p = await open();
    assert.deepEqual(p.backend.saves, []);
    assert.deepEqual(p.backend.values, {});
    assert.equal(p.select('Enabled').value, '0');
    assert.equal(p.select('MSAASamples').value, '4');
    assert.equal(p.select('MSAASamples').disabled, true);
    assert.equal(p.enhanced(), 1);
});

test('Remastered: toggling writes only Enabled and retains component choices', async () => {
    const p = await open({ MSAASamples: '8', Anisotropy: '16', CenteredHud: '1' });
    p.choose('Enabled', '1');
    await settle();
    assert.deepEqual(p.backend.saves, [{ Enabled: '1' }]);
    assert.equal(p.select('MSAASamples').disabled, false);
    assert.equal(p.select('MSAASamples').value, '8');
    p.choose('Enabled', '0');
    await settle();
    assert.deepEqual(p.backend.saves, [{ Enabled: '1' }, { Enabled: '0' }]);
    assert.equal(p.backend.values.Anisotropy, '16');
    assert.equal(p.backend.values.CenteredHud, '1');
});

test('Remastered: old Fix and active build disable edits', async () => {
    let p = await open({}, false);
    assert.equal(p.select('Enabled').disabled, true);
    p.choose('Enabled', '1');
    await settle();
    assert.deepEqual(p.backend.saves, []);
    assert.match(p.document.querySelector('#xml1-remastered-panel').textContent, /1\.12\.0/);
    p = await open({ Enabled: '1' });
    p.window.Xml1Port.building = true;
    p.window.dispatchEvent(new p.window.CustomEvent('ul-xml1-changed'));
    assert.equal(p.select('Enabled').disabled, true);
    p.choose('Anisotropy', '16');
    await settle();
    assert.deepEqual(p.backend.saves, []);
});

test('Remastered: refused save restores visible values and reports the failure', async () => {
    const p = await open({ Enabled: '1', Anisotropy: '4' });
    p.backend.refuse = true;
    p.choose('Anisotropy', '16');
    await settle();
    assert.equal(p.backend.values.Anisotropy, '4');
    assert.equal(p.select('Anisotropy').value, '4');
    assert.equal(p.toasts.length, 1);
});

test('Remastered: a pending write serializes controls and blocks stale refreshes', async () => {
    const p = await open({ Enabled: '1' });
    let resolve;
    p.backend.deferred = new Promise(done => { resolve = done; });
    p.choose('Anisotropy', '16');
    await settle();
    assert.equal(p.select('Enabled').disabled, true);
    await p.window.RemasteredView.reload('xml1');
    p.choose('MSAASamples', '8');
    await settle();
    assert.equal(p.backend.saves.length, 1);
    resolve();
    await settle();
    assert.equal(p.select('Anisotropy').value, '16');
    assert.equal(p.select('Enabled').disabled, false);
});

test('Remastered: invalid master stays off without rewriting hand edits', async () => {
    const p = await open({ Enabled: 'true', Anisotropy: '16' });
    assert.equal(p.select('Enabled').value, 'true');
    assert.equal(p.select('Anisotropy').disabled, true);
    assert.deepEqual(p.backend.saves, []);
});
