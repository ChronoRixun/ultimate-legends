'use strict';
// X-Men Legends: a build never starts while patch work (an XML2 Fix install, Verify Files, the
// update before a build) is alive in its folder - however that work's progress bar ended (review
// of the 0.3.1 fixes: B1 a duplicate request, B2 a cancel, B3 Verify on an unfinished build) - and
// it still starts after an update that failed or was skipped. The real xml1-port.js, xml1-view.js,
// download queue (main.js) and trackCommandProgress (utils.js) run against a fake backend.

const assert = require('node:assert/strict');
const { page, test } = require('./harness');

const PORT = 'D:\\Games\\X-Men Legends (Port)';
const key = folder => String(folder).toLowerCase().replace(/[\\/]+$/, '');

// The launcher's backend as far as a build's start goes: one patch worker per command (verify-game,
// xml1-update-fix), alive until the test lets it end; the progress tracker; start_build's refusal
// while a worker is alive in the folder (the C++ guard, mirrored so a test sees what it would say).
class Backend {
    constructor(clock, { state = 'ready', fix = true, autoFinish = {} } = {}) {
        this.clock = clock;
        this.state = state;
        this.fix = fix;              // dinput.dll in the port's folder
        this.fixCurrent = false;     // ... and it is the release's
        this.autoFinish = autoFinish; // kind -> ms after which a worker of that kind ends on its own
        this.workers = [];
        this.log = [];
        this.progress = { active: false, cancelled: false };
        this.build = null;
    }

    alive(folder) {
        return this.workers.filter(worker => !worker.done && (!folder || key(worker.folder) === key(folder)));
    }

    // A worker in `folder`: `finish(ok)` ends it (ok: the fix is the release's afterwards).
    startWorker(kind, folder) {
        const worker = { kind, folder, done: false, startedAt: this.clock.now };
        worker.finish = (ok = true) => {
            if (worker.done) return;
            worker.done = true;
            worker.endedAt = this.clock.now;
            if (ok && !this.progress.cancelled) {
                this.fix = true;
                this.fixCurrent = true;
            }
            this.progress.active = false;
        };
        this.workers.push(worker);
        this.progress = { active: true, cancelled: false };
        if (this.autoFinish[kind] !== undefined) this.clock.setTimeout(() => worker.finish(true), this.autoFinish[kind]);
        return worker;
    }

    status() {
        const building = !!(this.build && this.build.active);
        return {
            install: PORT, iso: 'D:\\Discs\\xml1.iso', isoExists: true, cacheHasDisc: true, movies: true, keepCache: true, linkBase: false,
            exists: true, isInstalled: this.state === 'ready', state: building ? 'building' : this.state,
            xml2: { setUp: true, path: 'D:\\Games\\X-Men Legends II' },
            build: { stamp: this.state !== 'incomplete', building: this.state === 'incomplete', game: true, contentVersion: 19 },
            fix: { installed: this.fix, version: this.fix ? (this.fixCurrent ? '1.5.0.0' : '1.4.0.0') : '', required: '', ok: true },
            builder: { installed: true, version: '0.2.2', checking: false, installing: false, contentVersion: 19, latest: null, updateAvailable: false },
            work: building ? { id: this.build.id, command: 'build', active: true, exitCode: -1 } : null
        };
    }

    handle(command, data) {
        this.log.push({ at: this.clock.now, command, data });
        switch (command) {
            case 'get-xml1-status':
                return this.status();
            case 'xml1-builder-check':
                return true;
            case 'xml1-folder':
                return { exists: true, empty: false, builder: true, launcherOnly: false, fix: this.fix, updating: this.alive(data.path).length > 0 };
            case 'verify-game':
                if (this.build && this.build.active) return null; // begin_patch_work: never during a build
                this.startWorker('verify-game', PORT);
                return null;
            case 'xml1-update-fix':
                if (this.offline) return { started: false, code: 'L_OFFLINE' };
                if (!this.fix) return { started: false, code: 'L_NO_FIX' };
                if (this.alive(data.out).length) return { started: false, code: 'L_FIX_UPDATING' };
                this.startWorker('xml1-update-fix', data.out);
                return { started: true };
            case 'get-update-progress':
                return { active: this.progress.active, progress: 40, message: 'Checking the XML2 Fix', mode: 'verifying', paused: false };
            case 'cancel-update':
                this.progress.cancelled = true; // a worker stuck fetching the manifest doesn't see it
                return true;
            case 'xml1-build-start':
                if (this.alive(data.out).length) return { success: false, code: 'L_FIX_UPDATING', error: 'The XML2 Fix is being installed or updated in this folder.' };
                this.build = { id: 7, active: true, at: this.clock.now, alive: this.alive().length, fixCurrent: this.fixCurrent };
                return { success: true, id: 7 };
            case 'get-xml1-build':
            case 'get-xml1-job':
                return this.build ? { id: 7, command: 'build', active: true, finished: false, stages: [], overall: 1, notices: [], errors: [], logTail: [] } : null;
            default:
                return null;
        }
    }

