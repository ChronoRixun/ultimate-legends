'use strict';
// The Downloads tab (views.js renderDownloads, main.js DownloadQueueManager) with the Character models
// section's work in it (models-view.js): one entry per Apply / Rebuild / Remove / Off and per install /
// update of the legends-models tool, drawn from the section's own job (phase, the skins downloaded with
// file, size, source and SHA-256, progress), Cancel from either place, then Recent with the outcome - the
// same Recent the patch installs, updates and removals go to. The fake backend is models.test.js's.

const assert = require('node:assert/strict');
const { page, test } = require('./harness');
const { Backend, ev, planRows } = require('./models.test.js');

const SHA_BEAST = 'b'.repeat(64);

// A build whose events come one per poll: the plan, then per hero its convert stage, the community download
// (Beast only: Wolverine's skin is already downloaded), its converter, its gate and progress.
function steppedBuild(request) {
    const rows = planRows(request.mode, request.costumes || {}, {});
    return {
        lines: [
            ev('plan', { mode: request.mode, rows }),
            ev('progress', { done: 0, total: 2, message: 'Beast: community', hero: 'beast' }),
            ev('stage', { stage: 'convert', message: 'Beast from Community (Classic)', hero: 'beast', tier: 'community', source: 'Classic' }),
            ev('download', { archive: '05XX_Classic.rar', source: 'author', bytes: 1583350, sha256: SHA_BEAST, character: 'beast', costume: 'Classic' }),
            ev('engine', { engine: 'community', script: 'fit.py', log: 'C:\\work\\beast.log' }),
            ev('gate', { hero: 'beast', tier: 'community', passed: true }),
            ev('progress', { done: 1, total: 2, message: 'Wolverine: community', hero: 'wolverine' }),
            ev('stage', { stage: 'convert', message: 'Wolverine from Community (Original)', hero: 'wolverine', tier: 'community', source: 'Original' }),
            ev('engine', { engine: 'community', script: 'fit.py', log: 'C:\\work\\wolverine.log' }),
            ev('gate', { hero: 'wolverine', tier: 'community', passed: true }),
            ev('progress', { done: 2, total: 2, message: 'conversions done' }),
            ev('stage', { stage: 'publish', message: 'writing mods\\Models-Community' }),
            ev('result', {
                pack: 'Models-Community', layout: 'per-hero', written: true, folders: ['Community-Beast', 'Community-Wolverine'], enabled: true, files: 12,
                characters: { beast: { tier: 'community', source: 'Classic' }, wolverine: { tier: 'community', source: 'Original' } },
                refused: {}, stock: { profxastral: 'no community skin' }
            })
        ],
        exit: 10
    };
}

// The scan with what the tool says of the community skins: Beast's Classic (1.51 MB) not downloaded yet,
// Wolverine's Original already on this PC.
function withSkins(backend) {
    const script = backend.script.bind(backend);
    backend.script = request => {
        const answer = script(request);
        if (request.command !== 'scan') return answer;
        const result = JSON.parse(answer.lines[0]);
        result.heroes.beast.tiers.community.costume_info = [{ id: 'Classic', label: 'Classic', author: 'BaconWizard17', bytes: 1583350 }];
        result.heroes.beast.tiers.community.cached = { Classic: false };
        result.heroes.wolverine.tiers.community.cached = { Original: true, 'Ultimate XML1': false };
        return { lines: [JSON.stringify(result)], exit: 0 };
    };
    return backend;
}

class ToolBackend extends Backend {
    constructor(options) {
        super(options);
        this.toolCancels = 0;
    }

    handle(command, data) {
        if (command === 'models-tool-cancel') {
            this.toolCancels++;
            const was = this.release.installing;
            this.release.cancelRequested = was;
            // the install notices it at its next chunk: two status polls later it has stopped
            this.releaseSteps = was ? [{}, { installing: false, code: 'L_TOOL_CANCELLED', error: 'cancelled', cancelRequested: true }] : [];
            return { cancelled: was };
        }
        return super.handle(command, data);
    }
}

