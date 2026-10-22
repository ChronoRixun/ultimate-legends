'use strict';
// Settings > Updates > Update channel (app/update-channel.js, updater/channel_status.hpp): the setting in
// en / fr / es, picked with the keyboard and a controller (FocusNav / GamepadNav), the versions with their
// Beta badge, the note when Beta used its last release because GitHub couldn't be asked, and switching
// back to Stable: "You're on a beta (x). Switch back to y?" - Keep the beta changes nothing, Switch back
// reinstalls the latest releases (the launcher's download, Verify for the fix, the builder) and then offers
// to rebuild X-Men Legends. The real scripts run against a fake backend.

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

class Backend {
    constructor({ channel = 'stable', items = STABLE_ITEMS, fromCache = null } = {}) {
        this.channel = channel;
        this.items = items.map(item => Object.assign({ beta: '', fromCache: false, error: '', dev: false }, item));
        this.fromCache = fromCache;
        this.calls = [];
        this.switchBack = { launcher: true, builder: true, fixGames: ['xml2', 'xml1'] };
        this.launcherState = 'up-to-date';
    }

    status() {
        // "ahead" only counts on Stable (the backend reports it either way; the page decides).
        const items = this.items.map(item => Object.assign({}, item, this.fromCache && this.channel === 'beta'
            ? { fromCache: true, error: this.fromCache.error, beta: this.fromCache.version } : {}));
        return { channel: this.channel, offline: false, checking: false, items };
    }

    handle(command, data) {
        this.calls.push([command, data]);
        switch (command) {
            case 'get-update-channel': return this.status();
            case 'set-update-channel':
                this.channel = data.channel;
                return this.status();
            case 'switch-back-to-stable': return this.switchBack;
            case 'get-launcher-update':
            case 'check-launcher-update':
                return {
                    enabled: true, current: this.items[0].installed, canInstall: true, state: this.launcherState,
                    latest: '0.4.0', channel: this.channel, prerelease: this.items[0].prerelease,
                    aheadOfStable: this.channel === 'stable' && this.items[0].ahead, fromCache: false, cacheError: ''
                };
            case 'verify-game': return null;
            case 'get-update-progress': return { active: false };
            case 'get-xml1-status': return { builder: { checking: false, installing: false } };
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
    // What the switch back runs through (main.js / utils.js): Verify's progress, the port's rebuild.
    const verified = [];
    vm.runInContext('GameUtils', p.window).trackCommandProgress = async config => {
        verified.push(config.commandArgs.game);
        await p.window.executeCommand(config.command, config.commandArgs);
        return null;
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
    return { ...p, backend, $, rows, verified, rebuilt, select: $('#update-channel-select') };
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

test('update channel: on Beta without GitHub, the note says the last beta found is used', async () => {
    const t = await open({ channel: 'beta', items: BETA_ITEMS, fromCache: { error: "GitHub's limit on update checks was reached (HTTP 403)", version: '1.8.0-beta.2' } });
    assert.equal(t.$('#update-channel-note').hidden, false);
    assert.match(t.$('#update-channel-note').textContent, /GitHub could not be reached \(GitHub's limit on update checks was reached \(HTTP 403\)\)\. Using the last beta found \(1\.8\.0-beta\.2\)\./);
    assert.equal(t.$('#update-channel-switch-back').hidden, true, 'Beta: nothing to switch back from');
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
    assert.equal(t.$('#update-channel-switch-back').hidden, false, 'the offer stays');
    assert.match(t.$('#update-channel-note').textContent, /You are on a beta .* newer than the latest release \(0\.4\.0, 1\.7\.1, 1\.7\.1, 0\.2\.4\)/);
    assert.equal(t.select.value, 'stable');
});

test('update channel: Switch back reinstalls the stable items, then offers Rebuild', async () => {
    const t = await open({ channel: 'beta', items: BETA_ITEMS });
    const asked = answer(t, 0, 0);
    choose(t, 'stable');
    await t.clock.advance(20000);
    assert.deepEqual(t.backend.sent('switch-back-to-stable'), [{ items: ['launcher', 'fix', 'builder'] }]);
    assert.deepEqual(t.verified, ['xml2', 'xml1'], 'Verify installs the latest fix in each folder, one after the other');
    assert.deepEqual(t.backend.sent('verify-game'), [{ game: 'xml2' }, { game: 'xml1' }]);
    assert.ok(t.backend.sent('check-launcher-update').length >= 1, 'the launcher checked the latest release before its download');
    assert.ok(t.backend.sent('get-xml1-status').length >= 1, 'waited for the builder');
    assert.equal(asked.length, 2);
    assert.equal(asked[1][0], 'Rebuild X-Men Legends?');
    assert.match(asked[1][1], /built with the beta/);
    assert.deepEqual(t.rebuilt, [true], 'Rebuild runs the port\'s rebuild');
});

test('update channel: the Switch back button offers the same choice later; no Rebuild when the port has no build', async () => {
    const t = await open({ items: [BETA_ITEMS[1]] });
    t.window.Xml1Port.status = { state: 'not-setup' };
    t.backend.switchBack = { launcher: false, builder: false, fixGames: ['xml2'] };
    const back = t.$('#update-channel-switch-back');
    assert.equal(back.hidden, false);
    assert.equal(back.textContent, 'Switch back to Stable');
    const asked = answer(t, 0);
    back.click();
    await t.clock.advance(20000);
    assert.match(asked[0][1], /You&#39;re on a beta \(XML2 Fix \(X-Men Legends II\) 1\.8\.0-beta\.2\)\. Switch back to XML2 Fix \(X-Men Legends II\) 1\.7\.1\?/);
    assert.deepEqual(t.backend.sent('switch-back-to-stable'), [{ items: ['fix'] }]);
    assert.deepEqual(t.verified, ['xml2']);
    assert.equal(asked.length, 1, 'only the X-Men Legends II fix changed: no rebuild offered');
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
