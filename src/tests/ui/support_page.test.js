'use strict';
// Support page (app/support-view.js, main.html #support-page, data/known-issues.js): the four tabs,
// Copy diagnostics (the preview is exactly what goes on the clipboard, with fallbacks), Report a bug
// (the GitHub form with the template name and nothing else), the launcher-only Discord invite (and that
// it appears nowhere else in the repository), Logs (open, missing, failure), Known issues in en / fr / es,
// and the Support strings in every language. The diagnostics' redaction itself is native
// (support/redact.cpp, support_redact_tests.cpp); here the report must not add anything the backend
// didn't give it.

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { page, test, settle } = require('./harness');

const ROOT = path.join(__dirname, '..', '..', '..');
const SCRIPTS = ['core/utils.js', 'core/i18n.js', 'core/focus-nav.js', 'data/known-issues.js', 'app/support-view.js'];
const BUG_URL = 'https://github.com/ChronoRixun/ultimate-legends/issues/new?template=bug_report.yml';
const ISSUES_URL = 'https://github.com/ChronoRixun/ultimate-legends/issues';
// SHA-256 of the launcher's Discord invite: the invite itself is written only in support-view.js.
const INVITE_SHA256 = '76a66d108873123861a6eedae93c793b8bb8a5bdb47bc75d6ed41c634f79baac';

const WINDOWS = {
    launcher: { version: '0.6.0-beta.3', channel: 'beta', portable: true, offline: false, dataFolder: '' },
    system: { wine: false, wineVersion: '', steamDeck: false, windows: 'Windows 11', build: 26200, monitors: 2,
        primary: { width: 3840, height: 2160, refresh: 60, dpi: 144, scale: 150 } },
    games: [
        { id: 'xml1', name: 'X-Men Legends', configured: true, installed: true, folder: 'X-Men Legends (Port)',
            fix: { name: 'XML2 Fix', version: '1.10.0' }, display: { mode: 'borderless', width: '0', height: '0' },
            build: { builder: '0.6.0-beta.3', content: 12, builderInstalled: '0.6.0-beta.3' } },
        { id: 'xml2', name: 'X-Men Legends II: Rise of Apocalypse', configured: false, installed: false, folder: '',
            fix: { name: 'XML2 Fix', version: null }, display: {} },
        { id: 'muac', name: 'Marvel: Ultimate Alliance (2006 PC)', configured: true, installed: true, folder: 'MUA Classic',
            fix: { name: 'MUA Classic Fix', version: '0.2.4', runtime: '0.1.3' }, display: { mode: 'borderless', resolution: '2560x1440' } },
        { id: 'mua', name: 'Marvel: Ultimate Alliance', configured: true, installed: false, folder: '%USERNAME% games',
            fix: { name: 'MUA Controller Fix', version: null }, display: {} },
        { id: 'mua2', name: 'Marvel: Ultimate Alliance 2', configured: true, installed: true, folder: 'Marvel Ultimate Alliance 2',
            fix: { name: 'MUA Controller Fix', version: '' }, display: {} }
    ],
    logs: [
        { id: 'launcher', game: '', file: 'ultimate-legends.log', available: true },
        { id: 'updates', game: '', file: 'update.log', available: false },
        { id: 'fix:xml1', game: 'xml1', file: 'xml2-fix.log', available: true },
        { id: 'builder', game: 'xml1', file: 'builder.log', available: false },
        { id: 'fix:muac', game: 'muac', file: 'muac-fix.log', available: true },
        { id: 'fix:mua2', game: 'mua2', file: 'mua-controller-fix.log', available: false }
    ]
};

const PROTON = Object.assign({}, WINDOWS, {
    system: { wine: true, wineVersion: '9.0', steamDeck: true, windows: 'Windows 10', build: 19045, monitors: 1,
        primary: { width: 1280, height: 800, refresh: 60, dpi: 96, scale: 100 } },
    games: [{ id: 'muac', name: 'Marvel: Ultimate Alliance (2006 PC)', configured: true, installed: true, folder: 'MUA',
        fix: { name: 'MUA Classic Fix', version: '0.2.4', runtime: '0.1.3' }, display: { proton: true } }]
});

