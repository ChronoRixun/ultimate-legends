// X-Men Legends (community port): the page's state, the builder's runs and the build's progress.
// The launcher's backend (xml1/xml1_port.cpp) installs and runs xml1-builder; this keeps what the
// page, the library cards and the setup wizard (xml1-setup.js, xml1-view.js) show in one place and
// tells them when it changes ('ul-xml1-changed').
//
// States of the entry (BUILDER_DESIGN.md 2.7 / 4.3): not-setup, absent (the folder is gone),
// incomplete (Resume build), building, needs-fix (built, XML2 Fix missing), stale (update
// available), damaged (a verify found missing or changed files), ready.
(function () {
    'use strict';

    const GAME = 'xml1';
    const REPORT_URL = 'https://github.com/ChronoRixun/legends-classic/issues/new';
    const DUMPING_URL = 'https://github.com/ChronoRixun/legends-classic/blob/main/docs/DUMPING.md';

    function t(key, variables) {
        return window.LauncherI18n ? window.LauncherI18n.t(key, variables) : key;
    }

    function has(key) {
        return t(key) !== key;
    }

    function run(command, payload) {
        return window.executeCommand(command, payload);
    }

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    // The builder's release is checked again while the launcher stays open (a release published after
    // startup used to go unseen until a restart: a Rebuild then ran the old builder): on a timer, when
    // the window comes back into view, when the port's page opens, and always right before a build.
    const RECHECK_MS = 30 * 60 * 1000;
    const DUE_MS = 5 * 60 * 1000;

    // Profile paths never leave the PC in copied details or reports (the builder masks its own the
    // same way). JSON text escapes backslashes, so "C:\\Users\\name" is masked too.
    function maskPaths(text) {
        return String(text || '').replace(/([A-Za-z]:(?:\\\\|[\\/])+Users(?:\\\\|[\\/])+)[^\\/\r\n"]+/g, '%USERPROFILE%');
    }

    // Warnings (W_*) a player should hear about after a build or a disc check. W_PIPELINE (the
    // pipeline's own notes, counted per stage) stays in the log and report.json.
    const NOTICES = ['W_XML2_UNKNOWN_EXE', 'W_XML2_MODIFIED', 'W_EXTRA_FILES', 'W_LINK_BASE', 'W_ISO_UNKNOWN_DUMP'];
    // The verification groups that make a build "damaged" (the builder's REPAIRS).
    const REPAIRS = ['missing', 'changed', 'unreadable'];

    const Xml1Port = {
        status: null,
        lastCheck: 0,
        info: null,      // the builder's `info` about the build in its folder (result.info)
        verify: null,    // the last `verify` (result.verify)
        build: null,     // the last build/clean run (get-xml1-build)
        finishing: false, // installing the XML2 Fix after a build
        buildTimer: null,
        watched: new Set(), // build ids seen running in this session
        handled: new Set(),

        REPORT_URL,
        DUMPING_URL,
        REPAIRS,
        maskPaths,

        emit() {
            window.dispatchEvent(new CustomEvent('ul-xml1-changed'));
        },

        async init() {
            this.cancelFromBar = () => this.confirmCancel();
            try {
                const version = await run('get-version');
                this.launcherVersion = version && version.version;
            } catch (_) { /* only for reports */ }
            try {
                await this.refresh();
            } catch (error) {
                console.error('xml1: status failed', error);
                return;
            }
            // A new builder installs quietly once the port is set up (never a rebuild: that is the
            // player's call, section 4.5).
            if (this.status && this.status.install && !window.IS_OFFLINE) {
                this.checkBuilder(true);
            }
            setInterval(() => this.checkBuilderIfDue(RECHECK_MS), RECHECK_MS);
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') this.checkBuilderIfDue(DUE_MS);
            });
        },

        // The release check again, when the last one is older than `maxAge` and nothing is in the
        // way (offline, the port not set up, a build running, a check or install already under way).
        async checkBuilderIfDue(maxAge) {
            const s = this.status;
            const builder = s && s.builder;
            if (!s || !s.install || window.IS_OFFLINE || this.isWorking()) return null;
            if (builder && (builder.checking || builder.installing)) return null;
            if (Date.now() - this.lastCheck < maxAge) return null;
            try {
                return await this.checkBuilder(true);
            } catch (error) {
                console.error('xml1: builder check failed', error);
                return null;
            }
        },

        async refresh() {
            this.status = await run('get-xml1-status');
            const work = this.status && this.status.work;
            if (work && work.active) {
                this.watchBuild();
            }
            this.emit();
            return this.status;
        },

        // Runs a builder command and waits for it: the final snapshot (errors hold a launcher
        // failure, exitCode -1, when it could not start).
        async runJob(command, payload, onUpdate) {
            const started = await run(command, payload || {});
            if (!started || !started.success) {
                return {
                    finished: true, exitCode: -1, result: null, logTail: [], stages: [],
                    errors: [{ code: (started && started.code) || 'L_BUILDER_START', msg: (started && started.error) || '', hint: '', detail: {} }]
                };
            }
            for (;;) {
                const job = await run('get-xml1-job', { id: started.id });
                if (onUpdate && job) onUpdate(job);
                if (!job || job.finished) return job;
                await sleep(250);
            }
        },

        // Checks the builder's release (and installs it when missing or older with `install`);
        // resolves the builder part of the status once that is done.
        async checkBuilder(install, onUpdate) {
            await run('xml1-builder-check', { install: !!install });
            let status;
            do {
                await sleep(250);
                status = await run('get-xml1-status');
                if (onUpdate) onUpdate(status.builder);
            } while (status.builder.checking || status.builder.installing);
            this.lastCheck = Date.now();
            this.status = status;
            this.emit();
            return status.builder;
        },

        // Installs a builder zip the player already has (checked against the release like a
        // download); waits for a check already under way first. The builder's status afterwards.
        async installBuilderZip(path, onUpdate) {
            let started = await run('xml1-builder-install-zip', { path });
            if (!started) {
                let status;
                do {
                    await sleep(250);
                    status = await run('get-xml1-status');
                } while (status.builder.checking || status.builder.installing);
                started = await run('xml1-builder-install-zip', { path });
            }
            let status;
            do {
                await sleep(250);
                status = await run('get-xml1-status');
                if (onUpdate) onUpdate(status.builder);
            } while (status.builder.checking || status.builder.installing);
            this.lastCheck = Date.now();
            this.status = status;
            this.emit();
            return status.builder;
        },

        // The builder's view of the build in the folder: stale, cache size, and so on.
        async refreshInfo() {
            const status = this.status;
            if (!status || !status.install || !status.builder.installed || this.isWorking()) return null;
            const job = await this.runJob('xml1-info', { out: status.install, iso: status.isoExists ? status.iso : '' });
            if (job && job.result && job.result.info) {
                this.info = job.result.info;
                this.emit();
            }
            return this.info;
        },

        async verifyBuild() {
            const job = await this.runJob('xml1-verify');
            this.verify = job && job.result ? job.result.verify : null;
            this.emit();
            return job;
        },

        isWorking() {
            return !!(this.build && this.build.active) || !!(this.status && this.status.work && this.status.work.active);
        },

        isBuilding() {
            if (this.build && this.build.active) return this.build.command === 'build';
            return !!(this.status && this.status.state === 'building');
        },

        buildPercent() {
            return this.build && this.build.active ? Math.max(0, Math.min(100, this.build.overall || 0)) : 0;
        },

        state() {
            const s = this.status;
            if (!s) return 'loading';
            if (this.isBuilding()) return 'building';
            if (this.finishing) return 'finishing';
            if (s.state === 'not-setup' || s.state === 'absent' || s.state === 'incomplete') return s.state;
            if (this.verify && this.verify.state === 'damaged') return 'damaged';
            if (s.state === 'needs-fix') return 'needs-fix';
            if (s.state === 'stale' || (this.info && this.info.out && this.info.out.state === 'stale')) return 'stale';
            return 'ready';
        },

        // The label of the library / home card button while the port isn't playable.
        cardLabel() {
            switch (this.state()) {
                case 'building': return t('xml1.building', { percent: Math.floor(this.buildPercent()) });
                case 'finishing': return t('common.installing');
                case 'incomplete': return t('xml1.resume');
                case 'needs-fix': return t('common.finishSetup');
                case 'absent': return t('xml1.build');
                default: return null;
            }
        },

        // What Set up / the card does for the port in its current state.
        async primaryAction() {
            const state = this.state();
            if (state === 'needs-fix') return this.installFix();
            if (state === 'incomplete' && this.canRebuild()) return this.resume();
            if (window.Xml1Setup) window.Xml1Setup.show();
        },

        // A build into the folder can run now: with the disc image, or - once a build prepared it -
        // with the disc from the build cache (the image may be deleted or unmounted after that).
        canRebuild() {
            const s = this.status;
            return !!(s && s.install && (s.isoExists || s.cacheHasDisc));
        },

        // Files a verification found missing, changed or unreadable (its counts: the reasons and
        // the files listed per group are capped, the counts are not).
        damageCount(verify) {
            const counts = (verify && verify.counts) || {};
            return REPAIRS.reduce((sum, code) => sum + (Number(counts[code]) || 0), 0);
        },

        // The warnings of a run worth showing, translated: [{ code, text, files }]. How many:
        // detail.count (every warning of the builder has it), else the number its message starts with.
        // W_EXTRA_FILES with detail.not_removed: files the rebuild could not delete, and why (cause).
        noticesOf(job) {
            const seen = new Set();
            const notices = job && Array.isArray(job.notices) ? job.notices : [];
            return notices.filter(notice => notice && NOTICES.includes(notice.code) && !seen.has(notice.code) && seen.add(notice.code))
                .map(notice => {
                    const detail = notice.detail && typeof notice.detail === 'object' && !Array.isArray(notice.detail) ? notice.detail : {};
                    const files = Array.isArray(detail.files) ? detail.files.map(String) : [];
                    const kept = Array.isArray(detail.not_removed) ? detail.not_removed.map(String) : [];
                    const msg = typeof notice.msg === 'string' ? notice.msg : '';
                    const count = Number.isInteger(detail.count) && detail.count > 0 ? detail.count
                        : parseInt(msg, 10) || files.length || notice.count || 1;
                    let key = `xml1.warnings.${notice.code}`;
                    if (kept.length && typeof detail.cause === 'string' && has(`${key}_${detail.cause}`)) key = `${key}_${detail.cause}`;
                    const text = has(key) ? t(key, { count, first: kept[0] || files[0] || '' }) : msg;
                    return { code: notice.code, text, files };
                });
        },

        async startBuild(options) {
            const started = await run('xml1-build-start', options);
            if (!started || !started.success) return started;
            this.verify = null;
            this.info = null;
            this.watched.add(started.id);
            this.build = await run('get-xml1-build');
            await this.refresh();
            this.watchBuild();
            return started;
        },

        // A build with the choices of the last one (Resume, Rebuild, Repair, Update). Without the disc
        // image the builder reads the disc from the build cache.
        async resume() {
            let s = this.status || await this.refresh();
            if (!this.canRebuild()) {
                if (window.Xml1Setup) window.Xml1Setup.show();
                return null;
            }
            // The latest builder first: a release published since the last check would otherwise
            // leave this build on the old content version.
            if (!window.IS_OFFLINE && !(s.builder && (s.builder.checking || s.builder.installing))) {
                try {
                    await this.checkBuilder(true);
                } catch (error) {
                    console.error('xml1: builder check before the build failed', error);
                }
                s = this.status || s;
            }
            const iso = s.isoExists ? s.iso : '';
            const started = await this.startBuild({ iso, out: s.install, movies: s.movies, keepCache: s.keepCache, linkBase: s.linkBase });
            if (started && !started.success) this.showStartError(started);
            return started;
        },

        showStartError(started) {
            const error = this.describe({ code: started.code, msg: started.error });
            window.showMessageBox(t('xml1.failedTitle'), this.messageHtml(error), [t('common.ok')]);
        },

        // An error for the message box (which takes HTML).
        messageHtml(error) {
            return [error.title, ...error.facts, error.hint].filter(Boolean).map(GameUtils.escapeHtml).join('<br><br>');
        },

        watchBuild() {
            if (this.buildTimer) return;
            const tick = async () => {
                let job = null;
                try {
                    job = await run('get-xml1-build');
                } catch (error) {
                    console.error('xml1: get-xml1-build failed', error);
                }
                this.build = job;
                if (job && job.active) this.watched.add(job.id);
                this.updateProgressBar(job);
                if (!job || !job.active) {
                    clearInterval(this.buildTimer);
                    this.buildTimer = null;
                    this.releaseProgressBar();
                    await this.onWorkFinished(job);
                }
                this.emit();
            };
            this.buildTimer = setInterval(tick, 500);
            tick();
        },

        async onWorkFinished(job) {
            if (!job || !job.finished || !this.watched.has(job.id) || this.handled.has(job.id)) {
                await this.refresh();
                return;
            }
            this.handled.add(job.id);
            if (job.command === 'build') {
                if (job.exitCode === 0) {
                    window.showToast(t('xml1.buildDone'), 'success');
                    this.finishing = true;
                    this.emit();
                    try {
                        await this.installFix();
                    } finally {
                        this.finishing = false;
                    }
                } else if (job.exitCode === 5) {
                    window.showToast(t('xml1.cancelled'), 'info', 6000);
                } else {
                    window.showToast(t('xml1.buildFailedToast', { error: this.jobError(job).title }), 'error', 8000);
                }
            }
            await this.refresh();
            this.refreshInfo();
        },

        // The XML2 Fix into the built folder, through the launcher's patch install (verify-game);
        // it marks the port installed once the fix is there.
        async installFix() {
            if (!await window.guardOnline()) return false;
            const name = t('xml1.name');
            try {
                await GameUtils.trackCommandProgress({
                    gameId: GAME,
                    command: 'verify-game',
                    op: 'install',
                    commandArgs: { game: GAME },
                    initialMessage: t('progress.installingPatch', { game: name }),
                    completeMessage: t('progress.verificationComplete')
                });
            } catch (error) {
                console.error('xml1: fix install failed', error);
            }
            window.dispatchEvent(new CustomEvent('gameInstallationUpdated', { detail: { game: GAME } }));
            await this.refresh();
            return !!(this.status && this.status.isInstalled);
        },

        progressMessage(job) {
            const stage = (job.stages || []).find(s => s.id === job.stage);
            const title = stage ? stage.title : t('xml1.buildingTitle');
            const count = job.total > 0 ? ` (${job.done}/${job.total}${job.unit ? ' ' + job.unit : ''})` : '';
            return t('xml1.progress', { stage: title }) + count;
        },

        // The global progress bar shows the build, like a download, whenever no patch install
        // or launch is using it.
        updateProgressBar(job) {
            const bar = window.ProgressManager;
            const queue = window.DownloadQueueManager;
            if (!bar || !job || !job.active || job.command !== 'build') return;
            if (queue && queue.active) return;
            if (bar.isActive && bar.cancelCallback !== this.cancelFromBar) return;
            const message = this.progressMessage(job);
            if (!bar.isActive) bar.show(GAME, message, this.cancelFromBar);
            bar.update(Math.max(0, Math.min(100, job.overall || 0)), message,
                job.etaS >= 0 ? { speed: 0, etaSeconds: job.etaS } : null);
        },

        releaseProgressBar() {
            const bar = window.ProgressManager;
            if (bar && bar.isActive && bar.cancelCallback === this.cancelFromBar) bar.hide();
        },

        async confirmCancel() {
            const choice = await window.showMessageBox(t('xml1.cancelTitle'), t('xml1.cancelBody'),
                [t('xml1.keepBuilding'), { label: t('xml1.cancelBuild'), danger: true }]);
            if (choice === 1) {
                await run('xml1-build-cancel');
                this.emit();
                return true;
            }
            return false;
        },

        // A builder or launcher error as the player reads it: the translated text for its code
        // (the builder's English text when the code is new), and the specifics from its detail.
        describe(error) {
            // The builder's fields are read defensively: a new builder may send other shapes.
            const code = error && typeof error.code === 'string' ? error.code : '';
            const detail = error && error.detail && typeof error.detail === 'object' && !Array.isArray(error.detail) ? error.detail : {};
            // A code of a known family without its own text (a new E_CACHE_*, say) reads as its family.
            const family = ['E_CACHE_'].find(prefix => code.startsWith(prefix));
            const key = has(`xml1.errors.${code}.msg`) || !family ? `xml1.errors.${code}` : `xml1.errors.${family}`;
            // E_IO names what happened to which file when the builder knows (detail.cause).
            const io = code === 'E_IO' ? this.ioProblem(detail) : null;
            const title = io && io.title ? io.title : has(`${key}.msg`) ? t(`${key}.msg`) : (error && error.msg) || t('xml1.errors.unknown.msg');
            const hint = io && io.title ? io.hint : has(`${key}.hint`) ? t(`${key}.hint`) : (error && error.hint) || '';
            const facts = [];
            if (detail.title) facts.push(t('xml1.detailFound', { title: String(detail.title) }));
            if (Array.isArray(detail.missing) && detail.missing.length) facts.push(t('xml1.detailMissing', { files: detail.missing.map(String).join(', ') }));
            if (Number.isFinite(detail.need) && Number.isFinite(detail.free)) {
                facts.push(t('xml1.detailSpace', { need: GameUtils.formatBytes(detail.need), free: GameUtils.formatBytes(detail.free), volume: detail.volume || '' }));
            }
            // A failed step (E_PIPELINE: a content module, or a prepare stage with its own code).
            if (detail.module) {
                facts.push(detail.code ? t('xml1.detailStepCode', { step: String(detail.module), code: String(detail.code) }) : t('xml1.detailStep', { step: String(detail.module) }));
            }
            if (Array.isArray(detail.first) && detail.first.length) {
                facts.push(t('xml1.detailFirst', { text: maskPaths(String(detail.first[0])).slice(0, 240) }));
            }
            if (io) {
                if (io.file && !io.named) facts.push(t('xml1.detailFile', { path: io.file }));
            } else if (typeof detail.path === 'string' && detail.path && !detail.title) {
                facts.push(t('xml1.detailFile', { path: maskPaths(detail.path) }));
            }
            if (Number.isInteger(detail.pid)) facts.push(t('xml1.detailPid', { pid: detail.pid }));
            return { code, title: String(title), hint: String(hint || ''), facts, builderText: error && typeof error.msg === 'string' ? error.msg : '' };
        },

        // An E_IO's detail as plain words: { title, hint } for its cause (held, disk_full, ...: the
        // builder's errors.IO_CAUSES; none for `other` or a builder without causes), file (the path
        // relative to its folder, named for the build cache / X-Men Legends II's folder), named (the
        // title says the file).
        ioProblem(detail) {
            const path = typeof detail.path === 'string' ? maskPaths(detail.path) : '';
            const where = typeof detail.where === 'string' && /^[a-z0-9]+$/.test(detail.where) && has(`xml1.io.where.${detail.where}`) ? detail.where : '';
            const file = path && where ? t(`xml1.io.where.${where}`, { path }) : path;
            const cause = typeof detail.cause === 'string' && /^[a-z_]+$/.test(detail.cause) ? detail.cause : '';
            const key = `xml1.io.causes.${cause}`;
            if (!cause || !has(`${key}.msg`)) return { title: '', hint: '', file, named: false };
            const named = !!file && t(`${key}.msg`).includes('{{file}}');
            const text = t(`${key}.msg`, { file: file || t('xml1.io.someFile') });
            return { title: text.charAt(0).toUpperCase() + text.slice(1), hint: has(`${key}.hint`) ? t(`${key}.hint`) : '', file, named };
        },

        // The error of a finished run: its first error, else what its exit code means.
        jobError(job) {
            if (job && job.errors && job.errors.length) return this.describe(job.errors[0]);
            const byExit = { 1: 'E_BUILD_FAILED', 2: 'E_USAGE', 3: 'E_INPUT', 4: 'E_SPACE', 5: 'E_CANCELLED', 6: 'E_IO', 70: 'E_INTERNAL' };
            return this.describe({ code: byExit[job && job.exitCode] || 'L_BUILDER_CRASH', msg: '' });
        },

        // "Copy details" (section 4.7): builder version, stage, code, the last log lines, no
        // profile paths, never any game file.
        details(job) {
            const s = this.status || {};
            const lines = [
                `X-Men Legends port build report`,
                `Builder: ${(job && job.version) || (s.builder && s.builder.version) || '?'} (content ${(job && job.contentVersion) || '?'})`,
                `Launcher: ${this.launcherVersion || '?'}; ${navigator.userAgent.match(/Windows NT [\d.]+/) || ''}`
            ];
            if (job) {
                const error = this.jobError(job);
                lines.push(`Command: ${job.command || '?'}, exit ${job.exitCode}${job.killed ? ' (ended by the launcher)' : ''}`,
                    `Stage: ${job.stage || '-'}`);
                if (job.exitCode !== 0) {
                    lines.push(`Error: ${error.code} ${error.builderText || error.title}`);
                    const detail = job.errors && job.errors[0] && job.errors[0].detail;
                    if (detail && Object.keys(detail).length) lines.push(`Detail: ${JSON.stringify(detail)}`);
                }
                (job.notices || []).filter(n => n.code !== 'W_PIPELINE').forEach(n => lines.push(`Warning: ${n.code} ${n.msg}`));
            }
            const verify = this.verify;
            if (verify) {
                lines.push(`Verify: ${verify.state}; ${JSON.stringify(verify.counts || {})}`);
                (verify.groups || []).forEach(group => {
                    lines.push(`  ${group.code} (${group.count}): ${(group.files || []).slice(0, 5).map(file => file.path || file.problem || '').join(', ')}`);
                });
            }
            lines.push('', 'Last log lines:', ...((job && job.logTail) || []));
            return maskPaths(lines.join('\n'));
        },

        // "Report a problem" (design 4.7): a file with the details above, the last verification
        // (_build\verify-report.json: relative paths, sizes, hashes, codes - never game content) and
        // the end of the build log, profile paths masked, saved in the launcher's reports folder for
        // the player to attach to an issue. -> { success, path, error }.
        async saveReport(job, reveal) {
            let sources = {};
            try {
                sources = await run('xml1-report-sources') || {};
            } catch (_) { /* the details alone still help */ }
            const parts = [this.details(job)];
            if (sources.verifyReport) {
                let text = sources.verifyReport;
                try {
                    text = JSON.stringify(JSON.parse(text), null, 1);
                } catch (_) { /* as it is */ }
                parts.push('', `=== verify-report.json (${sources.verifyReportPath || ''}) ===`, text);
            } else {
                parts.push('', '=== verify-report.json: none yet (no build or verify has finished) ===');
            }
            if (sources.logTail && sources.logTail.length) {
                parts.push('', `=== build log, last ${sources.logTail.length} lines (${sources.logPath || ''}) ===`, ...sources.logTail);
            }
            return run('xml1-save-report', { text: maskPaths(parts.join('\n')) + '\n', reveal: !!reveal });
        },

        async copyDetails(job, quiet) {
            const text = this.details(job);
            let copied = false;
            try {
                await navigator.clipboard.writeText(text);
                copied = true;
            } catch (_) {
                const area = document.createElement('textarea');
                area.value = text;
                area.style.position = 'fixed';
                area.style.opacity = '0';
                document.body.appendChild(area);
                area.select();
                try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
                area.remove();
            }
            if (!quiet) window.showToast(copied ? t('xml1.detailsCopied') : t('xml1.copyFailed'), copied ? 'success' : 'error');
            return copied;
        },

        // Saves the report file (shown selected in Explorer), copies the details, and opens a new
        // issue whose text says what to attach.
        async report(job) {
            const failed = job && job.finished && job.exitCode !== 0;
            const error = failed ? this.jobError(job) : null;
            const version = (job && job.version) || (this.status && this.status.builder && this.status.builder.version) || '';
            const damaged = this.verify && this.verify.state === 'damaged';
            const title = error ? `Build failed: ${error.code}${version ? ` (builder ${version})` : ''}`
                : damaged ? `Build damaged: ${this.damageCount(this.verify)} files${version ? ` (builder ${version})` : ''}` : `Problem report${version ? ` (builder ${version})` : ''}`;
            const saved = await this.saveReport(job, true);
            const file = saved && saved.success ? saved.path.split(/[\\/]/).pop() : '';
            const body = [
                'What happened (what you did, what you saw):', '', '',
                '---',
                file ? `Attach the report the launcher saved: ${file} (it just opened in Explorer; drag it into this box). ` +
                    'It has the build\'s file list checks and the end of the build log, no game files.' : null,
                `Builder ${version || '?'}, launcher ${this.launcherVersion || '?'}${error ? `, error ${error.code}` : ''}`
            ].filter(line => line !== null).join('\n');
            await this.copyDetails(job, true);
            run('open-url', { url: `${REPORT_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(maskPaths(body))}` });
            window.showToast(saved && saved.success ? t('xml1.reportSaved', { file }) : t('xml1.reportFailed'), saved && saved.success ? 'success' : 'error', 9000);
            return saved;
        },

        openLog() {
            return run('xml1-open-log');
        },

        async freeCache() {
            const job = await this.runJob('xml1-free-cache');
            if (job && job.exitCode === 0) {
                window.showToast(t('xml1.freedUp'), 'success');
            } else {
                window.showToast(this.jobError(job).title, 'error');
            }
            this.info = null;
            await this.refresh();
            this.refreshInfo();
            return job;
        },

        // Uninstall (section 4.6): the builder deletes the build it made (and, if asked, its mods
        // and the build cache); then the launcher removes the XML2 Fix and forgets the folder.
        async uninstall({ deleteGame, mods, cache }) {
            if (deleteGame) {
                const job = await this.runJob('xml1-clean', { mods: !!mods, cache: !!cache });
                if (!job || job.exitCode !== 0) {
                    const error = this.jobError(job);
                    window.showMessageBox(t('xml1.uninstallFailed'), this.messageHtml(error), [t('common.ok')]);
                    await this.refresh();
                    return false;
                }
            } else if (cache) {
                await this.runJob('xml1-free-cache');
            }
            await GameUtils.trackCommandProgress({
                gameId: GAME,
                command: 'delete-game',
                commandArgs: { game: GAME },
                initialMessage: t('xml1.uninstalling'),
                completeMessage: t('progress.uninstallComplete')
            }).catch(error => console.error('xml1: delete-game failed', error));
            this.info = null;
            this.verify = null;
            window.dispatchEvent(new CustomEvent('gameInstallationUpdated', { detail: { game: GAME } }));
            await this.refresh();
            return true;
        }
    };

    window.Xml1Port = Xml1Port;
})();