async function open(options = {}, { tool = false } = {}) {
    const backend = withSkins(tool ? new ToolBackend(options) : new Backend(options));
    const body = '<div id="xml1-page"><div id="xml1-models-panel"></div></div>';
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/main.js', 'app/views.js', 'app/models-view.js'], body, backend });
    // the Downloads tab open (what loadNavigationPage('downloads') does)
    p.document.getElementById('downloads-page').style.display = 'block';
    p.window.AppViews.renderDownloads();
    p.window.ModelsView.render('xml1');
    await p.clock.advance(0);
    const settle = async (ms = 20000) => p.clock.until(() => {
        const s = p.window.ModelsView._state('xml1');
        return !(s.job && s.job.active) && !s.refreshing && !s.acting && !s.runs;
    }, ms, 'the page to settle');
    if (!options.noRefresh) {
        p.window.ModelsView.refresh('xml1');
        await settle();
    }
    const dl = selector => p.document.querySelector(`#downloads-list ${selector}`);
    const dls = selector => p.document.querySelectorAll(`#downloads-list ${selector}`);
    const act = name => p.document.querySelector(`#xml1-models-panel [data-act="${name}"]`);
    const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    const badge = () => p.document.getElementById('downloads-badge');
    return { ...p, backend, settle, dl, dls, act, text, badge };
}

test('downloads: Apply is one entry - downloading a skin, converting hero N of M, installing - then Recent', async () => {
    const p = await open();
    assert.match(p.text(p.dl('.downloads-empty')), /No downloads in progress/);
    p.backend.buildScript = steppedBuild;
    p.backend.chunk = 1;
    p.backend.hold = true;
    p.act('apply').click();
    await p.clock.until(() => p.dl('.download-row.tracked'), 5000, 'the entry');
    assert.equal(p.dls('.download-row.tracked').length, 1, 'one entry for the Apply');
    assert.equal(p.dl('.downloads-empty'), null);
    assert.match(p.text(p.dl('.download-row.tracked .download-row-title')), /Character models: Apply \(Community pack\)/);
    assert.equal(p.badge().textContent, '1', 'the Downloads badge counts it');
    assert.equal(p.badge().style.display, '');

    // Beast's skin is not downloaded yet: the entry says it is downloading it, its size and where from
    await p.clock.until(() => /Downloading the Beast skin/.test(p.text(p.dl('.download-row.tracked .download-progress-message'))), 5000, 'the download phase');
    assert.match(p.text(p.dl('.download-row.tracked .download-progress-message')), /Downloading the Beast skin \(Classic, 1\.5\d? MB\) from the author’s link/);
    assert.ok(p.dl('.download-row.tracked .download-item.is-downloading'), 'the skin in flight');
    assert.match(p.text(p.dl('.download-item.is-downloading')), /Beast: Classic.*1\.5\d? MB expected.*downloading…/);
    assert.ok(p.dl('.download-progress-fill'), 'a progress bar');
    assert.match(p.text(p.dl('.download-row.tracked .download-progress-stats')), /0 of 2 heroes/);
    assert.ok(p.dl('.download-row.tracked .download-row-cancel'), 'Cancel on the entry');

    // the download event: the file, its size, source and SHA-256; then converting hero 1 of 2
    await p.clock.until(() => p.dl('.download-item.is-done'), 5000, 'the finished download');
    const item = p.text(p.dl('.download-item.is-done'));
    assert.match(item, /Beast: Classic/);
    assert.match(item, /05XX_Classic\.rar/);
    assert.match(item, /1\.5\d? MB/);
    assert.match(item, /from the author’s link/);
    assert.match(item, /SHA-256 bbbbbbbbbbbbbbbb…/);
    assert.equal(p.dl('.download-item.is-done .download-item-hash').getAttribute('title'), `SHA-256 ${SHA_BEAST}`);
    await p.clock.until(() => /Converting Beast: hero 1 of 2/.test(p.text(p.dl('.download-progress-message'))), 5000, 'converting Beast');
    // Wolverine's skin is already on this PC: no download phase, straight to converting
    await p.clock.until(() => /Converting Wolverine: hero 2 of 2/.test(p.text(p.dl('.download-progress-message'))), 5000, 'converting Wolverine');
    assert.equal(p.dl('.download-item.is-downloading'), null, 'nothing downloading for Wolverine');
    assert.match(p.text(p.dl('.download-progress-stats')), /1 of 2 heroes/);
    await p.clock.until(() => /Installing into the game’s mods folder/.test(p.text(p.dl('.download-progress-message'))), 5000, 'installing');
    assert.match(p.text(p.dl('.download-progress-percent')), /100%/);

    // the same job on the page: its progress bar and the same download
    assert.ok(p.document.querySelector('#xml1-models-panel .ul-models-progress'));
    assert.match(p.text(p.document.querySelector('#xml1-models-panel .ul-models-downloads')), /05XX_Classic\.rar/);

    p.backend.hold = false;
    await p.settle();
    assert.equal(p.dls('.download-row.tracked').length, 0, 'no longer running');
    assert.match(p.text(p.dl('.downloads-empty')), /No downloads in progress/);
    const recent = p.dl('.downloads-recent .download-row.finished');
    assert.ok(recent, 'in Recent');
    assert.equal(recent.dataset.outcome, 'partial');
    assert.match(p.text(recent), /Character models: Apply \(Community pack\)/);
    assert.match(p.text(recent), /Finished, with notes/);
    assert.match(p.text(recent), /2 heroes have their new models; 1 kept the original/, 'the reason the page gives');
    assert.match(p.text(recent), /05XX_Classic\.rar.*SHA-256 bbbbbbbbbbbbbbbb/, 'the downloads stay listed');
    assert.equal(p.badge().style.display, 'none', 'Recent is not counted');
    // the page's outcome is the same text
    assert.match(p.text(p.document.querySelector('#xml1-models-panel .ul-models-outcome')), /2 heroes have their new models; 1 kept the original/);
});