class Backend {
    constructor({ info = WINDOWS, copy = true, open = true } = {}) {
        this.info = info;
        this.copy = copy;
        this.open = open;
        this.calls = [];
    }

    handle(command, data) {
        this.calls.push([command, data]);
        if (command === 'get-support-diagnostics') return JSON.parse(JSON.stringify(this.info));
        if (command === 'get-support-logs') return { logs: JSON.parse(JSON.stringify(this.info.logs)) };
        if (command === 'copy-to-clipboard') return { success: this.copy };
        if (command === 'open-support-log') return { success: this.open };
        return null;
    }

    sent(command) {
        return this.calls.filter(([name]) => name === command).map(([, data]) => data);
    }
}

function open(backend, language = 'en') {
    const p = page({ scripts: SCRIPTS, backend });
    p.window.LauncherI18n.setLanguage(language);
    p.window.SupportView.refreshText();
    return p;
}

function panels(p) {
    return p.document.querySelectorAll('[data-support-panel]').filter(panel => !panel.hidden).map(panel => panel.dataset.supportPanel);
}

test('Support: four tabs, Help first; each tab shows only its own panel and is a button', async () => {
    const backend = new Backend();
    const p = open(backend);
    const tabs = p.document.querySelectorAll('#support-page [data-support-tab]');
    assert.deepEqual(tabs.map(tab => tab.dataset.supportTab), ['help', 'troubleshoot', 'known', 'community']);
    for (const tab of tabs) assert.equal(tab.tagName, 'BUTTON');
    assert.deepEqual(panels(p), ['help']);
    for (const name of ['troubleshoot', 'known', 'community', 'help']) {
        p.document.querySelector(`[data-support-tab="${name}"]`).click();
        await settle();
        assert.deepEqual(panels(p), [name]);
        const active = p.document.querySelectorAll('[data-support-tab]').filter(tab => tab.classList.contains('active'));
        assert.deepEqual(active.map(tab => tab.dataset.supportTab), [name]);
        assert.equal(p.document.querySelector(`[data-support-tab="${name}"]`).getAttribute('aria-selected'), 'true');
    }
    // No native <select> popups on the page (Proton rule).
    assert.equal(p.document.querySelectorAll('#support-page select').length, 0);
});

test('Support: the diagnostics preview is the report, and Copy puts exactly that text on the clipboard', async () => {
    const backend = new Backend();
    const p = open(backend);
    p.document.querySelector('[data-support-tab="troubleshoot"]').click();
    await settle();
    const preview = p.document.getElementById('support-diagnostics-preview');
    const report = preview.textContent;
    assert.equal(report, p.window.SupportView.report);
    for (const line of [
        'Launcher: 0.6.0-beta.3 (Beta channel), portable, offline mode off',
        'Language: en',
        'System: Windows 11 build 26200',
        'Primary monitor: 3840x2160 @ 60 Hz, display scaling 150% (2 monitors)',
        'X-Men Legends (Legends Classic): installed, folder "X-Men Legends (Port)"',
        '  XML2 Fix 1.10.0',
        '  Legends Classic build 0.6.0-beta.3 (content 12), builder 0.6.0-beta.3 installed',
        '  Display: borderless, desktop size',
        'X-Men Legends II: Rise of Apocalypse: not set up',
        'Marvel: Ultimate Alliance (2006 PC): installed, folder "MUA Classic"',
        '  MUA Classic Fix 0.2.4 (runtime 0.1.3)',
        '  Display: borderless, 2560x1440',
        'Marvel: Ultimate Alliance: folder "%USERNAME% games", but the game files are not there',
        '  MUA Controller Fix (version unknown)',
        'Logs found: ultimate-legends.log, xml2-fix.log, muac-fix.log; not found: update.log, builder.log, mua-controller-fix.log'
    ]) assert.ok(report.split('\n').includes(line), `missing line: ${line}\n${report}`);

    p.document.getElementById('support-copy-diagnostics').click();
    await settle();
    const copied = backend.sent('copy-to-clipboard');
    assert.equal(copied.length, 1);
    assert.equal(copied[0].text, preview.textContent);
    assert.equal(p.document.getElementById('support-diagnostics-status').textContent, 'Copied. Paste it into your bug report (Ctrl+V).');
    // The preview still shows what was copied.
    assert.equal(preview.textContent, copied[0].text);
});

