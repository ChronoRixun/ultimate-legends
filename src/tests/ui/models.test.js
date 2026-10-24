'use strict';
// The X-Men Legends page's Character models section (models-view.js): the real script against a fake
// backend that answers the models commands the way models_commands.cpp does and plays the
// legends-models tool's JSON-lines protocol (LAUNCHER-API.md, API 1) for scan / plan / build / verify /
// remove. Opening the page scans, plans the chosen appearance and verifies the installed one; the
// appearance buttons, the per-hero costume dropdowns, Apply with its progress and per-hero statuses,
// Cancel, Remove / Off, the credits and the mirror field are driven as a player would.
// tools/dev/models_cdp.py runs the same flows in the real launcher with tools/dev/fake_legends_models.py.

const assert = require('node:assert/strict');
const { page, test } = require('./harness');

const PORT = 'D:\\Games\\X-Men Legends (Port)';

function ev(event, fields) {
    return JSON.stringify(Object.assign({ event, api: 1, t: 0.1 }, fields));
}

function scanResult({ mua1 = false, mua2 = false } = {}) {
    const tier = (available, source, costumes, extra) => Object.assign({ available, reason: available ? `${source} available` : 'not installed', source, status: 'numeric', note: '', costumes }, extra || {});
    return {
        installs: {
            port: { found: true, path: PORT, flavour: '', problems: [] },
            mua1: { found: mua1, path: mua1 ? 'D:\\Steam\\MUA' : null, flavour: mua1 ? '2016-bin' : '', problems: [] },
            mua2: { found: mua2, path: mua2 ? 'D:\\Steam\\MUA2' : null, flavour: mua2 ? 'pc-bin' : '', problems: [] }
        },
        helpers: { python: 'python.exe' },
        heroes: {
            wolverine: {
                name: 'Wolverine', skin: '14301', tiers: {
                    mua2: tier(mua2, '0301', ['0301']),
                    mua1: tier(mua1, '0303', ['0301', '0302', '0303']),
                    community: tier(true, 'Original', ['Original', 'Ultimate XML1'], {
                        costume_info: [
                            { id: 'Original', label: 'Original', author: 'BaconWizard17' },
                            { id: 'Ultimate XML1', label: 'Ultimate XML1', author: 'BaconWizard17' }
                        ]
                    })
                }
            },
            beast: { name: 'Beast', skin: '14501', tiers: { community: tier(true, 'Classic', ['Classic']) } },
            profxastral: { name: 'Professor X (astral)', skin: '13301', tiers: { community: tier(false, '', []) } }
        }
    };
}

function planRows(mode, costumes, { mua1 = false } = {}) {
    const wolverine = (costumes.wolverine || '').split(':').pop();
    if (mode === 'upgraded' && mua1) {
        return [
            { hero: 'beast', name: 'Beast', skin: '14501', tier: 'community', source: 'Classic', status: 'numeric', reason: 'community Classic', fallbacks: [], skipped: [] },
            { hero: 'wolverine', name: 'Wolverine', skin: '14301', tier: 'mua1', source: wolverine && /^\d+$/.test(wolverine) ? wolverine : '0303', status: 'numeric', reason: 'mua1 2016-bin actor', fallbacks: ['community'], skipped: [] },
            { hero: 'profxastral', name: 'Professor X (astral)', skin: '13301', tier: 'stock', source: '', status: 'numeric', reason: 'no model in any installed game', fallbacks: [], skipped: [] }
        ];
    }
    return [
        { hero: 'beast', name: 'Beast', skin: '14501', tier: mode === 'sharpen' ? 'sharpen' : 'community', source: 'Classic', status: 'numeric', reason: 'community Classic', fallbacks: [], skipped: [] },
        { hero: 'wolverine', name: 'Wolverine', skin: '14301', tier: mode === 'sharpen' ? 'sharpen' : 'community', source: wolverine && !/^\d+$/.test(wolverine) ? wolverine : 'Original', status: 'numeric', reason: 'community', fallbacks: [], skipped: [] },
        { hero: 'profxastral', name: 'Professor X (astral)', skin: '13301', tier: 'stock', source: '', status: 'numeric', reason: 'no community skin', fallbacks: [], skipped: [] }
    ];
}

