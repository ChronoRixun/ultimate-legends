// Character models section of the X-Men Legends page: optional character-model mods built on this PC by
// the legends-models tool (LAUNCHER-API.md, API 1) from games the player owns. The player picks an
// appearance (Off / Community pack / Upgraded, and under More: Sharpened classic / XML2 look), sees per
// hero which source the tool would use and why, picks a costume where a source has several, and Applies.
// The launcher never ships a model: Apply runs `build` against the player's own installs and the tool
// writes <port>\mods\<Tier>-<Hero> folders plus their load-order lines; Off runs `remove`.
//
// The page talks to the tool only through models_commands.cpp: get-models-status (the tool, the port,
// the MUA1/MUA2 folders the launcher knows, the stored choices, the legends-models folders in mods\),
// models-run (scan / plan / build / verify / remove, by name - the C++ builds the command line from
// checked values) and get-models-job (the run's JSON lines from an index, so each event arrives once).
// Opening the page scans, plans the chosen appearance and verifies the installed one.
(function () {
    'use strict';

    const SUPPORTED = new Set(['xml1']);
    const API = 1;
    const POLL_MS = 300;
    const MODES = ['community', 'upgraded', 'sharpen', 'xml2'];
    const MORE_MODES = ['sharpen', 'xml2'];
    const PACKS = { community: 'Models-Community', upgraded: 'Models-Upgraded', xml2: 'Models-XML2-Look', sharpen: 'Models-Sharpened' };
    // The tool's exit codes (LAUNCHER-API.md); models_args::exit_name gives the same names.
    const EXIT_NAMES = { 0: 'ok', 10: 'partial', 11: 'nothing', 3: 'missing_input', 20: 'download', 30: 'verify_mismatch',
        40: 'unsafe', 2: 'usage', 1: 'bug', 130: 'cancelled' };

    const state = {};
    const escapeHtml = value => GameUtils.escapeHtml(value);

    function t(key, variables) {
        return window.LauncherI18n ? window.LauncherI18n.t(key, variables) : key;
    }

    function has(key) {
        return t(key) !== key;
    }

    function run(command, payload) {
        return window.executeCommand(command, payload);
    }

    function panel(gameId) {
        return document.getElementById(`${gameId}-models-panel`);
    }

    function getState(gameId) {
        if (!state[gameId]) {
            state[gameId] = {
                status: null,      // get-models-status
                scan: null,        // the scan result (installs, helpers, heroes)
                plan: null,        // { mode, pack, rows } of the chosen mode
                chosen: null,      // the appearance picked on the page (applied on Apply)
                job: null,         // the run shown: { command, id, events state... }
                verify: null,      // the last verify result of the installed group
                credits: null,     // [{ folder, text }] of the installed group
                outcome: null,     // the last build / remove: { kind, text, details }
                loading: false,
                refreshing: null,
                mirrorOpen: false
            };
        }
        return state[gameId];
    }

    function bytes(value) {
        const n = Number(value) || 0;
        return n > 0 ? GameUtils.formatBytes(n) : '';
    }

    // ---- what is installed ----

    // The legends-models folders of the installed appearance: the enabled group (the tool keeps one
    // appearance enabled at a time), else the group of any folder that is there.
    function installedGroup(s) {
        const folders = (s.status && s.status.installed) || [];
        const enabled = folders.find(folder => folder.enabled);
        const any = enabled || folders[0];
        if (!any) return null;
        const group = any.group;
        const members = folders.filter(folder => folder.group === group);
        const characters = {};
        members.forEach(folder => (folder.characters || []).forEach(character => {
            characters[character.hero] = Object.assign({ folder: folder.folder, enabled: folder.enabled }, character);
        }));
        return {
            group,
            mode: any.mode || Object.keys(PACKS).find(mode => PACKS[mode] === group) || '',
            enabled: members.some(folder => folder.enabled),
            folders: members.map(folder => folder.folder),
            credits: members.some(folder => folder.credits),
            characters
        };
    }

    function allGroups(s) {
        const folders = (s.status && s.status.installed) || [];
        return [...new Set(folders.map(folder => folder.group).filter(Boolean))];
    }

    function upgradedAvailable(s) {
        const installs = s.scan && s.scan.installs;
        if (installs) return !!((installs.mua1 && installs.mua1.found) || (installs.mua2 && installs.mua2.found));
        const known = s.status && s.status.installs;
        return !!(known && (known.mua1 || known.mua2));
    }

    function currentMode(s) {
        if (s.chosen) return s.chosen;
        const group = installedGroup(s);
        if (group && group.enabled && MODES.includes(group.mode)) return group.mode;
        const stored = s.status && s.status.settings ? s.status.settings.mode : '';
        if (stored === 'off' || MODES.includes(stored)) return stored;
        return 'community'; // the suggestion: needs nothing else
    }

    // ---- the tool's events ----

    // A fresh view of one run, fed event by event (applyEvent), whatever its command.
    function newRun(command, extra) {
        return Object.assign({
            command, id: null, from: 0, active: true, finished: false, cancelRequested: false, exitCode: null, exitName: '',
            plan: null, done: 0, total: 0, message: '', stage: '', heroes: {}, downloads: [], warnings: [], errors: [],
            gates: [], result: null, unknownApi: false, stderrTail: [], startError: ''
        }, extra || {});
    }

    function heroEntry(job, hero) {
        if (!job.heroes[hero]) job.heroes[hero] = { status: 'planned', reason: '', tier: '' };
        return job.heroes[hero];
    }

    // One JSON event of the tool (LAUNCHER-API.md "Events") into the run's view.
    function applyEvent(job, event) {
        if (!event || typeof event !== 'object' || typeof event.event !== 'string') return job;
        if (event.api !== undefined && event.api !== API) job.unknownApi = true;
        switch (event.event) {
            case 'plan':
                job.plan = { mode: event.mode, rows: Array.isArray(event.rows) ? event.rows : [] };
                job.plan.rows.forEach(row => {
                    if (!row || typeof row.hero !== 'string') return;
                    const entry = heroEntry(job, row.hero);
                    entry.tier = row.tier;
                    entry.status = row.tier === 'stock' ? 'stock' : 'planned';
                    entry.reason = row.tier === 'stock' ? String(row.reason || '') : '';
                });
                break;
            case 'stage':
                job.stage = String(event.stage || '');
                job.message = String(event.message || '');
                if (typeof event.hero === 'string' && job.stage === 'convert') {
                    const entry = heroEntry(job, event.hero);
                    if (entry.status === 'planned' || entry.status === 'trying') {
                        entry.status = 'converting';
                        if (event.tier) entry.tier = event.tier;
                    }
                }
                break;
            case 'progress':
                job.done = Math.max(0, Number(event.done) || 0);
                job.total = Math.max(0, Number(event.total) || 0);
                if (event.message) job.message = String(event.message);
                break;
            case 'cache':
                if (typeof event.hero === 'string' && event.hit) heroEntry(job, event.hero).cached = true;
                break;
            case 'download':
                job.downloads.push({
                    archive: String(event.archive || ''), source: String(event.source || ''),
                    bytes: Number(event.bytes) || 0, sha256: typeof event.sha256 === 'string' ? event.sha256 : ''
                });
                break;
            case 'gate': {
                job.gates.push(event);
                if (typeof event.hero !== 'string') break;
                const entry = heroEntry(job, event.hero);
                if (event.passed) {
                    entry.status = 'passed';
                    entry.tier = event.tier || entry.tier;
                    entry.reason = '';
                } else {
                    // A failure moves the hero to its next tier (or leaves it stock at the end).
                    entry.status = 'trying';
                    entry.reason = (Array.isArray(event.failures) && event.failures.length ? String(event.failures[0]) : '') ||
                        t('models.status.gateFailed', { tier: tierName(event.tier) });
                }
                break;
            }
            case 'warning':
                job.warnings.push({ message: String(event.message || ''), hero: event.hero || '' });
                break;
            case 'error':
                job.errors.push({ message: String(event.message || ''), code: event.code });
                break;
            case 'result':
                job.result = event;
                if (job.command === 'build') applyBuildResult(job, event);
                break;
            default:
                break; // workspace, engine, ...: nothing to show
        }
        return job;
    }

    // The build's last line: characters built, refused (failed with the last reason) and stock.
    function applyBuildResult(job, result) {
        const characters = result.characters && typeof result.characters === 'object' ? result.characters : {};
        Object.keys(characters).forEach(hero => {
            const entry = heroEntry(job, hero);
            entry.status = 'built';
            entry.tier = characters[hero].tier || entry.tier;
            entry.source = characters[hero].source;
            entry.reason = '';
        });
        const refused = result.refused && typeof result.refused === 'object' ? result.refused : {};
        Object.keys(refused).forEach(hero => {
            const entry = heroEntry(job, hero);
            const attempts = Array.isArray(refused[hero].attempts) ? refused[hero].attempts : [];
            const last = attempts[attempts.length - 1] || {};
            const failure = (Array.isArray(last.failures) && last.failures[0]) || last.reason || last.message || entry.reason;
            entry.status = 'failed';
            entry.reason = String(failure || t('models.status.refused'));
        });
        const stock = result.stock && typeof result.stock === 'object' ? result.stock : {};
        Object.keys(stock).forEach(hero => {
            const entry = heroEntry(job, hero);
            if (entry.status !== 'built' && entry.status !== 'failed') {
                entry.status = 'stock';
                entry.reason = String(stock[hero] || '');
            }
        });
        // Anything still in progress when the run ended did not make it.
        Object.values(job.heroes).forEach(entry => {
            if (['planned', 'converting', 'trying', 'passed'].includes(entry.status)) entry.status = 'stock';
        });
    }

    // Starts `command` and feeds its events to `job` until it ends. Resolves the finished job.
    async function runTool(gameId, job, payload) {
        const s = getState(gameId);
        let started;
        try {
            started = await run('models-run', Object.assign({ command: job.command }, payload || {}));
        } catch (error) {
            started = { success: false, code: 'L_TOOL_START', error: String((error && error.message) || error) };
        }
        if (!started || !started.success) {
            job.active = false;
            job.finished = true;
            job.exitCode = -1;
            job.startError = (started && started.error) || '';
            job.startCode = (started && started.code) || 'L_TOOL_START';
            return job;
        }
        job.id = started.id;
        for (;;) {
            let snapshot = null;
            try {
                snapshot = await run('get-models-job', { id: job.id, from: job.from });
            } catch (error) {
                snapshot = null;
            }
            if (!snapshot) {
                job.active = false;
                job.finished = true;
                job.exitCode = -1;
                return job;
            }
            (snapshot.lines || []).forEach(line => {
                let event = null;
                try {
                    event = JSON.parse(line);
                } catch (error) {
                    return; // not an event: in the launcher log
                }
                applyEvent(job, event);
            });
            job.from = (Number(snapshot.first) || 0) + (snapshot.lines || []).length;
            job.cancelRequested = !!snapshot.cancelRequested;
            job.stderrTail = snapshot.stderrTail || [];
            if (s.job === job) update(gameId);
            if (snapshot.finished) {
                job.active = false;
                job.finished = true;
                job.exitCode = snapshot.exitCode;
                job.exitName = snapshot.exitName || EXIT_NAMES[snapshot.exitCode] || 'unknown';
                if (snapshot.startError) job.startError = snapshot.startError;
                return job;
            }
            await new Promise(resolve => setTimeout(resolve, POLL_MS));
        }
    }

    // What a finished run's result is, or null (failed to start, crashed, cancelled).
    function resultOf(job) {
        return job && job.result && typeof job.result === 'object' ? job.result : null;
    }

    function failureText(job) {
        if (!job) return '';
        if (job.startCode && has(`models.errors.${job.startCode}`)) return t(`models.errors.${job.startCode}`);
        if (job.startError) return job.startError;
        const error = job.errors[job.errors.length - 1];
        const named = job.exitName && has(`models.exit.${job.exitName}`) ? t(`models.exit.${job.exitName}`) : t('models.exit.unknown', { code: job.exitCode });
        return error && error.message ? `${named} ${error.message}` : named;
    }

    // ---- refresh: status, scan, plan, verify, credits ----

    async function loadStatus(gameId) {
        const s = getState(gameId);
        try {
            s.status = await run('get-models-status', {});
        } catch (error) {
            console.error(error);
            s.status = null;
        }
        return s.status;
    }

    function ready(s) {
        return !!(s.status && s.status.tool && s.status.tool.found && s.status.port && s.status.port.built);
    }

    async function refresh(gameId, { rescan = false } = {}) {
        const s = getState(gameId);
        if (s.refreshing) return s.refreshing;
        s.refreshing = (async () => {
            s.loading = true;
            render(gameId);
            await loadStatus(gameId);
            if (ready(s) && !(s.job && s.job.active) && !s.status.busy) {
                if (!s.scan || rescan) {
                    const scan = await runTool(gameId, newRun('scan'));
                    s.scan = resultOf(scan) || s.scan;
                    if (!resultOf(scan)) s.outcome = { kind: 'error', text: failureText(scan) };
                }
                await plan(gameId, false);
                await verifyInstalled(gameId, false);
                await loadCredits(gameId);
            }
            s.loading = false;
            render(gameId);
        })();
        try {
            await s.refreshing;
        } finally {
            s.refreshing = null;
        }
    }

    async function plan(gameId, draw = true) {
        const s = getState(gameId);
        const mode = currentMode(s);
        if (mode === 'off' || !ready(s)) {
            s.plan = null;
            if (draw) render(gameId);
            return;
        }
        const job = await runTool(gameId, newRun('plan'), { mode });
        const result = resultOf(job);
        s.plan = result && Array.isArray(result.rows) ? { mode, pack: result.pack, rows: result.rows } : null;
        if (!result) s.outcome = { kind: 'error', text: failureText(job) };
        if (draw) render(gameId);
    }

    async function verifyInstalled(gameId, draw = true) {
        const s = getState(gameId);
        const group = installedGroup(s);
        if (!group || !ready(s)) {
            s.verify = null;
            return;
        }
        const job = await runTool(gameId, newRun('verify'), { pack: group.group });
        s.verify = resultOf(job) ? Object.assign({ group: group.group }, resultOf(job)) : null;
        if (draw) render(gameId);
    }

    async function loadCredits(gameId) {
        const s = getState(gameId);
        const group = installedGroup(s);
        if (!group || !group.credits) {
            s.credits = null;
            return;
        }
        try {
            const answer = await run('get-models-credits', { group: group.group });
            s.credits = answer && Array.isArray(answer.credits) ? answer.credits : null;
        } catch (error) {
            s.credits = null;
        }
    }

    // ---- actions ----

    function blockedReason(s) {
        if (!s.status) return t('models.loading');
        if (!s.status.tool || !s.status.tool.found) return t('models.toolMissing');
        if (!s.status.port || !s.status.port.built) return t('models.buildFirst');
        if (s.status.port.running) return t('models.gameRunning');
        if (s.status.xml1Busy || (window.Xml1Port && window.Xml1Port.isWorking && window.Xml1Port.isWorking())) return t('models.buildRunning');
        return '';
    }

    async function choose(gameId, mode) {
        const s = getState(gameId);
        if (mode === 'upgraded' && !upgradedAvailable(s)) return;
        if (s.job && s.job.active) return;
        s.chosen = mode;
        s.outcome = null;
        render(gameId);
        await plan(gameId);
    }

    async function chooseCostume(gameId, hero, tier, costume) {
        const s = getState(gameId);
        const costumes = Object.assign({}, (s.status && s.status.settings && s.status.settings.costumes) || {});
        costumes[hero] = tier ? `${tier}:${costume}` : costume;
        try {
            const saved = await run('set-models-settings', { costumes });
            if (!saved || !saved.success) throw new Error((saved && saved.error) || t('models.saveFailed'));
            if (s.status) s.status.settings = saved.settings;
        } catch (error) {
            window.showToast(String((error && error.message) || error), 'error');
        }
        await plan(gameId);
    }

    async function apply(gameId) {
        const s = getState(gameId);
        if (blockedReason(s) || (s.job && s.job.active)) return;
        const mode = currentMode(s);
        if (mode === 'off') return removeAll(gameId, false);

        s.outcome = null;
        s.job = newRun('build', { mode });
        render(gameId);
        const job = await runTool(gameId, s.job, { mode });
        const result = resultOf(job);
        if (result && (job.exitCode === 0 || job.exitCode === 10)) {
            const built = Object.keys(result.characters || {}).length;
            const stock = Object.keys(result.stock || {}).length + Object.keys(result.refused || {}).length;
            s.outcome = {
                kind: job.exitCode === 0 ? 'success' : 'warn',
                text: job.exitCode === 0 ? t('models.applied', { count: built }) : t('models.appliedPartial', { count: built, stock })
            };
            try {
                await run('set-models-settings', { mode });
            } catch (error) {
                console.error(error);
            }
        } else if (job.exitCode === 130) {
            s.outcome = { kind: 'info', text: t('models.cancelled') };
        } else {
            s.outcome = { kind: 'error', text: failureText(job), details: job.stderrTail };
        }
        s.chosen = null;
        await loadStatus(gameId);
        await verifyInstalled(gameId, false);
        await loadCredits(gameId);
        render(gameId);
    }

    // Off: every legends-models group removed (folders and load-order lines), the stock look back.
    async function removeAll(gameId, ask = true) {
        const s = getState(gameId);
        if (blockedReason(s) || (s.job && s.job.active)) return;
        const groups = allGroups(s);
        if (!groups.length) return;
        if (ask) {
            const choice = await window.showMessageBox(t('models.removeTitle'), escapeHtml(t('models.removeBody')),
                [t('common.cancel'), { label: t('models.remove'), danger: true }]);
            if (choice !== 1) return;
        }
        s.outcome = null;
        let failed = null;
        for (const group of groups) {
            s.job = newRun('remove', { pack: group });
            render(gameId);
            const job = await runTool(gameId, s.job, { pack: group });
            if (!resultOf(job) || job.exitCode !== 0) {
                failed = job;
                break;
            }
        }
        s.outcome = failed ? { kind: 'error', text: failureText(failed), details: failed.stderrTail } : { kind: 'success', text: t('models.removed') };
        if (!failed) {
            try {
                await run('set-models-settings', { mode: 'off' });
            } catch (error) {
                console.error(error);
            }
        }
        s.chosen = null;
        s.verify = null;
        s.credits = null;
        await loadStatus(gameId);
        await plan(gameId, false);
        render(gameId);
    }

    async function cancel(gameId) {
        const s = getState(gameId);
        if (!s.job || !s.job.active || !s.job.id) return;
        const choice = await window.showMessageBox(t('models.cancelTitle'), escapeHtml(t('models.cancelBody')),
            [t('models.keepGoing'), { label: t('models.cancel'), danger: true }]);
        if (choice !== 1) return;
        await run('models-cancel', { id: s.job.id });
        s.job.cancelRequested = true;
        render(gameId);
    }

    async function saveMirror(gameId, value) {
        const s = getState(gameId);
        const mirror = String(value || '').trim();
        if (mirror && !/^https:\/\/[^\s/"'<>\\]+/.test(mirror)) {
            window.showToast(t('models.mirrorInvalid'), 'error');
            return;
        }
        try {
            const saved = await run('set-models-settings', { mirror });
            if (!saved || !saved.success) throw new Error((saved && saved.error) || t('models.saveFailed'));
            if (s.status) s.status.settings = saved.settings;
            window.showToast(t(mirror ? 'models.mirrorSaved' : 'models.mirrorReset'), 'success');
        } catch (error) {
            window.showToast(String((error && error.message) || error), 'error');
        }
        render(gameId);
    }

    // ---- markup ----

    function tierName(tier) {
        return has(`models.tier.${tier}`) ? t(`models.tier.${tier}`) : String(tier || '');
    }

    // The costumes a hero's source tier offers (scan): strings, or objects with id / label / author /
    // credit / preview when the tool sends them.
    function costumesOf(s, hero, tier) {
        const info = s.scan && s.scan.heroes && s.scan.heroes[hero];
        const entry = info && info.tiers && info.tiers[tier];
        if (!entry) return [];
        const list = Array.isArray(entry.costume_info) && entry.costume_info.length ? entry.costume_info
            : (Array.isArray(entry.costumes) ? entry.costumes : []);
        return list.map(item => (typeof item === 'string' ? { id: item } : item))
            .filter(item => item && typeof item.id === 'string' && item.id)
            .map(item => Object.assign({ author: item.author || entry.author || '' }, item));
    }

    // Who made it / where it comes from, for the costume shown.
    function creditText(tier, costume) {
        if (costume && costume.credit) return String(costume.credit);
        if (costume && costume.author) return t('models.credit.by', { author: costume.author });
        return has(`models.credit.${tier}`) ? t(`models.credit.${tier}`) : '';
    }

    function statusOf(s, row) {
        const job = s.job && s.job.command === 'build' ? s.job : null;
        if (job && job.heroes[row.hero] && (job.active || job.finished)) return job.heroes[row.hero];
        if (row.tier === 'stock') return { status: 'stock', reason: row.reason || '' };
        const group = installedGroup(s);
        const installed = group && group.enabled && group.characters[row.hero];
        if (installed && group.mode === (s.plan && s.plan.mode)) {
            const same = installed.tier === row.tier && String(installed.source) === String(row.source);
            return same ? { status: 'built', reason: '' } : { status: 'changes', reason: t('models.status.changesOnApply') };
        }
        return { status: 'planned', reason: '' };
    }

    function statusHTML(entry) {
        const label = has(`models.status.${entry.status}`) ? t(`models.status.${entry.status}`) : entry.status;
        return `<span class="ul-models-status is-${escapeHtml(entry.status)}">${escapeHtml(label)}</span>` +
            (entry.reason ? `<span class="ul-models-reason">${escapeHtml(entry.reason)}</span>` : '');
    }

    function costumeHTML(s, row, disabled) {
        if (row.tier === 'stock') return `<span class="ul-models-none">${escapeHtml(t('models.noCostume'))}</span>`;
        const costumes = costumesOf(s, row.hero, row.tier);
        const current = costumes.find(item => item.id === String(row.source)) || { id: String(row.source || '') };
        if (!costumes.find(item => item.id === current.id) && current.id) costumes.unshift(current);
        const credit = creditText(row.tier, current);
        const preview = current.preview && /^data:image\/(png|jpeg);base64,/.test(current.preview)
            ? `<img class="ul-models-preview" alt="" src="${escapeHtml(current.preview)}">` : '';
        const control = costumes.length > 1
            ? `<select class="setting-select ul-models-costume" data-hero="${escapeHtml(row.hero)}" data-tier="${escapeHtml(row.tier)}" data-focus="costume-${escapeHtml(row.hero)}"
                    aria-label="${escapeHtml(t('models.costumeFor', { hero: row.name || row.hero }))}"${disabled ? ' disabled' : ''}>
                    ${costumes.map(item => `<option value="${escapeHtml(item.id)}"${item.id === current.id ? ' selected' : ''}>${escapeHtml(item.label || item.id)}${item.author ? ` · ${escapeHtml(item.author)}` : ''}</option>`).join('')}
               </select>
               <span class="ul-models-count">${escapeHtml(t('models.costumeCount', { count: costumes.length }))}</span>`
            : `<span class="ul-models-costume-name">${escapeHtml(current.label || current.id)}</span>`;
        return `<div class="ul-models-costume-cell">${preview}<div class="ul-models-costume-body">${control}
                    ${credit ? `<span class="ul-models-credit">${escapeHtml(credit)}</span>` : ''}</div></div>`;
    }

    function tableHTML(s, disabled) {
        const rows = (s.plan && s.plan.rows) || [];
        if (!rows.length) return '';
        return `
            <table class="ul-models-table">
                <thead><tr>
                    <th>${escapeHtml(t('models.col.hero'))}</th>
                    <th>${escapeHtml(t('models.col.source'))}</th>
                    <th>${escapeHtml(t('models.col.costume'))}</th>
                    <th>${escapeHtml(t('models.col.status'))}</th>
                </tr></thead>
                <tbody>${rows.map(row => `
                    <tr class="ul-models-row" data-hero="${escapeHtml(row.hero)}" data-tier="${escapeHtml(row.tier)}">
                        <td class="ul-models-hero">${escapeHtml(row.name || row.hero)}</td>
                        <td class="ul-models-tier"><span class="ul-models-tier-name is-${escapeHtml(row.tier)}">${escapeHtml(tierName(row.tier))}</span>
                            ${row.tier !== 'stock' && row.reason ? `<span class="ul-models-reason">${escapeHtml(row.reason)}</span>` : ''}</td>
                        <td class="ul-models-costume-td">${costumeHTML(s, row, disabled)}</td>
                        <td class="ul-models-status-td">${statusHTML(statusOf(s, row))}</td>
                    </tr>`).join('')}
                </tbody>
            </table>`;
    }

    function modeButton(s, mode, disabled) {
        const chosen = currentMode(s) === mode;
        const unavailable = mode === 'upgraded' && !upgradedAvailable(s);
        return `<button type="button" class="toggle-btn ul-models-mode${chosen ? ' active' : ''}" data-mode="${mode}" data-focus="mode-${mode}"
                    aria-pressed="${chosen ? 'true' : 'false'}"${disabled || unavailable ? ' disabled' : ''}>
                    <span class="ul-models-mode-name">${escapeHtml(t(`models.mode.${mode}`))}</span>
                    ${mode === 'community' ? `<span class="ul-models-mode-tag">${escapeHtml(t('models.suggested'))}</span>` : ''}
                </button>`;
    }

    function modesHTML(s, disabled) {
        const mode = currentMode(s);
        const moreOpen = MORE_MODES.includes(mode);
        const note = !upgradedAvailable(s) ? `<div class="ul-models-note is-muted ul-models-upgraded-note">${escapeHtml(t('models.upgradedNeeds'))}</div>` : '';
        return `
            <div class="ul-models-modes">
                <div class="toggle-group ul-models-mode-group" role="group" aria-label="${escapeHtml(t('models.appearance'))}">
                    ${modeButton(s, 'off', disabled)}
                    ${modeButton(s, 'community', disabled)}
                    ${modeButton(s, 'upgraded', disabled)}
                </div>
                <details class="ul-models-more"${moreOpen ? ' open' : ''}>
                    <summary data-focus="more">${escapeHtml(t('models.more'))}</summary>
                    <div class="toggle-group ul-models-mode-group">${MORE_MODES.map(m => modeButton(s, m, disabled)).join('')}</div>
                </details>
            </div>
            <div class="ul-models-mode-body">${escapeHtml(t(`models.modeBody.${mode}`))}</div>
            ${note}`;
    }

    function progressHTML(job) {
        if (!job || !job.active || job.command !== 'build') return '';
        const percent = job.total ? Math.max(0, Math.min(100, (100 * job.done) / job.total)) : 0;
        return `
            <div class="xml1-progress ul-models-progress">
                <div class="xml1-progress-bar"><div class="xml1-progress-fill" style="width:${percent.toFixed(1)}%"></div></div>
                <div class="xml1-progress-meta">
                    <span class="xml1-progress-message ul-models-progress-message">${escapeHtml(job.cancelRequested ? t('models.cancelling') : (job.message || t('models.starting')))}</span>
                    <span class="xml1-progress-numbers">${escapeHtml(job.total ? t('models.heroesDone', { done: job.done, total: job.total }) : '')}</span>
                </div>
            </div>`;
    }

    function downloadsHTML(job) {
        if (!job || !job.downloads.length) return '';
        return `
            <div class="ul-models-downloads">
                <div class="ul-models-subtitle">${escapeHtml(t('models.downloads'))}</div>
                <ul>${job.downloads.map(item => `
                    <li class="ul-models-download">
                        <span class="ul-models-download-file">${escapeHtml(item.archive)}</span>
                        <span class="ul-models-download-size">${escapeHtml(bytes(item.bytes))}</span>
                        <span class="ul-models-download-source">${escapeHtml(t(`models.downloadSource.${item.source === 'mirror' ? 'mirror' : 'author'}`))}</span>
                        ${item.sha256 ? `<span class="ul-models-download-hash" title="${escapeHtml(item.sha256)}">SHA-256 ${escapeHtml(item.sha256.slice(0, 16))}…</span>` : ''}
                    </li>`).join('')}</ul>
            </div>`;
    }

    function warningsHTML(job) {
        if (!job || !job.warnings.length) return '';
        return `<ul class="ul-models-warnings">${job.warnings.slice(-6).map(w =>
            `<li class="xml1-note is-warn">${escapeHtml(w.message)}</li>`).join('')}</ul>`;
    }

    function verifyHTML(s) {
        const verify = s.verify;
        if (!verify || verify.ok) return '';
        const count = (verify.missing || []).length + (verify.changed || []).length;
        const files = [...(verify.missing || []), ...(verify.changed || [])].slice(0, 3);
        return `
            <div class="xml1-note is-warn ul-models-verify">
                <div>${escapeHtml(t('models.verifyFailed', { count }))}</div>
                ${files.length ? `<ul class="xml1-verify-files">${files.map(file => `<li>${escapeHtml(file)}</li>`).join('')}</ul>` : ''}
            </div>`;
    }

    function outcomeHTML(s) {
        const outcome = s.outcome;
        if (!outcome) return '';
        const kind = outcome.kind === 'success' ? 'is-ok' : outcome.kind === 'error' ? 'is-error' : outcome.kind === 'warn' ? 'is-warn' : 'is-info';
        const details = outcome.details && outcome.details.length
            ? `<details class="ul-models-details"><summary>${escapeHtml(t('models.details'))}</summary><pre>${escapeHtml(outcome.details.join('\n'))}</pre></details>` : '';
        return `<div class="xml1-note ${kind} ul-models-outcome">${escapeHtml(outcome.text)}${details}</div>`;
    }

    // Community tier in use (planned or built): its credits, from the built pack's CREDITS.md.
    function communityInUse(s) {
        const rows = (s.plan && s.plan.rows) || [];
        const group = installedGroup(s);
        return rows.some(row => row.tier === 'community') ||
            !!(group && group.enabled && Object.values(group.characters).some(c => c.tier === 'community'));
    }

    function creditsHTML(s) {
        if (!communityInUse(s)) return '';
        const credits = s.credits || [];
        const body = credits.length
            ? credits.map(entry => `<div class="ul-models-credits-text" data-folder="${escapeHtml(entry.folder)}">${escapeHtml(entry.text)}</div>`).join('')
            : `<div class="ul-models-note is-muted">${escapeHtml(t('models.creditsAfterApply'))}</div>`;
        return `
            <section class="ul-models-credits">
                <div class="ul-models-subtitle">${escapeHtml(t('models.credits'))}</div>
                ${body}
            </section>`;
    }

    function mirrorHTML(s, disabled) {
        const settings = (s.status && s.status.settings) || {};
        const fallback = s.status && s.status.defaultMirror ? s.status.defaultMirror : '';
        return `
            <details class="ul-models-mirror"${s.mirrorOpen ? ' open' : ''}>
                <summary data-focus="mirror">${escapeHtml(t('models.mirror'))}</summary>
                <div class="ul-models-mirror-body">
                    <p class="ul-models-note is-muted">${escapeHtml(t('models.mirrorBody'))}</p>
                    <div class="ul-models-mirror-row">
                        <input type="text" class="ul-models-mirror-input" data-focus="mirror-input" spellcheck="false"
                            value="${escapeHtml(settings.mirror || '')}" placeholder="${escapeHtml(fallback || t('models.mirrorDefault'))}"${disabled ? ' disabled' : ''}>
                        <button type="button" class="secondary-action xml1-small" data-act="save-mirror" data-focus="save-mirror"${disabled ? ' disabled' : ''}>${escapeHtml(t('models.mirrorSave'))}</button>
                    </div>
                </div>
            </details>`;
    }

    function button(act, label, disabled, extra = '') {
        return `<button type="button" class="secondary-action xml1-small" data-act="${act}" data-focus="${act}"${disabled ? ' disabled' : ''}${extra}>${escapeHtml(label)}</button>`;
    }

    function render(gameId) {
        const host = panel(gameId);
        if (!host) return;
        const s = getState(gameId);
        const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focus : null;
        const focusInside = focused && document.activeElement.closest && document.activeElement.closest(`#${gameId}-models-panel`);

        if (!s.status) {
            host.innerHTML = `<div class="ul-display ul-models"><div class="ul-display-empty">${escapeHtml(t('models.loading'))}</div></div>`;
            return;
        }

        const tool = s.status.tool || {};
        const working = !!(s.job && s.job.active);
        const blocked = blockedReason(s);
        const disabled = !!blocked || working || s.loading;
        const group = installedGroup(s);
        const mode = currentMode(s);

        let head = '';
        if (!tool.found) {
            head = `<div class="xml1-note is-info ul-models-missing">${escapeHtml(t('models.toolMissing'))}</div>`;
        } else if (!s.status.port || !s.status.port.built) {
            head = `<div class="xml1-note is-info ul-models-notbuilt">${escapeHtml(t('models.buildFirst'))}</div>`;
        } else if (blocked) {
            head = `<div class="xml1-note is-warn ul-models-blocked">${escapeHtml(blocked)}</div>`;
        }

        const installedLine = group
            ? t(group.enabled ? 'models.installedOn' : 'models.installedOff', { name: t(`models.mode.${group.mode}`) !== `models.mode.${group.mode}` ? t(`models.mode.${group.mode}`) : group.group, count: Object.keys(group.characters).length })
            : t('models.installedNone');

        const actions = [];
        if (working && s.job.command === 'build') {
            actions.push(button('cancel', t('models.cancel'), s.job.cancelRequested));
        } else {
            const applyLabel = mode === 'off' ? t('models.applyOff') : group && group.enabled && group.mode === mode ? t('models.reapply') : t('models.apply');
            actions.push(button('apply', applyLabel, disabled || (mode === 'off' && !allGroups(s).length), ' data-primary="true"'));
            if (allGroups(s).length) actions.push(button('remove', t('models.remove'), disabled));
            if (group) actions.push(button('verify', t('models.verify'), disabled));
            if (s.status.modsFolder) actions.push(button('open-mods', t('models.openMods'), false));
        }

        host.innerHTML = `
            <div class="ul-display ul-models" data-mode="${escapeHtml(mode)}" data-busy="${working ? 'true' : 'false'}">
                <p class="ul-models-intro">${escapeHtml(t('models.intro'))}</p>
                ${head}
                ${tool.found && s.status.port && s.status.port.built ? `
                    <div class="ul-models-installed">${escapeHtml(installedLine)}</div>
                    ${modesHTML(s, disabled)}
                    ${progressHTML(s.job)}
                    ${outcomeHTML(s)}
                    ${verifyHTML(s)}
                    ${mode !== 'off' ? (s.plan ? tableHTML(s, disabled) : `<div class="ul-display-empty">${escapeHtml(s.loading ? t('models.loading') : t('models.noPlan'))}</div>`) : ''}
                    ${downloadsHTML(s.job)}
                    ${warningsHTML(s.job)}
                    <div class="xml1-actions ul-models-actions">${actions.join('')}</div>
                    <p class="ul-models-note is-muted">${escapeHtml(t('models.restartNote'))}</p>
                    ${creditsHTML(s)}
                    ${mirrorHTML(s, working)}
                ` : ''}
            </div>`;

        host.querySelectorAll('.ul-models-mode').forEach(element => {
            element.addEventListener('click', () => choose(gameId, element.dataset.mode));
        });
        host.querySelectorAll('.ul-models-costume').forEach(element => {
            element.addEventListener('change', () => chooseCostume(gameId, element.dataset.hero, element.dataset.tier, element.value));
        });
        host.querySelectorAll('[data-act]').forEach(element => {
            element.addEventListener('click', () => act(gameId, element.dataset.act));
        });
        const mirror = host.querySelector('.ul-models-mirror');
        if (mirror) mirror.addEventListener('toggle', () => { s.mirrorOpen = mirror.open; });

        if (focusInside) {
            const again = host.querySelector(`[data-focus="${focused}"]`);
            if (again && !again.disabled) again.focus();
        }
    }

    // During a run: redraw at most every poll (the run's events change the progress and the table).
    function update(gameId) {
        render(gameId);
    }

    async function act(gameId, action) {
        const s = getState(gameId);
        switch (action) {
            case 'apply':
                await apply(gameId);
                break;
            case 'remove':
                await removeAll(gameId, true);
                break;
            case 'cancel':
                await cancel(gameId);
                break;
            case 'verify': {
                await verifyInstalled(gameId);
                const verify = s.verify;
                if (verify && verify.ok) window.showToast(t('models.verifyOk', { count: verify.files || 0 }), 'success');
                break;
            }
            case 'open-mods':
                if (s.status && s.status.modsFolder) run('open-folder', { path: s.status.modsFolder });
                break;
            case 'save-mirror': {
                const input = panel(gameId).querySelector('.ul-models-mirror-input');
                await saveMirror(gameId, input ? input.value : '');
                break;
            }
            default:
                break;
        }
    }

    // A finished port build (or uninstall) changes what the tool sees: scan again.
    window.addEventListener('ul-xml1-changed', () => {
        SUPPORTED.forEach(gameId => {
            const s = getState(gameId);
            const building = window.Xml1Port && window.Xml1Port.isWorking && window.Xml1Port.isWorking();
            if (s.status && !building && !(s.job && s.job.active)) {
                s.scan = null;
                refresh(gameId);
            } else {
                render(gameId);
            }
        });
    });

    // Opening the page: status, scan (once), plan, verify.
    document.addEventListener('click', event => {
        const item = event.target.closest && event.target.closest('.game-item[data-game]');
        if (item && SUPPORTED.has(item.dataset.game) && panel(item.dataset.game)) {
            setTimeout(() => refresh(item.dataset.game), 0);
        }
    }, true);

    window.ModelsView = {
        supports: gameId => SUPPORTED.has(gameId),
        // The page is drawn at start-up: only the launcher's own status then; the tool runs when the
        // page is opened (or refresh() is called).
        render(gameId) {
            render(gameId);
            loadStatus(gameId).then(() => render(gameId));
        },
        refresh,
        // for the UI tests
        _applyEvent: applyEvent,
        _newRun: newRun,
        _state: gameId => getState(gameId)
    };
})();
