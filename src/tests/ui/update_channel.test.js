'use strict';
// Settings > Updates > Update channel (app/update-channel.js, updater/channel_status.hpp): the setting in
// en / fr / es, picked with the keyboard and a controller (FocusNav / GamepadNav), the versions with their
// Beta badge, what Settings says when GitHub couldn't be asked (with or without an earlier result), and
// switching back to Stable: "You're on a beta (x). Switch back to y?" - Keep the beta changes nothing and
// revokes earlier approvals; Switch back installs exactly the versions shown, each approved for one attempt,
// reads what each really did, says what did not switch back, and offers Rebuild only when the builder and the
// port's fix both did. The real scripts run against a fake backend that models each outcome.

const assert = require('node:assert/strict');
const vm = require('vm');
const { page, test } = require('./harness');

const SCRIPTS = ['core/utils.js', 'core/i18n.js', 'core/focus-nav.js', 'core/gamepad-nav.js', 'ui/message-box.js',
    'app/launcher-update.js', 'app/update-channel.js'];

const BETA_ITEMS = [
    { id: 'launcher', installed: '0.5.0-beta.1', prerelease: true, stable: '0.4.0', ahead: true },
    { id: 'fix', game: 'xml2', installed: '1.8.0-beta.2', prerelease: true, stable: '1.7.1', ahead: true },
    { id: 'fix', game: 'xml1', installed: '1.8.0-beta.2', prerelease: true, stable: '1.7.1', ahead: true },
    { id: 'builder', installed: '0.3.0-beta.1', prerelease: true, stable: '0.2.4', ahead: true }
];

const STABLE_ITEMS = [
    { id: 'launcher', installed: '0.4.0', prerelease: false, stable: '0.4.0', ahead: false },
    { id: 'fix', game: 'xml2', installed: '1.7.1', prerelease: false, stable: '1.7.1', ahead: false }
];

// The backend of updater/channel_status.hpp, verify-game / get-patch-attempt (game_commands.cpp), the
// builder (xml1_port) and the launcher's update, with what each switch back really does on the disk:
// `outcome.fix[game]` 'done' | 'failed' | 'cancelled' | 'busy', `outcome.builder` 'done' | 'failed' | 'busy',
// `outcome.launcher` 'ready' | 'failed' | 'busy'.
class Backend {
    constructor({ channel = 'stable', items = STABLE_ITEMS, repos = [], outcome = {} } = {}) {
        this.channel = channel;
        this.items = items.map(item => Object.assign({ beta: '', fromCache: false, error: '', dev: false }, item));
        this.repos = repos;
        this.outcome = Object.assign({ builder: 'done', launcher: 'ready' }, outcome);
        this.outcome.fix = Object.assign({}, outcome.fix);
        this.offline = false;
        this.calls = [];
        this.attempts = {};
        this.nextAttempt = 1;
        this.launcher = { state: 'up-to-date', readyVersion: '', installError: '' };
        this.builder = { checking: false, installing: false, version: '', code: '', error: '' };
    }

    item(key) {
        return this.items.find(item => (item.game ? `${item.id}:${item.game}` : item.id) === key);
    }

    status() {
        return { channel: this.channel, offline: this.offline, checking: false, items: this.items.map(item => Object.assign({}, item)),
            repos: this.repos.map(repo => Object.assign({}, repo)) };
    }

    // The switch back of one item went through: the stable version is installed (and no longer ahead).
    switched(key) {
        const item = this.item(key);
        item.installed = item.stable;
        item.prerelease = false;
        item.ahead = false;
    }

