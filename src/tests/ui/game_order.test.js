'use strict';
const assert = require('node:assert/strict');
const { page, test, settle, Event, MouseEvent } = require('./harness');
const DEFAULT = ['mua', 'mua2', 'xml2', 'muac', 'xml1'];

function setup(raw = null, { focus = false } = {}) {
    const calls = [];
    const saved = { value: raw, fail: false, ignoreWrite: false };
    const scripts = ['core/utils.js', 'core/i18n.js', 'core/game-order.js', 'app/views.js'];
    if (focus) scripts.push('core/focus-nav.js');
    const p = page({ scripts, backend: { handle(command, data) {
        calls.push({ command, data });
        if (command === 'get-property' && data === 'launcher-game-order') return saved.value;
        if (command === 'set-property' && Object.hasOwn(data, 'launcher-game-order')) {
            if (saved.fail) throw new Error('test write failure');
            if (!saved.ignoreWrite) saved.value = data['launcher-game-order'];
        }
        return null;
    } } });
    p.window.innerWidth = 1280;
    p.window.innerHeight = 800;
    const query = p.document.querySelectorAll.bind(p.document);
    p.document.querySelectorAll = selector => selector === '#library-grid .library-card:not(.library-card-empty)'
        ? query('#library-grid .library-card').filter(card => !card.classList.contains('library-card-empty')) : query(selector);
    return { ...p, order: p.window.GameOrder, calls, saved,
        ids: selector => p.document.querySelectorAll(selector).map(item => item.dataset.game),
        writes: () => calls.filter(call => call.command === 'set-property') };
}
const asArray = value => Array.from(value);

test('game order: normalisation drops unknown ids, duplicates and non-string entries', () => {
    const p = setup();
    const input = ['xml1', 'xml1', 'unknown', null, 9, '__proto__', 'mua', 'mua2', 'xml2', 'muac'];
    assert.deepEqual(asArray(p.order.normalise(input)), ['xml1', 'mua', 'mua2', 'xml2', 'muac']);
    assert.equal(input.length, 10, 'does not mutate settings input');
    for (const value of [null, {}, 1, 'xml1', true, []]) assert.deepEqual(asArray(p.order.normalise(value)), DEFAULT);
});

test('game order: merge adds missing and newly introduced games at default positions', () => {
    const p = setup();
    assert.deepEqual(asArray(p.order.normalise(['xml1', 'mua', 'xml2', 'muac'])), ['xml1', 'mua2', 'mua', 'xml2', 'muac']);
    const existing = ['xml1', 'xml2', 'mua2', 'mua'];
    assert.deepEqual(asArray(p.order.normalise(existing)), ['xml1', 'xml2', 'mua2', 'muac', 'mua']);
    p.window.GameUtils.GAME_ORDER.splice(2, 0, 'future');
    const merged = p.order.normalise(['xml1', 'muac', 'xml2', 'mua2', 'mua']);
    assert.deepEqual(asArray(merged), ['xml1', 'muac', 'future', 'xml2', 'mua2', 'mua']);
    assert.deepEqual(asArray(p.order.normalise(merged)), asArray(merged));
});

test('game order: invalid JSON and malformed stored values recover to defaults', async () => {
    for (const value of ['broken', '{}', 'null', '17', null]) {
        const p = setup(value);
        await p.order.load();
        assert.deepEqual(asArray(p.order.get()), DEFAULT);
    }
    const p = setup(JSON.stringify(['xml1', 'mua', 'xml2', 'muac', 'mua2', 'unknown', 'xml1']));
    await p.order.load();
    assert.deepEqual(asArray(p.order.get()), ['xml1', 'mua', 'xml2', 'muac', 'mua2']);
    const copy = p.order.get(); copy.reverse();
    assert.equal(p.order.get()[0], 'xml1', 'returned snapshots cannot mutate the saved order');
});

test('game order: move persists, serialises rapid actions, and refuses ends and unknown ids', async () => {
    const p = setup();
    await p.order.load();
    assert.equal(await p.order.move('mua', -1), false);
    assert.equal(await p.order.move('xml1', 1), false);
    assert.equal(await p.order.move('unknown', 1), false);
    assert.equal(await p.order.move('mua', 2), false);
    assert.equal(p.writes().length, 0);
    await Promise.all([p.order.move('xml1', -1), p.order.move('xml1', -1)]);
    assert.deepEqual(asArray(p.order.get()), ['mua', 'mua2', 'xml1', 'xml2', 'muac']);
    assert.deepEqual(JSON.parse(p.saved.value), asArray(p.order.get()));
    assert.equal(p.writes().length, 2);
    const reloaded = setup(p.saved.value);
    await reloaded.order.load();
    assert.deepEqual(asArray(reloaded.order.get()), asArray(p.order.get()));
});