class Backend {
    constructor({ tool = true, built = true, running = false, mua1 = false, mua2 = false, installed = [], verifyOk = true } = {}) {
        this.tool = tool;
        this.built = built;
        this.running = running;
        this.mua1 = mua1;
        this.mua2 = mua2;
        this.installed = installed;
        this.verifyOk = verifyOk;
        this.settings = { mode: '', mirror: '', costumes: {} };
        this.runs = [];       // every models-run request
        this.jobs = {};
        this.nextId = 1;
        this.saves = [];
        this.cancels = [];
        this.buildScript = null; // (request) => { lines, exit }
        this.hold = false;       // a build waits for release() before its last lines
        this.chunk = 2;          // lines per get-models-job answer
    }

    status() {
        return {
            tool: { found: this.tool, version: 'dev', dev: true },
            port: { path: PORT, built: this.built, running: this.running },
            installs: { mua1: this.mua1 ? 'D:\\Steam\\MUA' : null, mua2: this.mua2 ? 'D:\\Steam\\MUA2' : null },
            settings: JSON.parse(JSON.stringify(this.settings)),
            defaultMirror: '',
            modsFolder: this.built ? `${PORT}\\mods` : null,
            installed: JSON.parse(JSON.stringify(this.installed)),
            busy: false, xml1Busy: false, job: null
        };
    }

    script(request) {
        const costumes = request.costumes || this.settings.costumes;
        switch (request.command) {
            case 'scan':
                return { lines: [ev('result', scanResult({ mua1: this.mua1, mua2: this.mua2 }))], exit: 0 };
            case 'plan':
                return { lines: [ev('result', { mode: request.mode, pack: 'Models-X', rows: planRows(request.mode, costumes, { mua1: this.mua1 }) })], exit: 0 };
            case 'verify':
                return {
                    lines: [ev('result', this.verifyOk ? { ok: true, files: 6, missing: [], extra: [], changed: [], load_order: 'enabled' }
                        : { ok: false, files: 6, missing: ['Community-Beast/Actors/14501.IGB'], extra: [], changed: [], load_order: 'enabled' })],
                    exit: this.verifyOk ? 0 : 30
                };
            case 'remove':
                this.installed = this.installed.filter(folder => folder.group !== request.pack);
                return { lines: [ev('result', { folder_removed: true, load_order_entry_removed: true })], exit: 0 };
            case 'build':
                if (this.buildScript) return this.buildScript(request);
                return this.defaultBuild(request);
            default:
                return { lines: [ev('error', { message: 'usage', code: 2 })], exit: 2 };
        }
    }

    defaultBuild(request) {
        const rows = planRows(request.mode, request.costumes || this.settings.costumes, { mua1: this.mua1 });
        const lines = [
            ev('plan', { mode: request.mode, rows }),
            ev('workspace', { path: 'C:\\work\\ports\\abc' }),
            ev('stage', { stage: 'convert', message: 'Beast: community Classic', hero: 'beast', tier: 'community', source: 'Classic' }),
            ev('download', { archive: 'Beast.rar', source: 'author', bytes: 1572864, sha256: 'a'.repeat(64) }),
            ev('progress', { done: 1, total: 2, message: 'Beast done', hero: 'beast' }),
            ev('gate', { hero: 'beast', tier: 'community', passed: true }),
            ev('stage', { stage: 'convert', message: 'Wolverine: community Original', hero: 'wolverine', tier: 'community', source: 'Original' }),
            ev('gate', { hero: 'wolverine', tier: 'community', passed: false, failures: ['seam opens at the left glove'] }),
            ev('progress', { done: 2, total: 2, message: 'Wolverine done', hero: 'wolverine' }),
            ev('stage', { stage: 'publish', message: 'Writing Community-Beast' }),
            ev('result', {
                pack: 'Models-Community', layout: 'per-hero', written: true, folders: ['Community-Beast'], enabled: true, files: 6,
                characters: { beast: { tier: 'community', source: 'Classic', file: 'Actors/14501.IGB', folder: 'Community-Beast', sha256: 'b'.repeat(64) } },
                refused: { wolverine: { attempts: [{ tier: 'community', failures: ['seam opens at the left glove'] }] } },
                stock: { profxastral: 'no community skin' }
            })
        ];
        this.afterBuild = () => {
            this.installed = [{ folder: 'Community-Beast', group: 'Models-Community', mode: 'community', listed: true, enabled: true, credits: true,
                characters: [{ hero: 'beast', tier: 'community', source: 'Classic' }] }];
        };
        return { lines, exit: 10 };
    }

