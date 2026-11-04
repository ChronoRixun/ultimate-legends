/* Regression: all build paths must consult the selected builder, including an installed
 * stable builder in a fresh-install wizard after choosing Beta. Only external CEF commands
 * are faked; the settings controller and Xml1Port execute their real scripts. */
'use strict';
const assert = require('node:assert/strict');
const { page, test } = require('./harness');

function open({ channel = 'stable', install = 'O:/Games/Legends', failed = false } = {}) {
    let p;
    let selected = channel;
    const calls = [];
    const builder = { installed: true, version: '0.4.0', channel: 'stable', latestChannel: 'stable',
        latest: { version: '0.4.0', size: 1 }, updateAvailable: false, checking: false, installing: false };
    let fixing = false;
    let fixInstalled = false;
    const status = () => ({ install, state: 'ready', xml2: { setUp: true }, builder: { ...builder }, work: null });
    p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/xml1-port.js', 'app/xml1-view.js', 'app/xml1-setup.js', 'app/update-channel.js'],
        body: '<div id="xml1-build-panel"></div>',
        backend: { handle(command, data) {
            calls.push([command, data]);
            switch (command) {
                case 'get-version': return { version: '0.5.0-beta.6' };
                case 'get-update-channel': return { channel: selected, checking: false, items: [], repos: [] };
                case 'set-update-channel': selected = data.channel; return { channel: selected, checking: false, items: [], repos: [] };
                case 'xml1-builder-check': {
                    if (builder.checking) return false;
                    const resolving = selected;
                    builder.checking = true;
                    p.clock.setTimeout(() => {
                        builder.checking = false;
                        builder.channel = resolving;
                        builder.latestChannel = resolving;
                        builder.latest = failed ? null : { version: resolving === 'beta' ? '0.6.0-beta.1' : '0.4.0', size: 1 };
                        builder.updateAvailable = !!builder.latest && builder.version !== builder.latest.version;
                        builder.code = failed ? 'L_BUILDER_OFFLINE' : '';
                        builder.error = failed ? 'Could not reach GitHub.' : '';
                        if (data.install && builder.latest) {
                            builder.version = builder.latest.version;
                            builder.updateAvailable = false;
                        }
                    }, 750);
                    return true;
                }
                case 'get-xml1-status': return status();
                case 'xml1-folder': return { updating: fixing, fix: fixInstalled };
                case 'xml1-update-fix':
                    fixing = true;
                    p.clock.setTimeout(() => { fixing = false; fixInstalled = true; }, 500);
                    return { started: true };
                case 'get-update-progress': return { active: fixing, progress: 50, message: 'Preparing fix' };
                case 'xml1-build-start': return { success: true, id: 7, builder: builder.version };
                case 'get-xml1-build': return null;
                default: return null;
            }
        } }
    });
    p.window.ProgressManager = { show() {}, update() {}, hide() {} };
    p.window.LauncherUpdate = { check: async () => calls.push(['launcher-check', selected]) };
    return { ...p, calls, builder, status, port: p.window.Xml1Port };
}

async function complete(p, action) {
    let result;
    let done = false;
    const pending = action.then(value => { result = value; done = true; });
    await p.clock.until(() => done, 10000, 'channel/build refresh');
    await pending;
    return result;
}

for (const [before, next, expected] of [['stable', 'beta', '0.6.0-beta.1'], ['beta', 'stable', '0.4.0']]) {
    test(`channel refresh: ${before} -> ${next} refreshes the builder UI immediately`, async () => {
        const p = open({ channel: before });
        if (before === 'beta') {
            Object.assign(p.builder, { version: '0.6.0-beta.1', latestChannel: 'beta', latest: { version: '0.6.0-beta.1' } });
        }
        await p.port.refresh();
        await p.window.UpdateChannel.init();
        await complete(p, p.window.UpdateChannel.choose(next));
        assert.equal(p.port.status.builder.latestChannel, next);
        assert.equal(p.port.status.builder.latest.version, expected);
        if (next === 'stable') assert.equal(p.port.status.builder.version, '0.6.0-beta.1', 'a reverse switch does not silently downgrade');
        if (next === 'beta') assert.match(p.document.querySelector('#xml1-build-panel').textContent, /0\.6\.0-beta\.1/);
        assert.equal(p.calls.filter(call => call[0] === 'launcher-check').length, 1);
    });
}

test('channel refresh: self-update startup checks persisted Beta without a configured port', async () => {
    const p = open({ channel: 'beta', install: '' });
    await p.port.init();
    await p.window.UpdateChannel.init();
    await p.clock.advance(1500);
    assert.equal(p.calls.find(call => call[0] === 'get-update-channel')[1].refresh, true);
    assert.equal(p.port.status.builder.latest.version, '0.6.0-beta.1');
    assert.equal(p.port.status.builder.latestChannel, 'beta');
    assert.equal(p.calls.find(call => call[0] === 'xml1-builder-check')[1].install, false);
});

