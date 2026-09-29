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
    const REPORT_URL = 'https://github.com/ChronoRixun/xml1-port/issues/new';
    const DUMPING_URL = 'https://github.com/ChronoRixun/xml1-port/blob/main/docs/DUMPING.md';

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

    // Profile paths never leave the PC in copied details (the builder masks its own the same way).
    function maskPaths(text) {
        return String(text || '').replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\r\n"]+/g, '%USERPROFILE%');
    }

    const Xml1Port = {
        status: null,
        info: null,      // the builder's `info` about the build in its folder (result.info)
        verify: null,    // the last `verify` (result.verify)
        build: null,     // the last build/clean run (get-xml1-build)
        finishing: false, // installing the XML2 Fix after a build
        buildTimer: null,
        watched: new Set(), // build ids seen running in this session
        handled: new Set(),

        REPORT_URL,
        DUMPING_URL,
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
            if (state === 'incomplete' && this.status.isoExists) return this.resume();
            if (window.Xml1Setup) window.Xml1Setup.show();
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

        // A build with the choices of the last one (Resume, Rebuild, Repair).
        async resume() {
            const s = this.status || await this.refresh();
            if (!s.iso || !s.isoExists || !s.install) {
                if (window.Xml1Setup) window.Xml1Setup.show();
                return null;
            }
            const started = await this.startBuild({ iso: s.iso, out: s.install, movies: s.movies, keepCache: s.keepCache, linkBase: s.linkBase });
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
            const code = (error && error.code) || '';
            const detail = (error && error.detail) || {};
            const key = `xml1.errors.${code}`;
            const title = has(`${key}.msg`) ? t(`${key}.msg`) : (error && error.msg) || t('xml1.errors.unknown.msg');
            const hint = has(`${key}.hint`) ? t(`${key}.hint`) : (error && error.hint) || '';
            const facts = [];
            if (detail.title) facts.push(t('xml1.detailFound', { title: detail.title }));
            if (detail.missing && detail.missing.length) facts.push(t('xml1.detailMissing', { files: detail.missing.join(', ') }));
            if (detail.need != null && detail.free != null) {
                facts.push(t('xml1.detailSpace', { need: GameUtils.formatBytes(detail.need), free: GameUtils.formatBytes(detail.free), volume: detail.volume || '' }));
            }
            return { code, title, hint, facts, builderText: (error && error.msg) || '' };
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
            const error = this.jobError(job);
            const s = this.status || {};
            const lines = [
                `X-Men Legends port build report`,
                `Builder: ${(job && job.version) || (s.builder && s.builder.version) || '?'} (content ${(job && job.contentVersion) || '?'})`,
                `Command: ${(job && job.command) || '?'}, exit ${job ? job.exitCode : '?'}${job && job.killed ? ' (ended by the launcher)' : ''}`,
                `Stage: ${(job && job.stage) || '-'}`,
                `Error: ${error.code} ${error.builderText || error.title}`,
                `Launcher: ${this.launcherVersion || '?'}; ${navigator.userAgent.match(/Windows NT [\d.]+/) || ''}`,
                '',
                'Last log lines:',
                ...((job && job.logTail) || [])
            ];
            return maskPaths(lines.join('\n'));
        },

        async copyDetails(job) {
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
            window.showToast(copied ? t('xml1.detailsCopied') : t('xml1.copyFailed'), copied ? 'success' : 'error');
            return copied;
        },

        report(job) {
            const error = this.jobError(job);
            const version = (job && job.version) || (this.status && this.status.builder && this.status.builder.version) || '';
            const title = `Build failed: ${error.code}${version ? ` (builder ${version})` : ''}`;
            run('open-url', { url: `${REPORT_URL}?title=${encodeURIComponent(title)}` });
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