test("downloads: Cancel on the entry asks like the page, then the run is cancelled and Recent says so", async () => {
    const p = await open();
    p.backend.buildScript = steppedBuild;
    p.backend.chunk = 1;
    p.backend.hold = true;
    const asked = [];
    p.window.showMessageBox = async (...args) => { asked.push(args); return 1; };
    p.act('apply').click();
    await p.clock.until(() => p.dl('.download-row.tracked .download-row-cancel') && p.window.ModelsView._state('xml1').job.id, 5000, 'Cancel');
    p.dl('.download-row.tracked .download-row-cancel').click();
    await p.clock.until(() => p.backend.cancels.length === 1, 5000, 'models-cancel');
    assert.match(asked[0][0], /Cancel the character models\?/, "the page's own question");
    assert.equal(p.backend.cancels[0], p.window.ModelsView._state('xml1').job.id, 'the running job');
    await p.settle();
    const recent = p.dl('.downloads-recent .download-row.finished');
    assert.equal(recent.dataset.outcome, 'cancelled');
    assert.match(p.text(recent), /Cancelled.*The models you had before are unchanged/);
    assert.match(p.text(p.document.querySelector('#xml1-models-panel .ul-models-outcome')), /Cancelled\. The models you had before are unchanged/);
});

test("downloads: the page's Cancel shows as Cancelling… on the entry, which keeps no second Cancel", async () => {
    const p = await open();
    p.backend.buildScript = steppedBuild;
    p.backend.chunk = 1;
    p.backend.hold = true;
    p.window.showMessageBox = async () => 1;
    // the cancel lands but the tool takes a moment to stop: the job is still running
    const handle = p.backend.handle.bind(p.backend);
    p.backend.handle = (command, data) => {
        if (command === 'models-cancel') { p.backend.cancels.push(data.id); return true; }
        return handle(command, data);
    };
    p.act('apply').click();
    await p.clock.until(() => p.act('cancel') && p.window.ModelsView._state('xml1').job.id, 5000, 'the page Cancel');
    p.act('cancel').click();
    await p.clock.until(() => p.backend.cancels.length === 1, 5000, 'models-cancel');
    await p.clock.advance(0);
    assert.match(p.text(p.dl('.download-row.tracked .download-progress-message')), /Cancelling…/);
    assert.ok(p.dl('.download-row.tracked').className.includes('cancelling'));
    assert.equal(p.dl('.download-row.tracked .download-row-cancel').disabled, true);
    p.backend.jobs[p.backend.cancels[0]].cancelled = true; // the tool has stopped
    await p.settle();
    assert.equal(p.dl('.downloads-recent .download-row.finished').dataset.outcome, 'cancelled');
});