test('channel refresh: first build immediately after a switch installs the selected builder before starting', async () => {
    const p = open({ channel: 'beta' });
    await p.port.refresh(); // stale stable manifest and installed 0.4.0, as in the fresh-install report
    const started = await complete(p, p.port.startBuildNow({ out: 'O:/Games/Legends' }));
    assert.equal(started.success, true);
    assert.equal(started.builder, '0.6.0-beta.1');
    const commands = p.calls.map(call => call[0]);
    assert.ok(commands.indexOf('xml1-builder-check') < commands.indexOf('xml1-build-start'));
});

test('channel refresh: failed feed blocks a first build instead of reusing a stable builder on Beta', async () => {
    const p = open({ channel: 'beta', failed: true });
    await p.port.refresh();
    const started = await complete(p, p.port.startBuildNow({ out: 'O:/Games/Legends' }));
    assert.equal(started.success, false);
    assert.match(started.error, /GitHub/);
    assert.equal(p.calls.filter(call => call[0] === 'xml1-build-start').length, 0);
});

test('channel refresh: a build waits for a busy lookup then retries its install request', async () => {
    const p = open({ channel: 'beta' });
    await p.port.refresh();
    const looking = p.port.checkBuilder(false);
    const started = await complete(p, p.port.startBuildNow({ out: 'O:/Games/Legends' }));
    await looking;
    assert.equal(started.success, true);
    assert.equal(started.builder, '0.6.0-beta.1');
    assert.equal(p.calls.filter(call => call[0] === 'xml1-builder-check' && call[1].install).length, 2,
        'one refused while busy; the install request is submitted again after that check finishes');
});

test('channel refresh: a failed lookup on switching clears the old manifest and displays the error', async () => {
    const p = open({ failed: true });
    await p.port.refresh();
    await p.window.UpdateChannel.init();
    await complete(p, p.window.UpdateChannel.choose('beta'));
    assert.equal(p.port.status.builder.latest, null);
    assert.equal(p.port.status.builder.latestChannel, 'beta');
    assert.equal(p.port.status.builder.code, 'L_BUILDER_OFFLINE');
    assert.match(p.port.status.builder.error, /GitHub/);
    assert.ok(p.document.querySelector('#xml1-build-panel .xml1-note.is-error'));
});

test('channel refresh: other component views see the switch before slow lookups finish', async () => {
    const p = open();
    await p.port.refresh();
    await p.window.UpdateChannel.init();
    const events = [];
    p.window.addEventListener('gameInstallationUpdated', () => events.push(p.clock.now));
    p.window.LauncherUpdate.check = () => new Promise(resolve => p.clock.setTimeout(resolve, 5000));
    const switching = p.window.UpdateChannel.choose('beta');
    await p.clock.advance(0);
    assert.equal(events.length, 1, 'notify patch/model views as soon as the selected channel is stored');
    assert.equal(p.window.UpdateChannel.busy, true, 'component lookups are still running');
    await complete(p, switching);
    assert.equal(events.length, 2, 'also refresh completed states');
});

test('channel refresh: setup wizard displays a failed lookup even with an installed builder', async () => {
    const p = open({ failed: true });
    await p.port.refresh();
    await complete(p, p.port.checkBuilder(false));
    await p.window.Xml1Setup.show();
    assert.match(p.document.querySelector('.xml1-setup').textContent, /release page could not be reached/);
});

test('channel refresh: an open setup wizard replaces the Stable installed answer after choosing Beta', async () => {
    const p = open();
    await p.port.refresh();
    await p.window.UpdateChannel.init();
    await p.window.Xml1Setup.show();
    assert.match(p.document.querySelector('.xml1-setup').textContent, /0\.4\.0/);
    await p.clock.advance(0); // initial free-space answer may redraw the form
    const field = p.document.querySelector('.xml1-setup input');
    field.value = 'O:/Discs/player-typing.iso';
    field.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    field.focus();
    await complete(p, p.window.UpdateChannel.choose('beta'));
    assert.ok(p.document.activeElement === field, 'builder-only refresh preserves the input focus');
    assert.equal(field.value, 'O:/Discs/player-typing.iso');
    const text = p.document.querySelector('.xml1-setup').textContent;
    assert.match(text, /0\.6\.0-beta\.1/);
    assert.match(text, /will be installed when you build/);
    assert.doesNotMatch(text, /is being installed/);
    assert.match(p.document.querySelector('#xml1-build-panel').textContent, /0\.6\.0-beta\.1/);
    p.document.querySelector('.xml1-setup [data-act="builder-zip"]').click();
    await p.clock.advance(0);
    assert.ok(p.calls.some(call => call[0] === 'browse-file'), 'the refreshed builder zip action remains bound');
});

for (const channel of ['stable', 'beta']) {
    test(`build preparation: ${channel} resolves builder, installs missing fix, waits, then starts`, async () => {
        const p = open({ channel });
        await p.port.refresh();
        const result = await complete(p, p.port.startBuildNow({ out: 'O:/Games/Fresh' }));
        assert.equal(result.success, true);
        const names = p.calls.map(call => call[0]);
        const check = names.indexOf('xml1-builder-check');
        const fix = names.indexOf('xml1-update-fix');
        const build = names.indexOf('xml1-build-start');
        assert.ok(check < fix && fix < build);
        assert.equal(result.builder, channel === 'beta' ? '0.6.0-beta.1' : '0.4.0');
    });
}
