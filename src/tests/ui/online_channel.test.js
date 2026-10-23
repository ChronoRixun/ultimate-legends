'use strict';
// The Online section and the update channel (launcher 0.4.0 ships stable while XML2 Fix 1.8.0 and Legends
// Classic 0.3.0 come out as betas first). On Stable an XML2 Fix older than 1.8.0 can't be updated to one
// with rooms yet, so the section says online play arrives with Legends Classic 0.3.0 and offers Open Update
// channel (Settings, Beta) instead of Verify Files; on Beta the Verify Files flow stays. A 1.8.0 beta fix
// counts. An unreadable or missing fix, and normal Play, are as before. The real online-view.js and
// update-channel.js run on online_fixture.js's fake backend.

const assert = require('node:assert/strict');
const { test } = require('./harness');

const { open } = require('./online_fixture');

const SCRIPTS = ['core/utils.js', 'core/i18n.js', 'core/focus-nav.js', 'app/online-browse.js', 'app/online-view.js', 'app/update-channel.js'];

const NEEDS_BETA = {
    en: 'Online play arrives with Legends Classic 0.3.0. Want to try it now? Switch Update channel to Beta in Settings.',
    fr: "Le jeu en ligne arrive avec Legends Classic 0.3.0. Envie de l'essayer maintenant ? Passez le canal de mise a jour sur Beta dans les Parametres.",
    es: 'El juego en linea llega con Legends Classic 0.3.0. ¿Quieres probarlo ya? Cambia el canal de actualizacion a Beta en Ajustes.'
};
const BUTTON = { en: 'Open Update channel', fr: 'Ouvrir le canal de mise a jour', es: 'Abrir el canal de actualizacion' };

async function openOnline(options) {
    const t = await open(Object.assign({ scripts: SCRIPTS }, options));
    // The sidebar's Settings item, as main.js wires it: shows the settings page.
    const settings = t.document.getElementById('settings');
    settings.addEventListener('click', () => {
        t.document.querySelectorAll('.page-section').forEach(section => { section.style.display = 'none'; });
        t.document.getElementById('settings-page').style.display = 'flex';
        settings.classList.add('active');
    });
    const button = () => t.$('.ul-online-open-channel');
    return Object.assign(t, { button });
}

async function play(t) {
    const started = t.window.GameUtils.launchGame('xml1', 'xml1');
    await t.clock.advance(1500);
    return started;
}

test('online on Stable: an XML2 Fix older than 1.8.0 points to the Beta channel, not to Verify Files (en / fr / es)', async () => {
    for (const language of ['en', 'fr', 'es']) {
        const t = await openOnline({ updateChannel: 'stable', fixVersion: '1.7.1', language });
        assert.equal(t.blockedText(), NEEDS_BETA[language], `${language}: the message`);
        assert.doesNotMatch(t.blockedText(), /Verify|Verifier|Verificar/, `${language}: no Verify Files`);
        assert.equal(t.document.getElementById('xml1-online-panel').dataset.blocked, 'needsBeta');
        assert.equal(t.visible('.ul-online-open-channel'), true, `${language}: the button`);
        assert.equal(t.button().textContent, BUTTON[language]);
        assert.equal(t.visible('.ul-online-testmode-off'), false);
        t.controls().forEach(control => assert.equal(control.disabled, true, `${language}: Host, Join and the field are off`));
    }
});

test('online on Stable: Open Update channel shows Settings with the focus on the setting', async () => {
    const t = await openOnline({ updateChannel: 'stable', fixVersion: '1.7.1' });
    t.button().click();
    await t.clock.advance(10);
    assert.equal(t.document.getElementById('settings-page').style.display, 'flex', 'Settings shows');
    assert.equal(t.document.activeElement, t.document.getElementById('update-channel-select'), 'the focus is on Update channel');
});

test('online on Stable: the button works from the keyboard or a pad (Enter / A)', async () => {
    const t = await openOnline({ updateChannel: 'stable', fixVersion: '1.7.1' });
    t.button().focus();
    t.window.FocusNav.press('Enter', 'pad');
    await t.clock.advance(10);
    assert.equal(t.document.getElementById('settings-page').style.display, 'flex');
    assert.equal(t.document.activeElement, t.document.getElementById('update-channel-select'));
});

test('online on Stable: normal Play is unaffected, and nothing is armed', async () => {
    const t = await openOnline({ updateChannel: 'stable', fixVersion: '1.7.1', online: { JoinCode: 'ZZZZ9999' } });
    const answer = await play(t);
    assert.equal(answer.accepted, true, 'Play starts');
    assert.deepEqual(t.backend.armed(), [], 'no room key');
    assert.deepEqual(t.backend.starts, [], 'no online start');
});

test('online on Beta: an old XML2 Fix keeps the Verify Files message, without the channel button', async () => {
    const t = await openOnline({ updateChannel: 'beta', fixVersion: '1.7.1' });
    assert.match(t.blockedText(), /needs XML2 Fix 1\.8\.0 or later; this folder has 1\.7\.1\. Use Verify Files/);
    assert.equal(t.document.getElementById('xml1-online-panel').dataset.blocked, 'fixOld');
    assert.equal(t.visible('.ul-online-open-channel'), false);
});

test('online: a 1.8.0 beta fix plays online on either channel; an unreadable or missing fix keeps its Verify message', async () => {
    for (const updateChannel of ['stable', 'beta']) {
        const t = await openOnline({ updateChannel, fixVersion: '1.8.0-beta.1' });
        assert.equal(t.blockedText(), null, `${updateChannel}: 1.8.0-beta.1 has the rooms`);
        t.controls().forEach(control => assert.equal(control.disabled, false));
    }
    const unknown = await openOnline({ updateChannel: 'stable', fixVersion: null });
    assert.match(unknown.blockedText(), /can’t be read.*Use Verify Files/);
    assert.equal(unknown.visible('.ul-online-open-channel'), false);
    const missing = await openOnline({ updateChannel: 'stable', fixInstalled: false });
    assert.match(missing.blockedText(), /Install the XML2 Fix first/);
});

test('online: switching the channel to Beta turns the message into Verify Files', async () => {
    const t = await openOnline({ updateChannel: 'stable', fixVersion: '1.7.1' });
    assert.equal(t.document.getElementById('xml1-online-panel').dataset.blocked, 'needsBeta');
    t.backend.updateChannel = 'beta';
    // (update-channel.js sends this after a switch; the section loads again.)
    t.window.dispatchEvent(new t.window.CustomEvent('gameInstallationUpdated', { detail: { game: null } }));
    await t.clock.advance(100);
    assert.equal(t.document.getElementById('xml1-online-panel').dataset.blocked, 'fixOld');
    assert.equal(t.visible('.ul-online-open-channel'), false);
});