    calls(command) {
        return this.log.filter(entry => entry.command === command);
    }
}

async function open(options) {
    let backend;
    const p = page({
        scripts: ['core/utils.js', 'core/i18n.js', 'app/xml1-port.js', 'app/xml1-view.js', 'app/main.js'],
        body: '<div id="xml1-build-panel"></div>',
        backend: { handle: (command, data) => backend.handle(command, data) },
        offline: !!(options && options.offline)
    });
    backend = new Backend(p.clock, options);
    backend.offline = !!(options && options.offline);
    const port = p.window.Xml1Port;
    p.errors = () => p.logs.filter(entry => entry[0] === 'error');
    await port.refresh();
    p.window.Xml1View.render('xml1');
    const button = act => p.document.querySelector(`#xml1-build-panel [data-act="${act}"]`);
    return { ...p, backend, port, button };
}

test('B1: Rebuild is disabled while an XML2 Fix install runs', async () => {
    const { clock, backend, port, button } = await open({ state: 'needs-fix', fix: true });
    assert.equal(button('rebuild').disabled, false, 'Rebuild offered before the install');
    port.installFix(); // Install the XML2 Fix: verify-game, op install
    await clock.until(() => backend.alive().length === 1, 2000, 'the install worker');
    assert.equal(button('rebuild').disabled, true, 'Rebuild disabled while the install runs');
    assert.equal(button('install-fix').disabled, true, 'and Install too');
    backend.alive()[0].finish(true);
    await clock.until(() => !button('rebuild').disabled, 5000, 'Rebuild offered again after the install');
});

test('B1: a Rebuild during an XML2 Fix install waits for that install, then updates and builds', async () => {
    const { clock, backend, port } = await open({ state: 'needs-fix', fix: true, autoFinish: { 'xml1-update-fix': 300 } });
    port.installFix();
    await clock.until(() => backend.alive().length === 1, 2000, 'the install worker');
    const install = backend.alive()[0];

    port.resume(); // a click that got through anyway (the library card, a deep link)
    await clock.advance(10000);
    assert.equal(backend.calls('xml1-build-start').length, 0, 'no build while the install is fetching');

    install.finish(true);
    await clock.until(() => backend.calls('xml1-build-start').length === 1, 10000, 'the build');
    const update = backend.calls('xml1-update-fix');
    assert.equal(update.length, 1, 'the update before the build ran (not dropped as a duplicate of the install)');
    assert.ok(update[0].at >= install.endedAt, 'after the install ended');
    assert.equal(backend.build.alive, 0, 'no updater alive when the builder starts');
    assert.ok(backend.build.at >= backend.workers[1].endedAt, 'the builder starts after the update ended');
});

test('B2: a cancelled update that is still fetching holds the build until its worker ends', async () => {
    const { window, clock, backend, port } = await open({ state: 'ready', fix: true });

    port.resume(); // Rebuild
    await clock.until(() => backend.alive().length === 1, 5000, 'the update worker');
    const update = backend.alive()[0];
    assert.equal(update.kind, 'xml1-update-fix');

    window.DownloadQueueManager.cancel('xml1', 'install'); // the progress bar's cancel
    await clock.advance(6000);
    assert.ok(backend.calls('cancel-update').length >= 1, 'cancel sent');
    assert.equal(window.DownloadQueueManager.active, null, 'the queue moved on after its 5 s wait');
    assert.equal(backend.calls('xml1-build-start').length, 0, 'but no build while the worker still fetches');

    await clock.advance(30000);
    assert.equal(backend.calls('xml1-build-start').length, 0, 'not after 36 s either');

    update.finish(false); // the manifest fetch finally gave up: the old fix stays
    await clock.until(() => backend.calls('xml1-build-start').length === 1, 5000, 'the build after the worker ended');
    assert.equal(backend.build.alive, 0, 'no updater alive when the builder starts');
    assert.ok(backend.build.at >= update.endedAt);
    assert.equal(backend.build.fixCurrent, false, 'built with the old fix: the builder warns (W_XML2FIX_OLD)');
});