test('downloads: a failed Apply is in Recent as Failed with the reason in plain words', async () => {
    const p = await open();
    p.backend.buildScript = () => ({ lines: [ev('plan', { mode: 'community', rows: [] }), ev('error', { message: "could not fetch 05XX_Classic.rar: author: HTTP 403", code: 20 })], exit: 20 });
    p.act('apply').click();
    await p.settle();
    const recent = p.dl('.downloads-recent .download-row.finished');
    assert.equal(recent.dataset.outcome, 'failed');
    assert.match(p.text(recent), /Failed/);
    assert.match(p.text(recent), /A community skin could not be downloaded or did not match its checksum\. could not fetch 05XX_Classic\.rar: author: HTTP 403/);
});

test('downloads: Rebuild and Remove are entries of their own; Recent is newest first, and Clear empties it', async () => {
    const p = await open({ verifyOk: true, installed: [{ folder: 'Community-Beast', group: 'Models-Community', mode: 'community', listed: true, enabled: true, credits: true, characters: [{ hero: 'beast', tier: 'community', source: 'Classic' }] }] });
    p.window.showMessageBox = async () => 1;
    p.backend.chunk = 1;
    p.backend.hold = true;
    // verify says stale: Rebuild
    p.window.ModelsView._state('xml1').verify = { ok: true, stale: true, stale_folders: ['Community-Beast'], port_changed: [], port_build_unknown: [], group: 'Models-Community' };
    p.window.ModelsView.render('xml1');
    await p.clock.advance(0);
    p.act('rebuild').click();
    await p.clock.until(() => p.dl('.download-row.tracked'), 5000, 'the Rebuild entry');
    assert.match(p.text(p.dl('.download-row.tracked .download-row-title')), /Character models: Rebuild \(Community pack\)/);
    p.backend.hold = false;
    await p.settle();

    // the remove waits (its tool still running) until the entry is checked
    let holdRemove = true;
    const handle = p.backend.handle.bind(p.backend);
    p.backend.handle = (command, data) => {
        const job = command === 'get-models-job' && p.backend.jobs[data.id];
        if (holdRemove && job && job.command === 'remove') {
            return { id: data.id, command: 'remove', active: true, finished: false, cancelRequested: false, exitCode: -1, exitName: '', seconds: 1,
                first: data.from || 0, total: job.lines.length, startError: '', lines: [], stderrTail: [] };
        }
        return handle(command, data);
    };
    p.act('remove').click();
    await p.clock.until(() => p.dl('.download-row.tracked'), 5000, 'the Remove entry');
    assert.match(p.text(p.dl('.download-row.tracked .download-row-title')), /Character models: Remove/);
    assert.match(p.text(p.dl('.download-row.tracked .download-progress-message')), /Removing Models-Community/);
    assert.equal(p.dl('.download-row.tracked .download-row-cancel'), null, 'a remove is not cancelled half way');
    holdRemove = false;
    await p.settle();
    const rows = p.dls('.downloads-recent .download-row.finished');
    assert.equal(rows.length, 2);
    assert.match(p.text(rows[0]), /Character models: Remove.*Finished.*Removed\. The heroes have their original models/, 'newest first');
    assert.match(p.text(rows[1]), /Character models: Rebuild/);
    p.dl('.downloads-clear').click();
    await p.clock.advance(0);
    assert.equal(p.dl('.downloads-recent'), null, 'cleared');
    assert.match(p.text(p.dl('.downloads-empty')), /No downloads in progress/);
});

