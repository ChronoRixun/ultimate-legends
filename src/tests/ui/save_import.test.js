'use strict';
const assert = require('node:assert/strict');
const { page, test, Event, settle } = require('./harness');
const { reply, TOKEN, TXN } = require('./fake_save_import_cli');

class Backend {
    constructor(scenario) { this.scenario = scenario; this.calls = []; this.paths = ['C:\\Owned\\UDATA\\4156001e', 'C:\\Player\\SaveLC']; this.jobs = new Map(); this.next = 1; this.hold = false; this.delayStart = null; this.noResult = false; this.exitOverride = null; }
    handle(command, data) {
        this.calls.push({ command, data });
        if (command === 'browse-folder' || command === 'browse-file') return this.paths.shift() || null;
        if (command === 'xml1-import-start') {
            const id = this.next++;
            const events = reply(data.mode, data, this.scenario);
            this.jobs.set(id, { id, command: 'import-xml1-save', active: this.hold, finished: !this.hold,
                exitCode: this.exitOverride === null ? events.at(-1).exit : this.exitOverride,
                result: this.noResult ? null : events.find(event => event.ev === 'result'), errors: events.filter(event => event.ev === 'error') });
            return this.delayStart ? this.delayStart.then(() => ({ success: true, id })) : { success: true, id };
        }
        if (command === 'get-xml1-job') return this.jobs.get(data.id);
        if (command === 'xml1-import-cancel') {
            const job = this.jobs.get(data.id);
            Object.assign(job, { active: false, finished: true, exitCode: 5, result: { ok: false, exit: 5, cancelled: true } });
            return true;
        }
        return null;
    }
    starts(mode) { return this.calls.filter(call => call.command === 'xml1-import-start' && (!mode || call.data.mode === mode)); }
}
async function open(scenario = 'gated') {
    const backend = new Backend(scenario);
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/xml1-save-import.js'], backend, offline: true, body: '<div id="xml1-save-import"></div>' });
    p.window.Xml1SaveImport.open();
    const control = action => p.document.querySelector(`[data-import-act="${action}"]`);
    const click = async action => { assert.ok(control(action), action); control(action).click(); await settle(); };
    const change = async (id, value, checked) => { const element = p.document.getElementById(id); element.value = value; if (checked !== undefined) element.checked = checked; element.dispatchEvent(new Event('change')); await settle(); };
    const text = () => p.document.getElementById('xml1-save-import').textContent;
    const select = async () => { await click('source'); await click('target'); await change('xml1-import-slot', '0'); };
    return { ...p, backend, control, click, change, text, select };
}

test('save import: offline discovery and preview show heroes, levels, progress, resets and skips without apply', async () => {
    const p = await open(); await p.select(); await p.click('preview');
    assert.match(p.text(), /wolverine/); assert.match(p.text(), /12/); assert.match(p.text(), /invented_hub/);
    assert.match(p.text(), /Continue from Invented mansion checkpoint/); assert.match(p.text(), /Enemies and fog reset/);
    assert.match(p.text(), /Unresolved trivia state/); assert.match(p.text(), /Xbox signature not checked/);
    assert.match(p.text(), /Preview only/); assert.equal(p.control('apply').disabled, true);
    assert.equal(p.backend.starts('apply').length, 0);
    assert.equal(p.document.getElementById('xml1-import-merge').checked, false);
    assert.equal(p.document.getElementById('xml1-import-merge').disabled, true);
    assert.ok(p.backend.calls.every(call => ['browse-folder', 'xml1-import-start', 'get-xml1-job'].includes(call.command)));
});

test('save import: occupied and backup slots stay unavailable and preview refuses an occupied selection', async () => {
    const p = await open(); await p.select();
    const slots = p.document.querySelectorAll('#xml1-import-slot option');
    assert.equal(slots[2].disabled, true); assert.equal(slots[3].disabled, true);
    await p.change('xml1-import-slot', '1'); await p.click('preview');
    assert.equal(p.backend.starts('preview').length, 0); assert.equal(p.control('apply').disabled, true);
});

test('save import: multiple campaigns require an explicit selection', async () => {
    const p = await open('multiple'); await p.click('source');
    assert.ok(p.document.getElementById('xml1-import-campaign')); assert.equal(p.control('preview').disabled, true);
    await p.change('xml1-import-campaign', '1');
    assert.match(p.backend.starts('inspect')[1].data.source, /campaignB$/);
    assert.match(p.text(), /wolverine/);
});

