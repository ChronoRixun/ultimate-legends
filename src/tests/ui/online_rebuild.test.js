'use strict';
// The Online section needs a build made for online play (FS1): a 1.8 XML2 Fix in a folder built by an older
// builder (its stamp's requires.xml2fix below 1.8.0-0, whatever GameVersion its ini has) has no rooms, so Host and Join stay
// off and the section says "Rebuild to play online: this build is older than your XML2 Fix" with Rebuild
// (xml1-view.js's, the X-Men Legends page's own confirmation). A start the backend refuses with
// build_too_old says the same. The XML2 Fix's own messages come first; normal Play is unaffected. The real
// online-view.js runs on online_fixture.js's fake backend.

const assert = require('node:assert/strict');
const { test } = require('./harness');

const { open, host } = require('./online_fixture');

const SCRIPTS = ['core/utils.js', 'core/i18n.js', 'core/focus-nav.js', 'app/online-browse.js', 'app/online-view.js', 'app/update-channel.js'];

const MESSAGE = {
    en: 'Rebuild to play online: this build is older than your XML2 Fix.',
    fr: 'Reconstruisez pour jouer en ligne : cette construction est plus ancienne que votre XML2 Fix.',
    es: 'Reconstruye para jugar en linea: esta compilacion es mas antigua que tu XML2 Fix.'
};
const BUTTON = { en: 'Rebuild', fr: 'Reconstruire', es: 'Reconstruir' };
// A Legends Classic 0.2.x build's stamp. Its [Online] has a GameVersion and a Broker all the same (the fixture's
// default ini: GameVersion LC33, a Broker), as 0.2.4 (LC31) and 0.2.5 (LC32) builds do.
const OLD_STAMP = '>=1.7.1';

async function openOnline(options) {
    const rebuilds = [];
    const t = await open(Object.assign({
        scripts: SCRIPTS,
        beforeRender: window => {
            window.Xml1View = { rebuild: async () => { rebuilds.push('rebuild'); } };
        }
    }, options));
    return Object.assign(t, { rebuilds, panelBlocked: () => t.document.getElementById('xml1-online-panel').dataset.blocked });
}

test('online: a build older than the XML2 Fix asks for a rebuild, with Rebuild (en / fr / es)', async () => {
    for (const language of ['en', 'fr', 'es']) {
        const t = await openOnline({ stampRequires: OLD_STAMP, language });
        assert.equal(t.blockedText(), MESSAGE[language], `${language}: the message`);
        assert.equal(t.panelBlocked(), 'rebuild');
        assert.equal(t.visible('.ul-online-rebuild'), true, `${language}: the button`);
        assert.equal(t.$('.ul-online-rebuild').textContent, BUTTON[language]);
        assert.equal(t.visible('.ul-online-open-channel'), false);
        assert.equal(t.visible('.ul-online-testmode-off'), false);
        t.controls().forEach(control => assert.equal(control.disabled, true, `${language}: Host, Join and the field are off`));
    }
});

test('online: the stamp decides whenever it has a requirement: >=1.7.1 with a GameVersion asks for a Rebuild', async () => {
    for (const GameVersion of ['LC31', 'LC32', 'LC33']) {
        const t = await openOnline({ stampRequires: '>=1.7.1', online: { GameVersion } });
        assert.equal(t.backend.online.GameVersion, GameVersion);
        assert.equal(t.panelBlocked(), 'rebuild', `${GameVersion}: Rebuild`);
        assert.equal(t.blockedText(), MESSAGE.en);
        assert.equal(t.visible('.ul-online-rebuild'), true);
        t.controls().forEach(control => assert.equal(control.disabled, true));
    }
    // A 0.3.0 builder's stamp, stable or beta: plays.
    for (const stampRequires of ['>=1.8', '>=1.8.0-0']) {
        const t = await openOnline({ stampRequires });
        assert.equal(t.blockedText(), null, `${stampRequires}: plays`);
    }
});