test('Support: the report holds only what the launcher gave it (no paths, names or addresses of its own)', async () => {
    const backend = new Backend();
    const p = open(backend);
    const report = p.window.SupportView.formatReport(WINDOWS, { language: 'en' });
    assert.doesNotMatch(report, /[A-Za-z]:\\/);
    assert.doesNotMatch(report, /\/home\//);
    assert.doesNotMatch(report, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    assert.doesNotMatch(report, /[\w.-]+@[\w-]+\.\w+/);
    // Proton: the system line and MUA 2006's display say so.
    const proton = p.window.SupportView.formatReport(PROTON, {});
    assert.ok(proton.includes('System: Proton/Wine (wine 9.0), Steam Deck'));
    assert.ok(proton.includes('Primary monitor: 1280x800 @ 60 Hz, display scaling 100%'));
    assert.ok(proton.includes('  Display: handled by Proton'));
    assert.ok(!proton.includes('Windows 10 build'));
    // An installed (not portable) launcher shows its data folder as the backend redacted it.
    const installed = JSON.parse(JSON.stringify(WINDOWS));
    installed.launcher.portable = false;
    installed.launcher.dataFolder = '%USERPROFILE%\\AppData\\Local\\Ultimate Legends';
    const text = p.window.SupportView.formatReport(installed, {});
    assert.ok(text.split('\n').includes('Data folder: %USERPROFILE%\\AppData\\Local\\Ultimate Legends'), text);
    assert.ok(text.includes('Launcher: 0.6.0-beta.3 (Beta channel), installed, offline mode off'));
});

test('Support: Copy falls back to the page clipboard, then says to copy by hand', async () => {
    const backend = new Backend({ copy: false });
    const p = open(backend);
    let written = null;
    p.window.navigator.clipboard.writeText = async text => { written = text; };
    p.document.querySelector('[data-support-tab="troubleshoot"]').click();
    await settle();
    p.document.getElementById('support-copy-diagnostics').click();
    await settle();
    assert.equal(written, p.window.SupportView.report);
    assert.equal(p.document.getElementById('support-diagnostics-status').dataset.kind, 'ok');

    p.window.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    assert.equal(await p.window.SupportView.copyDiagnostics(), false);
    assert.equal(p.document.getElementById('support-diagnostics-status').textContent, 'Could not copy. Select the text below and press Ctrl+C.');
});

test('Support: Report a bug opens the GitHub form with the template name and nothing else', async () => {
    const backend = new Backend();
    const p = open(backend);
    p.document.querySelector('[data-support-tab="troubleshoot"]').click();
    await settle();
    p.document.getElementById('support-report-bug').click();
    p.document.getElementById('support-footer-report').click();
    await settle();
    // main.js sends only links written as http(s) addresses to the browser, never the footer's href="#".
    const main = fs.readFileSync(path.join(ROOT, 'src', 'launcher-ui', 'assets', 'js', 'app', 'main.js'), 'utf8');
    assert.ok(main.includes("/^https?:\\/\\//i.test(link.getAttribute('href') || '')"));
    const urls = backend.sent('open-url').map(data => data.url);
    assert.deepEqual(urls, [BUG_URL, BUG_URL]);
    const url = new URL(urls[0]);
    assert.equal(url.origin + url.pathname, 'https://github.com/ChronoRixun/ultimate-legends/issues/new');
    assert.deepEqual([...url.searchParams.keys()], ['template']);
    assert.equal(url.hash, '');
    // The diagnostics are never sent anywhere by the page: only copied when asked.
    assert.equal(backend.sent('copy-to-clipboard').length, 0);
    // The form exists, asks for the diagnostics and has no Discord link (GitHub templates are public).
    const form = fs.readFileSync(path.join(ROOT, '.github', 'ISSUE_TEMPLATE', url.searchParams.get('template')), 'utf8');
    assert.match(form, /Diagnostics \(paste from Support > Copy diagnostics\)/);
    for (const option of ['Ultimate Legends launcher', 'X-Men Legends (Legends Classic)', 'Marvel: Ultimate Alliance (2006 PC)', 'Marvel: Ultimate Alliance 2', 'Steam Deck (Proton)', 'Windows']) {
        assert.ok(form.includes(option), option);
    }
    assert.doesNotMatch(form, /discord/i);
});

test('Support: Community opens the launcher-only Discord invite and the GitHub issues', async () => {
    const backend = new Backend();
    const p = open(backend);
    p.document.querySelector('[data-support-tab="community"]').click();
    await settle();
    p.document.getElementById('support-join-discord').click();
    p.document.getElementById('support-open-issues').click();
    await settle();
    const urls = backend.sent('open-url').map(data => data.url);
    assert.equal(urls.length, 2);
    assert.match(urls[0], /^https:\/\/discord\.gg\/[A-Za-z0-9]+$/);
    assert.equal(crypto.createHash('sha256').update(urls[0]).digest('hex'), INVITE_SHA256);
    assert.equal(urls[0], p.window.SupportView.DISCORD_INVITE);
    assert.equal(urls[1], ISSUES_URL);
});

test('Support: the Discord invite is written only in support-view.js (join-source tracking)', () => {
    const invite = (() => {
        const p = open(new Backend());
        return p.window.SupportView.DISCORD_INVITE;
    })();
    const code = invite.split('/').pop();
    const skip = new Set(['.git', 'build', 'deps', 'node_modules']);
    const found = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (skip.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(js|html|css|md|yml|yaml|json|cpp|hpp|txt|lua|ps1|py)$/i.test(entry.name) &&
                fs.readFileSync(full, 'utf8').includes(code)) found.push(path.relative(ROOT, full).replace(/\\/g, '/'));
        }
    };
    walk(ROOT);
    assert.deepEqual(found, ['src/launcher-ui/assets/js/app/support-view.js']);
});

