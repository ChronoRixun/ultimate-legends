'use strict';
// The Display section's Fullscreen (review of the 0.3.1 fixes, S1): Width=0 / Height=0 follow the
// Mode that is saved, never a Fullscreen picked and left again within the 250 ms the page waits
// before it saves. The real display-view.js runs against a fake backend that applies the C++
// rule (xml2_display::implied_changes: a saved Mode=fullscreen writes Width=0 / Height=0).

const assert = require('node:assert/strict');
const { page, test, Event } = require('./harness');

class Backend {
    constructor(values) {
        this.values = Object.assign({ Mode: null, Width: null, Height: null, Topmost: null, RunInBackground: null, FrameRate: null, VSync: null }, values);
        this.saves = [];
    }

    handle(command, data) {
        if (command === 'get-display-settings') {
            return {
                supported: true, installed: true, fixInstalled: true, running: false, ini: 'D:\\Games\\XML2\\xml2-fix.ini',
                values: Object.assign({}, this.values),
                modes: [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }],
                desktop: { width: 2560, height: 1440, refresh: 180 }
            };
        }
        if (command === 'set-display-settings') {
            const sent = Object.assign({}, data.values);
            this.saves.push(sent);
            Object.assign(this.values, sent);
            if (sent.Mode === 'fullscreen') Object.assign(this.values, { Width: 0, Height: 0 });
            return { success: true, values: Object.assign({}, this.values) };
        }
        return null;
    }
}

async function open(values) {
    const backend = new Backend(values);
    const p = page({ scripts: ['core/utils.js', 'core/i18n.js', 'app/display-view.js'], body: '<div id="xml2-display-panel"></div>', backend });
    p.window.DisplayView.render('xml2');
    await p.clock.advance(0);
    const select = key => p.document.querySelector(`#xml2-display-panel select[data-key="${key}"]`);
    const choose = (key, value) => {
        select(key).value = value;
        select(key).dispatchEvent(new Event('change', { bubbles: true }));
    };
    return { ...p, backend, select, choose };
}

test('S1: Fullscreen left again before the save keeps the windowed size', async () => {
    const { clock, backend, select, choose } = await open({ Mode: 'windowed', Width: 1280, Height: 720 });
    assert.equal(select('Resolution').value, '1280x720');

    choose('Mode', 'fullscreen');
    assert.equal(select('Resolution').value, '', 'Fullscreen picked: the row shows Game setting');
    assert.equal(select('Resolution').disabled, true);
    await clock.advance(100);
    choose('Mode', 'windowed');
    assert.equal(select('Resolution').value, '1280x720', 'Windowed again: the size is back');
    await clock.advance(400);

    assert.deepEqual(backend.saves, [{ Mode: 'windowed' }], 'one save, Mode only: no Width/Height zeros');
    assert.equal(backend.values.Width, 1280);
    assert.equal(backend.values.Height, 720);
    assert.equal(select('Resolution').value, '1280x720');
    assert.equal(select('Resolution').disabled, false);
});

test('S1: Fullscreen left for Borderless or Game default keeps the size too', async () => {
    for (const next of ['borderless', '']) {
        const { clock, backend, choose } = await open({ Mode: 'windowed', Width: 1280, Height: 720 });
        choose('Mode', 'fullscreen');
        await clock.advance(50);
        choose('Mode', next);
        await clock.advance(400);
        assert.deepEqual(backend.saves, [{ Mode: next || null }], `Fullscreen -> ${next || 'Game default'}`);
        assert.equal(backend.values.Width, 1280);
    }
});

test('Fullscreen saved: Width=0 / Height=0 from the save, shown as Game setting', async () => {
    const { clock, backend, select, choose } = await open({ Mode: 'windowed', Width: 1280, Height: 720 });
    choose('Mode', 'fullscreen');
    await clock.advance(400);
    assert.deepEqual(backend.saves, [{ Mode: 'fullscreen' }], 'the page sends the Mode; the backend writes the zeros with it');
    assert.equal(backend.values.Width, 0);
    assert.equal(select('Resolution').value, '', 'Game setting, from the saved values');
    assert.equal(select('Resolution').disabled, true);

    choose('Mode', 'windowed');
    await clock.advance(400);
    assert.equal(select('Resolution').value, '', 'Windowed afterwards: the cleared size stays cleared (the game\'s setting)');
});

test('a size picked in Windowed, then Fullscreen within the same save: the saved Mode decides', async () => {
    const { clock, backend, select, choose } = await open({ Mode: 'windowed', Width: 1280, Height: 720 });
    choose('Resolution', '1920x1080');
    await clock.advance(100);
    choose('Mode', 'fullscreen');
    await clock.advance(400);
    assert.deepEqual(backend.saves, [{ Width: 1920, Height: 1080, Mode: 'fullscreen' }]);
    assert.equal(backend.values.Width, 0, 'the backend clears it with the saved Fullscreen');
    assert.equal(select('Resolution').value, '');
});