test('online: a stamp without a requirement falls back to the ini, which needs both GameVersion and Broker', async () => {
    let t = await openOnline({ stampRequires: '' });
    assert.equal(t.blockedText(), null, 'GameVersion and Broker: plays');
    t = await openOnline({ stampRequires: '', online: { Broker: '' } });
    assert.equal(t.panelBlocked(), 'rebuild', 'no Broker: Rebuild');
    t = await openOnline({ stampRequires: '', online: { GameVersion: '' } });
    assert.equal(t.panelBlocked(), 'rebuild', 'no GameVersion: Rebuild');
});

test('online: Rebuild runs the X-Men Legends page\'s rebuild, from a click or a pad (Enter / A)', async () => {
    const t = await openOnline({ stampRequires: OLD_STAMP });
    t.$('.ul-online-rebuild').click();
    await t.clock.advance(0);
    assert.deepEqual(t.rebuilds, ['rebuild']);
    t.$('.ul-online-rebuild').focus();
    t.window.FocusNav.press('Enter', 'pad');
    await t.clock.advance(0);
    assert.deepEqual(t.rebuilds, ['rebuild', 'rebuild']);
});

test('online: the XML2 Fix\'s own messages come first; a build made for online play plays', async () => {
    // On Stable with 1.7.1: Beta first (a rebuild alone would not bring rooms).
    let t = await openOnline({ stampRequires: OLD_STAMP, updateChannel: 'stable', fixVersion: '1.7.1' });
    assert.equal(t.panelBlocked(), 'needsBeta');
    assert.equal(t.visible('.ul-online-rebuild'), false);
    // On Beta with 1.7.1: Verify Files first.
    t = await openOnline({ stampRequires: OLD_STAMP, updateChannel: 'beta', fixVersion: '1.7.1' });
    assert.equal(t.panelBlocked(), 'fixOld');
    assert.equal(t.visible('.ul-online-rebuild'), false);
    // Not built yet: Build, not Rebuild.
    t = await openOnline({ stampRequires: OLD_STAMP, playable: false });
    assert.equal(t.panelBlocked(), 'notBuilt');
    // A 1.8.0 beta fix in a build made for online play.
    t = await openOnline({ fixVersion: '1.8.0-beta.1' });
    assert.equal(t.blockedText(), null);
    assert.equal(t.visible('.ul-online-rebuild'), false);
    t.controls().forEach(control => assert.equal(control.disabled, false));
});

test('online: the note goes once the build is made for online play', async () => {
    const t = await openOnline({ stampRequires: OLD_STAMP });
    assert.equal(t.panelBlocked(), 'rebuild');
    t.backend.stampRequires = '>=1.8.0-0'; // the rebuild with a 0.3.0 builder finished
    t.window.dispatchEvent(new t.window.CustomEvent('gameInstallationUpdated', { detail: { game: null } }));
    await t.clock.advance(100);
    assert.equal(t.blockedText(), null);
    assert.equal(t.visible('.ul-online-rebuild'), false);
});

test('online: a start refused with build_too_old says so, with Rebuild, and arms nothing', async () => {
    const t = await openOnline({ online: { JoinCode: 'ZZZZ9999' } });
    t.backend.stampRequires = OLD_STAMP; // between the last poll and the click
    await host(t, { running: false });
    assert.match(t.phase(), /This build is older than your XML2 Fix: rebuild it/);
    assert.deepEqual(t.backend.armed(), [], 'no key armed (the stale JoinCode removed too)');
    const button = t.$('.ul-online-session .ul-online-rebuild');
    assert.ok(button, 'with Rebuild');
    button.click();
    await t.clock.advance(0);
    assert.deepEqual(t.rebuilds, ['rebuild']);
});

test('online: normal Play is unaffected by an old build', async () => {
    const t = await openOnline({ stampRequires: OLD_STAMP, online: { JoinCode: 'ZZZZ9999' } });
    const answer = t.window.GameUtils.launchGame('xml1', 'xml1');
    await t.clock.advance(1500);
    assert.equal((await answer).accepted, true, 'Play starts');
    assert.deepEqual(t.backend.armed(), [], 'no room key');
});