    handle(command, data) {
        this.calls.push([command, data]);
        switch (command) {
            case 'get-update-channel': return this.status();
            case 'set-update-channel':
                this.channel = data.channel;
                return this.status();
            case 'keep-beta': return true;
            case 'switch-back-to-stable': {
                const started = { launcher: !!data.launcher && this.outcome.launcher !== 'busy', builder: !!data.builder && this.outcome.builder !== 'busy' };
                if (started.launcher) {
                    this.launcher = this.outcome.launcher === 'ready'
                        ? { state: 'ready', readyVersion: data.launcher, installError: '' }
                        : { state: 'up-to-date', readyVersion: '', installError: 'Switching back to 0.4.0 failed: the download was interrupted. Your launcher was not changed.' };
                }
                if (started.builder) {
                    if (this.outcome.builder === 'done') {
                        this.switched('builder');
                        this.builder = { checking: false, installing: false, version: data.builder, code: '', error: '' };
                    } else {
                        this.builder = { checking: false, installing: false, version: this.item('builder').installed, code: 'L_BUILDER_DOWNLOAD', error: 'download failed' };
                    }
                }
                return started;
            }
            case 'get-launcher-update':
            case 'check-launcher-update': {
                const launcher = this.item('launcher') || { installed: '0.4.0', prerelease: false, ahead: false };
                return Object.assign({
                    enabled: true, current: launcher.installed, canInstall: true, latest: '0.4.0', channel: this.channel,
                    prerelease: launcher.prerelease, aheadOfStable: this.channel === 'stable' && launcher.ahead, fromCache: false, cacheError: ''
                }, this.launcher);
            }
            case 'verify-game': {
                const result = this.outcome.fix[data.game] || 'done';
                if (!data.downgrade) return { accepted: true };
                if (result === 'busy') return { accepted: false, reason: 'busy' };
                const id = this.nextAttempt++;
                const key = `fix:${data.game}`;
                if (result === 'done') this.switched(key);
                this.attempts[id] = {
                    state: result, installed: this.item(key).installed,
                    error: result === 'failed' ? 'Failed to download: dinput.dll' : result === 'cancelled' ? 'Cancelled.' : ''
                };
                return { accepted: true, attempt: id };
            }
            case 'get-patch-attempt': return this.attempts[data.attempt] || null;
            case 'get-update-progress': return { active: false };
            case 'get-xml1-status': return { builder: Object.assign({}, this.builder) };
            default: return null;
        }
    }

    // (A copy in this realm: the page's objects come from its own context.)
    sent(command) {
        return this.calls.filter(([name]) => name === command).map(([, data]) => JSON.parse(JSON.stringify(data)));
    }
}

async function open(options = {}) {
    const backend = new Backend(options);
    const p = page({ scripts: SCRIPTS, backend });
    if (options.language) {
        p.window.LauncherI18n.setLanguage(options.language);
        p.window.LauncherI18n.applyStaticTranslations();
    }
    // The settings page is the one showing.
    p.document.querySelectorAll('.page-section').forEach(section => { section.style.display = 'none'; });
    p.document.querySelector('#settings-page').style.display = 'block';
    // What the switch back runs through (main.js / utils.js): Verify's progress (resolving with the
    // command's answer, as trackCommandProgress does), the port's rebuild.
    const verified = [];
    vm.runInContext('GameUtils', p.window).trackCommandProgress = async config => {
        verified.push(config.commandArgs.game);
        return p.window.executeCommand(config.command, config.commandArgs);
    };
    const rebuilt = [];
    p.window.Xml1Port = {
        status: { state: 'ready' },
        canRebuild: () => true,
        refresh: async () => p.window.Xml1Port.status,
        resume: async () => { rebuilt.push(true); return { success: true }; }
    };
    await p.window.UpdateChannel.init();
    await p.window.UpdateChannel.refresh(true); // Settings opened (main.js)
    await p.clock.advance(0);
    const $ = selector => p.document.querySelector(selector);
    const rows = () => p.document.querySelectorAll('#update-channel-versions .update-channel-row');
    const note = () => ($('#update-channel-note').hidden ? '' : $('#update-channel-note').textContent);
    return { ...p, backend, $, rows, note, verified, rebuilt, select: $('#update-channel-select') };
}

// Answers the next message boxes with `answers` (button indexes), recording them.
function answer(t, ...answers) {
    const asked = [];
    t.window.showMessageBox = async (...args) => {
        asked.push(JSON.parse(JSON.stringify(args)));
        return answers.length ? answers.shift() : 1;
    };
    return asked;
}

function choose(t, value) {
    t.select.value = value;
    t.select.dispatchEvent(new t.window.Event('change', { bubbles: true }));
}

// ---- the setting ----

