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
        this.settings = { mode: '', mirror: '', costumes: {}, termsAccepted: true };
        this.toolVersion = 'dev';
        this.toolDev = true;
        // the tool's release on the update channel (models-tool-check), as models_commands.cpp reports it
        this.release = { checking: false, installing: false, done: 0, total: 0, code: '', error: '', notPublished: false, latest: '',
            latestSize: 0, channel: 'stable', fromCache: false, source: '', installedNow: '', updateAvailable: false, offline: false };
        this.releaseScript = null; // (install) => [release states, one per status poll]; the last one stays
        this.checks = [];          // every models-tool-check request
        this.previews = [];        // every get-models-preview request
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
            tool: { found: this.tool, version: this.tool ? this.toolVersion : '', dev: this.tool && this.toolDev },
            toolRelease: this.nextRelease(),
            port: { path: PORT, built: this.built, running: this.running },
            installs: { mua1: this.mua1 ? 'D:\\Steam\\MUA' : null, mua2: this.mua2 ? 'D:\\Steam\\MUA2' : null },
            settings: JSON.parse(JSON.stringify(this.settings)),
            defaultMirror: '',
            modsFolder: this.built ? `${PORT}\\mods` : null,
            installed: JSON.parse(JSON.stringify(this.installed)),
            busy: false, xml1Busy: false, job: null
        };
    }

    nextRelease() {
        if (this.releaseSteps && this.releaseSteps.length) {
            const step = this.releaseSteps.shift();
            if (typeof step === 'function') step(this);
            else Object.assign(this.release, step);
        }
        return JSON.parse(JSON.stringify(this.release));
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
            case 'models-tool-check': {
                this.checks.push(JSON.parse(JSON.stringify(data)));
                if (this.release.offline) return { started: false };
                this.release.checking = true;
                this.releaseSteps = this.releaseScript ? this.releaseScript(!!data.install) : [{ checking: false, code: 'L_TOOL_OFFLINE', error: 'no connection' }];
                return { started: true };
            }
            case 'get-models-preview':
                this.previews.push(data.path);
                return { data: /\.png$/.test(data.path) ? 'data:image/png;base64,iVBORw0KGgo=' : null };
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

// ---- 0.5.0: the tool's own install / update, the author's terms, offline, stale, migration ----

test('models: no tool - the update channel offers it, Install installs it and the page scans with it', async () => {
    const backend = { tool: false };
    const p = await open(backend, { refresh: false });
    p.backend.releaseScript = install => install
        ? [{ checking: false, installing: true, done: 0, total: 62113029 },
            { done: 31000000 },
            b => { b.tool = true; b.toolVersion = '0.4.0-beta.1'; b.toolDev = false; Object.assign(b.release, { installing: false, done: 62113029, installedNow: '0.4.0-beta.1', source: 'download' }); }]
        : [{ checking: false, latest: '0.4.0-beta.1', latestSize: 62113029, channel: 'beta' }];
    p.window.ModelsView.refresh('xml1');
    await p.clock.until(() => p.act('tool-install'), 5000, 'Install');
    assert.deepEqual(p.backend.checks, [{ install: false }], 'asked the channel once, without installing');
    assert.match(p.$('.ul-models-missing').textContent, /legends-models 0\.4\.0-beta\.1, a beta on your Beta update channel, is ready to install \(59\.2\d? MB\)/);
    assert.equal(p.backend.runs.length, 0, 'no tool run yet');
    p.act('tool-install').click();
    await p.clock.until(() => p.$('.ul-models-tool-progress'), 5000, 'the install progress');
    await p.clock.until(() => p.backend.commands('scan').length === 1, 20000, 'a scan with the new tool');
    await p.settle();
    assert.deepEqual(p.backend.checks[1], { install: true });
    assert.ok(p.toasts.some(toast => /legends-models 0\.4\.0-beta\.1 is installed/.test(toast[0])), 'said so');
    assert.equal(p.$('.ul-models-missing'), null);
    assert.match(p.$('.ul-models-tool-version').textContent, /legends-models 0\.4\.0-beta\.1/);
    assert.ok(p.$('.ul-models-table'), 'the plan table');
});

test('models: no tool and nothing published yet - the page says so, with Check again', async () => {
    const p = await open({ tool: false }, { refresh: false });
    p.backend.releaseScript = () => [{ checking: false, notPublished: true, code: 'L_TOOL_UNPUBLISHED', error: 'No release has been published.' }];
    p.window.ModelsView.refresh('xml1');
    await p.clock.until(() => p.act('tool-check'), 5000, 'Check again');
    assert.match(p.$('.ul-models-missing').textContent, /has not been published yet/);
    assert.equal(p.act('tool-install'), null);
    p.act('tool-check').click();
    await p.clock.until(() => p.backend.checks.length === 2, 5000, 'a second check');
    assert.deepEqual(p.backend.checks[1], { install: false, force: true }, 'Check again asks GitHub again');
});

test('models: a failed tool download is said in plain words and Install stays', async () => {
    const p = await open({ tool: false }, { refresh: false });
    p.backend.releaseScript = install => install
        ? [{ installing: true, checking: false, total: 100 }, { installing: false, code: 'L_TOOL_HASH', error: 'SHA-256 mismatch' }]
        : [{ checking: false, latest: '0.3.0', latestSize: 100, channel: 'stable' }];
    p.window.ModelsView.refresh('xml1');
    await p.clock.until(() => p.act('tool-install'), 5000, 'Install');
    assert.match(p.$('.ul-models-missing').textContent, /legends-models 0\.3\.0 is ready to install/);
    p.act('tool-install').click();
    await p.clock.until(() => p.$('.ul-models-tool-error'), 5000, 'the failure');
    assert.match(p.$('.ul-models-tool-error').textContent, /did not match its SHA-256, so nothing was installed/);
    assert.ok(p.act('tool-install'), 'Install again');
});

test('models: an installed tool with a newer release on the channel offers Update', async () => {
    const p = await open({}, { refresh: false });
    p.backend.toolVersion = '0.3.0';
    p.backend.toolDev = false;
    p.backend.releaseScript = install => install
        ? [{ installing: true, checking: false, total: 10 }, { installing: false, installedNow: '0.3.1', updateAvailable: false }]
        : [{ checking: false, latest: '0.3.1', latestSize: 10, channel: 'stable', updateAvailable: true }];
    p.window.ModelsView.refresh('xml1');
    await p.settle();
    await p.clock.until(() => p.act('tool-install'), 5000, 'Update');
    assert.match(p.$('.ul-models-tool-update').textContent, /legends-models 0\.3\.1 is available \(you have 0\.3\.0\)/);
    assert.equal(p.act('tool-install').textContent.trim(), 'Update the tool');
    p.act('tool-install').click();
    await p.clock.until(() => p.backend.checks.length === 2 && !p.window.ModelsView._state('xml1').acting, 20000, 'the update');
    assert.deepEqual(p.backend.checks[1], { install: true });
    assert.equal(p.$('.ul-models-tool-update'), null);
});

test('models: -offline - no release check, and the tool missing says it can only be installed online', async () => {
    const p = await open({ tool: false }, { refresh: false, offline: true });
    p.backend.release.offline = true;
    p.window.ModelsView.refresh('xml1');
    await p.clock.until(() => !p.window.ModelsView._state('xml1').refreshing, 5000, 'refresh');
    assert.equal(p.backend.checks.length, 0);
    assert.match(p.$('.ul-models-missing').textContent, /Start the launcher online to install it/);
    assert.equal(p.act('tool-install'), null);
});

test("models: the author's terms are asked for before the first community download, once", async () => {
    const p = await open();
    p.backend.settings.termsAccepted = false;
    p.window.ModelsView.refresh('xml1');
    await p.settle();
    // declined: nothing built
    p.act('apply').click();
    await p.settle();
    assert.equal(p.messages.length, 1);
    assert.match(p.messages[0][0], /the author’s terms/);
    assert.match(p.messages[0][1], /don’t share or re-upload these files outside marvelmods\.com, don’t sell them, and credit him/);
    assert.equal(p.backend.commands('build').length, 0, 'declined: no build');
    assert.match(p.$('.ul-models-outcome').textContent, /Nothing was downloaded/);
    // agreed: stored, then built
    p.window.showMessageBox = async (...args) => { p.messages.push(args); return 1; };
    p.act('apply').click();
    await p.settle();
    assert.ok(p.backend.saves.some(save => save.termsAccepted === true), 'the acceptance is stored');
    assert.equal(p.backend.commands('build').length, 1);
    // next time: no question
    const asked = p.messages.length;
    p.act('apply').click();
    await p.settle();
    assert.equal(p.messages.length, asked);
    assert.equal(p.backend.commands('build').length, 2);
});

test('models: no terms question for an appearance without community skins', async () => {
    const p = await open();
    p.backend.settings.termsAccepted = false;
    p.$('.ul-models-mode[data-mode="sharpen"]').click();
    await p.settle();
    p.act('apply').click();
    await p.settle();
    assert.equal(p.messages.length, 0);
    assert.equal(p.backend.commands('build').length, 1);
});

test('models: offline, the tool plans the undownloaded skins away (--offline) and the page says so', async () => {
    const backend = new Backend();
    const script = backend.script.bind(backend);
    backend.script = request => {
        if (request.command !== 'plan') return script(request);
        const rows = planRows(request.mode, {});
        rows[0] = Object.assign({}, rows[0], { tier: 'stock', source: '', reason: 'Classic is not in the download cache (offline)',
            skipped: [{ tier: 'community', reason: 'Classic is not in the download cache (offline)' }] });
        const result = { mode: request.mode, pack: 'Models-Community', rows };
        return { lines: [ev('result', result)], exit: 0 };
    };
    backend.release.offline = true;
    const scan = backend.script;
    backend.script = request => {
        if (request.command !== 'scan') return scan(request);
        const result = scanResult();
        result.heroes.beast.tiers.community.cached = { Classic: false };
        result.heroes.wolverine.tiers.community.cached = { Original: true, 'Ultimate XML1': true };
        return { lines: [ev('result', result)], exit: 0 };
    };
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/models-view.js'], body: '<div id="xml1-models-panel"></div>', backend, offline: true });
    p.window.ModelsView.render('xml1');
    p.window.ModelsView.refresh('xml1');
    await p.clock.until(() => !p.window.ModelsView._state('xml1').refreshing, 20000, 'refresh');
    assert.equal(backend.commands('plan')[0].offline, true, 'plan --offline');
    const note = p.document.querySelector('.ul-models-offline-skipped');
    assert.ok(note, 'the offline note');
    assert.match(note.textContent, /1 community skins are not downloaded yet/);
    assert.match(p.document.querySelector('.ul-models-row[data-hero="beast"]').textContent, /not in the download cache \(offline\)/);
    const apply = p.document.querySelector('[data-act="apply"]');
    assert.ok(!apply.disabled, 'Apply builds what is there');
    apply.click();
    await p.clock.until(() => backend.commands('build').length === 1 && !p.window.ModelsView._state('xml1').job.active, 20000, 'the build');
    assert.equal(backend.commands('build')[0].offline, true, 'build --offline');
});

test('models: verify says the port was rebuilt since (exit 31) and Rebuild builds the installed appearance', async () => {
    const installed = [{ folder: 'Upgraded-MUA-Storm', group: 'Models-Upgraded', mode: 'upgraded', listed: true, enabled: true, credits: false,
        characters: [{ hero: 'wolverine', tier: 'mua1', source: '0303' }] }];
    const backend = new Backend({ installed, mua1: true });
    const script = backend.script.bind(backend);
    backend.script = request => request.command !== 'verify' ? script(request) : {
        lines: [ev('result', { ok: true, files: 4, missing: [], extra: [], changed: [], load_order: 'enabled', stale: true,
            stale_folders: ['Upgraded-MUA-Storm'], port_changed: ['Upgraded-MUA-Storm: Actors/14601.IGB'], port_build_unknown: [] })], exit: 31
    };
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/models-view.js'], body: '<div id="xml1-models-panel"></div>', backend });
    p.window.ModelsView.render('xml1');
    p.window.ModelsView.refresh('xml1');
    await p.clock.until(() => !p.window.ModelsView._state('xml1').refreshing, 20000, 'refresh');
    const note = p.document.querySelector('.ul-models-stale');
    assert.ok(note, 'the stale note');
    assert.match(note.textContent, /rebuilt since these models were made: 1 heroes need converting again/);
    assert.match(note.textContent, /Upgraded-MUA-Storm: Actors\/14601\.IGB/);
    assert.equal(p.document.querySelector('.ul-models-verify'), null, 'not a damaged pack');
    note.querySelector('[data-act="rebuild"]').click();
    await p.clock.until(() => backend.commands('build').length === 1, 20000, 'the rebuild');
    assert.equal(backend.commands('build')[0].mode, 'upgraded');
});

test('models: a pack made before 0.3.0 (no port build recorded) offers Rebuild quietly', async () => {
    const installed = [{ folder: 'Community-Beast', group: 'Models-Community', mode: 'community', listed: true, enabled: true, credits: true,
        characters: [{ hero: 'beast', tier: 'community', source: 'Classic' }] }];
    const backend = new Backend({ installed });
    const script = backend.script.bind(backend);
    backend.script = request => request.command !== 'verify' ? script(request) : {
        lines: [ev('result', { ok: true, files: 4, missing: [], extra: [], changed: [], load_order: 'enabled', stale: false,
            stale_folders: [], port_changed: [], port_build_unknown: ['Community-Beast'] })], exit: 0
    };
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/models-view.js'], body: '<div id="xml1-models-panel"></div>', backend });
    p.window.ModelsView.render('xml1');
    p.window.ModelsView.refresh('xml1');
    await p.clock.until(() => !p.window.ModelsView._state('xml1').refreshing, 20000, 'refresh');
    const note = p.document.querySelector('.ul-models-stale');
    assert.ok(note && note.className.includes('is-info'));
    assert.match(note.textContent, /older version of the tool/);
});

test("models: the tool's folder renames (0.2.x names) are announced after the build", async () => {
    const p = await open();
    const build = p.backend.defaultBuild.bind(p.backend);
    p.backend.buildScript = request => {
        const out = build(request);
        out.lines.splice(1, 0, ev('stage', { stage: 'publish', message: 'renamed MUA-Storm to Upgraded-MUA-Storm (group-qualified folder names)' }),
            ev('stage', { stage: 'publish', message: 'renamed MUA2-Wolverine to Upgraded-MUA2-Wolverine (group-qualified folder names)' }));
        return out;
    };
    p.act('apply').click();
    await p.settle();
    const note = p.$('.ul-models-renamed');
    assert.ok(note);
    assert.match(note.textContent, /gave 2 model folders its new names/);
    const job = p.window.ModelsView._state('xml1').job;
    assert.equal(JSON.stringify(job.renamed[0]), JSON.stringify({ from: 'MUA-Storm', to: 'Upgraded-MUA-Storm' }));
});

test('models: a download names the hero and costume with its SHA-256', async () => {
    const p = await open();
    const build = p.backend.defaultBuild.bind(p.backend);
    p.backend.buildScript = request => {
        const out = build(request);
        out.lines = out.lines.map(line => JSON.parse(line).event === 'download'
            ? ev('download', { archive: 'Beast-Classic.rar', source: 'author', bytes: 1048576, sha256: 'c'.repeat(64), character: 'beast', costume: 'Classic' }) : line);
        return out;
    };
    p.act('apply').click();
    await p.settle();
    const text = p.$('.ul-models-downloads').textContent;
    assert.match(text, /Beast: Classic/);
    assert.match(text, /Beast-Classic\.rar/);
    assert.match(text, /SHA-256 cccccccccccccccc/);
});

test('models: costume labels and authors, and a preview the tool named is read through the launcher', async () => {
    const backend = new Backend({ mua1: true });
    const script = backend.script.bind(backend);
    backend.script = request => {
        if (request.command !== 'scan') return script(request);
        const result = scanResult({ mua1: true });
        result.heroes.wolverine.tiers.mua1.author = '';
        result.heroes.wolverine.tiers.mua1.costume_info = [
            { id: '0301', label: 'White shirt and jeans', author: '', credit: 'from your own copy of Marvel: Ultimate Alliance' },
            { id: '0302', label: 'Brown/yellow', author: '', credit: 'from your own copy of Marvel: Ultimate Alliance' },
            { id: '0303', label: 'Classic yellow/blue', author: '', credit: 'from your own copy of Marvel: Ultimate Alliance' }];
        result.heroes.beast.tiers.community.costume_info = [{ id: 'Classic', label: 'Classic', author: 'BaconWizard17',
            credit: 'by BaconWizard17 (marvelmods.com)', preview: 'C:\\work\\ports\\abc\\community\\extracted\\beast\\classic\\Beast (Character Select Portrait).png' }];
        return { lines: [ev('result', result)], exit: 0 };
    };
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/models-view.js'], body: '<div id="xml1-models-panel"></div>', backend });
    p.window.ModelsView.render('xml1');
    p.window.ModelsView.refresh('xml1');
    await p.clock.until(() => !p.window.ModelsView._state('xml1').refreshing, 20000, 'refresh');
    p.document.querySelector('.ul-models-mode[data-mode="upgraded"]').click();
    await p.clock.until(() => !p.window.ModelsView._state('xml1').acting, 20000, 'the upgraded plan');
    const wolverine = p.document.querySelector('.ul-models-row[data-hero="wolverine"]');
    const select = wolverine.querySelector('select');
    assert.deepEqual([...select.options].map(o => o.textContent.trim()), ['White shirt and jeans', 'Brown/yellow', 'Classic yellow/blue']);
    assert.equal(select.value, '0303');
    assert.match(wolverine.querySelector('.ul-models-credit').textContent, /from your own copy of Marvel: Ultimate Alliance/);
    const beast = p.document.querySelector('.ul-models-row[data-hero="beast"]');
    assert.match(beast.querySelector('.ul-models-credit').textContent, /by BaconWizard17 \(marvelmods\.com\)/);
    await p.clock.until(() => p.document.querySelector('.ul-models-row[data-hero="beast"] img.ul-models-preview'), 5000, 'the preview');
    assert.equal(backend.previews.length, 1, 'asked once');
    assert.match(p.document.querySelector('.ul-models-row[data-hero="beast"] img.ul-models-preview').getAttribute('src'), /^data:image\/png;base64,/);
});

test('models: exit 31 has a name of its own', async () => {
    const p = await open();
    const { _newRun: newRun } = p.window.ModelsView;
    assert.ok(newRun('verify').renamed, 'a run keeps its renames');
    assert.match(p.window.LauncherI18n.t('models.exit.stale'), /rebuilt since they were made/);
});

test('models: a plan where every hero stays original has nothing to Apply', async () => {
    const backend = new Backend();
    const script = backend.script.bind(backend);
    backend.script = request => request.command !== 'plan' ? script(request) : {
        lines: [ev('result', { mode: request.mode, pack: 'Models-Community', rows: planRows(request.mode, {}).map(row => Object.assign({}, row,
            { tier: 'stock', source: '', reason: `${row.source || 'x'} is not in the download cache (offline)` })) })], exit: 0
    };
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/models-view.js'], body: '<div id="xml1-models-panel"></div>', backend, offline: true });
    p.window.ModelsView.render('xml1');
    p.window.ModelsView.refresh('xml1');
    await p.clock.until(() => !p.window.ModelsView._state('xml1').refreshing, 20000, 'refresh');
    assert.ok(p.document.querySelector('[data-act="apply"]').disabled);
    assert.ok(p.document.querySelector('.ul-models-offline-skipped'));
});

test('models: Verify of a stale pack shows the note, not an "intact" toast', async () => {
    const installed = [{ folder: 'Community-Beast', group: 'Models-Community', mode: 'community', listed: true, enabled: true, credits: true,
        characters: [{ hero: 'beast', tier: 'community', source: 'Classic' }] }];
    const p = await open({ installed });
    const script = p.backend.script.bind(p.backend);
    p.backend.script = request => request.command !== 'verify' ? script(request) : {
        lines: [ev('result', { ok: true, files: 4, missing: [], extra: [], changed: [], load_order: 'enabled', stale: true,
            stale_folders: ['Community-Beast'], port_changed: ['Community-Beast: libIGSg.dll'], port_build_unknown: [] })], exit: 31
    };
    p.act('verify').click();
    await p.settle();
    await p.clock.until(() => !p.window.ModelsView._state('xml1').acting, 5000, 'verify');
    assert.ok(p.$('.ul-models-stale'));
    assert.equal(p.toasts.filter(toast => /intact/.test(toast[0])).length, 0);
});
