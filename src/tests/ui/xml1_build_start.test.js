'use strict';
// X-Men Legends: a build never starts while patch work (an XML2 Fix install, Verify Files, the
// update before a build) is alive in its folder - however that work's progress bar ended (review
// of the 0.3.1 fixes: B1 a duplicate request, B2 a cancel, B3 Verify on an unfinished build) - and
// it still starts after an update that failed or was skipped; Uninstall waits for that work too
// (R1); and no patch work starts in a folder the builder holds, whatever the game entry (R2). The
// real xml1-port.js, xml1-view.js, download queue and verifyGame (main.js) and trackCommandProgress
// (utils.js) run against a fake backend.

const assert = require('node:assert/strict');
const { page, test } = require('./harness');

const PORT = 'D:\\Games\\X-Men Legends (Port)';
const XML2 = 'D:\\Games\\X-Men Legends II';
const key = folder => String(folder).toLowerCase().replace(/[\\/]+$/, '');

// The launcher's backend as far as these tests go, with its C++ rules mirrored so a test sees what
// the launcher would do: updater::folder_work's holds by folder (patch work alongside patch work, the
// builder alone; src/tests/folder_work_tests.cpp tests the real ones), taken by every updater
// admission whatever the entry (verify-game, delete-game, xml1-update-fix) and by start_build and an
// output-folder clean for the builder; one patch worker per command, alive until the test lets it
// end (or `autoFinish` does); the shared progress tracker.
class Backend {
    constructor(clock, { state = 'ready', fix = true, autoFinish = {}, installs = {} } = {}) {
        this.clock = clock;
        this.state = state;
        this.fix = fix;              // dinput.dll in the port's folder
        this.fixCurrent = false;     // ... and it is the release's
        this.autoFinish = autoFinish; // kind -> ms after which a worker of that kind ends on its own
        this.installs = Object.assign({ xml1: PORT, xml2: XML2 }, installs);
        this.holds = new Map();      // folder key -> { patch, builder }
        this.workers = [];
        this.refused = [];           // patch work the folder holds turned away: { kind, game, folder }
        this.cleans = [];
        this.log = [];
        this.progress = { active: false, cancelled: false };
        this.build = null;
    }

    // updater::reserve: a release function, or null when the folder can't be held for `use` now.
    reserve(folder, use) {
        const held = this.holds.get(key(folder)) || { patch: 0, builder: 0 };
        if (held.builder > 0 || (use === 'builder' && held.patch > 0)) return null;
        held[use]++;
        this.holds.set(key(folder), held);
        let released = false;
        return () => {
            if (!released) held[use]--;
            released = true;
        };
    }

    patching(folder) {
        const held = this.holds.get(key(folder));
        return !!(held && held.patch > 0);
    }

    alive(folder) {
        return this.workers.filter(worker => !worker.done && (!folder || key(worker.folder) === key(folder)));
    }

    // A patch worker in `folder`, holding it: `finish(ok)` ends it (ok: it did its job).
    startWorker(kind, folder, release) {
        const worker = { kind, folder, done: false, startedAt: this.clock.now };
        worker.finish = (ok = true) => {
            if (worker.done) return;
            worker.done = true;
            worker.endedAt = this.clock.now;
            release();
            if (ok && !this.progress.cancelled && key(folder) === key(PORT)) {
                this.fix = kind !== 'delete-game';
                this.fixCurrent = this.fix;
            }
            this.progress.active = false;
        };
        this.workers.push(worker);
        this.progress = { active: true, cancelled: false };
        if (this.autoFinish[kind] !== undefined) this.clock.setTimeout(() => worker.finish(true), this.autoFinish[kind]);
        return worker;
    }

    // verify-game / delete-game: begin_patch_work, by folder whatever the entry.
    patchCommand(kind, game) {
        const folder = this.installs[game];
        const release = this.reserve(folder, 'patch');
        if (!release) {
            this.refused.push({ kind, game, folder });
            return null;
        }
        this.startWorker(kind, folder, release);
        return null;
    }

