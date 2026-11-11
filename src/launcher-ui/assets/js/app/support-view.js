// The Support page's tabs (main.html #support-page): Help (redistributables, FAQ), Report a problem
// (Copy diagnostics, Report a bug, Logs), Known issues (data/known-issues.js) and Community (Discord,
// GitHub issues). External links open in the player's browser through open-url, like every other link.
//
// Privacy: the diagnostics come from get-support-diagnostics (support/diagnostics.cpp), which reads
// local facts only and redacts the user name, profile folder, computer name and Linux home; game folders
// are named, never given as paths. The page shows the report before and after copying. The bug report
// address carries only the form's template name: the player pastes the diagnostics themselves.
(function () {
    'use strict';

    const REPO = 'https://github.com/ChronoRixun/ultimate-legends';
    const ISSUES_URL = `${REPO}/issues`;
    const BUG_TEMPLATE = 'bug_report.yml';
    const BUG_REPORT_URL = `${ISSUES_URL}/new?template=${BUG_TEMPLATE}`;
    // The launcher's own invite: used only here, so the server can tell who joined from the launcher.
    const DISCORD_INVITE = 'https://discord.gg/abQb3BjEkF';

    const TABS = ['help', 'troubleshoot', 'known', 'community'];
    // Known issues, in the order of the sidebar's games; 'launcher' first.
    const KNOWN_ORDER = ['launcher', 'xml1', 'xml2', 'muac', 'mua', 'mua2'];
    const GAME_NAMES = {
        launcher: 'Ultimate Legends',
        xml1: 'X-Men Legends (Legends Classic)',
        xml2: 'X-Men Legends II: Rise of Apocalypse',
        muac: 'Marvel: Ultimate Alliance (2006 PC)',
        mua: 'Marvel: Ultimate Alliance',
        mua2: 'Marvel: Ultimate Alliance 2'
    };
    const SHORT_NAMES = { xml1: 'X-Men Legends', xml2: 'X-Men Legends II', muac: 'MUA 2006', mua: 'Marvel: Ultimate Alliance', mua2: 'MUA 2' };
    const FIX_NAMES = { xml1: 'XML2 Fix', xml2: 'XML2 Fix', muac: 'MUA Classic Fix', mua: 'MUA Controller Fix', mua2: 'MUA Controller Fix' };

    const t = (key, vars) => (window.LauncherI18n ? window.LauncherI18n.t(key, vars) : key);
    const esc = value => String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const byId = id => document.getElementById(id);

    let activeTab = 'help';
    let report = '';
    let logs = null;
    let loading = null;

    function openUrl(url) {
        return Promise.resolve(window.executeCommand('open-url', { url })).catch(() => {});
    }

    // ---- the diagnostics text (English, for whoever reads the bug report) ----

    function yesNo(value) {
        return value ? 'on' : 'off';
    }

    function fixLine(game) {
        const fix = game.fix || {};
        const name = fix.name || FIX_NAMES[game.id] || 'Fix';
        if (fix.version === null || fix.version === undefined) return `${name}: not installed`;
        let line = `${name} ${fix.version === '' ? '(version unknown)' : fix.version}`;
        if (game.id === 'muac') {
            line += fix.runtime === null || fix.runtime === undefined ? ', runtime dinput8.dll missing'
                : fix.runtime === '' ? ', runtime version unknown' : ` (runtime ${fix.runtime})`;
        }
        return line;
    }

    function displayLine(game) {
        const display = game.display || {};
        if (display.proton) return 'Display: handled by Proton';
        if (game.id === 'muac') {
            if (!display.mode && !display.resolution) return '';
            return `Display: ${display.mode || 'default'}, ${display.resolution || 'game default'}`;
        }
        if (game.id === 'xml1' || game.id === 'xml2') {
            if (display.mode === undefined) return '';
            const width = Number(display.width), height = Number(display.height);
            const size = display.width && display.height && width > 0 && height > 0 ? `${width}x${height}`
                : (display.width === '0' || display.height === '0') ? 'desktop size' : 'game setting';
            return `Display: ${display.mode || 'game default'}, ${size}`;
        }
        return '';
    }

    function gameLines(game) {
        const name = game.id === 'xml1' ? GAME_NAMES.xml1 : (game.name || GAME_NAMES[game.id] || game.id);
        if (!game.configured) return [`${name}: not set up`];
        const folder = game.folder ? `folder "${game.folder}"` : 'folder set';
        if (!game.installed) return [`${name}: ${folder}, but the game files are not there`];
        const lines = [`${name}: installed, ${folder}`, `  ${fixLine(game)}`];
        if (game.id === 'xml1' && game.build) {
            const build = game.build;
            const parts = [];
            parts.push(build.builder ? `Legends Classic build ${build.builder} (content ${build.content || 0})` : 'no finished Legends Classic build');
            parts.push(build.builderInstalled ? `builder ${build.builderInstalled} installed` : 'builder not installed');
            lines.push(`  ${parts.join(', ')}`);
        }
        const display = displayLine(game);
        if (display) lines.push(`  ${display}`);
        return lines;
    }

    // The plain-text report from get-support-diagnostics' answer.
    function formatReport(info, extra) {
        const data = info || {};
        const launcher = data.launcher || {};
        const system = data.system || {};
        const primary = system.primary || {};
        const lines = ['Ultimate Legends diagnostics'];
        const channel = launcher.channel === 'beta' ? 'Beta' : 'Stable';
        lines.push(`Launcher: ${launcher.version || 'unknown'} (${channel} channel), ${launcher.portable ? 'portable' : 'installed'}, offline mode ${yesNo(launcher.offline)}`);
        if (launcher.dataFolder) lines.push(`Data folder: ${launcher.dataFolder}`);
        if (extra && extra.language) lines.push(`Language: ${extra.language}`);
        if (system.wine) {
            const version = system.wineVersion ? ` (wine ${system.wineVersion})` : '';
            lines.push(`System: Proton/Wine${version}${system.steamDeck ? ', Steam Deck' : ''}`);
        } else {
            lines.push(`System: ${system.windows || 'Windows'} build ${system.build || 'unknown'}`);
        }
        const refresh = primary.refresh ? ` @ ${primary.refresh} Hz` : '';
        const scale = primary.scale ? `, display scaling ${primary.scale}%` : ', display scaling unknown';
        const monitors = system.monitors > 1 ? ` (${system.monitors} monitors)` : '';
        lines.push(`Primary monitor: ${primary.width || '?'}x${primary.height || '?'}${refresh}${scale}${monitors}`);
        lines.push('');
        for (const game of data.games || []) lines.push(...gameLines(game));
        const present = (data.logs || []).filter(log => log.available).map(log => log.file);
        const missing = (data.logs || []).filter(log => !log.available).map(log => log.file);
        lines.push('');
        lines.push(`Logs found: ${present.length ? present.join(', ') : 'none'}${missing.length ? `; not found: ${missing.join(', ')}` : ''}`);
        return lines.join('\n');
    }

    // ---- the page ----

    function setStatus(text, kind) {
        const element = byId('support-diagnostics-status');
        if (!element) return;
        element.textContent = text || '';
        element.dataset.kind = kind || '';
    }

    function showReport() {
        const preview = byId('support-diagnostics-preview');
        if (preview) preview.textContent = report || t('support.diagnosticsLoading');
    }

    // Asks the launcher again; the preview shows exactly what Copy puts on the clipboard.
    function loadDiagnostics() {
        if (loading) return loading;
        loading = Promise.resolve(window.executeCommand('get-support-diagnostics'))
            .then(info => {
                const language = window.LauncherI18n && window.LauncherI18n.getLanguage ? window.LauncherI18n.getLanguage() : '';
                report = formatReport(info, { language });
                logs = info && Array.isArray(info.logs) ? info.logs : logs;
                showReport();
                renderLogs();
                return report;
            })
            .catch(error => {
                console.error('get-support-diagnostics failed', error);
                setStatus(t('support.diagnosticsFailed'), 'error');
                return '';
            })
            .finally(() => { loading = null; });
        return loading;
    }

    async function copyDiagnostics() {
        setStatus(t('support.copying'));
        const text = await loadDiagnostics();
        if (!text) return false;
        let copied = false;
        try {
            const result = await window.executeCommand('copy-to-clipboard', { text });
            copied = !!(result && result.success);
        } catch (error) {
            copied = false;
        }
        if (!copied && window.navigator && window.navigator.clipboard && window.navigator.clipboard.writeText) {
            try {
                await window.navigator.clipboard.writeText(text);
                copied = true;
            } catch (error) {
                copied = false;
            }
        }
        setStatus(copied ? t('support.copied') : t('support.copyFailed'), copied ? 'ok' : 'error');
        return copied;
    }

    function logLabel(log) {
        if (log.id === 'launcher') return t('support.logLauncher');
        if (log.id === 'updates') return t('support.logUpdates');
        if (log.id === 'builder') return t('support.logBuilder', { game: SHORT_NAMES.xml1 });
        return t('support.logFix', { game: SHORT_NAMES[log.game] || log.game, fix: FIX_NAMES[log.game] || '' });
    }

    function renderLogs() {
        const host = byId('support-logs');
        if (!host) return;
        if (!logs) {
            host.innerHTML = `<p class="support-empty">${esc(t('support.logsLoading'))}</p>`;
            return;
        }
        host.innerHTML = logs.map(log => {
            const missing = !log.available;
            const title = missing ? t('support.logMissing', { file: log.file }) : t('support.logOpenTitle', { file: log.file });
            return `<div class="support-log-row" data-row="${esc(log.id)}">
                <div class="support-log-info"><span class="support-log-name">${esc(logLabel(log))}</span>
                <span class="support-log-file">${esc(log.file)}${missing ? ` · ${esc(t('support.logNotFound'))}` : ''}</span></div>
                <button type="button" class="settings-action-btn support-log-open" data-op="open-log" data-key="${esc(log.id)}" title="${esc(title)}"${missing ? ' disabled aria-disabled="true"' : ''}>${esc(t('support.openFolder'))}</button>
            </div>`;
        }).join('');
    }

    function loadLogs() {
        return Promise.resolve(window.executeCommand('get-support-logs'))
            .then(result => {
                logs = result && Array.isArray(result.logs) ? result.logs : [];
                renderLogs();
            })
            .catch(() => {});
    }

    async function openLog(id) {
        let ok = false;
        try {
            const result = await window.executeCommand('open-support-log', { id });
            ok = !!(result && result.success);
        } catch (error) {
            ok = false;
        }
        if (!ok) {
            const log = (logs || []).find(entry => entry.id === id);
            if (typeof window.showToast === 'function') window.showToast(t('support.openFolderFailed', { file: log ? log.file : '' }), 'error');
            loadLogs();
        }
        return ok;
    }

    function knownIssueText(entry, language) {
        const text = entry && entry.text ? entry.text : {};
        return text[language] || text.en || '';
    }

    function renderKnownIssues() {
        const host = byId('support-known-issues');
        if (!host) return;
        const language = window.LauncherI18n && window.LauncherI18n.getLanguage ? window.LauncherI18n.getLanguage() : 'en';
        const entries = Array.isArray(window.KnownIssues) ? window.KnownIssues : [];
        host.innerHTML = KNOWN_ORDER.map(game => {
            const items = entries.filter(entry => entry && entry.game === game).map(entry => knownIssueText(entry, language)).filter(Boolean);
            const title = game === 'launcher' ? t('support.knownLauncher') : GAME_NAMES[game];
            const body = items.length
                ? `<ul class="support-known-list">${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`
                : `<p class="support-empty">${esc(t('support.knownNone'))}</p>`;
            return `<section class="support-panel support-known-game" data-game="${esc(game)}"><h2>${esc(title)}</h2>${body}</section>`;
        }).join('');
    }

    function selectTab(name) {
        if (!TABS.includes(name)) return;
        activeTab = name;
        for (const tab of document.querySelectorAll('[data-support-tab]')) {
            const on = tab.dataset.supportTab === name;
            tab.classList.toggle('active', on);
            tab.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        for (const panel of document.querySelectorAll('[data-support-panel]')) {
            panel.hidden = panel.dataset.supportPanel !== name;
        }
        if (name === 'troubleshoot') {
            showReport();
            renderLogs();
            loadDiagnostics();
        } else if (name === 'known') {
            renderKnownIssues();
        }
    }

    // The Support page was opened (main.js) or its language changed.
    function onShow() {
        selectTab(activeTab);
    }

    function refreshText() {
        renderLogs();
        renderKnownIssues();
        showReport();
        setStatus('');
    }

    function reportBug() {
        return openUrl(BUG_REPORT_URL);
    }

    function joinDiscord() {
        return openUrl(DISCORD_INVITE);
    }

    function openIssues() {
        return openUrl(ISSUES_URL);
    }

    function init() {
        const page = byId('support-page');
        if (!page || page.dataset.supportBound) return;
        page.dataset.supportBound = 'true';
        page.addEventListener('click', event => {
            const target = event.target && event.target.closest ? event.target : null;
            if (!target) return;
            const tab = target.closest('[data-support-tab]');
            if (tab) {
                selectTab(tab.dataset.supportTab);
                return;
            }
            const action = target.closest('[data-act]');
            if (action && action.tagName === 'A' && typeof event.preventDefault === 'function') event.preventDefault();
            if (action && !action.disabled) {
                const act = action.dataset.act;
                if (act === 'copy-diagnostics') copyDiagnostics();
                else if (act === 'refresh-diagnostics') { setStatus(''); loadDiagnostics(); }
                else if (act === 'report-bug') reportBug();
                else if (act === 'join-discord') joinDiscord();
                else if (act === 'open-issues') openIssues();
                return;
            }
            const open = target.closest('[data-op="open-log"]');
            if (open && !open.disabled) openLog(open.dataset.key);
        });
        renderKnownIssues();
    }

    if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.SupportView = {
        init, onShow, refreshText, selectTab, formatReport, loadDiagnostics, copyDiagnostics, openLog, loadLogs,
        reportBug, joinDiscord, openIssues, renderKnownIssues,
        BUG_REPORT_URL, ISSUES_URL, DISCORD_INVITE,
        get report() { return report; },
        get activeTab() { return activeTab; }
    };
})();
