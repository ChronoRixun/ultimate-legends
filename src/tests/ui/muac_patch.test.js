'use strict';
const assert = require('node:assert/strict');
const { page, test, settle } = require('./harness');

async function open(status, options = {}) {
    const calls = [];
    let patch = status;
    let state = { active: false, success: false };
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'core/focus-nav.js', 'app/muac-setup.js', 'app/patch-view.js'],
        body: '<button id="return-focus">Return</button><div id="muac-button-group"><button id="muac-play">Play</button></div><div id="muac-patch"></div><div id="xml2-patch"></div>',
        backend: { handle(command, data) {
            calls.push({ command, data });
            if (command === 'get-patch-status') return patch;
            if (command === 'get-muac-setup') return { ...state };
            if (command === 'start-muac-update') {
                if (options.refuse) return { success: false, error: 'Close MUA 2006 before updating MUA Classic Fix.' };
                state = { active: true, updating: true, phase: 'Updating MUA Classic Fix', percent: 50 };
                return { success: true };
            }
            if (command === 'cancel-muac-setup') { state = { active: true, updating: true, cancelled: true }; return { ...state }; }
            return null;
        } } });
    p.window.verifyGame = game => calls.push({ command: 'verify', game });
    await p.window.PatchView.render('muac'); await settle();
    return { ...p, calls, setPatch: value => { patch = value; }, setState: value => { state = value; } };
}

test('MUAC patch: installed, unknown and absent versions use the shared patch line', async () => {
    for (const [installed, expected] of [['0.2.1', '0.2.1'], ['', 'version unknown'], [null, 'Not installed']]) {
        const p = await open({ installed, updateAvailable: false });
        assert.ok(p.window.PatchView.supports('muac'));
        assert.match(p.document.querySelector('#muac-patch').textContent, /MUA Classic Fix/);
        assert.match(p.document.querySelector('.detail-patch-installed').textContent.toLowerCase(), new RegExp(expected.toLowerCase()));
        assert.equal(p.document.querySelector('.detail-patch-update-action'), null);
    }
});

test('MUAC patch: prerelease badge and newer release; text is escaped', async () => {
    const p = await open({ installed: '0.2.2-beta.1', prerelease: true, latest: '0.2.2-beta.2', updateAvailable: true, page: 'https://example.com/release' });
    assert.equal(p.document.querySelector('.beta-badge').textContent, 'Beta');
    assert.match(p.document.querySelector('.detail-patch-update-label').textContent, /0\.2\.2-beta\.2/);
    p.setPatch({ installed: '<img src=x>', latest: '<script>bad</script>', updateAvailable: true });
    await p.window.PatchView.render('muac');
    assert.equal(p.document.querySelector('#muac-patch img'), null);
    assert.equal(p.document.querySelector('#muac-patch script'), null);
});

test('MUAC patch: Update starts runtime update without disc fields or Verify', async () => {
    const p = await open({ installed: '0.2.0', latest: '0.2.1', updateAvailable: true });
    const update = p.document.querySelector('.detail-patch-update-action');
    update.focus(); update.click(); await settle();
    assert.equal(p.calls.filter(c => c.command === 'start-muac-update').length, 1);
    assert.equal(p.calls.filter(c => c.command === 'verify' || c.command === 'start-muac-setup').length, 0);
    assert.equal(p.document.querySelector('#muac-source'), null);
    assert.equal(p.document.querySelector('#muac-output'), null);
    assert.equal(p.document.querySelector('[data-act="existing"]'), null);
    assert.equal(p.document.querySelector('#muac-setup-title').textContent, 'Update MUA Classic Fix');
    assert.ok(p.document.querySelector('[data-act="cancel"]'));
    p.setState({ active: false, updating: true, success: true });
    p.setPatch({ installed: '0.2.1', latest: '0.2.1', updateAvailable: false });
    await p.clock.advance(800); await settle();
    assert.equal(p.document.querySelector('.detail-patch-installed').textContent.trim(), '0.2.1');
    assert.equal(p.document.querySelector('.detail-patch-update-action'), null);
    assert.equal(p.document.querySelector('.muac-setup-progress').textContent, 'MUA Classic Fix is up to date.');
    assert.ok(p.document.activeElement === p.document.querySelector('[data-act="done"]'), 'completion focuses Done');
    p.document.querySelector('[data-act="done"]').click(); await settle();
    assert.ok(p.document.activeElement === p.document.querySelector('#muac-play'), 'close returns focus to a live game action');
});

