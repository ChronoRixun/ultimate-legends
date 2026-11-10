'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { page, test, settle } = require('./harness');

function open(ready = false) {
    const calls = [];
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'popups/setup-flow-popup.js',
        'popups/install-popup.js', 'app/main.js'], backend: { handle(command, data) {
            calls.push({ command, data });
            if (command === 'browse-folder') return 'C:\\Fixture\\MUA 2006';
            if (command === 'set-game-path') return true;
            if (command === 'get-muac-settings') return { runtimeReady: ready };
            if (command === 'get-game-install-info') return { path: 'C:\\Fixture\\MUA 2006', valid: true,
                hasPatch: true, missingRuntime: ready ? [] : ['version.dll', 'D3D9.dll'] };
            return null;
        } } });
    p.window.MuacSetup = { showUpdate: repair => calls.push({ command: 'runtime-popup', repair }) };
    p.window.GameInstallationManager = { getGameDisplayName: () => 'MUA 2006' };
    p.window.GameUtils.trackCommandProgress = options => {
        calls.push({ command: 'generic-patch', options }); return Promise.resolve();
    };
    return { ...p, calls };
}

test('MUAC existing: a prepared folder finishes without the generic patch popup', async () => {
    const p = open(true);
    const popup = vm.runInContext('new SetupFlowPopup()', p.window);
    popup.show('muac', 'MUA 2006');
    await popup.handleExistingInstallation(); await settle();
    assert.ok(p.calls.some(c => c.command === 'set-game-path'));
    assert.ok(!p.document.querySelector('.setup-flow-backdrop'));
    assert.ok(!p.document.querySelector('.install-popup'));
    assert.ok(!p.calls.some(c => c.command === 'runtime-popup' || c.command === 'generic-patch'));
});

test('MUAC existing: Finish Setup explains missing components and uses runtime repair', async () => {
    const p = open();
    await p.window.showManageInstall('muac', { finishSetup: true }); await settle();
    assert.match(p.document.querySelector('#install-popup-missing').textContent, /version\.dll.*D3D9\.dll/);
    assert.equal(p.document.querySelector('#install-popup-missing').hidden, false);
    p.document.querySelector('.btn-apply').click(); await settle();
    assert.ok(p.calls.some(c => c.command === 'runtime-popup' && c.repair === true));
    assert.ok(!p.calls.some(c => c.command === 'generic-patch'));
});

test('MUAC Verify Files uses its runtime installer; XML2 still uses its patch manifest', async () => {
    const p = open();
    await p.window.verifyGame('muac'); await settle();
    assert.ok(p.calls.some(c => c.command === 'runtime-popup' && c.repair === true));
    assert.ok(!p.calls.some(c => c.command === 'generic-patch'));
    await p.window.verifyGame('xml2'); await settle();
    assert.ok(p.calls.some(c => c.command === 'generic-patch' && c.options.commandArgs.game === 'xml2'));
});