test('save import: HDD selection forwards a unique image campaign and raw/QCOW2 picker filters', async () => {
    const p = await open('hdd'); await p.change('xml1-import-source-type', 'hdd'); await p.click('source');
    assert.equal(p.backend.starts('inspect').length, 1);
    const picker = p.backend.calls.find(call => call.command === 'browse-file');
    assert.match(picker.data.filters[0].pattern, /\*\.qcow2;\*\.raw/);
    assert.equal(picker.data.filters[1].pattern, '*.*');
    assert.equal(p.backend.calls[0].command, 'browse-file'); assert.equal(p.control('apply').disabled, true);
});

test('save import: recomp folder inspection and preview forward its kind and list losses', async () => {
    const p = await open('recomp'); await p.change('xml1-import-source-type', 'recomp'); await p.click('source');
    assert.equal(p.backend.calls[0].command, 'browse-folder');
    assert.match(p.text(), /UDATA[\\/]4156001e/);
    assert.equal(p.backend.starts('inspect')[0].data.sourceKind, 'recomp');
    await p.click('target'); await p.change('xml1-import-slot', '0'); await p.click('preview');
    assert.equal(p.backend.starts('preview')[0].data.sourceKind, 'recomp');
    assert.match(p.text(), /Preview only/); assert.match(p.text(), /recomp stash/);
    assert.equal(p.control('apply').disabled, true);
    assert.equal(p.backend.starts('apply').length, 0);
});

test('save import: recomp version refusal stays visible and cannot fall back to retail', async () => {
    const p = await open('recomp-version'); await p.change('xml1-import-source-type', 'recomp'); await p.click('source');
    assert.match(p.text(), /Unsupported recomp CHR version/);
    assert.equal(p.control('preview').disabled, true); assert.equal(p.control('apply').disabled, true);
    assert.equal(p.backend.starts('inspect')[0].data.sourceKind, 'recomp');
});

test('save import: recomp preview must match its source container kind', async () => {
    const p = await open('recomp-wrong-kind'); await p.change('xml1-import-source-type', 'recomp'); await p.select(); await p.click('preview');
    assert.match(p.text(), /complete matching result/); assert.equal(p.control('apply').disabled, true);
});

test('save import: changing away from recomp invalidates preview and clears its source kind', async () => {
    const p = await open('recomp'); await p.change('xml1-import-source-type', 'recomp'); await p.select(); await p.click('preview');
    await p.change('xml1-import-source-type', 'xbox');
    assert.equal(p.control('preview').disabled, true); assert.doesNotMatch(p.text(), /recomp stash/);
    p.backend.scenario = 'gated'; p.backend.paths.push('C:\\Owned\\UDATA'); await p.click('source');
    assert.equal(p.backend.starts('inspect').at(-1).data.sourceKind, 'auto');
});

test('save import: approximations need a separate opt-in followed by a fresh preview', async () => {
    const p = await open('inferred'); await p.select(); await p.click('preview');
    assert.match(p.text(), /Enemies and fog reset/); assert.equal(p.document.getElementById('xml1-import-inferred').checked, false);
    await p.change('xml1-import-inferred', '', true); await p.click('preview');
    assert.equal(p.backend.starts('preview')[0].data.allowInferred, false);
    assert.equal(p.backend.starts('preview')[1].data.allowInferred, true);
    assert.match(p.text(), /Preview only/); assert.equal(p.backend.starts('apply').length, 0);
});

test('save import: source, slot, target and opt-in changes invalidate a preview token', async () => {
    const p = await open('admitted'); await p.select(); await p.click('preview'); assert.equal(p.control('apply').disabled, false);
    await p.change('xml1-import-slot', '3'); assert.equal(p.control('apply').disabled, true);
    await p.click('preview'); assert.equal(p.control('apply').disabled, false);
    p.backend.paths.push('C:\\Other\\SaveLC'); await p.click('target'); assert.equal(p.control('apply').disabled, true);
    await p.change('xml1-import-source-type', 'recomp'); assert.equal(p.control('apply').disabled, true);
});