    handle(command, data) {
        switch (command) {
            case 'get-models-status':
                return this.status();
            case 'set-models-settings': {
                this.saves.push(JSON.parse(JSON.stringify(data)));
                if (data.mirror !== undefined && data.mirror && !/^https:\/\//.test(data.mirror)) {
                    return { success: false, error: 'The mirror must be an https:// address.', settings: this.settings };
                }
                Object.keys(data).forEach(key => { this.settings[key] = data[key]; });
                return { success: true, settings: JSON.parse(JSON.stringify(this.settings)) };
            }
            case 'models-run': {
                this.runs.push(JSON.parse(JSON.stringify(data)));
                if (!this.tool) return { success: false, code: 'L_TOOL_MISSING', error: 'not installed' };
                const id = this.nextId++;
                const { lines, exit } = this.script(data);
                this.jobs[id] = { lines, exit, delivered: 0, cancelled: false, command: data.command };
                return { success: true, id };
            }
            case 'get-models-job': {
                const job = this.jobs[data.id];
                if (!job) return null;
                const from = data.from || 0;
                let upto = Math.min(job.lines.length, from + this.chunk);
                if (this.hold && job.command === 'build' && upto >= job.lines.length - 1) upto = Math.min(upto, job.lines.length - 1);
                if (job.cancelled) upto = from;
                const finished = job.cancelled || (upto >= job.lines.length);
                if (finished && !job.cancelled && job.command === 'build' && this.afterBuild) {
                    this.afterBuild();
                    this.afterBuild = null;
                }
                return {
                    id: data.id, command: job.command, active: !finished, finished, cancelRequested: job.cancelled,
                    exitCode: finished ? (job.cancelled ? 130 : job.exit) : -1, exitName: '', seconds: 1,
                    first: from, total: job.lines.length, startError: '', lines: job.lines.slice(from, upto), stderrTail: job.cancelled ? [] : ['converter log line']
                };
            }
            case 'models-cancel': {
                this.cancels.push(data.id);
                if (this.jobs[data.id]) this.jobs[data.id].cancelled = true;
                return true;
            }
            case 'get-models-credits':
                return { credits: this.installed.some(folder => folder.credits) ? [{ folder: 'Community-Beast', text: '# Credits\n\nCommunity skins: BaconWizard17.\n' }] : [] };
            case 'open-folder':
                return null;
            default:
                return null;
        }
    }

    commands(name) {
        return this.runs.filter(entry => entry.command === name);
    }
}

