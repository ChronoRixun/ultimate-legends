// The Build section of the X-Men Legends page (BUILDER_DESIGN.md 4.3, "Game page"): where the
// build stands (up to date, update available, resume, building, damaged, the XML2 Fix missing),
// the folder, the disc image, the builder and the build cache, and Rebuild / Verify build / Open
// build log / Change disc image / Free up. State and runs live in Xml1Port (xml1-port.js).
(function () {
    'use strict';

    const SUPPORTED = new Set(['xml1']);
    const escapeHtml = value => GameUtils.escapeHtml(value);

    function t(key, variables) {
        return window.LauncherI18n ? window.LauncherI18n.t(key, variables) : key;
    }

    function run(command, payload) {
        return window.executeCommand(command, payload);
    }

    function panel(gameId) {
        return document.getElementById(`${gameId}-build-panel`);
    }

    function bytes(value) {
        return GameUtils.formatBytes(Math.max(0, Number(value) || 0));
    }

    function date(text) {
        const value = text ? new Date(text) : null;
        return value && !isNaN(value) ? value.toLocaleDateString() : '';
    }

    function row(label, value, action) {
        return `
            <div class="install-info-row xml1-row">
                <span class="install-info-label">${escapeHtml(label)}</span>
                <span class="install-info-value xml1-row-value" title="${escapeHtml(value)}">${escapeHtml(value)}</span>
                ${action || ''}
            </div>`;
    }

    function button(act, label, extra = '') {
        return `<button type="button" class="secondary-action xml1-small" data-act="${act}" ${extra}>${escapeHtml(label)}</button>`;
    }

    function stateText(port) {
        const s = port.status;
        const state = port.state();
        switch (state) {
            case 'not-setup': return t('xml1.state.notSetUp');
            case 'absent': return t('xml1.state.absent', { folder: s.install });
            case 'incomplete': return t(s.isoExists || s.cacheHasDisc ? 'xml1.state.incomplete' : 'xml1.state.incompleteNeedsDisc');
            case 'building': return port.build && port.build.cancelRequested ? t('xml1.cancelling') : port.progressMessage(port.build);
            case 'finishing': return t('xml1.finishingBody');
            case 'needs-fix': return t('xml1.state.needsFix');
            case 'damaged': return t('xml1.state.damaged', { count: port.damageCount(port.verify) });
            case 'stale': return t('xml1.state.stale');
            case 'ready': return t('xml1.state.ready');
            default: return t('xml1.loading');
        }
    }

    // What the last verification found, group by group (BUILDER_DESIGN.md 2.9: missing, changed,
    // unreadable, extra, xml2_changed, ...): its count, the builder's cause hint and the first files.
    function verifyHTML(port) {
        const verify = port.verify;
        const groups = verify && Array.isArray(verify.groups) ? verify.groups.filter(group => group && typeof group.code === 'string') : [];
        if (!groups.length) return '';
        const items = groups.map(group => {
            const files = (Array.isArray(group.files) ? group.files : [])
                .map(file => (file && typeof file === 'object' ? file.path || file.problem : file) || '').map(String).filter(Boolean);
            const shown = files.slice(0, 3);
            const count = Number(group.count) || 0;
            const more = Math.max(0, count - shown.length);
            const repair = port.REPAIRS.includes(group.code);
            const label = t(`xml1.verifyGroup.${group.code}`) !== `xml1.verifyGroup.${group.code}` ? t(`xml1.verifyGroup.${group.code}`) : group.code;
            return `
                <li class="xml1-verify-group ${repair ? 'is-damage' : 'is-info'}" data-code="${escapeHtml(group.code)}" data-count="${escapeHtml(count)}">
                    <div class="xml1-verify-head"><span class="xml1-verify-label">${escapeHtml(label)}</span>
                        <span class="xml1-verify-count">${escapeHtml(t('xml1.verifyFiles', { count }))}</span></div>
                    ${typeof group.cause_hint === 'string' && group.cause_hint ? `<div class="xml1-verify-cause">${escapeHtml(group.cause_hint)}</div>` : ''}
                    ${shown.length ? `<ul class="xml1-verify-files">${shown.map(path => `<li title="${escapeHtml(path)}">${escapeHtml(path)}</li>`).join('')}
                        ${more ? `<li class="xml1-verify-more">${escapeHtml(t('xml1.verifyMore', { count: more }))}</li>` : ''}</ul>` : ''}
                </li>`;
        }).join('');
        return `<ul class="xml1-verify" data-state="${escapeHtml(String(verify.state || ''))}">${items}</ul>`;
    }

    // The last build's warnings a player should know about (W_XML2_MODIFIED, W_EXTRA_FILES, ...).
    function noticesHTML(port, job) {
        if (!job || job.command !== 'build' || !job.finished) return '';
        return port.noticesOf(job).map(notice =>
            `<div class="xml1-note is-warn xml1-notice" data-code="${escapeHtml(notice.code)}">${escapeHtml(notice.text)}</div>`).join('');
    }

    function render(gameId) {
        const host = panel(gameId);
        const port = window.Xml1Port;
        if (!host || !port) return;
        const s = port.status;
        if (!s) {
            host.innerHTML = `<div class="ul-display"><div class="ul-display-empty">${escapeHtml(t('xml1.loading'))}</div></div>`;
            return;
        }

        const state = port.state();
        const job = port.build;
        const builder = s.builder || {};
        const info = port.info || {};
        const cache = info.cache || null;
        const failed = job && job.finished && job.command === 'build' && ![0, 5].includes(job.exitCode) && state !== 'building';

        let progress = '';
        if (state === 'building' && job) {
            const percent = Math.max(0, Math.min(100, job.overall || 0));
            const eta = job.etaS > 0 ? t('xml1.eta', { time: GameUtils.formatDuration(job.etaS) }) : '';
            progress = `
                <div class="xml1-progress">
                    <div class="xml1-progress-bar"><div class="xml1-progress-fill" style="width:${percent.toFixed(1)}%"></div></div>
                    <div class="xml1-progress-meta">
                        <span class="xml1-progress-message">${escapeHtml(t('xml1.stageOf', { index: (job.stages || []).findIndex(x => x.id === job.stage) + 1, count: (job.stages || []).length }))}</span>
                        <span class="xml1-progress-numbers">${escapeHtml(eta)}${eta ? ' · ' : ''}${percent.toFixed(0)}%</span>
                    </div>
                </div>`;
        }

        let error = '';
        if (failed) {
            const described = port.jobError(job);
            error = `
                <div class="xml1-error" data-code="${escapeHtml(described.code)}">
                    <div class="xml1-error-title">${escapeHtml(t('xml1.lastBuildFailed'))} ${escapeHtml(described.title)}</div>
                    ${(described.facts || []).map(fact => `<div class="xml1-error-fact">${escapeHtml(fact)}</div>`).join('')}
                    ${described.hint ? `<div class="xml1-error-hint">${escapeHtml(described.hint)}</div>` : ''}
                    <div class="xml1-error-code">${escapeHtml(described.code)}</div>
                    <div class="xml1-error-tools">
                        ${button('copy-details', t('xml1.copyDetails'))}
                        ${button('open-log', t('xml1.openLog'))}
                        ${button('report', t('xml1.report'))}
                    </div>
                </div>`;
        } else if (builder.code && !builder.installed && s.install) {
            const described = port.describe({ code: builder.code, msg: builder.error });
            error = `<div class="xml1-note is-error">${escapeHtml(described.title)} ${escapeHtml(described.hint)}</div>`;
        }

        let fixNote = '';
        if (s.fix && s.fix.installed && !s.fix.ok) {
            fixNote = `<div class="xml1-note is-warn">${escapeHtml(t('xml1.fixOld', { version: s.fix.version || '?', required: s.fix.required }))}</div>`;
        }

        // Rows: what the page knows about the build.
        let builderValue;
        if (builder.installed) {
            builderValue = builder.updateAvailable ? t('xml1.builderUpdate', { version: builder.version, latest: builder.latest.version })
                : t('xml1.builderVersion', { version: builder.version });
        } else if (builder.installing) {
            builderValue = t('xml1.installingBuilder', { percent: builder.total ? Math.floor(100 * builder.done / builder.total) : 0 });
        } else {
            builderValue = builder.notPublished ? t('xml1.errors.L_BUILDER_UNPUBLISHED.msg') : t('xml1.builderMissing');
        }
        const buildValue = s.build && s.build.stamp
            ? t('xml1.buildInfo', { content: s.build.contentVersion, date: date(s.build.finished), movies: s.build.movies === false ? t('xml1.moviesOff') : '' })
            : (s.build && s.build.building ? t('xml1.buildUnfinished') : t('xml1.none'));
        const fixValue = s.fix && s.fix.installed ? (s.fix.version ? t('xml1.fixVersion', { version: s.fix.version.replace(/\.0$/, '') }) : t('xml1.fixInstalled'))
            : t('xml1.fixNotInstalled');
        const cacheValue = cache ? (cache.bytes > 0 ? bytes(cache.bytes) : t('xml1.cacheEmpty')) : '…';
        const working = port.isWorking();

        const discValue = !s.iso ? (s.cacheHasDisc ? t('xml1.discInCache') : t('xml1.none'))
            : s.isoExists ? s.iso : t(s.cacheHasDisc ? 'xml1.discMissingCached' : 'xml1.discMissing', { path: s.iso });
        const rows = s.install ? `
            <div class="install-info-section xml1-facts">
                ${row(t('xml1.rowFolder'), s.install, s.exists ? button('open-folder', t('xml1.open')) : '')}
                ${row(t('xml1.rowDisc'), discValue, button('change-disc', t('xml1.changeDisc'), working ? 'disabled' : ''))}
                ${row(t('xml1.rowBuild'), buildValue)}
                ${row(t('xml1.rowFix'), fixValue)}
                ${row(t('xml1.rowBuilder'), builderValue, !builder.installed && !builder.installing ? button('install-builder', t('xml1.installBuilder')) : '')}
                ${row(t('xml1.rowCache'), cacheValue, cache && cache.bytes > 0 ? button('free-cache', t('xml1.freeUp'), working ? 'disabled' : '') : '')}
            </div>` : '';

        const actions = [];
        if (state === 'building') {
            actions.push(button('cancel-build', t('xml1.cancelBuild'), job && job.cancelRequested ? 'disabled' : ''));
            actions.push(button('show-progress', t('xml1.showProgress')));
        } else if (s.install) {
            if (state === 'incomplete') actions.push(button('resume', t('xml1.resume')));
            else if (state === 'damaged') actions.push(button('rebuild', t('xml1.repair')), button('report', t('xml1.reportProblem')));
            else if (state === 'absent') actions.push(button('setup', t('xml1.build')));
            else if (state === 'needs-fix') actions.push(button('install-fix', t('xml1.installFix')));
            if (['ready', 'stale', 'needs-fix'].includes(state)) actions.push(button('rebuild', t('xml1.rebuild'), working ? 'disabled' : ''));
            if (s.build && s.build.stamp) actions.push(button('verify', t('xml1.verifyBuild'), working || !builder.installed ? 'disabled' : ''));
            actions.push(button('open-log', t('xml1.openLog')));
        } else {
            actions.push(button('setup', t('common.setUp')));
        }

        host.innerHTML = `
            <div class="ul-display xml1-view" data-state="${escapeHtml(state)}">
                <div class="xml1-state is-${escapeHtml(state)}">
                    <span class="xml1-state-name">${escapeHtml(t(`xml1.stateName.${state}`))}</span>
                    <span class="xml1-state-text">${escapeHtml(stateText(port))}</span>
                </div>
                ${progress}
                ${error}
                ${fixNote}
                ${state !== 'building' ? verifyHTML(port) : ''}
                ${state !== 'building' && !failed ? noticesHTML(port, job) : ''}
                ${rows}
                <div class="xml1-actions">${actions.join('')}</div>
            </div>`;

        host.querySelectorAll('[data-act]').forEach(element => {
            element.addEventListener('click', () => act(gameId, element.dataset.act));
        });
    }

    async function act(gameId, action) {
        const port = window.Xml1Port;
        const s = port.status;
        switch (action) {
            case 'setup':
            case 'show-progress':
            case 'change-disc':
                window.Xml1Setup.show();
                break;
            case 'resume':
                await port.primaryAction();
                break;
            case 'rebuild': {
                if (!port.canRebuild()) {
                    window.Xml1Setup.show();
                    break;
                }
                const choice = await window.showMessageBox(t('xml1.rebuildTitle'), GameUtils.escapeHtml(t('xml1.rebuildBody')),
                    [t('common.cancel'), t('xml1.rebuild')]);
                if (choice === 1) await port.resume();
                break;
            }
            case 'cancel-build':
                await port.confirmCancel();
                break;
            case 'install-fix':
                await port.installFix();
                break;
            case 'install-builder':
                await port.checkBuilder(true);
                port.refreshInfo();
                break;
            case 'verify': {
                const job = await port.verifyBuild();
                const verify = port.verify;
                if (!verify) {
                    window.showToast(port.jobError(job).title, 'error');
                } else if (verify.state === 'damaged') {
                    window.showToast(t('xml1.verifyDamaged', { count: port.damageCount(verify) }), 'error', 8000);
                } else {
                    window.showToast(t('xml1.verifyOk', { count: verify.files || 0 }), 'success');
                }
                break;
            }
            case 'open-log':
                if (!await port.openLog()) window.showToast(t('xml1.noLog'), 'info');
                break;
            case 'open-folder':
                run('open-folder', { path: s.install });
                break;
            case 'free-cache': {
                const size = port.info && port.info.cache ? bytes(port.info.cache.bytes) : '';
                const choice = await window.showMessageBox(t('xml1.freeUpTitle'), GameUtils.escapeHtml(t('xml1.freeUpBody', { size })),
                    [t('common.cancel'), { label: t('xml1.freeUp'), danger: true }]);
                if (choice === 1) await port.freeCache();
                break;
            }
            case 'copy-details':
                await port.copyDetails(port.build);
                break;
            case 'report':
                await port.report(port.build);
                break;
            default:
                break;
        }
        render(gameId);
    }

    window.addEventListener('ul-xml1-changed', () => {
        SUPPORTED.forEach(gameId => render(gameId));
    });

    // Opening the page refreshes what the builder says about the build.
    document.addEventListener('click', event => {
        const item = event.target.closest && event.target.closest('.game-item[data-game]');
        if (item && SUPPORTED.has(item.dataset.game) && window.Xml1Port) {
            setTimeout(async () => {
                await window.Xml1Port.refresh();
                window.Xml1Port.refreshInfo();
            }, 0);
        }
    }, true);

    window.Xml1View = {
        supports: gameId => SUPPORTED.has(gameId),
        render
    };
})();