test('save import: an admitted fake CLI needs confirmation and the exact token before showing success and undo', async () => {
    const p = await open('admitted'); await p.select(); await p.click('preview');
    await p.click('apply'); assert.equal(p.backend.starts('apply').length, 0, 'declined confirmation');
    p.window.showMessageBox = async () => 1; await p.click('apply');
    assert.equal(p.backend.starts('apply').length, 1);
    assert.equal(p.backend.starts('apply')[0].data.previewToken, TOKEN); assert.equal(p.backend.starts('apply')[0].data.confirmed, true);
    assert.match(p.text(), /Imported into slot 0/); assert.match(p.text(), /campaign\.lcsave/); assert.match(p.text(), /report\.json/);
    await p.click('undo-0'); assert.equal(p.backend.starts('undo')[0].data.transactionId, TXN);
    assert.match(p.text(), /Import removed from slot 0/); assert.equal(p.control('apply').disabled, true);
});

test('save import: an apply refusal for changed inputs clears preview and requires source inspection again', async () => {
    const p = await open('changed'); await p.select(); await p.click('preview'); p.window.showMessageBox = async () => 1; await p.click('apply');
    assert.match(p.text(), /changed.*preview again/); assert.equal(p.control('preview').disabled, true);
    assert.doesNotMatch(p.text(), /Imported into slot/); assert.equal(p.control('apply').disabled, true);
});

test('save import: missing result, mismatched source hash and nonzero process exits never become success', async () => {
    for (const kind of ['no-result', 'wrong-source', 'wrong-output', 'nonzero-exit']) {
        const p = await open(['wrong-source', 'wrong-output'].includes(kind) ? kind : 'admitted'); await p.select();
        if (kind === 'no-result') p.backend.noResult = true;
        if (kind === 'nonzero-exit') p.backend.exitOverride = 3;
        await p.click('preview'); assert.equal(p.control('apply').disabled, true, kind);
        assert.doesNotMatch(p.text(), /Imported into slot/, kind);
    }
});

test('save import: refusals escape converter text rather than adding HTML', async () => {
    const p = await open('refused'); await p.select(); await p.click('preview');
    assert.match(p.text(), /<script>alert/); assert.equal(p.document.querySelector('#xml1-save-import script'), null);
    assert.doesNotMatch(p.text(), /Reading the save with the local converter/);
});

test('save import: cancellation waits for exit, stays single-flight and survives redraw', async () => {
    const p = await open(); await p.select(); p.backend.hold = true; await p.click('preview');
    assert.equal(p.control('preview').disabled, true); assert.equal(p.control('close'), null);
    p.window.Xml1SaveImport.mount(); await p.click('preview'); assert.equal(p.backend.starts('preview').length, 1);
    await p.click('cancel'); assert.equal(p.control('cancel').disabled, true);
    await p.clock.advance(250); assert.match(p.text(), /Cancelled/); assert.ok(p.control('close'));
    assert.equal(p.backend.calls.filter(call => call.command === 'xml1-import-cancel').length, 1);
});

test('save import: cancellation while start is pending is delivered when the job ID arrives', async () => {
    const p = await open(); await p.select(); let release;
    p.backend.delayStart = new Promise(resolve => { release = resolve; }); p.backend.hold = true;
    await p.click('preview'); await p.click('cancel'); release(); await settle();
    assert.equal(p.backend.calls.filter(call => call.command === 'xml1-import-cancel').length, 1);
    assert.match(p.text(), /Cancelled/);
});

test('save import: a second apply cannot start while confirmation is pending', async () => {
    const p = await open('admitted'); await p.select(); await p.click('preview'); let resolve;
    p.window.showMessageBox = () => new Promise(done => { resolve = done; });
    await p.click('apply'); await p.click('apply'); assert.equal(p.backend.starts('apply').length, 0);
    resolve(1); await settle(); assert.equal(p.backend.starts('apply').length, 1);
});

test('save import: a refused cancellation keeps the job alive and offers cancellation again', async () => {
    const p = await open(); await p.select(); p.backend.hold = true; await p.click('preview');
    const handle = p.backend.handle.bind(p.backend);
    p.backend.handle = (command, data) => command === 'xml1-import-cancel' ? false : handle(command, data);
    await p.click('cancel'); assert.equal(p.control('cancel').disabled, false); assert.equal(p.control('preview').disabled, true);
    p.backend.handle = handle; await p.click('cancel'); await p.clock.advance(250);
    assert.match(p.text(), /Cancelled/); assert.equal(p.backend.starts('preview').length, 1);
});