async function open(options = {}, { refresh = true, offline = false } = {}) {
    const backend = new Backend(options);
    const body = '<div id="xml1-page"><div id="xml1-models-panel"></div></div>';
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/models-view.js'], body, backend, offline });
    p.window.ModelsView.render('xml1');
    await p.clock.advance(0);
    if (refresh) {
        p.window.ModelsView.refresh('xml1');
        await p.clock.until(() => !p.window.ModelsView._state('xml1').loading && !p.window.ModelsView._state('xml1').refreshing, 20000, 'the page refresh');
    }
    const $ = selector => p.document.querySelector(`#xml1-models-panel ${selector}`);
    const $$ = selector => p.document.querySelectorAll(`#xml1-models-panel ${selector}`);
    const row = hero => $(`.ul-models-row[data-hero="${hero}"]`);
    const statusOf = hero => row(hero).querySelector('.ul-models-status').dataset ? row(hero).querySelector('.ul-models-status').className.replace(/.*is-/, '') : '';
    const act = name => $(`[data-act="${name}"]`);
    const settle = async (ms = 20000) => p.clock.until(() => {
        const s = p.window.ModelsView._state('xml1');
        return !(s.job && s.job.active) && !s.refreshing;
    }, ms, 'the run to end');
    return { ...p, backend, $, $$, row, statusOf, act, settle };
}

test('models: no tool installed - the page says so and runs nothing', async () => {
    const p = await open({ tool: false });
    assert.ok(p.$('.ul-models-missing'), 'the tool-missing note');
    assert.match(p.$('.ul-models-missing').textContent, /not installed yet/);
    assert.equal(p.$('.ul-models-table'), null);
    assert.equal(p.act('apply'), null);
    assert.equal(p.backend.runs.length, 0, 'no run was even asked for');
});

test('models: the port not built yet - build first', async () => {
    const p = await open({ built: false });
    assert.ok(p.$('.ul-models-notbuilt'));
    assert.equal(p.$('.ul-models-table'), null);
    assert.equal(p.backend.runs.length, 0);
});

test('models: start-up draws only the status; opening the page scans and plans the suggested Community pack', async () => {
    const p = await open({}, { refresh: false });
    assert.equal(p.backend.runs.length, 0, 'nothing runs at launcher start-up');
    p.window.ModelsView.refresh('xml1');
    await p.settle();
    assert.deepEqual(p.backend.runs.map(r => r.command), ['scan', 'plan']);
    assert.equal(p.backend.runs[1].mode, 'community');
    assert.ok(p.$('.ul-models-mode[data-mode="community"]').className.includes('active'), 'Community pack is the suggestion');
    assert.match(p.$('.ul-models-mode[data-mode="community"]').textContent, /Suggested/);
    assert.equal(p.$$('.ul-models-row').length, 3);
    assert.match(p.row('beast').querySelector('.ul-models-tier').textContent, /Community/);
    assert.equal(p.statusOf('beast'), 'planned');
    assert.equal(p.statusOf('profxastral'), 'stock');
    assert.match(p.row('profxastral').textContent, /no community skin/);
    // Wolverine has two community costumes: a dropdown with the author on each
    const select = p.row('wolverine').querySelector('select.ul-models-costume');
    assert.ok(select, 'the costume chooser');
    assert.equal(select.options.length, 2);
    assert.match(select.options[1].textContent, /Ultimate XML1 · BaconWizard17/);
    assert.match(p.row('wolverine').querySelector('.ul-models-credit').textContent, /by BaconWizard17/);
    // Beast has one: its name, no dropdown
    assert.equal(p.row('beast').querySelector('select'), null);
    // credits: community tier planned, nothing built yet
    assert.ok(p.$('.ul-models-credits'));
    assert.match(p.$('.ul-models-credits').textContent, /once the pack is built/);
});