test('game order: failed or silently ignored writes keep the displayed order and recover', async () => {
    const p = setup();
    await p.order.load();
    for (const fail of ['fail', 'ignoreWrite']) {
        p.saved[fail] = true;
        assert.equal(await p.order.move('mua', 1), false);
        assert.deepEqual(asArray(p.order.get()), DEFAULT);
        p.saved[fail] = false;
    }
    assert.equal(p.toasts.length, 2);
    assert.equal(await p.order.move('mua', 1), true);
});

test('game order: place handles forward/backward insertion without losing games', async () => {
    const p = setup();
    await p.order.load();
    await p.order.place('mua', 'xml2', true);
    assert.deepEqual(asArray(p.order.get()), ['mua2', 'xml2', 'mua', 'muac', 'xml1']);
    await p.order.place('xml1', 'mua2', false);
    assert.deepEqual(asArray(p.order.get()), ['xml1', 'mua2', 'xml2', 'mua', 'muac']);
    assert.equal(await p.order.place('xml1', 'xml1', false), false);
    assert.equal(await p.order.place('../unknown', 'mua', false), false);
    assert.equal(await p.order.place('mua', 'unknown', false), false);
    assert.equal(new Set(p.order.get()).size, DEFAULT.length);
});

test('game order: Settings reset is reachable and writes clean defaults even from malformed settings', async () => {
    const p = setup(JSON.stringify(DEFAULT.toReversed()));
    await p.order.load();
    p.document.dispatchEvent(new Event('DOMContentLoaded'));
    const reset = p.document.getElementById('reset-game-order-btn');
    assert.equal(reset.textContent, 'Reset game order');
    await reset.onclick();
    assert.deepEqual(asArray(p.order.get()), DEFAULT);
    assert.deepEqual(JSON.parse(p.saved.value), DEFAULT);
    p.saved.value = 'bad data';
    await p.order.load();
    await p.order.reset();
    assert.deepEqual(JSON.parse(p.saved.value), DEFAULT);
});

test('game order: both menu actions follow saved positions and hide at list ends', async () => {
    const p = setup();
    await p.order.load();
    assert.deepEqual(asArray(p.order.menuItems('mua').map(item => item.label)), ['Move later']);
    assert.deepEqual(asArray(p.order.menuItems('xml1').map(item => item.label)), ['Move earlier']);
    assert.deepEqual(asArray(p.order.menuItems('xml2').map(item => item.label)), ['Move earlier', 'Move later']);
    p.window.AppViews.renderLibrary();
    const card = p.document.querySelector('.library-card[data-game="mua"]');
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const menu = p.document.querySelector('.library-card-menu');
    assert.match(menu.textContent, /Move later/);
    assert.doesNotMatch(menu.textContent, /Move earlier/);
    const move = menu.querySelectorAll('button').find(button => button.textContent === 'Move later');
    move.click();
    await settle();
    assert.equal(p.order.get()[1], 'mua');
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    assert.match(menu.textContent, /Move earlier/);
});

test('game order: Library/sidebar share persisted order despite recency, filters and installation state', async () => {
    const chosen = ['xml1', 'mua', 'muac', 'xml2', 'mua2'];
    const p = setup(JSON.stringify(chosen));
    await p.order.load();
    p.window.AppViews.renderSidebarGames();
    p.window.AppViews.renderLibrary();
    p.window.__recentGamesSnapshot = ['mua2', 'xml2', 'mua', 'xml1'];
    await p.window.AppViews.refreshInstallationStates(async game => ({ status: ['mua', 'xml2', 'mua2'].includes(game) ? 'installed' : 'not-setup' }));
    const library = '#library-grid .library-card[data-game]';
    const sidebar = '.sidebar .game-item[data-game]';
    assert.deepEqual(p.ids(library), chosen);
    assert.deepEqual(p.ids(sidebar), chosen);
    const shown = selector => p.document.querySelectorAll(selector).filter(item => item.style.display !== 'none').map(item => item.dataset.game);
    assert.deepEqual(shown(sidebar), ['mua', 'xml2', 'mua2']);
    const filters = p.document.getElementById('library-filters');
    for (const [filter, expected] of [['installed', ['mua', 'xml2', 'mua2']], ['not-installed', ['xml1', 'muac']], ['all', chosen]]) {
        filters.querySelector(`[data-filter="${filter}"]`).click();
        assert.deepEqual(shown(library), expected);
    }
    const card = p.document.querySelector('.library-card[data-game="mua"]');
    card.focus();
    await p.order.move('mua', -1);
    assert.equal(p.document.querySelector('.library-card[data-game="mua"]'), card);
    assert.equal(p.document.activeElement, card);
    assert.equal(card.dataset.status, 'installed');
    assert.deepEqual(p.ids(library), ['mua', 'xml1', 'muac', 'xml2', 'mua2']);
    assert.deepEqual(p.ids(sidebar), p.ids(library));
});