test('MUAC patch: refusal stays visible, hiding keeps update alive, and later updates can start', async () => {
    const refused = await open({ installed: '0.2.0', latest: '0.2.1', updateAvailable: true }, { refuse: true });
    await refused.window.MuacSetup.showUpdate(); await settle();
    assert.match(refused.document.querySelector('.muac-setup-error').textContent, /Close MUA/);
    await refused.clock.advance(800); await settle();
    assert.match(refused.document.querySelector('.muac-setup-error').textContent, /Close MUA/);
    assert.ok(refused.document.querySelector('[data-act="start"]'));

    const p = await open({ installed: '0.2.0', latest: '0.2.1', updateAvailable: true });
    await p.window.MuacSetup.showUpdate(); await settle();
    p.document.querySelector('[data-act="hide"]').click(); await settle();
    assert.equal(p.calls.filter(c => c.command === 'cancel-muac-setup').length, 0);
    await p.window.MuacSetup.showUpdate(); await settle();
    assert.equal(p.calls.filter(c => c.command === 'start-muac-update').length, 1);
    p.setState({ active: false, updating: true, success: true }); await p.clock.advance(800); await settle();
    p.document.querySelector('[data-act="done"]').click();
    await p.window.MuacSetup.showUpdate(); await settle();
    assert.equal(p.calls.filter(c => c.command === 'start-muac-update').length, 2);
});

test('MUAC patch: checking polls, failed or incompatible latest offers no Update, other games still Verify', async () => {
    const p = await open({ installed: '0.2.0', checking: true, updateAvailable: false });
    p.setPatch({ installed: '0.2.0', checking: false, latest: null, updateAvailable: false, error: 'Needs a newer launcher.' });
    await p.clock.advance(1600); await settle();
    assert.ok(p.calls.filter(c => c.command === 'get-patch-status').length >= 2);
    assert.equal(p.document.querySelector('.detail-patch-update-action'), null);
    assert.match(p.document.querySelector('.detail-patch-check-error').textContent, /Needs a newer launcher/);
    p.setPatch({ installed: '1.0.0', latest: '1.1.0', updateAvailable: true });
    await p.window.PatchView.render('xml2');
    p.document.querySelector('#xml2-patch .detail-patch-update-action').click(); await settle();
    assert.ok(p.calls.some(c => c.command === 'verify' && c.game === 'xml2'));
});

test('MUAC patch: keyboard and controller activate Update', async () => {
    for (const source of ['key', 'pad']) {
        const p = await open({ installed: '0.2.0', latest: '0.2.1', updateAvailable: true });
        p.window.FocusNav.setRectSource(() => ({ left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }));
        p.document.querySelector('.detail-patch-update-action').focus();
        p.window.FocusNav.press('Enter', source); await settle();
        assert.equal(p.calls.filter(c => c.command === 'start-muac-update').length, 1);
    }
});

test('MUAC patch: rapid double activation opens one popup and starts one job', async () => {
    const p = await open({ installed: '0.2.0', latest: '0.2.1', updateAvailable: true });
    await Promise.all([p.window.MuacSetup.showUpdate(), p.window.MuacSetup.showUpdate()]); await settle();
    assert.equal(p.document.querySelectorAll('#muac-setup-title').length, 1);
    assert.equal(p.calls.filter(c => c.command === 'start-muac-update').length, 1);
});