test("downloads: the tool's install is an entry with its file, bytes and channel; Cancel from the entry stops it", async () => {
    const p = await open({ tool: false, noRefresh: true }, { tool: true });
    p.backend.releaseScript = install => install
        ? [{ checking: false, installing: true, done: 0, total: 61371081, latest: '0.3.0-beta.1', latestZip: 'legends-models-0.3.0-beta.1-win64.zip', latestSha256: 'd'.repeat(64), channel: 'beta' },
            { done: 12000000 }, { done: 24000000 }, { done: 30000000 }, { done: 36000000 }, { done: 42000000 }]
        : [{ checking: false, latest: '0.3.0-beta.1', latestSize: 61371081, latestZip: 'legends-models-0.3.0-beta.1-win64.zip', channel: 'beta' }];
    p.window.ModelsView.refresh('xml1');
    await p.clock.until(() => p.act('tool-install'), 5000, 'Install');
    p.act('tool-install').click();
    await p.clock.until(() => p.dl('.download-row.tracked') && /11\.4\d? MB/.test(p.text(p.dl('.download-progress-stats'))), 5000, 'the install entry with its bytes');
    const row = p.dl('.download-row.tracked');
    assert.match(p.text(row.querySelector('.download-row-title')), /Character-model tool: install legends-models 0\.3\.0-beta\.1/);
    assert.match(p.text(row.querySelector('.download-progress-message')), /Downloading legends-models-0\.3\.0-beta\.1-win64\.zip/);
    assert.match(p.text(row.querySelector('.download-progress-stats')), / \/ 58\.5\d? MB/);
    assert.match(p.text(row.querySelector('.download-item')), /from GitHub \(Beta update channel\)/);
    assert.ok(p.document.querySelector('#xml1-models-panel [data-act="tool-cancel"]'), 'the page has Cancel too');
    row.querySelector('.download-row-cancel').click();
    await p.clock.until(() => p.backend.toolCancels === 1, 5000, 'models-tool-cancel');
    await p.settle();
    const recent = p.dl('.downloads-recent .download-row.finished');
    assert.equal(recent.dataset.outcome, 'cancelled');
    assert.match(p.text(recent), /The tool’s install was cancelled; nothing was changed/);
    assert.ok(p.act('tool-install'), 'Install is offered again');
    assert.match(p.text(p.document.querySelector('#xml1-models-panel .ul-models-tool-error')), /cancelled/);
});

test("downloads: a finished tool install is in Recent with the zip's SHA-256", async () => {
    const p = await open({ tool: false, noRefresh: true }, { tool: true });
    p.backend.releaseScript = install => install
        ? [{ checking: false, installing: true, done: 0, total: 61371081, latest: '0.3.0-beta.1', latestZip: 'legends-models-0.3.0-beta.1-win64.zip', latestSha256: 'd'.repeat(64), channel: 'beta' },
            { done: 61371081 },
            b => { b.tool = true; b.toolVersion = '0.3.0-beta.1'; b.toolDev = false; Object.assign(b.release, { installing: false, installedNow: '0.3.0-beta.1', source: 'download' }); }]
        : [{ checking: false, latest: '0.3.0-beta.1', latestSize: 61371081, channel: 'beta' }];
    p.window.ModelsView.refresh('xml1');
    await p.clock.until(() => p.act('tool-install'), 5000, 'Install');
    p.act('tool-install').click();
    await p.clock.until(() => p.dl('.download-row.tracked'), 5000, 'the entry');
    await p.clock.until(() => p.dl('.downloads-recent .download-row.finished'), 10000, 'Recent');
    const recent = p.dl('.downloads-recent .download-row.finished');
    assert.equal(recent.dataset.outcome, 'done');
    assert.match(p.text(recent), /legends-models 0\.3\.0-beta\.1 is installed/);
    assert.match(p.text(recent), /legends-models-0\.3\.0-beta\.1-win64\.zip.*SHA-256 dddddddddddddddd…/);
    await p.settle();
});