test('save import: a missing status is retried without launching another converter', async () => {
    const p = await open(); await p.select();
    const handle = p.backend.handle.bind(p.backend); let missing = true;
    p.backend.handle = (command, data) => command === 'get-xml1-job' && missing ? null : handle(command, data);
    await p.click('preview'); assert.match(p.text(), /Waiting for the converter status/); assert.equal(p.control('preview').disabled, true);
    missing = false; await p.clock.advance(250);
    assert.match(p.text(), /Preview only/); assert.equal(p.backend.starts('preview').length, 1);
});

test('save import: keyboard focus survives redraws and never moves from an unrelated control', async () => {
    const p = await open();
    assert.equal(p.document.activeElement.id, 'xml1-import-source-type');
    await p.select();
    const slot = p.document.getElementById('xml1-import-slot'); slot.focus();
    await p.change('xml1-import-slot', '3'); assert.equal(p.document.activeElement.id, 'xml1-import-slot');
    p.control('preview').focus(); await p.click('preview');
    assert.equal(p.document.activeElement.dataset.importAct, 'preview');
    const other = p.document.createElement('button'); other.id = 'unrelated'; p.document.body.appendChild(other); other.focus();
    p.window.Xml1SaveImport.mount(); assert.equal(p.document.activeElement, other);
});

test('save import: all three interface languages render the flow without untranslated keys', async () => {
    for (const [language, title] of [['en', 'Import an X-Men Legends save'], ['fr', 'Importer une sauvegarde'], ['es', 'Importar una partida']]) {
        const p = await open(); p.window.LauncherI18n.setLanguage(language); p.window.Xml1SaveImport.mount();
        assert.ok(p.text().includes(title)); assert.doesNotMatch(p.text(), /saveImport\./);
    }
});

test('save import: the real library page exposes the button only for a built game and disables it while busy', async () => {
    const backend = new Backend('gated');
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/xml1-port.js', 'app/xml1-save-import.js', 'app/xml1-view.js'], backend,
        offline: true, body: '<div id="xml1-build-panel"></div>' });
    const port = p.window.Xml1Port;
    port.status = { install: 'C:\\Games\\LC', exists: true, state: 'ready', builder: { installed: true }, build: { stamp: true }, fix: { installed: true, ok: true } };
    p.window.Xml1View.render('xml1');
    const button = () => p.document.querySelector('[data-act="import-save"]');
    assert.ok(button()); button().click(); await settle(); assert.ok(p.document.getElementById('xml1-import-source-type'));
    p.document.querySelector('[data-import-act="source"]').click(); await settle();
    p.document.querySelector('[data-import-act="target"]').click(); await settle();
    const slot = p.document.getElementById('xml1-import-slot'); slot.value = '0'; slot.dispatchEvent(new Event('change')); await settle();
    backend.hold = true; p.document.querySelector('[data-import-act="preview"]').click(); await settle();
    assert.equal(port.isWorking(), true); assert.equal(button().disabled, true);
    p.document.querySelector('[data-import-act="cancel"]').click(); await p.clock.advance(250);
    assert.equal(port.isWorking(), false); assert.equal(button().disabled, false);
    port.status.running = true; p.window.Xml1View.render('xml1'); assert.equal(button().disabled, true);
    port.status.running = false; port.status.build.stamp = false; p.window.Xml1View.render('xml1'); assert.equal(button(), null);
});


test('save import: image campaign selection preserves image path through inspection and preview', async () => {
    const p = await open('hdd-multiple');
    p.backend.paths = ['C:\\Owned\\xemu disk.qcow2', 'C:\\Player\\SaveLC'];
    await p.change('xml1-import-source-type', 'hdd'); await p.click('source');
    assert.equal(p.backend.starts('inspect')[0].data.campaign, '');
    assert.match(p.text(), /Campaign A/); assert.match(p.text(), /Campaign B/);
    assert.equal(p.control('preview').disabled, true);
    await p.change('xml1-import-campaign', '1');
    const inspected = p.backend.starts('inspect')[1].data;
    assert.equal(inspected.source, 'C:\\Owned\\xemu disk.qcow2');
    assert.equal(inspected.campaign, 'E:/UDATA/4156001e/Campaign B');
    assert.equal(p.document.getElementById('xml1-import-campaign').value, '1');
    await p.click('target'); await p.change('xml1-import-slot', '0'); await p.click('preview');
    assert.equal(p.backend.starts('preview')[0].data.source, inspected.source);
    assert.equal(p.backend.starts('preview')[0].data.campaign, inspected.campaign);
    assert.match(p.text(), /Preview only/); assert.equal(p.control('apply').disabled, true);
    await p.change('xml1-import-campaign', '0');
    assert.equal(p.control('apply').disabled, true);
    assert.equal(p.backend.starts('inspect')[2].data.campaign, 'E:/UDATA/4156001e/Campaign A');
    await p.change('xml1-import-campaign', ''); assert.equal(p.control('preview').disabled, true);
    await p.change('xml1-import-source-type', 'xbox');
    p.backend.scenario = 'gated'; p.backend.paths.push('C:\\Owned\\extracted'); await p.click('source');
    assert.equal(p.backend.starts('inspect').at(-1).data.campaign, '');
});