test('update channel: the setting in English - Stable by default, the help text, every version with its badge', async () => {
    const t = await open();
    assert.equal(t.$('label[for="update-channel-select"]').textContent, 'Update channel');
    assert.match(t.$('#update-channel-section .setting-description').textContent,
        /^Beta gets test versions early; they may have bugs\. You can switch back to Stable any time\.$/);
    assert.deepEqual(Array.from(t.select.options, option => [option.value, option.textContent]), [['stable', 'Stable'], ['beta', 'Beta']]);
    assert.equal(t.select.value, 'stable', 'Stable is the default');
    assert.equal(t.rows().length, 2);
    assert.match(t.rows()[0].textContent, /Ultimate Legends\s+0\.4\.0/);
    assert.match(t.rows()[1].textContent, /XML2 Fix \(X-Men Legends II\)\s+1\.7\.1/);
    assert.equal(t.document.querySelectorAll('#update-channel-versions .beta-badge').length, 0, 'no badge on a release');
    assert.equal(t.$('#update-channel-switch-back').hidden, true);
    assert.equal(t.$('#update-channel-note').hidden, true);
    assert.deepEqual(t.backend.sent('get-update-channel').slice(0, 2), [{ refresh: false }, { refresh: true }],
        'at start only what is installed; GitHub is asked when Settings opens');
});

test('update channel: French and Spanish', async () => {
    const fr = await open({ language: 'fr', channel: 'beta', items: BETA_ITEMS });
    assert.equal(fr.$('label[for="update-channel-select"]').textContent, 'Canal de mise a jour');
    assert.equal(fr.$('#update-channel-section h3').textContent, 'Mises a jour');
    assert.match(fr.$('#update-channel-section .setting-description').textContent, /Beta recoit les versions de test en avance/);
    assert.match(fr.$('#update-channel-section .setting-description').textContent, /revenir a Stable a tout moment/);
    assert.deepEqual(Array.from(fr.select.options, option => option.textContent), ['Stable', 'Beta']);
    assert.equal(fr.select.value, 'beta');
    assert.match(fr.rows()[3].textContent, /Constructeur Legends Classic\s+0\.3\.0-beta\.1/);
    assert.equal(fr.document.querySelectorAll('#update-channel-versions .beta-badge').length, 4);

    const es = await open({ language: 'es' });
    assert.equal(es.$('label[for="update-channel-select"]').textContent, 'Canal de actualizacion');
    assert.match(es.$('#update-channel-section .setting-description').textContent, /Beta recibe versiones de prueba antes; pueden tener errores\. Puedes volver a Estable cuando quieras\./);
    assert.deepEqual(Array.from(es.select.options, option => option.textContent), ['Estable', 'Beta']);
    assert.equal(es.$('#update-channel-switch-back').textContent, 'Volver a Estable');
});

test('update channel: the launcher\'s version line shows the channel and a Beta badge on a pre-release', async () => {
    const t = await open({ channel: 'beta', items: BETA_ITEMS });
    await t.window.LauncherUpdate.refresh();
    assert.equal(t.$('#launcher-version-badge').hidden, false);
    assert.equal(t.$('#launcher-version-badge').textContent, 'Beta');
    assert.equal(t.$('#launcher-update-channel').textContent, 'Update channel: Beta');

    const stable = await open();
    await stable.window.LauncherUpdate.refresh();
    assert.equal(stable.$('#launcher-version-badge').hidden, true);
    assert.equal(stable.$('#launcher-update-channel').textContent, 'Update channel: Stable');
});

test('update channel: choosing Beta stores it, checks the launcher on it, and says so', async () => {
    const t = await open();
    choose(t, 'beta');
    await t.clock.advance(5000);
    assert.deepEqual(t.backend.sent('set-update-channel'), [{ channel: 'beta' }]);
    assert.equal(t.backend.sent('check-launcher-update').length, 1, 'the launcher checks the new channel');
    assert.equal(t.select.value, 'beta');
    assert.equal(t.select.disabled, false);
    assert.match(t.toasts.at(-1)[0], /Update channel: Beta/);
    assert.deepEqual(t.backend.sent('switch-back-to-stable'), []);
});