test('models: Upgraded is greyed with a reason until MUA1 or MUA2 is set up', async () => {
    const p = await open();
    const upgraded = p.$('.ul-models-mode[data-mode="upgraded"]');
    assert.ok(upgraded.disabled);
    assert.ok(p.$('.ul-models-upgraded-note'));
    assert.match(p.$('.ul-models-upgraded-note').textContent, /set one of them up in the launcher/);
    upgraded.click();
    await p.settle();
    assert.equal(p.backend.commands('plan').length, 1, 'a disabled mode plans nothing');

    const q = await open({ mua1: true });
    const button = q.$('.ul-models-mode[data-mode="upgraded"]');
    assert.ok(!button.disabled);
    assert.equal(q.$('.ul-models-upgraded-note'), null);
    button.click();
    await q.settle();
    const plans = q.backend.commands('plan');
    assert.equal(plans[plans.length - 1].mode, 'upgraded');
    assert.match(q.row('wolverine').querySelector('.ul-models-tier').textContent, /MUA1/);
    const select = q.row('wolverine').querySelector('select.ul-models-costume');
    assert.equal(select.options.length, 3, "MUA1's three Wolverine costumes");
    assert.match(q.row('wolverine').querySelector('.ul-models-credit').textContent, /Marvel: Ultimate Alliance install/);
});

test('models: setting up MUA1 later scans again on the next open, and Upgraded comes on', async () => {
    const p = await open();
    assert.ok(p.$('.ul-models-mode[data-mode="upgraded"]').disabled);
    p.window.ModelsView.refresh('xml1');
    await p.settle();
    assert.equal(p.backend.commands('scan').length, 1, 'nothing changed: no second scan');
    p.backend.mua1 = true;
    p.window.ModelsView.refresh('xml1');
    await p.settle();
    assert.equal(p.backend.commands('scan').length, 2, 'the MUA1 folder is new: scanned again');
    assert.ok(!p.$('.ul-models-mode[data-mode="upgraded"]').disabled);
});

test('models: More holds Sharpened classic and XML2 look', async () => {
    const p = await open();
    const more = p.$('details.ul-models-more');
    assert.ok(more && !more.open);
    assert.ok(more.querySelector('[data-mode="sharpen"]'));
    assert.ok(more.querySelector('[data-mode="xml2"]'));
    more.querySelector('[data-mode="sharpen"]').click();
    await p.settle();
    assert.equal(p.backend.commands('plan').pop().mode, 'sharpen');
    assert.ok(p.$('details.ul-models-more').open, 'the chosen More mode stays visible');
    assert.match(p.row('beast').querySelector('.ul-models-tier').textContent, /Sharpened/);
});

test('models: a costume choice is stored per hero and tier, and the plan follows it', async () => {
    const p = await open();
    const select = p.row('wolverine').querySelector('select.ul-models-costume');
    select.value = 'Ultimate XML1';
    select.dispatchEvent(new p.window.Event('change', { bubbles: true }));
    await p.settle();
    assert.deepEqual(p.backend.saves.pop(), { costumes: { wolverine: 'community:Ultimate XML1' } });
    assert.equal(p.backend.commands('plan').length, 2, 'planned again');
    assert.equal(p.row('wolverine').querySelector('select.ul-models-costume').value, 'Ultimate XML1');
});

test('models: Apply builds with progress, per-hero statuses, downloads and credits', async () => {
    const p = await open();
    p.backend.hold = true;
    p.backend.chunk = 4;
    p.act('apply').click();
    await p.clock.until(() => p.backend.commands('build').length === 1 && p.$('.ul-models-progress'), 5000, 'the build to start');
    assert.equal(p.backend.commands('build')[0].mode, 'community');
    await p.clock.advance(1000);
    assert.ok(p.$('.ul-models-progress'), 'a progress bar');
    assert.match(p.$('.ul-models-progress').textContent, /of 2 heroes/);
    assert.ok(p.act('cancel'), 'Cancel while it runs');
    assert.equal(p.act('apply'), null);
    assert.ok(p.row('wolverine').querySelector('select').disabled, 'no costume changes while it runs');
    assert.match(p.$('.ul-models-downloads').textContent, /Beast\.rar/);
    assert.match(p.$('.ul-models-downloads').textContent, /1\.5 MB/);
    assert.match(p.$('.ul-models-downloads').textContent, /SHA-256 aaaaaaaaaaaaaaaa/);
    assert.match(p.$('.ul-models-downloads').textContent, /from the author’s link/);
    assert.equal(p.statusOf('beast'), 'passed');
    assert.equal(p.statusOf('wolverine'), 'trying');
    p.backend.hold = false;
    await p.settle();
    assert.equal(p.statusOf('beast'), 'built');
    assert.match(p.row('wolverine').textContent, /seam opens at the left glove/);
    assert.ok(p.$('.ul-models-outcome').className.includes('is-warn'));
    assert.match(p.$('.ul-models-outcome').textContent, /1 heroes have their new models; 2 kept the original/);
    assert.deepEqual(p.backend.saves.pop(), { mode: 'community' });
    assert.match(p.$('.ul-models-installed').textContent, /Community pack, 1 heroes/);
    assert.match(p.$('.ul-models-credits').textContent, /BaconWizard17/, 'the built pack\'s CREDITS.md');
    assert.ok(p.backend.commands('verify').length >= 1, 'verified after the build');
    // the next open shows the installed hero as built without a run of its own
    p.window.ModelsView._state('xml1').job = null;
    p.window.ModelsView.refresh('xml1');
    await p.settle();
    assert.equal(p.statusOf('beast'), 'built');
    assert.equal(p.$('[data-act="apply"]').textContent.trim(), 'Rebuild');
});