test('Support: Logs opens a present log, a missing one is disabled with an explanation, a failure says so', async () => {
    const backend = new Backend();
    const p = open(backend);
    p.document.querySelector('[data-support-tab="troubleshoot"]').click();
    await settle();
    const rows = p.document.querySelectorAll('#support-logs .support-log-row');
    assert.deepEqual(rows.map(row => row.dataset.row), WINDOWS.logs.map(log => log.id));
    const button = id => p.document.querySelector(`#support-logs [data-key="${id}"]`);
    assert.equal(button('launcher').disabled, false);
    assert.equal(button('updates').disabled, true);
    assert.equal(button('updates').getAttribute('title'), 'update.log was not found. It is written the next time this runs.');
    assert.equal(p.document.querySelector('#support-logs [data-row="fix:muac"] .support-log-name').textContent, 'MUA 2006: MUA Classic Fix log');
    assert.equal(p.document.querySelector('#support-logs [data-row="builder"] .support-log-name').textContent, 'X-Men Legends: Legends Classic builder log');

    button('updates').click();
    button('fix:muac').click();
    await settle();
    assert.equal(JSON.stringify(backend.sent('open-support-log')), JSON.stringify([{ id: 'fix:muac' }]));
    assert.equal(p.toasts.length, 0);

    backend.open = false;
    button('launcher').click();
    await settle();
    assert.equal(p.toasts.length, 1);
    assert.equal(p.toasts[0][0], 'The folder with ultimate-legends.log could not be opened.');
});