test('update channel: with the keyboard - Enter, Down, Enter picks Beta in place', async () => {
    const t = await open();
    t.select.focus();
    const key = name => t.document.activeElement.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    key('Enter');
    assert.equal(t.select.classList.contains('is-picking'), true);
    key('ArrowDown');
    assert.deepEqual(t.backend.sent('set-update-channel'), [], 'nothing stored while stepping');
    key('Enter');
    await t.clock.advance(5000);
    assert.deepEqual(t.backend.sent('set-update-channel'), [{ channel: 'beta' }]);
    assert.equal(t.document.activeElement, t.select, 'the focus stays on the setting');
});

test('update channel: with a controller - A, D-pad down, A picks Beta; B while picking keeps Stable', async () => {
    const t = await open();
    t.document.querySelector('.window').hidden = false;
    let state = null;
    const blank = () => ({ connected: true, mapping: 'standard', buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0] });
    const pad = button => {
        const next = blank();
        next.buttons[button] = { pressed: true, value: 1 };
        return next;
    };
    t.window.navigator.getGamepads = () => [state];
    const press = button => {
        state = pad(button);
        t.window.GamepadNav.poll();
        state = blank();
        t.window.GamepadNav.poll();
    };
    t.select.focus();
    press(0); // A
    press(13); // D-pad down
    press(1); // B: Escape puts the old value back
    await t.clock.advance(5000);
    assert.equal(t.select.value, 'stable');
    assert.deepEqual(t.backend.sent('set-update-channel'), []);

    press(0);
    press(13);
    press(0);
    await t.clock.advance(5000);
    assert.deepEqual(t.backend.sent('set-update-channel'), [{ channel: 'beta' }]);
});

// ---- switching back ----