test("models: after a build, another appearance's plan shows its own statuses, not the build's", async () => {
    const p = await open();
    p.act('apply').click();
    await p.settle();
    assert.equal(p.statusOf('wolverine'), 'failed');
    p.$('.ul-models-mode[data-mode="sharpen"]').click();
    await p.settle();
    assert.equal(p.statusOf('wolverine'), 'planned', 'the Sharpened plan, not the community build');
    assert.equal(p.$('.ul-models-downloads'), null);
});

test('models: Cancel asks, then kills the run; the previous models stay', async () => {
    const p = await open();
    p.backend.hold = true;
    p.backend.chunk = 1;
    p.window.showMessageBox = async () => 1;
    p.act('apply').click();
    await p.clock.until(() => p.act('cancel'), 5000, 'Cancel');
    p.act('cancel').click();
    await p.settle();
    assert.equal(p.backend.cancels.length, 1);
    assert.match(p.$('.ul-models-outcome').textContent, /Cancelled\. The models you had before are unchanged/);
    assert.equal(p.backend.saves.filter(save => save.mode).length, 0, 'a cancelled build stores no mode');
});

test('models: a failed build says why in plain words, with details', async () => {
    const p = await open();
    p.backend.buildScript = () => ({ lines: [ev('plan', { mode: 'community', rows: [] }), ev('error', { message: 'BaconWizard17 archive: SHA-256 mismatch', code: 20 })], exit: 20 });
    p.act('apply').click();
    await p.settle();
    const outcome = p.$('.ul-models-outcome');
    assert.ok(outcome.className.includes('is-error'));
    assert.match(outcome.textContent, /could not be downloaded or did not match its checksum/);
    assert.match(outcome.textContent, /SHA-256 mismatch/);
    assert.ok(outcome.querySelector('details'), 'the tool\'s stderr under Details');
});

test('models: Verify on open warns when the installed pack is damaged', async () => {
    const installed = [{ folder: 'Community-Beast', group: 'Models-Community', mode: 'community', listed: true, enabled: true, credits: true,
        characters: [{ hero: 'beast', tier: 'community', source: 'Classic' }] }];
    const p = await open({ installed, verifyOk: false });
    assert.equal(p.backend.commands('verify')[0].pack, 'Models-Community');
    assert.ok(p.$('.ul-models-verify'));
    assert.match(p.$('.ul-models-verify').textContent, /1 files of the character models are missing or changed/);
    assert.match(p.$('.ul-models-verify').textContent, /Community-Beast\/Actors\/14501\.IGB/);
    assert.match(p.$('.ul-models-credits').textContent, /BaconWizard17/);
});