test('save import: unique image campaign is forwarded and mismatched preview campaigns refuse', async () => {
    for (const scenario of ['hdd', 'hdd-wrong-campaign']) {
        const p = await open(scenario); await p.change('xml1-import-source-type', 'hdd'); await p.select(); await p.click('preview');
        assert.equal(p.backend.starts('preview')[0].data.campaign, 'E:/UDATA/4156001e/Campaign A');
        assert.equal(p.control('apply').disabled, true);
        assert.match(p.text(), scenario === 'hdd' ? /Preview only/ : /complete matching result/);
    }
});

test('save import: encrypted, unknown and corrupt images display CLI refusals with escaped reasons', async () => {
    for (const [scenario, reason] of [['hdd-encrypted', /Encrypted QCOW2/], ['hdd-unknown', /Unknown disk format/], ['hdd-corrupt', /Truncated QCOW2/]]) {
        const p = await open(scenario); await p.change('xml1-import-source-type', 'hdd'); await p.click('source');
        assert.match(p.text(), reason); assert.equal(p.control('preview').disabled, true);
        assert.equal(p.control('apply').disabled, true); assert.equal(p.backend.starts().length, 1);
    }
});

test('save import: locked image waits for the writer and retries only after an explicit click', async () => {
    const p = await open('hdd-locked'); await p.change('xml1-import-source-type', 'hdd'); await p.click('source');
    assert.match(p.text(), /Close that writer, wait for it to exit/); assert.ok(p.control('retry'));
    assert.equal(p.control('preview').disabled, true); assert.equal(p.control('apply').disabled, true);
    await p.clock.advance(10000); assert.equal(p.backend.starts().length, 1);
    p.backend.scenario = 'hdd'; await p.click('retry');
    assert.equal(p.backend.starts('inspect').length, 2); assert.equal(p.control('retry'), null);
    assert.match(p.text(), /wolverine/); assert.equal(p.backend.starts('apply').length, 0);
});

test('save import: a running game refusal before start offers read retry without an active job', async () => {
    const p = await open(); const handle = p.backend.handle.bind(p.backend); let blocked = true;
    p.backend.handle = (command, data) => command === 'xml1-import-start' && blocked
        ? { success: false, code: 'L_GAME_RUNNING', error: 'Close X-Men Legends before importing a save.' } : handle(command, data);
    await p.click('source'); assert.match(p.text(), /Close X-Men Legends/); assert.ok(p.control('retry'));
    assert.equal(p.control('preview').disabled, true); blocked = false; await p.click('retry');
    assert.match(p.text(), /wolverine/); assert.equal(p.control('retry'), null);
});

test('save import: active CLI progress is escaped, redraw-safe and cancellable', async () => {
    const p = await open('hdd'); await p.change('xml1-import-source-type', 'hdd');
    p.backend.hold = true; await p.click('source');
    const job = Array.from(p.backend.jobs.values())[0]; job.message = 'Reading FATX <script>bad()</script>';
    await p.clock.advance(250); assert.match(p.text(), /Reading FATX <script>/);
    assert.equal(p.document.querySelector('#xml1-save-import script'), null);
    p.window.Xml1SaveImport.mount(); assert.match(p.text(), /Reading FATX/);
    await p.click('cancel'); await p.clock.advance(250); assert.match(p.text(), /Cancelled/);
    assert.equal(p.control('preview').disabled, true); assert.equal(p.backend.starts().length, 1);
});
