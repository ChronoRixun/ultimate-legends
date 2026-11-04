'use strict';
const assert = require('node:assert/strict');
const { page, test, settle } = require('./harness');
const pending = "The last MUA Classic Fix update didn't finish. Choose Update to finish it.";
const locked = 'A MUA Classic Fix file is in use. Close the game or any program using it and try Update again.';

for (const language of ['en', 'fr', 'es', 'ru']) {
    test(`MUAC messages: ${language} pending Play and options use the actionable i18n fallback`, async () => {
        let recoveryPending = true;
        const calls = [];
        const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/muac-view.js'],
            body: '<div id="muac-options-panel"></div>',
            backend: { handle(command) {
                calls.push(command);
                if (command === 'get-game-property') return 'C:\\Fixture\\MUA';
                if (command === 'get-property') return 'true';
                if (command === 'get-muac-settings') return { installed: true, runtimeReady: false,
                    recoveryPending, missing: ['version.dll'], values: {} };
                if (command === 'launch-game') return { accepted: false, reason: 'muac_update_pending', error: pending };
                return null;
            } } });
        p.window.LauncherI18n.setLanguage(language);
        p.window.ProgressManager = { show() {}, update() {}, hide() {} };
        p.document.getElementById('muac-options-panel').getClientRects = () => [{}];
        p.window.MuacView.render(); await settle();
        const empty = p.document.querySelector('.ul-display-empty');
        assert.equal(empty.textContent, pending);
        assert.equal(p.document.querySelector('#muac-options-panel select'), null);
        const answer = await p.window.GameUtils.launchGame('muac', 'muac');
        assert.equal(answer.accepted, false);
        assert.equal(p.messages.length, 1);
        assert.equal(p.messages[0][1], pending);
        assert.equal(calls.filter(c => c === 'launch-game').length, 1);
        recoveryPending = false;
        await p.clock.advance(3100); await settle();
        assert.match(p.document.querySelector('.ul-display-empty').textContent, /version.dll/);
    });

    test(`MUAC messages: ${language} locked rollback is plain text and retains recovery advice`, async () => {
        let error = locked;
        let active = true;
        const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/muac-setup.js'],
            backend: { handle(command) {
                if (command === 'get-muac-setup') return { active, updating: true, error: active ? '' : error };
                if (command === 'start-muac-update') return { success: false, error };
                return null;
            } } });
        p.window.LauncherI18n.setLanguage(language);
        await p.window.MuacSetup.showUpdate(); await settle();
        active = false;
        await p.clock.advance(800); await settle();
        assert.equal(p.document.querySelector('.muac-setup-error').textContent, locked);
        assert.equal(p.document.querySelector('[data-act="done"]'), null);
        error += ' Recovery is pending; retry Update before playing. rename: private fixture path';
        await p.clock.advance(800); await settle();
        const text = p.document.querySelector('.muac-setup-error').textContent;
        assert.match(text, /Your files still need recovery. Choose Update to finish it./);
        assert.doesNotMatch(text, /rename:|private fixture path/);
    });
}
