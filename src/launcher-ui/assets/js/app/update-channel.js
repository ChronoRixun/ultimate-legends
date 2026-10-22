// Settings > Updates > Update channel: Stable (the default) or Beta, which the launcher's own update,
// the XML2 Fix and the X-Men Legends builder all follow (updater/channel_status.hpp). Under it, each
// item's exact version with a Beta badge on a pre-release, and a note when GitHub couldn't be asked
// and Beta used the last release it found. Switching back to Stable while something is a beta newer
// than the latest release asks first ("You're on a beta (x). Switch back to y?"): Switch back
// reinstalls the latest release of each (the launcher's download, Verify for the fix, the builder),
// then offers to rebuild X-Men Legends; Keep the beta changes nothing, and the same choice stays
// offered here. Nothing is ever downgraded without that answer.
(function () {
    'use strict';

    const POLL_MS = 1000;
    const MAX_POLLS = 60;
    // The items, in the order they are listed.
    const ORDER = ['launcher', 'fix:xml2', 'fix:xml1', 'builder'];

    function t(key, variables) {
        return window.LauncherI18n ? window.LauncherI18n.t(key, variables) : key;
    }

    function run(command, payload) {
        return window.executeCommand(command, payload);
    }

    function el(id) {
        return document.getElementById(id);
    }

    function escapeHtml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function keyOf(item) {
        return item.game ? `${item.id}:${item.game}` : item.id;
    }

    function itemName(item) {
        switch (keyOf(item)) {
            case 'launcher': return t('updateChannel.itemLauncher');
            case 'fix:xml2': return t('updateChannel.itemFixXml2');
            case 'fix:xml1': return t('updateChannel.itemFixXml1');
            case 'builder': return t('updateChannel.itemBuilder');
            default: return item.id;
        }
    }

    // A repository by what it updates.
    function repoName(id) {
        switch (id) {
            case 'launcher': return t('updateChannel.itemLauncher');
            case 'fix': return t('updateChannel.repoFix');
            case 'builder': return t('updateChannel.itemBuilder');
            default: return id;
        }
    }

    // "1.8.0-beta.2" and a Beta badge, for any page that shows a version.
    function badgeHtml() {
        return `<span class="beta-badge">${escapeHtml(t('updateChannel.badge'))}</span>`;
    }

    function versionHtml(version, prerelease) {
        return `${escapeHtml(version)}${prerelease ? ` ${badgeHtml()}` : ''}`;
    }

    const UpdateChannel = {
        status: null,
        busy: false,
        polling: false,

        async init() {
            const select = el('update-channel-select');
            if (select && !select.dataset.bound) {
                select.dataset.bound = 'true';
                select.addEventListener('change', () => this.choose(select.value));
            }
            const back = el('update-channel-switch-back');
            if (back && !back.dataset.bound) {
                back.dataset.bound = 'true';
                back.addEventListener('click', () => this.offerSwitchBack());
            }
            // What is installed; GitHub is asked when Settings opens (main.js: refresh(true)).
            await this.refresh(false);
        },

        async refresh(ask) {
            try {
                this.status = await run('get-update-channel', { refresh: !!ask && !window.IS_OFFLINE });
            } catch (error) {
                console.error('update channel: status failed', error);
            }
            this.render();
            if (this.status && this.status.checking) await this.follow();
            return this.status;
        },

        // Polls while the backend asks GitHub.
        async follow() {
            if (this.polling) return;
            this.polling = true;
            try {
                for (let i = 0; i < MAX_POLLS; i++) {
                    await sleep(POLL_MS);
                    this.status = await run('get-update-channel');
                    this.render();
                    if (!this.status || !this.status.checking) break;
                }
            } catch (error) {
                console.error('update channel: polling failed', error);
            } finally {
                this.polling = false;
            }
        },

        channel() {
            return this.status && this.status.channel === 'beta' ? 'beta' : 'stable';
        },

        items() {
            const items = (this.status && Array.isArray(this.status.items)) ? this.status.items.slice() : [];
            return items.sort((a, b) => ORDER.indexOf(keyOf(a)) - ORDER.indexOf(keyOf(b)));
        },

        // Betas newer than the latest release, while the channel is Stable - but not a launcher whose
        // switch back is downloaded and only waits for the restart that installs it.
        ahead() {
            if (this.channel() !== 'stable') return [];
            const launcher = window.LauncherUpdate && window.LauncherUpdate.status;
            return this.items().filter(item => item.ahead &&
                !(item.id === 'launcher' && launcher && launcher.state === 'ready' && launcher.readyVersion === item.stable));
        },

        async choose(value) {
            const next = value === 'beta' ? 'beta' : 'stable';
            if (this.busy || next === this.channel()) {
                this.render();
                return;
            }
            this.busy = true;
            this.render();
            try {
                this.status = await run('set-update-channel', { channel: next });
                this.render();
                await this.follow();
                // The launcher's own check follows the new channel.
                if (window.LauncherUpdate && !window.IS_OFFLINE) await window.LauncherUpdate.check();
                if (window.showToast) {
                    window.showToast(t(next === 'beta' ? 'updateChannel.nowBeta' : 'updateChannel.nowStable'), 'info', 6000);
                }
            } catch (error) {
                console.error('update channel: switching failed', error);
            } finally {
                this.busy = false;
                this.render();
            }
            if (next === 'stable') await this.offerSwitchBack();
            // The fix's patch line and the builder follow the channel too.
            window.dispatchEvent(new CustomEvent('gameInstallationUpdated', { detail: { game: null } }));
        },

        // "You're on a beta (x). Switch back to y?" Switch back installs exactly the versions shown, each
        // approved for this one attempt: the launcher's download, Verify in each XML2 Fix folder, the
        // builder. Each item's result is what is on the disk afterwards, not that its work started; what
        // failed or was cancelled stays as it was and is said, with the same offer kept here for a retry
        // (asked again). Rebuild is offered only when the builder and the port's fix it needed both
        // switched. Keep the beta revokes anything approved before that hasn't installed yet.
        async offerSwitchBack() {
            const ahead = this.ahead();
            if (!ahead.length || this.busy) return false;
            const current = ahead.map(item => `${itemName(item)} ${item.installed}`).join(', ');
            const stable = ahead.map(item => `${itemName(item)} ${item.stable}`).join(', ');
            const choice = await window.showMessageBox(t('updateChannel.switchBackTitle'),
                `${escapeHtml(t('updateChannel.switchBackBody', { current, stable }))}<br><br>${escapeHtml(t('updateChannel.switchBackDetail'))}`,
                [t('updateChannel.switchBackYes'), { label: t('updateChannel.keepBeta'), cancel: true }]);
            if (choice !== 0) {
                try {
                    await run('keep-beta');
                } catch (error) {
                    console.error('update channel: keep-beta failed', error);
                }
                return false;
            }

            this.busy = true;
            this.render();
            const outcomes = [];
            try {
                const launcher = ahead.find(item => item.id === 'launcher');
                const builder = ahead.find(item => item.id === 'builder');
                // The launcher's download starts from its check of the latest release.
                if (launcher && window.LauncherUpdate && !window.IS_OFFLINE) await window.LauncherUpdate.check();
                const started = (await run('switch-back-to-stable', {
                    launcher: launcher ? launcher.stable : '',
                    builder: builder ? builder.stable : ''
                })) || {};
                for (const item of ahead.filter(entry => entry.id === 'fix')) {
                    outcomes.push({ item, ...(await this.verify(item)) });
                }
                if (builder) outcomes.push({ item: builder, ...(await this.builderResult(builder, !!started.builder)) });
                if (launcher) outcomes.push({ item: launcher, ...(await this.launcherResult(launcher, !!started.launcher)) });
            } catch (error) {
                console.error('update channel: switching back failed', error);
                for (const item of ahead) {
                    if (!outcomes.some(outcome => outcome.item === item)) outcomes.push({ item, ok: false, reason: String(error && error.message || error) });
                }
            } finally {
                this.busy = false;
                await this.refresh(false);
            }
            window.dispatchEvent(new CustomEvent('gameInstallationUpdated', { detail: { game: null } }));
            await this.report(outcomes);

            // A rebuild with the stable builder and fix, once both that the port needed are there.
            const portNeeds = outcomes.filter(outcome => outcome.item.id === 'builder' || keyOf(outcome.item) === 'fix:xml1');
            if (portNeeds.length && portNeeds.every(outcome => outcome.ok)) await this.offerRebuild();
            return outcomes.every(outcome => outcome.ok);
        },

        // What happened to each item, when anything did not switch back (and a short note when all did).
        async report(outcomes) {
            const failed = outcomes.filter(outcome => !outcome.ok);
            if (!failed.length) {
                if (outcomes.length && window.showToast) window.showToast(t('updateChannel.resultAllDone'), 'success', 6000);
                return;
            }
            const lines = outcomes.map(({ item, ok, pending, reason }) => {
                if (ok && pending) return t('updateChannel.resultLauncherReady', { name: itemName(item), version: item.stable, button: t('launcherUpdate.restartNow') });
                if (ok) return t('updateChannel.resultDone', { name: itemName(item), version: item.stable });
                return t('updateChannel.resultFailed', { name: itemName(item), version: item.installed, reason: reason || t('updateChannel.reasonUnknown') });
            });
            await window.showMessageBox(t('updateChannel.resultTitle'),
                `${escapeHtml(t('updateChannel.resultIntro'))}<br><br>${lines.map(escapeHtml).join('<br>')}<br><br>${escapeHtml(t('updateChannel.resultRetry'))}`,
                [t('common.ok')]);
        },

        // Verify with the approval for this folder, this attempt: { ok, reason } from get-patch-attempt,
        // which reads the folder afterwards.
        async verify(item) {
            const game = item.game;
            const gameId = (GameUtils.getUIIdFromBackendId && GameUtils.getUIIdFromBackendId(game)) || game;
            const name = window.GameInstallationManager && window.GameInstallationManager.getGameDisplayName
                ? window.GameInstallationManager.getGameDisplayName(gameId) : game;
            let answer = null;
            try {
                answer = await GameUtils.trackCommandProgress({
                    gameId,
                    command: 'verify-game',
                    op: 'verify',
                    commandArgs: { game, downgrade: { from: item.installed, to: item.stable } },
                    initialMessage: t('progress.verifying', { game: name }),
                    completeMessage: t('progress.verificationComplete')
                });
            } catch (error) {
                console.error(`update channel: verify ${game} failed`, error);
                return { ok: false, reason: String(error && error.message || error) };
            }
            if (!answer || answer.accepted === false || !answer.attempt) return { ok: false, reason: t('updateChannel.reasonBusy') };
            for (let i = 0; i < MAX_POLLS * 5; i++) {
                const attempt = await run('get-patch-attempt', { attempt: answer.attempt });
                if (attempt && attempt.state !== 'running') {
                    if (attempt.state === 'done' && attempt.installed === item.stable) return { ok: true };
                    if (attempt.state === 'cancelled') return { ok: false, reason: t('updateChannel.reasonCancelled') };
                    return { ok: false, reason: attempt.error || attempt.state };
                }
                await sleep(500);
            }
            return { ok: false, reason: t('updateChannel.reasonUnknown') };
        },

        // The builder's install of exactly `item.stable`: done when that version is the one installed.
        async builderResult(item, started) {
            if (!started) return { ok: false, reason: t('updateChannel.reasonBusy') };
            const builder = await this.waitForBuilder();
            if (builder && builder.version === item.stable && !builder.code) return { ok: true };
            return { ok: false, reason: (builder && (builder.error || builder.code)) || t('updateChannel.reasonUnknown') };
        },

        // The launcher's download of exactly `item.stable`: ready to install at the next start.
        async launcherResult(item, started) {
            if (!started || !window.LauncherUpdate) return { ok: false, reason: t('updateChannel.reasonBusy') };
            const s = await window.LauncherUpdate.follow() || window.LauncherUpdate.status;
            const status = s || window.LauncherUpdate.status;
            if (status && status.state === 'ready' && status.readyVersion === item.stable) return { ok: true, pending: true };
            return { ok: false, reason: (status && (status.installError || status.error)) || t('updateChannel.reasonUnknown') };
        },

        async waitForBuilder() {
            for (let i = 0; i < MAX_POLLS * 5; i++) {
                await sleep(500);
                const s = await run('get-xml1-status');
                const builder = s && s.builder;
                if (!builder || (!builder.checking && !builder.installing)) {
                    if (window.Xml1Port) await window.Xml1Port.refresh();
                    return builder;
                }
            }
            return null;
        },

        // A build made with the beta builder or fix: offer to build it again with the release.
        async offerRebuild() {
            const port = window.Xml1Port;
            if (!port || typeof port.canRebuild !== 'function') return false;
            const s = port.status || await port.refresh();
            if (!s || !['ready', 'stale', 'needs-fix'].includes(s.state) || !port.canRebuild()) return false;
            const choice = await window.showMessageBox(t('updateChannel.rebuildTitle'), escapeHtml(t('updateChannel.rebuildBody')),
                [t('xml1.rebuild'), { label: t('launcherUpdate.notNow'), cancel: true }]);
            if (choice !== 0) return false;
            await port.resume();
            return true;
        },

        // Shows Settings with the focus on Update channel (the Online section's "Open Update channel").
        openSetting() {
            const nav = el('settings');
            if (nav && !nav.classList.contains('active')) nav.click();
            setTimeout(() => {
                const select = el('update-channel-select');
                if (!select) return;
                if (typeof select.scrollIntoView === 'function') select.scrollIntoView({ block: 'center' });
                select.focus();
            }, 0);
        },

        // What Settings says under the versions, one line each: offline mode; a check running; for each
        // repository GitHub could not be asked about, whether its last result is used or there is none (a
        // first check that failed); a beta newer than the latest release on Stable.
        note() {
            const s = this.status;
            if (!s) return '';
            if (s.offline) return t('updateChannel.offline');
            if (s.checking) return t('updateChannel.checking');
            const lines = (Array.isArray(s.repos) ? s.repos : []).filter(repo => repo.error).map(repo => repo.fromCache
                ? t('updateChannel.fromCacheRepo', { name: repoName(repo.id), error: repo.error, version: repo.version })
                : t('updateChannel.checkFailedRepo', { name: repoName(repo.id), error: repo.error }));
            const ahead = this.ahead();
            if (ahead.length) {
                lines.push(t('updateChannel.aheadNote', {
                    current: ahead.map(item => `${itemName(item)} ${item.installed}`).join(', '),
                    stable: ahead.map(item => item.stable).join(', ')
                }));
            }
            return lines.join('\n');
        },

        render() {
            const select = el('update-channel-select');
            if (select) {
                if (!select.classList.contains('is-picking')) select.value = this.channel();
                select.disabled = this.busy;
            }

            const list = el('update-channel-versions');
            if (list) {
                list.innerHTML = this.items().map(item => {
                    const version = item.dev ? t('updateChannel.devBuild', { version: item.installed }) : item.installed;
                    const newer = this.channel() === 'beta' && item.beta && item.beta !== item.installed && !item.dev
                        ? ` <span class="update-channel-latest">${escapeHtml(t('updateChannel.betaAvailable', { version: item.beta }))}</span>` : '';
                    return `<div class="update-channel-row" data-item="${escapeHtml(keyOf(item))}">
                        <span class="update-channel-name">${escapeHtml(itemName(item))}</span>
                        <span class="update-channel-version">${versionHtml(version, item.prerelease)}${newer}</span>
                    </div>`;
                }).join('');
            }

            const note = el('update-channel-note');
            if (note) {
                const text = this.note();
                note.textContent = text;
                note.hidden = !text;
            }

            const back = el('update-channel-switch-back');
            if (back) {
                back.hidden = !this.ahead().length;
                back.disabled = this.busy;
                back.textContent = t('updateChannel.switchBackButton');
            }
        },

        badgeHtml,
        versionHtml
    };

    window.UpdateChannel = UpdateChannel;
})();