test('downloads: patch work and tracked work share the order (running by start, then queued) and Recent', async () => {
    const p = await open();
    const queue = p.window.DownloadQueueManager;
    let finishPatch;
    const patch = queue.enqueue({ gameId: 'xml2', op: 'verify', blocksGameButtons: true, runFn: () => new Promise(resolve => { finishPatch = resolve; }) });
    await p.clock.advance(0);
    p.backend.buildScript = steppedBuild;
    p.backend.chunk = 1;
    p.backend.hold = true;
    p.act('apply').click();
    await p.clock.until(() => p.dl('.download-row.tracked'), 5000, 'the Apply entry');
    let failQueued;
    const queued = queue.enqueue({ gameId: 'mua', op: 'install', blocksGameButtons: true, runFn: () => new Promise((resolve, reject) => { failQueued = reject; }) });
    await p.clock.advance(0);
    const kinds = [...p.dls('.download-row')].filter(row => !row.closest('.downloads-recent')).map(row => `${row.dataset.kind}:${row.dataset.game}`);
    assert.deepEqual(kinds, ['patch:xml2', 'tracked:xml1', 'patch:mua'], 'the running patch, the Apply started after it, the queued install');
    assert.equal(p.badge().textContent, '3');
    finishPatch();
    await patch;
    await p.clock.until(() => !!failQueued, 5000, 'the queued install starts');
    failQueued(new Error('HTTP 404'));
    await queued.catch(() => {});
    p.backend.hold = false;
    await p.settle();
    const recent = [...p.dls('.downloads-recent .download-row.finished')].map(row => `${row.dataset.outcome}:${row.dataset.game}`);
    assert.deepEqual(recent, ['partial:xml1', 'failed:mua', 'done:xml2'], 'newest first, patch and models alike');
    assert.match(p.text(p.dls('.downloads-recent .download-row.finished')[1]), /Patch install.*Failed.*HTTP 404/);
    assert.match(p.text(p.dls('.downloads-recent .download-row.finished')[2]), /Verify \/ update.*Finished/);
});

test('downloads: a queued patch item cancelled from its row is in Recent as Cancelled', async () => {
    const p = await open();
    const queue = p.window.DownloadQueueManager;
    let finish;
    queue.enqueue({ gameId: 'xml2', op: 'verify', blocksGameButtons: true, runFn: () => new Promise(resolve => { finish = resolve; }) });
    queue.enqueue({ gameId: 'mua', op: 'install', blocksGameButtons: true, runFn: () => Promise.resolve() });
    await p.clock.advance(0);
    p.dl('.download-row.queued .download-row-cancel').click();
    await p.clock.advance(0);
    const row = p.dl('.downloads-recent .download-row.finished');
    assert.equal(row.dataset.outcome, 'cancelled');
    assert.equal(row.dataset.game, 'mua');
    finish();
    await p.clock.advance(0);
});

test('downloads: an install that begins and ends between two polls (a zip already here) is in Recent all the same', async () => {
    const p = await open({ tool: false, noRefresh: true }, { tool: true });
    p.backend.releaseScript = install => install
        ? [b => { b.tool = true; b.toolVersion = '0.3.0'; b.toolDev = false;
            Object.assign(b.release, { checking: false, installing: false, latest: '0.3.0', latestZip: 'legends-models-0.3.0-win64.zip', latestSha256: 'e'.repeat(64),
                installedNow: '0.3.0', source: 'zip', channel: 'stable' }); }]
        : [{ checking: false, latest: '0.3.0', latestSize: 61371081, channel: 'stable' }];
    p.window.ModelsView.refresh('xml1');
    await p.clock.until(() => p.act('tool-install'), 5000, 'Install');
    p.act('tool-install').click();
    await p.clock.until(() => p.dl('.downloads-recent .download-row.finished'), 10000, 'Recent');
    const recent = p.dl('.downloads-recent .download-row.finished');
    assert.equal(recent.dataset.outcome, 'done');
    assert.match(p.text(recent), /install legends-models 0\.3\.0.*legends-models 0\.3\.0 is installed.*from the zip already on this PC.*SHA-256 eeeeeeeeeeeeeeee/);
    await p.settle();
});