function dragEvent(type, init = {}) {
    const event = new MouseEvent(type, { bubbles: true, ...init });
    const data = new Map();
    event.dataTransfer = { setData: (key, value) => data.set(key, value), getData: key => data.get(key) || '' };
    event.stopImmediatePropagation = () => event.stopPropagation();
    return event;
}

test('game order: native drag shows insertion bars, moves in both surfaces, and clears on cancel', async () => {
    for (const vertical of [false, true]) {
        const p = setup();
        await p.order.load();
        const parent = p.document.createElement('div');
        p.document.body.appendChild(parent);
        const items = ['mua', 'xml1'].map(game => {
            const item = p.document.createElement('article');
            item.dataset.game = game;
            item.className = vertical ? 'game-item' : 'library-card';
            item.getBoundingClientRect = () => ({ left: 100, top: 100, width: 100, height: 100 });
            parent.appendChild(item);
            p.order.bindDrag(item, vertical);
            return item;
        });
        const [source, target] = items;
        source.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        assert.equal(source.classList.contains('is-order-dragging'), false, 'plain press does not start dragging');
        source.dispatchEvent(dragEvent('dragstart'));
        assert.equal(source.getAttribute('draggable'), 'true');
        assert.equal(source.classList.contains('is-order-dragging'), true);
        target.dispatchEvent(dragEvent('dragover', { clientX: 110, clientY: 110 }));
        assert.equal(target.classList.contains('order-drop-before'), true);
        target.dispatchEvent(dragEvent('dragover', { clientX: 190, clientY: 190 }));
        assert.equal(target.classList.contains('order-drop-after'), true);
        target.dispatchEvent(dragEvent('drop', { clientX: 190, clientY: 190 }));
        source.dispatchEvent(dragEvent('dragend'));
        await settle();
        assert.deepEqual(asArray(p.order.get()), ['mua2', 'xml2', 'muac', 'xml1', 'mua']);
        assert.equal(target.classList.contains('order-drop-after'), false);
        source.dispatchEvent(dragEvent('dragstart'));
        target.dispatchEvent(dragEvent('dragover', { clientX: 110, clientY: 110 }));
        source.dispatchEvent(dragEvent('dragend'));
        assert.equal(target.classList.contains('order-drop-before'), false);
        assert.equal(source.classList.contains('is-order-dragging'), false);
    }
});

test('game order: ordinary click survives, interactive controls cannot drag, and external drops are ignored', async () => {
    const p = setup();
    await p.order.load();
    const card = p.document.createElement('article');
    card.dataset.game = 'mua';
    const button = p.document.createElement('button');
    card.appendChild(button); p.document.body.appendChild(card);
    p.order.bindDrag(card, false);
    let clicks = 0;
    card.addEventListener('click', () => clicks++);
    card.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    card.dispatchEvent(dragEvent('click'));
    assert.equal(clicks, 1);
    assert.equal(p.writes().length, 0);
    button.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    const refused = dragEvent('dragstart');
    button.dispatchEvent(refused);
    assert.equal(refused.defaultPrevented, true);
    assert.equal(card.classList.contains('is-order-dragging'), false);
    card.dispatchEvent(dragEvent('drop'));
    await settle();
    assert.equal(p.writes().length, 0);
    card.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    card.dispatchEvent(dragEvent('dragstart'));
    card.dispatchEvent(dragEvent('click'));
    assert.equal(clicks, 1, 'post-drag click does not navigate');
    card.dispatchEvent(dragEvent('dragend'));
    await p.clock.advance(1);
    card.dispatchEvent(dragEvent('click'));
    assert.equal(clicks, 2, 'the next ordinary click works');
});

test('game order: keyboard and pad reach Move later and keep focus on the moved card', async () => {
    const p = setup(null, { focus: true });
    await p.order.load();
    p.document.getElementById('home-page').style.display = 'none';
    p.document.getElementById('library-page').style.display = 'block';
    p.window.AppViews.renderLibrary();
    const card = p.document.querySelector('.library-card[data-game="mua"]');
    card.focus();
    const nav = p.window.FocusNav;
    nav.press('ContextMenu', 'key'); nav.sync();
    for (let i = 0; i < 20 && p.document.activeElement.textContent !== 'Move later'; i++) nav.press('Tab', 'key');
    assert.equal(p.document.activeElement.textContent, 'Move later');
    nav.press('Enter', 'pad'); nav.sync();
    await settle(); nav.sync();
    assert.equal(p.order.get()[1], 'mua');
    assert.equal(p.document.activeElement, card);
});

test('game order: every language has move, reset, saved and failure strings', () => {
    const p = setup();
    for (const language of ['en', 'fr', 'es', 'ru']) {
        p.window.LauncherI18n.setLanguage(language);
        for (const key of ['earlier', 'later', 'reset', 'saved', 'failed']) {
            assert.notEqual(p.window.LauncherI18n.t(`gameOrder.${key}`), `gameOrder.${key}`);
        }
    }
});