test('models: Off and Remove take every legends-models group out, after a confirmation for Remove', async () => {
    const installed = [
        { folder: 'Community-Beast', group: 'Models-Community', mode: 'community', listed: true, enabled: false, credits: true, characters: [{ hero: 'beast', tier: 'community', source: 'Classic' }] },
        { folder: 'MUA-Wolverine', group: 'Models-Upgraded', mode: 'upgraded', listed: true, enabled: true, credits: false, characters: [{ hero: 'wolverine', tier: 'mua1', source: '0303' }] }
    ];
    const p = await open({ installed, mua1: true });
    assert.ok(p.$('.ul-models-mode[data-mode="upgraded"]').className.includes('active'), 'the installed appearance is shown as chosen');
    // Remove, declined
    p.act('remove').click();
    await p.settle();
    assert.equal(p.messages.length, 1);
    assert.equal(p.backend.commands('remove').length, 0);
    // Off + Turn off: no question, both groups
    p.$('.ul-models-mode[data-mode="off"]').click();
    await p.settle();
    assert.equal(p.$('.ul-models-table'), null, 'Off has no table');
    assert.equal(p.act('apply').textContent.trim(), 'Turn off');
    p.act('apply').click();
    await p.settle();
    assert.deepEqual(p.backend.commands('remove').map(r => r.pack).sort(), ['Models-Community', 'Models-Upgraded']);
    assert.match(p.$('.ul-models-outcome').textContent, /original models/);
    assert.deepEqual(p.backend.saves.pop(), { mode: 'off' });
    assert.match(p.$('.ul-models-installed').textContent, /none/);
    assert.equal(p.act('remove'), null);
});

test('models: offline mode - Apply waits while community skins are not downloaded yet', async () => {
    const p = await open({}, { offline: true });
    assert.ok(p.$('.ul-models-offline'), 'the offline note');
    assert.match(p.$('.ul-models-offline').textContent, /2 of the community skins/);
    assert.ok(p.act('apply').disabled);
    p.act('apply').click();
    await p.settle();
    assert.equal(p.backend.commands('build').length, 0, 'nothing downloads');
    // Sharpened classic downloads nothing: Apply works offline
    p.$('.ul-models-mode[data-mode="sharpen"]').click();
    await p.settle();
    assert.equal(p.$('.ul-models-offline'), null);
    assert.ok(!p.act('apply').disabled);
});

test('models: offline mode - skins already downloaded are fine', async () => {
    const backend = new Backend();
    const scan = backend.script.bind(backend);
    backend.script = request => {
        if (request.command !== 'scan') return scan(request);
        const result = scanResult();
        result.heroes.beast.tiers.community.cached = { Classic: true };
        result.heroes.wolverine.tiers.community.cached = { Original: true, 'Ultimate XML1': false };
        return { lines: [ev('result', result)], exit: 0 };
    };
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/models-view.js'], body: '<div id="xml1-models-panel"></div>', backend, offline: true });
    p.window.ModelsView.render('xml1');
    p.window.ModelsView.refresh('xml1');
    await p.clock.until(() => !p.window.ModelsView._state('xml1').refreshing, 20000, 'refresh');
    assert.equal(p.document.querySelector('.ul-models-offline'), null);
    assert.ok(!p.document.querySelector('[data-act="apply"]').disabled);
});

test("models: the tool's own refusal of the port folder is shown, with no table and no Apply", async () => {
    const backend = new Backend();
    const scan = backend.script.bind(backend);
    backend.script = request => {
        if (request.command !== 'scan') return scan(request);
        const result = scanResult();
        result.installs.port = { found: false, path: PORT, flavour: '', problems: ['not a Legends Classic build (missing stock skins for beast)'] };
        return { lines: [ev('result', result)], exit: 0 };
    };
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/models-view.js'], body: '<div id="xml1-models-panel"></div>', backend });
    p.window.ModelsView.render('xml1');
    p.window.ModelsView.refresh('xml1');
    await p.clock.until(() => !p.window.ModelsView._state('xml1').refreshing, 20000, 'refresh');
    const note = p.document.querySelector('.ul-models-blocked');
    assert.ok(note);
    assert.match(note.textContent, /missing stock skins for beast/);
    assert.match(note.textContent, /Rebuild the game/);
    assert.equal(p.document.querySelector('.ul-models-table'), null);
    assert.ok(p.document.querySelector('[data-act="apply"]').disabled);
});

