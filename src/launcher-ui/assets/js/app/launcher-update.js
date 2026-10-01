// The launcher's own update: a bar at the top of every page when a newer Ultimate Legends is
// released, and a line under the version in Settings. The backend (updater/launcher_update.cpp)
// checks GitHub's latest release, downloads and verifies the portable zip when the player says
// Update, and installs it on the next start (Restart now does that at once). Development builds and
// offline mode never check.
(function () {
    'use strict';

    const RECHECK_MS = 6 * 60 * 60 * 1000;

    function t(key, variables) {
        return window.LauncherI18n ? window.LauncherI18n.t(key, variables) : key;
    }

    function run(command, payload) {
        return window.executeCommand(command, payload);
    }

    function el(id) {
        return document.getElementById(id);
    }

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function formatBytes(bytes) {
        return typeof GameUtils !== 'undefined' && typeof GameUtils.formatBytes === 'function'
            ? GameUtils.formatBytes(bytes)
            : `${Math.round(bytes / (1024 * 1024))} MB`;
    }

    const LauncherUpdate = {
        status: null,
        dismissed: '', // the version whose "available" bar the player closed this session
        polling: false,

        async init() {
            const checkButton = el('launcher-update-check');
            if (checkButton) checkButton.onclick = () => this.check();
            const action = el('launcher-update-action');
            if (action) action.onclick = () => this.act();
            const notes = el('launcher-update-notes');
            if (notes) notes.onclick = () => this.openPage();
            const dismiss = el('launcher-update-dismiss');
            if (dismiss) dismiss.onclick = () => {
                this.dismissed = this.status ? this.status.latest : '';
                this.render();
            };

            await this.refresh();
            const s = this.status;
            if (s && s.updatedTo && window.showToast) {
                window.showToast(t('launcherUpdate.updated', { version: s.updatedTo }), 'success', 8000);
            }
            if (s && s.enabled && !window.IS_OFFLINE) {
                this.check();
                setInterval(() => this.check(), RECHECK_MS);
            }
        },

        async refresh() {
            try {
                this.status = await run('get-launcher-update');
            } catch (error) {
                console.error('launcher update: status failed', error);
            }
            this.render();
            return this.status;
        },

        // Polls while the backend checks or downloads.
        async follow() {
            if (this.polling) return;
            this.polling = true;
            try {
                for (;;) {
                    const s = await this.refresh();
                    if (!s || (s.state !== 'checking' && s.state !== 'downloading')) break;
                    await sleep(s.state === 'downloading' ? 500 : 1000);
                }
            } finally {
                this.polling = false;
            }
        },

        async check() {
            if (window.IS_OFFLINE) return;
            try {
                this.status = await run('check-launcher-update');
            } catch (error) {
                console.error('launcher update: check failed', error);
                return;
            }
            this.render();
            await this.follow();
        },

        openPage() {
            const page = this.status && this.status.page;
            if (page) run('open-url', { url: page });
        },

        async act() {
            const s = this.status;
            if (!s) return;
            if (s.state === 'ready') return this.restart();
            if (s.state !== 'available' && s.state !== 'failed') return;
            if (!s.canInstall) {
                const manual = await window.showMessageBox(t('launcherUpdate.confirmTitle'),
                    t('launcherUpdate.confirmManual', { version: s.latest, current: s.current }),
                    [t('launcherUpdate.download'), t('launcherUpdate.notNow')]);
                if (manual === 0) this.openPage();
                return;
            }

            const size = s.size ? formatBytes(s.size) : '';
            const choice = await window.showMessageBox(t('launcherUpdate.confirmTitle'),
                t('launcherUpdate.confirmBody', { version: s.latest, current: s.current, size }),
                [t('launcherUpdate.update'), t('launcherUpdate.notNow')]);
            if (choice !== 0) return;
            await run('start-launcher-update');
            await this.follow();
        },

        async restart() {
            const result = await run('restart-launcher-update');
            if (result && result.ok) {
                const text = el('launcher-update-text');
                if (text) text.textContent = t('launcherUpdate.restarting');
                const action = el('launcher-update-action');
                if (action) action.disabled = true;
                return;
            }
            if (result && result.error === 'busy') {
                await window.showMessageBox(t('launcherUpdate.busyTitle'), t('launcherUpdate.busyBody'), [t('common.ok')]);
            }
            await this.refresh();
        },

        // The bar's text and button for a state, or null when the bar stays hidden.
        barFor(s) {
            if (!s || !s.enabled) return null;
            const version = s.latest || s.readyVersion;
            switch (s.state) {
                case 'available':
                    if (s.installError) {
                        return { text: s.installError, action: t('launcherUpdate.tryAgain'), failed: true };
                    }
                    if (this.dismissed && this.dismissed === s.latest) return null;
                    return {
                        text: t('launcherUpdate.available', { version }),
                        action: t(s.canInstall ? 'launcherUpdate.update' : 'launcherUpdate.download'),
                        dismiss: true
                    };
                case 'downloading': {
                    const percent = s.total ? Math.min(100, Math.floor((s.done * 100) / s.total)) : 0;
                    return { text: t('launcherUpdate.downloading', { version, percent }), progress: percent };
                }
                case 'ready':
                    return {
                        text: s.installError || t('launcherUpdate.ready', { version: s.readyVersion || version }),
                        action: t('launcherUpdate.restartNow'),
                        failed: !!s.installError
                    };
                case 'failed':
                    return { text: t('launcherUpdate.failed', { error: s.error }), action: t('launcherUpdate.tryAgain'), failed: true };
                default:
                    return s.installError ? { text: s.installError, failed: true, dismiss: true } : null;
            }
        },

        statusLine(s) {
            if (!s) return '';
            if (!s.enabled) return t('launcherUpdate.devBuild');
            if (window.IS_OFFLINE) return t('launcherUpdate.offline');
            const bar = this.barFor(s);
            switch (s.state) {
                case 'checking': return t('launcherUpdate.checking');
                case 'up-to-date': return t('launcherUpdate.upToDate');
                case 'check-failed': return t('launcherUpdate.checkFailed', { error: s.error });
                case 'available': return t('launcherUpdate.available', { version: s.latest });
                default: return bar ? bar.text : '';
            }
        },

        render() {
            const s = this.status;
            const bar = el('launcher-update-bar');
            if (bar) {
                const spec = this.barFor(s);
                bar.hidden = !spec;
                if (spec) {
                    bar.classList.toggle('is-failed', !!spec.failed);
                    el('launcher-update-text').textContent = spec.text;
                    const action = el('launcher-update-action');
                    action.hidden = !spec.action;
                    action.disabled = false;
                    action.textContent = spec.action || '';
                    const progress = el('launcher-update-progress');
                    progress.hidden = spec.progress === undefined;
                    el('launcher-update-fill').style.width = `${spec.progress || 0}%`;
                    el('launcher-update-notes').hidden = !(s && s.latest);
                    el('launcher-update-dismiss').hidden = !spec.dismiss;
                }
            }

            const line = el('launcher-update-status');
            if (line) line.textContent = this.statusLine(s);
            const checkButton = el('launcher-update-check');
            if (checkButton) {
                checkButton.hidden = !s || !s.enabled;
                checkButton.disabled = !!window.IS_OFFLINE || !s ||
                    ['checking', 'downloading', 'ready'].includes(s.state);
            }
        }
    };

    window.LauncherUpdate = LauncherUpdate;
})();