test('B3: Resume is disabled while Verify Files runs on an unfinished build', async () => {
    const { clock, backend, port, button } = await open({ state: 'incomplete', fix: false });
    assert.ok(button('verify-files'), 'Verify Files offered for the unfinished build');
    assert.equal(button('resume').disabled, false);
    port.installFix('verify'); // Verify Files: verify-game, op verify
    await clock.until(() => backend.alive().length === 1, 2000, 'the Verify worker');
    assert.equal(button('resume').disabled, true, 'Resume disabled while Verify runs');
    assert.equal(button('verify-files').disabled, true);
});

test('B3: a Resume during Verify Files on an unfinished build without the fix waits for it', async () => {
    const { clock, backend, port } = await open({ state: 'incomplete', fix: false, autoFinish: { 'xml1-update-fix': 200 } });
    port.installFix('verify');
    await clock.until(() => backend.alive().length === 1, 2000, 'the Verify worker');
    const verify = backend.alive()[0];

    port.resume(); // a Resume that got through anyway
    await clock.advance(10000);
    assert.equal(backend.calls('xml1-build-start').length, 0, 'no build while Verify downloads the fix');

    verify.finish(true); // the DLL is there now
    await clock.until(() => backend.calls('xml1-build-start').length === 1, 10000, 'the resumed build');
    assert.equal(backend.build.alive, 0, 'no updater alive when the builder starts');
    assert.ok(backend.build.at >= verify.endedAt);
    assert.equal(backend.build.fixCurrent, true, 'the builder meets the fix Verify installed');
});

test('a failed update still builds, once its worker has ended', async () => {
    const { clock, backend, port } = await open({ state: 'ready', fix: true });
    port.resume();
    await clock.until(() => backend.alive().length === 1, 5000, 'the update worker');
    const update = backend.alive()[0];
    await clock.advance(3000);
    update.finish(false); // the release could not be reached
    await clock.until(() => backend.calls('xml1-build-start').length === 1, 5000, 'the build');
    assert.equal(backend.build.fixCurrent, false);
    assert.equal(backend.build.alive, 0);
});

test('offline: no update, the build starts with the fix in the folder', async () => {
    const { clock, backend, port } = await open({ state: 'ready', fix: true, offline: true });
    port.resume();
    await clock.until(() => backend.calls('xml1-build-start').length === 1, 5000, 'the build');
    assert.equal(backend.workers.length, 0, 'no updater started');
    assert.equal(backend.calls('xml1-update-fix').length, 1, 'the backend was told (it logs the skipped update)');
});

test('no fix in the folder: no update, the build starts at once', async () => {
    const { clock, backend, port } = await open({ state: 'incomplete', fix: false });
    port.resume();
    await clock.until(() => backend.calls('xml1-build-start').length === 1, 5000, 'the build');
    assert.equal(backend.calls('xml1-update-fix').length, 0);
    assert.equal(backend.workers.length, 0);
});

test('one start at a time: a second Rebuild gets the first one\'s answer', async () => {
    const { clock, backend, port } = await open({ state: 'ready', fix: true, autoFinish: { 'xml1-update-fix': 500 } });
    const first = port.startBuild({ out: PORT });
    const second = port.startBuild({ out: PORT });
    assert.equal(first, second);
    assert.equal(port.buildBlocked(), true, 'the build buttons wait while it starts');
    await clock.until(() => backend.calls('xml1-build-start').length === 1, 10000, 'the build');
    await clock.advance(2000);
    assert.equal(backend.calls('xml1-build-start').length, 1);
    assert.equal(backend.calls('xml1-update-fix').length, 1);
});