    status() {
        const building = !!(this.build && this.build.active);
        return {
            install: PORT, iso: 'D:\\Discs\\xml1.iso', isoExists: true, cacheHasDisc: true, movies: true, keepCache: true, linkBase: false,
            exists: true, isInstalled: this.state === 'ready', state: building ? 'building' : this.state,
            xml2: { setUp: true, path: XML2 },
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
                return { exists: true, empty: false, builder: true, launcherOnly: false, fix: this.fix, updating: this.patching(data.path) };
            case 'verify-game':
                return this.patchCommand('verify-game', data.game);
            case 'delete-game':
                return this.patchCommand('delete-game', data.game);
            case 'xml1-update-fix': {
                if (this.offline) return { started: false, code: 'L_OFFLINE' };
                if (!this.fix) return { started: false, code: 'L_NO_FIX' };
                if (this.patching(data.out)) return { started: false, code: 'L_FIX_UPDATING' };
                const release = this.reserve(data.out, 'patch');
                if (!release) return { started: false, code: 'L_BUILD_RUNNING' };
                this.startWorker('xml1-update-fix', data.out, release);
                return { started: true };
            }
            case 'get-update-progress':
                return { active: this.progress.active, progress: 40, message: 'Checking the XML2 Fix', mode: 'verifying', paused: false };
            case 'cancel-update':
                this.progress.cancelled = true; // a worker stuck fetching the manifest doesn't see it
                return true;
            case 'xml1-build-start': {
                if (this.build && this.build.active) return { success: false, code: 'L_BUILD_RUNNING', error: 'A build is already running.' };
                const release = this.reserve(data.out, 'builder');
                if (!release) return { success: false, code: 'L_FIX_UPDATING', error: 'The XML2 Fix is being installed or updated in this folder.' };
                this.build = { id: 7, active: true, at: this.clock.now, alive: this.alive().length, fixCurrent: this.fixCurrent, release };
                return { success: true, id: 7 };
            }
            case 'xml1-clean': {
                const release = this.reserve(PORT, 'builder'); // start_clean: the output folder, the builder's alone
                if (!release) return { success: false, code: 'L_FIX_UPDATING', error: 'The XML2 Fix is being installed or updated in this folder.' };
                this.cleans.push({ at: this.clock.now, alive: this.alive(PORT).length });
                release(); // (the clean is over at once here)
                return { success: true, id: 9 };
            }
            case 'xml1-free-cache':
                return { success: true, id: 10 };
            case 'get-xml1-build':
                return this.build ? { id: 7, command: 'build', active: true, finished: false, stages: [], overall: 1, notices: [], errors: [], logTail: [] } : null;
            case 'get-xml1-job':
                if (data.id === 9 || data.id === 10) return { id: data.id, command: 'clean', active: false, finished: true, exitCode: 0, stages: [], notices: [], errors: [], logTail: [] };
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

test('R1: Uninstall after a cancelled Verify waits for its worker before the clean', async () => {
    const { window, clock, backend, port } = await open({ state: 'incomplete', fix: false, autoFinish: { 'delete-game': 300 } });
    port.installFix('verify'); // Verify Files on the unfinished build
    await clock.until(() => backend.alive().length === 1, 2000, 'the Verify worker');
    const verify = backend.alive()[0];
    window.DownloadQueueManager.cancel('xml1', 'verify'); // the progress bar's cancel; the manifest fetch stalls
    await clock.advance(6000);
    assert.equal(window.DownloadQueueManager.active, null, 'the queue moved on after its 5 s wait');

    let done = false;
    port.uninstall({ deleteGame: true, mods: false, cache: false }).then(() => { done = true; });
    await clock.advance(10000);
    assert.equal(backend.calls('xml1-clean').length, 0, 'no clean while the cancelled Verify still fetches');
    assert.equal(backend.calls('delete-game').length, 0, 'nor the patch removal');

    verify.finish(false);
    await clock.until(() => done, 20000, 'the uninstall');
    const clean = backend.calls('xml1-clean')[0];
    const removal = backend.calls('delete-game')[0];
    assert.ok(clean && clean.at >= verify.endedAt, 'the clean after the Verify worker ended');
    assert.equal(backend.cleans[0].alive, 0, 'no updater alive in the folder when the clean starts');
    assert.ok(removal && removal.at >= clean.at, 'then the patch removal');
    assert.ok(backend.workers.find(worker => worker.kind === 'delete-game').done, 'Uninstall resolves after the removal\'s worker ended');
});

test('R1: Uninstall with nothing running cleans and removes the patch straight away', async () => {
    const { clock, backend, port } = await open({ state: 'ready', fix: true, autoFinish: { 'delete-game': 300 } });
    let done = false;
    port.uninstall({ deleteGame: true, mods: false, cache: false }).then(() => { done = true; });
    await clock.until(() => done, 10000, 'the uninstall');
    assert.equal(backend.calls('xml1-clean').length, 1);
    assert.equal(backend.calls('delete-game').length, 1);
    assert.equal(backend.fix, false, 'the patch removed');
});

test('R2: Verify Files for an X-Men Legends II entry in the port\'s folder starts nothing during a build', async () => {
    const { window, clock, backend, port } = await open({ state: 'ready', fix: false, installs: { xml2: PORT } });
    port.startBuild({ out: PORT });
    await clock.until(() => backend.build && backend.build.active, 5000, 'the build');
    window.verifyGame('xml2'); // the X-Men Legends II page's Verify Files (its buttons go by game id)
    await clock.advance(3000);
    assert.equal(backend.calls('verify-game').length, 1, 'the request reached the backend');
    assert.equal(backend.alive(PORT).length, 0, 'no updater in the folder the builder holds');
    assert.deepEqual(backend.refused.map(r => [r.kind, r.game]), [['verify-game', 'xml2']]);
});

test('R2: separate installs are not held by a port build', async () => {
    const { window, clock, backend, port } = await open({ state: 'ready', fix: false, autoFinish: { 'verify-game': 300 } });
    port.startBuild({ out: PORT });
    await clock.until(() => backend.build && backend.build.active, 5000, 'the build');
    window.verifyGame('xml2'); // X-Men Legends II in its own folder: as before
    await clock.until(() => backend.workers.some(worker => worker.kind === 'verify-game' && worker.done), 5000, 'its Verify');
    assert.equal(backend.refused.length, 0);
    assert.equal(key(backend.workers[0].folder), key(XML2));
});