test('models: nothing writes while the game runs', async () => {
    const p = await open({ running: true });
    assert.ok(p.$('.ul-models-blocked'));
    assert.match(p.$('.ul-models-blocked').textContent, /close it/);
    assert.ok(p.act('apply').disabled);
    p.act('apply').click();
    await p.settle();
    assert.equal(p.backend.commands('build').length, 0);
});

test('models: the mirror field takes an https address only', async () => {
    const p = await open();
    const input = p.$('.ul-models-mirror-input');
    assert.ok(input);
    assert.match(input.getAttribute('placeholder'), /author’s links/);
    input.value = 'http://example.com/packs/';
    p.act('save-mirror').click();
    await p.settle();
    assert.equal(p.backend.saves.length, 0, 'refused on the page');
    assert.match(p.toasts.pop()[0], /https:\/\//);
    p.$('.ul-models-mirror-input').value = 'https://example.com/packs/';
    p.act('save-mirror').click();
    await p.settle();
    assert.deepEqual(p.backend.saves.pop(), { mirror: 'https://example.com/packs/' });
    assert.equal(p.$('.ul-models-mirror-input').value, 'https://example.com/packs/');
});

test('models: per-hero CREDITS.md files are shown as one text, each opening once', async () => {
    const installed = ['Beast', 'Storm'].map(name => ({ folder: `Community-${name}`, group: 'Models-Community', mode: 'community', listed: true,
        enabled: true, credits: true, characters: [{ hero: name.toLowerCase(), tier: 'community', source: 'Classic' }] }));
    const p = await open({ installed }, { refresh: false });
    p.backend.handle = (orig => (command, data) => command === 'get-models-credits'
        ? { credits: [
            { folder: 'Community-Beast', text: '# Credits\r\n\r\nCommunity skins: BaconWizard17.\r\n\r\n## Beast\r\n\r\n- Raven Software: XML1/XML2 Beast assets\r\n' },
            { folder: 'Community-Storm', text: '# Credits\n\nCommunity skins: BaconWizard17.\n\n## Storm\n\n- Teancum: Storm skin\n' }] }
        : orig.call(p.backend, command, data))(p.backend.handle);
    p.window.ModelsView.refresh('xml1');
    await p.settle();
    const texts = p.$$('.ul-models-credits-text');
    assert.equal(texts.length, 1);
    const text = texts[0].textContent;
    assert.equal(text.split('# Credits').length - 1, 1, 'the opening once');
    assert.match(text, /## Beast[\s\S]*Raven Software[\s\S]*## Storm[\s\S]*Teancum/);
});

test('models: events of an unexpected shape are ignored, an other API version is noticed', async () => {
    const p = await open();
    const { _applyEvent: applyEvent, _newRun: newRun } = p.window.ModelsView;
    const job = newRun('build');
    applyEvent(job, null);
    applyEvent(job, { nope: 1 });
    applyEvent(job, { event: 'progress', api: 1, done: 'x', total: -3 });
    assert.equal(job.done, 0);
    assert.equal(job.total, 0);
    applyEvent(job, { event: 'gate', api: 1, hero: 5 });
    applyEvent(job, { event: 'something-new', api: 1 });
    assert.equal(job.unknownApi, false);
    applyEvent(job, { event: 'stage', api: 2, stage: 'convert', message: 'x' });
    assert.equal(job.unknownApi, true);
    applyEvent(job, { event: 'result', api: 1, characters: { beast: { tier: 'community' } }, refused: 'bad', stock: null });
    assert.equal(job.heroes.beast.status, 'built');
});
