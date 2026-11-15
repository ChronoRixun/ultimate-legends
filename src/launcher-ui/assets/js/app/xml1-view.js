// The Build section of the X-Men Legends page (BUILDER_DESIGN.md 4.3, "Game page"): where the
// build stands (up to date, update available, resume, building, damaged, the XML2 Fix missing),
// the folder, the disc image, the builder and the build cache, and Rebuild / Verify build / Verify
// Files (an unfinished build's XML2 Fix) / Open build log / Change disc image / Free up. State and
// runs live in Xml1Port (xml1-port.js).
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

    // The tabbed page's persistent attention strip (above the tabs) and the Display & options tab's
    // Appearance host; without them (the page before tabs, the tests' bare panel) everything stays in the
    // Build panel as it was.
    function stripHost(gameId) {
        return document.getElementById(`${gameId}-attention`);
    }

    function appearanceHost(gameId) {
        return document.getElementById(`${gameId}-appearance-panel`);
    }

    // States the strip shows (the game can't simply be played): what the player can do about each.
    const STRIP_STATES = new Set(['not-setup', 'absent', 'building', 'finishing', 'incomplete', 'damaged', 'needs-fix']);

    function bytes(value) {
        return GameUtils.formatBytes(Math.max(0, Number(value) || 0));
    }

    function date(text) {
        const value = text ? new Date(text) : null;
        return value && !isNaN(value) ? value.toLocaleDateString() : '';
    }

    // `badge`: a Beta badge after the value (a pre-release builder or XML2 Fix, update-channel.js).
    function row(label, value, action, badge) {
        const beta = badge ? `<span class="beta-badge">${escapeHtml(t('updateChannel.badge'))}</span>` : '';
        return `
            <div class="install-info-row xml1-row">
                <span class="install-info-label">${escapeHtml(label)}</span>
                <span class="install-info-value xml1-row-value" title="${escapeHtml(value)}">${escapeHtml(value)}${beta}</span>
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
            case 'building': return port.build && port.build.cancelRequested ? t('xml1.cancelling') : port.build ? port.progressMessage(port.build) : t('xml1.buildingTitle');
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
        } else if (builder.code && s.install) {
            const described = port.describe({ code: builder.code, msg: builder.error });
            error = `<div class="xml1-note is-error">${escapeHtml(described.title)} ${escapeHtml(described.hint)}</div>`;
        }

        let fixNote = '';
        if (s.fix && s.fix.installed && !s.fix.ok) {
            fixNote = `<div class="xml1-note is-warn">${escapeHtml(t('xml1.fixOld', { version: s.fix.version || '?', required: s.fix.required }))}</div>`;
        }

        // Rows: what the page knows about the build.
        let builderValue;
        if (builder.installed && builder.checking) {
            builderValue = t('xml1.builderChecking', { version: builder.version });
        } else if (builder.installed) {
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
        // Nothing that writes the folder while a build runs or starts, or the port's patch work is queued or running.
        const blocked = port.buildBlocked();

        const discValue = !s.iso ? (s.cacheHasDisc ? t('xml1.discInCache') : t('xml1.none'))
            : s.isoExists ? s.iso : t(s.cacheHasDisc ? 'xml1.discMissingCached' : 'xml1.discMissing', { path: s.iso });
        const rows = s.install ? `
            <div class="install-info-section xml1-facts">
                ${row(t('xml1.rowFolder'), s.install, s.exists ? button('open-folder', t('xml1.open')) : '')}
                ${row(t('xml1.rowDisc'), discValue, button('change-disc', t('xml1.changeDisc'), working ? 'disabled' : ''))}
                ${row(t('xml1.rowBuild'), buildValue)}
                ${row(t('xml1.rowFix'), fixValue, '', !!(s.fix && s.fix.installed && /-/.test(s.fix.version || '')))}
                ${row(t('xml1.rowBuilder'), builderValue, !builder.installed && !builder.installing ? button('install-builder', t('xml1.installBuilder'))
                    : builder.installed ? button('check-builder', t('xml1.checkUpdates'), builder.checking || builder.installing || working || window.IS_OFFLINE ? 'disabled' : '') : '',
                    !!(builder.installed && builder.prerelease))}
                ${row(t('xml1.rowCache'), cacheValue, cache && cache.bytes > 0 ? button('free-cache', t('xml1.freeUp'), working ? 'disabled' : '') : '')}
            </div>` : '';

        const actions = [];
        const saveImport = !!(window.Xml1SaveImport && window.Xml1SaveImport.enabled === true);
        if (s.install && s.build && s.build.stamp && saveImport) {
            actions.push(button('import-save', t('saveImport.title'), blocked || s.running ? 'disabled' : ''));
        }
        if (state === 'building') {
            actions.push(button('cancel-build', t('xml1.cancelBuild'), job && job.cancelRequested ? 'disabled' : ''));
            actions.push(button('show-progress', t('xml1.showProgress')));
        } else if (s.install) {
            const disabled = blocked ? 'disabled' : '';
            if (state === 'incomplete') {
                actions.push(button('resume', t('xml1.resume'), disabled));
                // The game is in the folder: its XML2 Fix can be installed or updated (verify-game).
                if (port.canVerifyUnfinished()) actions.push(button('verify-files', t('common.verify'), disabled));
            } else if (state === 'damaged') actions.push(button('rebuild', t('xml1.repair'), disabled), button('report', t('xml1.reportProblem')));
            else if (state === 'absent') actions.push(button('setup', t('xml1.build')));
            else if (state === 'needs-fix' || (s.fix && s.fix.installed && !s.fix.ok))
                actions.push(button('install-fix', t('xml1.installFix'), disabled));
            if (['ready', 'stale', 'needs-fix'].includes(state)) actions.push(button('rebuild', t('xml1.rebuild'), disabled));
            if (s.build && s.build.stamp) actions.push(button('verify', t('xml1.verifyBuild'), blocked || !builder.installed ? 'disabled' : ''));
            actions.push(button('open-log', t('xml1.openLog')));
        } else {
            actions.push(button('setup', t('common.setUp')));
        }

        // The attention strip above the tabs: the state, the build's progress and the one thing to do
        // (Details opens Build & tools); the Build panel then leaves out the pill, the bar and those buttons.
        const strip = stripHost(gameId);
        const stripShown = !!strip && STRIP_STATES.has(state);
        const stripActs = new Set();
        if (strip) {
            if (stripShown) {
                const stripActions = [];
                const take = (action, label, extra) => {
                    stripActs.add(action);
                    stripActions.push(button(action, label, extra));
                };
                const disabled = blocked ? 'disabled' : '';
                // Set up / Build stay in the Build panel too: before a first build it is that tab's one action.
                if (state === 'not-setup') stripActions.push(button('setup', t('common.setUp')));
                else if (state === 'absent') stripActions.push(button('setup', t('xml1.build')));
                else if (state === 'building') {
                    take('cancel-build', t('xml1.cancelBuild'), job && job.cancelRequested ? 'disabled' : '');
                    take('show-progress', t('xml1.showProgress'));
                } else if (state === 'incomplete') take('resume', t('xml1.resume'), disabled);
                else if (state === 'damaged') take('rebuild', t('xml1.repair'), disabled);
                else if (state === 'needs-fix') take('install-fix', t('xml1.installFix'), disabled);
                if (!['not-setup', 'absent', 'building', 'finishing'].includes(state)) {
                    stripActions.push(`<button type="button" class="secondary-action xml1-small" data-goto-tab="build">${escapeHtml(t('gameTabs.details'))}</button>`);
                }
                const focused = strip.contains(document.activeElement) ? document.activeElement : null;
                const stripFocus = focused && focused.dataset ? (focused.dataset.act || focused.dataset.gotoTab || '') : '';
                strip.innerHTML = `
                    <div class="xml1-state xml1-attention is-${escapeHtml(state)}" data-state="${escapeHtml(state)}" role="status">
                        <span class="xml1-state-name">${escapeHtml(t(`xml1.stateName.${state}`))}</span>
                        <span class="xml1-state-text">${escapeHtml(stateText(port))}${progress}</span>
                        ${stripActions.length ? `<span class="xml1-attention-actions">${stripActions.join('')}</span>` : ''}
                    </div>`;
                strip.hidden = false;
                strip.querySelectorAll('[data-act]').forEach(element => {
                    element.addEventListener('click', () => act(gameId, element.dataset.act));
                });
                const details = strip.querySelector('[data-goto-tab]');
                if (details) {
                    details.addEventListener('click', () => {
                        if (window.GameTabs) window.GameTabs.select(gameId, 'build', { user: true, focus: true });
                    });
                }
                if (stripFocus) {
                    const again = strip.querySelector(`[data-act="${stripFocus}"]`) || strip.querySelector(`[data-goto-tab="${stripFocus}"]`);
                    if (again && !again.disabled) again.focus();
                }
            } else {
                const hadFocus = strip.contains(document.activeElement);
                strip.hidden = true;
                strip.innerHTML = '';
                // A keyboard or controller user who pressed the strip's last button lands on Play.
                if (hadFocus) {
                    const group = document.getElementById(`${gameId}-button-group`);
                    const next = group && [...group.querySelectorAll('button')].find(item => !item.disabled);
                    if (next) next.focus();
                }
            }
        }

        const updatesRow = s.install && strip ? channelRow() : '';
        const appearanceTarget = appearanceHost(gameId) || host;
        const appearanceFocus = appearanceTarget.contains(document.activeElement) && document.activeElement?.dataset?.option === 'classicConversation';
        const appearance = builder.installed && builder.classicConversation ? `
            <div class="xml1-appearance">
                ${appearanceTarget === host ? `<h3>${escapeHtml(t('xml1.appearance'))}</h3>` : ''}
                <label class="xml1-option">
                    <span class="xml1-option-text"><strong>${escapeHtml(t('xml1.classicConversation'))}</strong>
                        <small>${escapeHtml(t('xml1.classicConversationBody'))}</small></span>
                    <span class="ul-mod-toggle"><input type="checkbox" data-option="classicConversation"
                        ${s.classicConversation !== false ? 'checked' : ''} ${blocked ? 'disabled' : ''}><span class="ul-mod-switch"></span></span>
                </label>
            </div>` : '';
        const importFocus = window.Xml1SaveImport && window.Xml1SaveImport.captureFocus();
        const shownActions = actions.filter(html => !stripActs.has((/data-act="([^"]+)"/.exec(html) || [])[1]));
        host.innerHTML = `
            <div class="ul-display xml1-view" data-state="${escapeHtml(state)}">
                ${stripShown ? '' : `<div class="xml1-state is-${escapeHtml(state)}">
                    <span class="xml1-state-name">${escapeHtml(t(`xml1.stateName.${state}`))}</span>
                    <span class="xml1-state-text">${escapeHtml(stateText(port))}</span>
                </div>
                ${progress}`}
                ${error}
                ${fixNote}
                ${state !== 'building' ? verifyHTML(port) : ''}
                ${state !== 'building' && !failed ? noticesHTML(port, job) : ''}
                ${rows}
                ${updatesRow}
                ${appearanceTarget === host ? appearance : ''}
                ${shownActions.length ? `<div class="xml1-actions">${shownActions.join('')}</div>` : ''}
                ${saveImport ? '<div id="xml1-save-import"></div>' : ''}
            </div>`;
        if (appearanceTarget !== host) {
            appearanceTarget.innerHTML = appearance;
            // Without a builder that offers it there is nothing to show: the section goes, title and all.
            const section = appearanceTarget.closest ? appearanceTarget.closest('section') : null;
            if (section) section.hidden = !appearance;
        }

        const appearanceBox = appearanceTarget.querySelector('[data-option="classicConversation"]');
        if (appearanceBox) {
            appearanceBox.addEventListener('change', () => port.setClassicConversation(appearanceBox.checked));
            if (appearanceFocus) appearanceBox.focus();
        }
        if (saveImport) window.Xml1SaveImport.mount(importFocus);
        host.querySelectorAll('[data-act]').forEach(element => {
            element.addEventListener('click', () => act(gameId, element.dataset.act));
        });
        const channelButton = host.querySelector('[data-op="open-channel"]');
        if (channelButton) {
            channelButton.addEventListener('click', () => {
                if (window.UpdateChannel) window.UpdateChannel.openSetting();
            });
        }
    }

    // Build & tools: the builder and the XML2 Fix come from the launcher's update channel (Settings >
    // Updates), so the tab says which one and leads there.
    function channelRow() {
        const channel = window.UpdateChannel && typeof window.UpdateChannel.channel === 'function' && window.UpdateChannel.status
            ? window.UpdateChannel.channel() : '';
        const value = channel === 'beta' ? t('gameTabs.updatesBeta') : channel === 'stable' ? t('gameTabs.updatesStable') : t('gameTabs.updatesChannel');
        const action = window.UpdateChannel && typeof window.UpdateChannel.openSetting === 'function'
            ? `<button type="button" class="secondary-action xml1-small" data-op="open-channel">${escapeHtml(t('online.openUpdateChannel'))}</button>` : '';
        return `
            <div class="install-info-section xml1-facts xml1-updates">
                ${row(t('gameTabs.updatesRow'), value, action)}
            </div>`;
    }

    // Rebuild (this page, and the Online section when the build is older than the XML2 Fix): from the disc
    // image the port remembers, after a confirmation; without one, setup asks for it.
    async function rebuild() {
        const port = window.Xml1Port;
        if (!port.canRebuild()) {
            window.Xml1Setup.show();
            return;
        }
        const choice = await window.showMessageBox(t('xml1.rebuildTitle'), GameUtils.escapeHtml(t('xml1.rebuildBody')),
            [t('common.cancel'), t('xml1.rebuild')]);
        if (choice === 1) await port.resume();
    }

    async function act(gameId, action) {
        const port = window.Xml1Port;
        const s = port.status;
        switch (action) {
            case 'import-save':
                if (window.Xml1SaveImport) window.Xml1SaveImport.open();
                break;
            case 'setup':
            case 'show-progress':
            case 'change-disc':
                window.Xml1Setup.show();
                break;
            case 'resume':
                await port.primaryAction();
                break;
            case 'rebuild':
                await rebuild();
                break;
            case 'cancel-build':
                await port.confirmCancel();
                break;
            case 'install-fix':
                await port.installFix();
                break;
            case 'verify-files':
                await port.installFix('verify');
                break;
            case 'install-builder':
                await port.checkBuilder(true);
                port.refreshInfo();
                break;
            case 'check-builder': {
                const before = s && s.builder ? s.builder.version : '';
                const builder = await port.checkBuilder(true);
                if (!builder || !builder.installed) {
                    const described = port.describe({ code: (builder && builder.code) || 'L_BUILDER_OFFLINE', msg: builder ? builder.error : '' });
                    window.showToast(described.title, 'error', 6000);
                } else if (builder.version !== before) {
                    window.showToast(t('xml1.builderInstalled', { version: builder.version }), 'success', 6000);
                } else {
                    window.showToast(t('xml1.builderUpToDate', { version: builder.version }), 'info');
                }
                port.refreshInfo();
                break;
            }
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
    // The port's patch work coming and going in the download queue enables or disables the build buttons.
    window.addEventListener('ul-download-queue-changed', () => {
        SUPPORTED.forEach(gameId => render(gameId));
    });

    // Opening the page refreshes what the builder says about the build.
    document.addEventListener('click', event => {
        const item = event.target.closest && event.target.closest('.game-item[data-game]');
        if (item && SUPPORTED.has(item.dataset.game) && window.Xml1Port) {
            setTimeout(async () => {
                await window.Xml1Port.refresh();
                window.Xml1Port.refreshInfo();
                window.Xml1Port.checkBuilderIfDue(5 * 60 * 1000);
            }, 0);
        }
    }, true);

    // The X-Men Legends page's tabs (TAB-MAP.md, Owen's decisions 2026-11-11): Online, Display & options,
    // Characters and Mods exist once a build has put the game in its folder; a state the player must act on
    // opens Build & tools once. Not set up / absent need no override: only Overview and Build & tools
    // exist then, Overview shows and the strip offers Set up, and the remembered tab returns after the build.
    const OVERRIDES = { building: 'build', damaged: 'build', 'needs-fix': 'build', incomplete: 'build' };

    function hasGame() {
        const port = window.Xml1Port;
        const s = port && port.status;
        if (!s || !s.install || s.exists === false || !s.build) return false;
        if (['not-setup', 'absent', 'loading'].includes(port.state())) return false;
        return !!(s.build.stamp || s.build.game);
    }

    let testersWereOn = false;
    if (window.GameTabs) {
        window.GameTabs.define('xml1', {
            fallback: 'overview',
            tabs: [
                { id: 'overview', label: 'gameTabs.overview' },
                { id: 'online', label: 'gameTabs.online', available: hasGame },
                { id: 'options', label: 'gameTabs.options', available: hasGame },
                { id: 'characters', label: 'gameTabs.characters', available: hasGame },
                { id: 'mods', label: 'gameTabs.mods', available: hasGame },
                { id: 'build', label: 'gameTabs.build', always: true }
            ],
            override() {
                const port = window.Xml1Port;
                const state = port && port.status ? port.state() : 'loading';
                return { state, tab: OVERRIDES[state] || null };
            },
            // "For testers" opens by itself when a test switch turns on (the badge by Play says so too).
            onRefresh() {
                const on = !!(window.TestModeView && window.TestModeView.isOn('xml1'));
                const details = document.getElementById('xml1-testers');
                if (details && on && !testersWereOn) details.open = true;
                testersWereOn = on;
            }
        });
    }

    window.Xml1View = {
        supports: gameId => SUPPORTED.has(gameId),
        render,
        rebuild
    };
})();