test('update channel: back to Stable on a beta asks first; Keep the beta installs nothing and keeps the offer', async () => {
    const t = await open({ channel: 'beta', items: BETA_ITEMS });
    const asked = answer(t, 1);
    choose(t, 'stable');
    await t.clock.advance(5000);
    assert.deepEqual(t.backend.sent('set-update-channel'), [{ channel: 'stable' }]);
    assert.equal(asked.length, 1);
    const [title, body, buttons] = asked[0];
    assert.equal(title, 'You are on a beta');
    assert.match(body, /You&#39;re on a beta \(Ultimate Legends 0\.5\.0-beta\.1, XML2 Fix \(X-Men Legends II\) 1\.8\.0-beta\.2, XML2 Fix \(X-Men Legends\) 1\.8\.0-beta\.2, Legends Classic builder 0\.3\.0-beta\.1\)\. Switch back to Ultimate Legends 0\.4\.0, XML2 Fix \(X-Men Legends II\) 1\.7\.1, XML2 Fix \(X-Men Legends\) 1\.7\.1, Legends Classic builder 0\.2\.4\?/);
    assert.equal(buttons[0], 'Switch back');
    assert.deepEqual(buttons[1], { label: 'Keep the beta', cancel: true }, 'Escape / B keeps the beta');

    assert.deepEqual(t.backend.sent('switch-back-to-stable'), [], 'never a downgrade without the answer');
    assert.deepEqual(t.verified, []);
    assert.equal(t.backend.sent('keep-beta').length, 1, 'Keep the beta revokes anything approved earlier');
    assert.equal(t.$('#update-channel-switch-back').hidden, false, 'the offer stays');
    assert.match(t.$('#update-channel-note').textContent, /You are on a beta .* newer than the latest release \(0\.4\.0, 1\.7\.1, 1\.7\.1, 0\.2\.4\)/);
    assert.equal(t.select.value, 'stable');
});

test('update channel: Switch back installs exactly the versions shown, checks each, then offers Rebuild', async () => {
    const t = await open({ channel: 'beta', items: BETA_ITEMS });
    const asked = answer(t, 0, 0);
    choose(t, 'stable');
    await t.clock.advance(20000);
    assert.deepEqual(t.backend.sent('switch-back-to-stable'), [{ launcher: '0.4.0', builder: '0.2.4' }], 'the exact versions approved');
    assert.deepEqual(t.verified, ['xml2', 'xml1'], 'Verify in each folder, one after the other');
    assert.deepEqual(t.backend.sent('verify-game'), [
        { game: 'xml2', downgrade: { from: '1.8.0-beta.2', to: '1.7.1' } },
        { game: 'xml1', downgrade: { from: '1.8.0-beta.2', to: '1.7.1' } }
    ], 'each Verify carries the approval for its own folder');
    assert.deepEqual([...new Set(t.backend.sent('get-patch-attempt').map(sent => sent.attempt))], [1, 2], 'and its result is read');
    assert.ok(t.backend.sent('check-launcher-update').length >= 1, 'the launcher checked the latest release before its download');
    assert.equal(asked.length, 2, 'no failure to report');
    assert.equal(asked[1][0], 'Rebuild X-Men Legends?');
    assert.match(asked[1][1], /built with the beta/);
    assert.deepEqual(t.rebuilt, [true], 'Rebuild runs the port\'s rebuild');
    assert.match(t.toasts.at(-1)[0], /Switched back to Stable/);
    assert.equal(t.$('#update-channel-switch-back').hidden, true, 'nothing ahead any more');
});

test('update channel: a builder that did not switch back is said, and no Rebuild is offered', async () => {
    const t = await open({ channel: 'beta', items: BETA_ITEMS, outcome: { builder: 'failed' } });
    const asked = answer(t, 0, 0, 0);
    choose(t, 'stable');
    await t.clock.advance(20000);
    assert.equal(asked.length, 2, 'the prompt and the report - no Rebuild');
    const [title, body] = asked[1];
    assert.equal(title, 'Switch back to Stable');
    assert.match(body, /Not everything switched back/);
    assert.match(body, /XML2 Fix \(X-Men Legends II\): now 1\.7\.1\./);
    assert.match(body, /XML2 Fix \(X-Men Legends\): now 1\.7\.1\./);
    assert.match(body, /Legends Classic builder: still 0\.3\.0-beta\.1 \(download failed\)\./);
    assert.match(body, /Ultimate Legends 0\.4\.0: downloaded; it installs when the launcher restarts \(Restart now\)\./);
    assert.match(body, /Switch back to Stable here asks again/);
    assert.deepEqual(t.rebuilt, []);
    assert.equal(t.$('#update-channel-switch-back').hidden, false, 'the builder is still ahead: the offer stays for a retry');
});

test('update channel: a cancelled or failed fix, or one that could not start, is said; no Rebuild without the port\'s fix', async () => {
    for (const [result, reason] of [['cancelled', 'cancelled'], ['failed', 'Failed to download: dinput\\.dll'], ['busy', 'it could not start now']]) {
        const t = await open({ channel: 'beta', items: [BETA_ITEMS[1], BETA_ITEMS[2], BETA_ITEMS[3]], outcome: { fix: { xml1: result } } });
        const asked = answer(t, 0, 0, 0);
        choose(t, 'stable');
        await t.clock.advance(20000);
        assert.equal(asked.length, 2, `${result}: the prompt and the report`);
        assert.match(asked[1][1], /XML2 Fix \(X-Men Legends II\): now 1\.7\.1/);
        assert.match(asked[1][1], new RegExp(`XML2 Fix \\(X-Men Legends\\): still 1\\.8\\.0-beta\\.2 \\(${reason}\\)`), `${result}: said`);
        assert.match(asked[1][1], /Legends Classic builder: now 0\.2\.4/);
        assert.deepEqual(t.rebuilt, [], `${result}: the port's fix is still the beta, no Rebuild`);
    }
});

test('update channel: a launcher download that failed is said; nothing is waiting to install', async () => {
    const t = await open({ channel: 'beta', items: [BETA_ITEMS[0], BETA_ITEMS[1]], outcome: { launcher: 'failed' } });
    const asked = answer(t, 0, 0);
    choose(t, 'stable');
    await t.clock.advance(20000);
    assert.match(asked[1][1], /Ultimate Legends: still 0\.5\.0-beta\.1 \(Switching back to 0\.4\.0 failed: the download was interrupted\. Your launcher was not changed\.\)/);
    assert.match(asked[1][1], /XML2 Fix \(X-Men Legends II\): now 1\.7\.1/);
    assert.deepEqual(t.rebuilt, [], 'neither the builder nor the port\'s fix was part of it');
});

test('update channel: a retry asks again and carries a fresh approval; Keep the beta between sends only its revocation', async () => {
    const t = await open({ items: [BETA_ITEMS[2]], outcome: { fix: { xml1: 'cancelled' } } });
    const back = t.$('#update-channel-switch-back');
    let asked = answer(t, 0, 0);
    back.click();
    await t.clock.advance(20000);
    assert.equal(asked.length, 2, 'the prompt, then the report');
    assert.equal(back.hidden, false, 'still offered');

    // Later: Keep the beta. Nothing is sent but the revocation.
    asked = answer(t, 1);
    back.click();
    await t.clock.advance(5000);
    assert.equal(t.backend.sent('verify-game').length, 1);
    assert.equal(t.backend.sent('keep-beta').length, 1);

    // Then a retry that works: asked again, a fresh approval with this attempt's versions; Rebuild offered.
    t.backend.outcome.fix.xml1 = 'done';
    asked = answer(t, 0, 0);
    back.click();
    await t.clock.advance(20000);
    assert.equal(asked[0][0], 'You are on a beta', 'asked again');
    assert.deepEqual(t.backend.sent('verify-game'), [
        { game: 'xml1', downgrade: { from: '1.8.0-beta.2', to: '1.7.1' } },
        { game: 'xml1', downgrade: { from: '1.8.0-beta.2', to: '1.7.1' } }
    ]);
    assert.equal(asked[1][0], 'Rebuild X-Men Legends?', 'the port\'s fix is stable now');
    assert.deepEqual(t.rebuilt, [true]);
});

test('update channel: the switch-back report in French and Spanish', async () => {
    const fr = await open({ language: 'fr', channel: 'beta', items: [BETA_ITEMS[3]], outcome: { builder: 'failed' } });
    const askedFr = answer(fr, 0, 0);
    choose(fr, 'stable');
    await fr.clock.advance(20000);
    assert.equal(askedFr[1][0], 'Revenir a Stable');
    assert.match(askedFr[1][1], /Tout n&#39;est pas revenu a Stable :/);
    assert.match(askedFr[1][1], /Constructeur Legends Classic : toujours 0\.3\.0-beta\.1 \(download failed\)\./);

    const es = await open({ language: 'es', channel: 'beta', items: [BETA_ITEMS[1]], outcome: { fix: { xml2: 'cancelled' } } });
    const askedEs = answer(es, 0, 0);
    choose(es, 'stable');
    await es.clock.advance(20000);
    assert.equal(askedEs[1][0], 'Volver a Estable');
    assert.match(askedEs[1][1], /XML2 Fix \(X-Men Legends II\): sigue en 1\.8\.0-beta\.2 \(cancelado\)\./);
});

test('update channel: with a pad - Switch back, the report closed with B, the offer still reachable', async () => {
    const t = await open({ items: [BETA_ITEMS[1]], outcome: { fix: { xml2: 'failed' } } });
    const back = t.$('#update-channel-switch-back');
    back.focus();
    t.window.FocusNav.press('Enter', 'pad');
    await t.clock.advance(100);
    t.window.FocusNav.sync();
    assert.match(t.document.querySelector('#message-box .mb-title').textContent, /You are on a beta/);
    t.window.FocusNav.press('Enter', 'pad'); // A on Switch back (the box's first button has the focus)
    await t.clock.advance(20000);
    t.window.FocusNav.sync();
    const buttons = t.document.querySelectorAll('#message-box .mb-buttons button');
    assert.deepEqual(Array.from(buttons, button => button.textContent), ['OK']);
    assert.match(t.document.querySelector('#message-box .mb-title').textContent, /Switch back to Stable/);
    t.window.FocusNav.press('Escape', 'pad');
    await t.clock.advance(1000);
    t.window.FocusNav.sync();
    assert.equal(back.hidden, false, 'still offered');
    assert.equal(t.document.activeElement, back, 'the focus is back on Switch back to Stable');
});

test('update channel: the Switch back button offers the same choice later; no Rebuild when the port has no build', async () => {
    const t = await open({ items: [BETA_ITEMS[1]] });
    t.window.Xml1Port.status = { state: 'not-setup' };
    const back = t.$('#update-channel-switch-back');
    assert.equal(back.hidden, false);
    assert.equal(back.textContent, 'Switch back to Stable');
    const asked = answer(t, 0);
    back.click();
    await t.clock.advance(20000);
    assert.match(asked[0][1], /You&#39;re on a beta \(XML2 Fix \(X-Men Legends II\) 1\.8\.0-beta\.2\)\. Switch back to XML2 Fix \(X-Men Legends II\) 1\.7\.1\?/);
    assert.deepEqual(t.backend.sent('switch-back-to-stable'), [{ launcher: '', builder: '' }]);
    assert.deepEqual(t.verified, ['xml2']);
    assert.equal(asked.length, 1, 'only the X-Men Legends II fix changed: no report, no rebuild');
    assert.deepEqual(t.rebuilt, []);
});

test('update channel: the switch-back prompt in French and Spanish', async () => {
    const fr = await open({ language: 'fr', channel: 'beta', items: [BETA_ITEMS[1]] });
    const askedFr = answer(fr, 1);
    choose(fr, 'stable');
    await fr.clock.advance(5000);
    assert.equal(askedFr[0][0], 'Vous etes sur une beta');
    assert.match(askedFr[0][1], /Vous etes sur une beta \(XML2 Fix \(X-Men Legends II\) 1\.8\.0-beta\.2\)\. Revenir a XML2 Fix \(X-Men Legends II\) 1\.7\.1 \?/);
    assert.deepEqual(askedFr[0][2], ['Revenir', { label: 'Garder la beta', cancel: true }]);

    const es = await open({ language: 'es', channel: 'beta', items: [BETA_ITEMS[3]] });
    const askedEs = answer(es, 1);
    choose(es, 'stable');
    await es.clock.advance(5000);
    assert.equal(askedEs[0][0], 'Estas en una beta');
    assert.match(askedEs[0][1], /Estas en una beta \(Constructor de Legends Classic 0\.3\.0-beta\.1\)\. ¿Volver a Constructor de Legends Classic 0\.2\.4\?/);
    assert.deepEqual(askedEs[0][2], ['Volver', { label: 'Mantener la beta', cancel: true }]);
});

test('update channel: the prompt is a real message box a pad can answer (B keeps the beta)', async () => {
    const t = await open({ channel: 'beta', items: [BETA_ITEMS[1]] });
    choose(t, 'stable');
    await t.clock.advance(5000);
    t.window.FocusNav.sync();
    const buttons = t.document.querySelectorAll('#message-box .mb-buttons button');
    assert.deepEqual(Array.from(buttons, button => button.textContent), ['Switch back', 'Keep the beta']);
    assert.equal(t.document.activeElement, buttons[0], 'the box takes the focus');
    t.window.FocusNav.press('Escape', 'pad');
    await t.clock.advance(5000);
    assert.deepEqual(t.backend.sent('switch-back-to-stable'), [], 'B: kept');
    assert.equal(t.$('#update-channel-switch-back').hidden, false);
});

// ---- GitHub couldn't be asked ----

test('update channel: on Beta without GitHub, the note says the last result is used', async () => {
    const t = await open({ channel: 'beta', items: BETA_ITEMS,
        repos: [{ id: 'fix', version: '1.8.0-beta.2', fromCache: true, error: "GitHub's limit on update checks was reached (HTTP 403)" }] });
    assert.equal(t.note(), "XML2 Fix: GitHub could not be reached (GitHub's limit on update checks was reached (HTTP 403)). Using the last result (1.8.0-beta.2).");
    assert.equal(t.$('#update-channel-switch-back').hidden, true, 'Beta: nothing to switch back from');
});

test('update channel: a first Beta check that failed with no earlier result is said, per repository', async () => {
    for (const error of ["GitHub's limit on update checks was reached (HTTP 403); it resets within an hour.",
        "GitHub's limit on update checks was reached (HTTP 429); it resets within an hour.",
        'Could not reach GitHub (Could not resolve host).', "GitHub's answer is not a list of releases."]) {
        const t = await open({ channel: 'beta', items: STABLE_ITEMS, repos: [
            { id: 'launcher', version: '', fromCache: false, error },
            { id: 'fix', version: '', fromCache: false, error },
            { id: 'builder', version: '', fromCache: false, error }
        ] });
        const lines = t.note().split('\n');
        assert.equal(lines.length, 3, error);
        assert.equal(lines[1], `XML2 Fix: could not check (${error}), and there is no earlier result to use. Nothing was changed; it is checked again later.`);
        assert.match(lines[0], /^Ultimate Legends: could not check/);
        assert.match(lines[2], /^Legends Classic builder: could not check/);
        assert.doesNotMatch(t.note(), /Using the last/, 'no claim that an earlier result is used');
    }
});

test('update channel: mixed results - one fine, one from its last result, one not checked; then a retry that works', async () => {
    const t = await open({ channel: 'beta', items: STABLE_ITEMS, repos: [
        { id: 'launcher', version: '0.4.0', fromCache: false, error: '' },
        { id: 'fix', version: '1.8.0-beta.1', fromCache: true, error: 'Could not reach GitHub (timeout).' },
        { id: 'builder', version: '', fromCache: false, error: 'GitHub answered HTTP 502.' }
    ] });
    assert.deepEqual(t.note().split('\n'), [
        'XML2 Fix: GitHub could not be reached (Could not reach GitHub (timeout).). Using the last result (1.8.0-beta.1).',
        'Legends Classic builder: could not check (GitHub answered HTTP 502.), and there is no earlier result to use. Nothing was changed; it is checked again later.'
    ]);
    t.backend.repos = [{ id: 'launcher', version: '0.4.0', fromCache: false, error: '' }, { id: 'fix', version: '1.8.0-beta.1', fromCache: false, error: '' },
        { id: 'builder', version: '0.3.0-beta.1', fromCache: false, error: '' }];
    await t.window.UpdateChannel.refresh(true);
    assert.equal(t.note(), '', 'all checked: no note');
});

test('update channel: Stable says the same when GitHub can\'t be asked; offline mode says only that', async () => {
    const t = await open({ repos: [{ id: 'fix', version: '1.7.1', fromCache: true, error: "GitHub's limit on update checks was reached (HTTP 403); it resets within an hour." }] });
    assert.match(t.note(), /^XML2 Fix: GitHub could not be reached .* Using the last result \(1\.7\.1\)\.$/);
    t.backend.offline = true;
    await t.window.UpdateChannel.refresh(false);
    assert.equal(t.note(), 'Offline mode: the channel is not checked.');
});

test('update channel: the could-not-check note in French and Spanish', async () => {
    const repos = [{ id: 'fix', version: '', fromCache: false, error: 'HTTP 403' }];
    const fr = await open({ language: 'fr', channel: 'beta', items: STABLE_ITEMS, repos });
    assert.equal(fr.note(), "XML2 Fix : verification impossible (HTTP 403), et aucun resultat precedent n'est disponible. Rien n'a change ; une nouvelle verification aura lieu plus tard.");
    const es = await open({ language: 'es', channel: 'beta', items: STABLE_ITEMS, repos });
    assert.equal(es.note(), 'XML2 Fix: no se pudo comprobar (HTTP 403) y no hay un resultado anterior. No se cambio nada; se volvera a comprobar mas tarde.');
});

// ---- where versions were shown before ----

test('update channel: a game page\'s XML2 Fix line shows a beta\'s whole version with a Beta badge', async () => {
    const statuses = {
        xml2: { installed: '1.8.0-beta.2', latest: '1.8.0-beta.3', page: '', checking: false, updateAvailable: true, channel: 'beta', prerelease: true },
        mua: { installed: '1.2.0', latest: '1.2.0', page: '', checking: false, updateAvailable: false, channel: 'stable', prerelease: false }
    };
    const p = page({
        scripts: ['core/utils.js', 'core/i18n.js', 'app/patch-view.js'],
        backend: { handle: (command, data) => (command === 'get-patch-status' ? statuses[data.game] : null) },
        body: '<div id="xml2-patch"></div><div id="mua-patch"></div>'
    });
    await p.window.PatchView.render('xml2');
    await p.window.PatchView.render('mua');
    const xml2 = p.document.querySelector('#xml2-patch .detail-patch-installed');
    assert.match(xml2.textContent, /^1\.8\.0-beta\.2\s*Beta$/);
    assert.equal(p.document.querySelectorAll('#xml2-patch .beta-badge').length, 1);
    assert.match(p.document.querySelector('#xml2-patch .detail-patch-update').textContent, /Update available: 1\.8\.0-beta\.3/);
    assert.equal(p.document.querySelectorAll('#mua-patch .beta-badge').length, 0, 'a release: no badge');
});