test('Support: Known issues list every game, in en / fr / es, from data/known-issues.js', async () => {
    for (const language of ['en', 'fr', 'es']) {
        const p = open(new Backend(), language);
        p.document.querySelector('[data-support-tab="known"]').click();
        await settle();
        const sections = p.document.querySelectorAll('#support-known-issues .support-known-game');
        assert.deepEqual(sections.map(section => section.dataset.game), ['launcher', 'xml1', 'xml2', 'muac', 'mua', 'mua2']);
        const muac = p.document.querySelector('#support-known-issues [data-game="muac"]');
        const items = muac.querySelectorAll('li').map(li => li.textContent);
        const data = p.window.KnownIssues.filter(entry => entry.game === 'muac');
        assert.equal(JSON.stringify(items), JSON.stringify(data.map(entry => entry.text[language])));
        assert.ok(items.some(item => item.includes('0.2.4')));
        const none = p.document.querySelector('#support-known-issues [data-game="xml2"] .support-empty');
        assert.equal(none.textContent, p.window.LauncherI18n.t('support.knownNone'));
    }
});

test('Support: known-issues data is well formed and shown as text, never HTML', () => {
    const p = open(new Backend());
    const games = new Set(['launcher', 'xml1', 'xml2', 'muac', 'mua', 'mua2']);
    const ids = new Set();
    for (const entry of p.window.KnownIssues) {
        assert.ok(games.has(entry.game), entry.game);
        assert.ok(!ids.has(entry.id), entry.id);
        ids.add(entry.id);
        for (const language of ['en', 'fr', 'es']) assert.ok(entry.text[language], `${entry.id} ${language}`);
    }
    p.window.KnownIssues.push({ game: 'mua', id: 'x', text: { en: '<img src=x onerror=alert(1)>' } });
    p.window.SupportView.renderKnownIssues();
    const item = p.document.querySelector('#support-known-issues [data-game="mua"] li');
    assert.equal(item.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(p.document.querySelectorAll('#support-known-issues img').length, 0);
});

test('Support: every Support string exists in en, fr and es', () => {
    const p = open(new Backend());
    const i18n = p.window.LauncherI18n;
    const keys = ['tabHelp', 'tabTroubleshoot', 'tabKnown', 'tabCommunity', 'diagnosticsTitle', 'diagnosticsBody', 'copyDiagnostics',
        'refreshDiagnostics', 'diagnosticsLoading', 'diagnosticsFailed', 'copying', 'copied', 'copyFailed', 'reportTitle', 'reportBody',
        'reportBug', 'logsTitle', 'logsBody', 'logsLoading', 'logLauncher', 'logUpdates', 'logBuilder', 'logFix', 'logMissing',
        'logOpenTitle', 'logNotFound', 'openFolder', 'openFolderFailed', 'knownLauncher', 'knownNone', 'discordTitle', 'discordBody',
        'joinDiscord', 'issuesTitle', 'issuesBody', 'openIssues'];
    const html = fs.readFileSync(path.join(ROOT, 'src', 'launcher-ui', 'main.html'), 'utf8');
    for (const key of keys.filter(key => !['diagnosticsLoading', 'diagnosticsFailed', 'copying', 'copied', 'copyFailed', 'logsLoading',
        'logLauncher', 'logUpdates', 'logBuilder', 'logFix', 'logMissing', 'logOpenTitle', 'logNotFound', 'openFolder', 'openFolderFailed',
        'knownLauncher', 'knownNone'].includes(key))) {
        assert.ok(html.includes(`"support.${key}"`), `main.html uses support.${key}`);
    }
    const english = {};
    for (const language of ['en', 'fr', 'es']) {
        i18n.setLanguage(language);
        for (const key of keys) {
            const value = i18n.t(`support.${key}`);
            assert.notEqual(value, `support.${key}`, `${language} support.${key}`);
            if (language === 'en') english[key] = value;
            else if (!['discordTitle', 'reportBug', 'knownLauncher'].includes(key)) assert.notEqual(value, english[key], `${language} support.${key} is translated`);
        }
    }
});
