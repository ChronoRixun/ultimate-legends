'use strict';
// Keyboard and controller navigation (focus-nav.js, gamepad-nav.js; launcher 0.3.3): which control an
// arrow picks, Enter / Space on controls that are divs, the toggles' Left / Right, a <select> picked in
// place, popups keeping the focus and giving it back, Back through the pages, LB / RB, and a pad read
// through the Gamepad API. The harness has no layout, so each test element carries its box in
// data-rect="left,top,width,height" and FocusNav reads that instead (setRectSource).
// tools/dev/focus_nav_cdp.py walks the real launcher with real key presses.

const assert = require('node:assert/strict');
const { page, test } = require('./harness');

const SCRIPTS = ['core/utils.js', 'core/i18n.js', 'core/focus-nav.js', 'core/gamepad-nav.js', 'ui/message-box.js'];

function rectFromData(element) {
    const data = element.getAttribute('data-rect');
    if (!data) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    const [left, top, width, height] = data.split(',').map(Number);
    return { left, top, width, height, right: left + width, bottom: top + height };
}

// A page with `body` after main.html's; with `own` the launcher's window is hidden, so only `body`
// can have the focus.
function open(body = '', { own = true } = {}) {
    const p = page({ scripts: SCRIPTS, body, backend: { handle: () => null } });
    if (own) p.document.querySelector('.window').hidden = true;
    p.window.FocusNav.setRectSource(rectFromData);
    const $ = selector => p.document.querySelector(selector);
    const focused = () => p.document.activeElement;
    const key = (name, init = {}) => {
        const event = new p.window.KeyboardEvent('keydown', Object.assign({ key: name, bubbles: true, cancelable: true }, init));
        (p.document.activeElement || p.document.body).dispatchEvent(event);
        return event;
    };
    return { ...p, $, focused, key, nav: p.window.FocusNav };
}

function rect(left, top, width, height) {
    return { left, top, width, height, right: left + width, bottom: top + height };
}

// The sidebar pages work as main.js's handlers do: a click shows that page and marks its item.
function wireNavigation(t) {
    const show = id => {
        t.document.querySelectorAll('.page-section').forEach(section => { section.style.display = 'none'; });
        t.$(`#${id}-page`).style.display = 'block';
        t.document.querySelectorAll('.nav-item, .game-item').forEach(item => item.classList.remove('active'));
    };
    t.document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            show(item.id);
            item.classList.add('active');
        });
    });
    t.document.querySelectorAll('.game-item').forEach(item => {
        item.addEventListener('click', () => {
            show(item.dataset.game);
            item.classList.add('active');
        });
    });
}

// ---- direction picking ----

test('focus nav: an arrow picks the nearest control that way, in line before off to the side', () => {
    const { nav } = open();
    const at = (name, r) => ({ element: name, rect: r });
    const middle = rect(200, 0, 100, 40);
    const row = [at('left', rect(50, 0, 100, 40)), at('far-left', rect(-200, 0, 100, 40)), at('right', rect(350, 0, 100, 40))];
    assert.equal(nav.pick(middle, row, 'left'), 'left');
    assert.equal(nav.pick(middle, row, 'right'), 'right');
    assert.equal(nav.pick(middle, row, 'up'), null, 'nothing above');
    assert.equal(nav.pick(middle, row, 'down'), null, 'nor below: the same row is not "down"');

    const below = [at('in-line', rect(200, 120, 100, 40)), at('nearer-aside', rect(500, 50, 100, 40))];
    assert.equal(nav.pick(middle, below, 'down'), 'in-line', '80 px straight down beats 10 px down and 200 px aside');

    const overlap = [at('a-pixel-lower', rect(350, 1, 100, 40))];
    assert.equal(nav.pick(middle, overlap, 'down'), null, 'a neighbour a pixel lower is still beside, not below');
});

test('focus nav: from a card, Down goes to its own button first, then on to the next row', () => {
    const { nav } = open();
    const card = rect(0, 0, 200, 300);
    const button = { element: 'button', rect: rect(20, 250, 160, 30) };
    const nextCard = { element: 'next card', rect: rect(0, 320, 200, 300) };
    const inside = element => element === 'button';
    assert.equal(nav.pick(card, [button, nextCard], 'down', inside), 'button');
    assert.equal(nav.pick(button.rect, [nextCard], 'down'), 'next card');
    assert.equal(nav.pick(nextCard.rect, [{ element: 'card', rect: card }, button], 'up'), 'card', 'Up from below lands on the card');
});

test('focus nav: the arrow keys move the focus through a grid of cards and their buttons', () => {
    const t = open(`
        <div class="grid">
            <article id="c1" class="card" tabindex="0" role="button" data-rect="0,0,200,300"><button id="b1" data-rect="20,250,160,30">Play</button></article>
            <article id="c2" class="card" tabindex="0" role="button" data-rect="220,0,200,300"><button id="b2" data-rect="240,250,160,30">Play</button></article>
            <article id="c3" class="card" tabindex="0" role="button" data-rect="0,320,200,300"></article>
            <article id="c4" class="card" tabindex="0" role="button" data-rect="220,320,200,300" hidden></article>
        </div>`);
    t.$('#c1').focus();
    t.key('ArrowRight');
    assert.equal(t.focused().id, 'c2');
    t.key('ArrowDown');
    assert.equal(t.focused().id, 'b2', "into the card's button");
    t.key('ArrowDown');
    assert.equal(t.focused().id, 'c3', 'a hidden card is skipped: the one below-left is next');
    t.key('ArrowUp');
    assert.equal(t.focused().id, 'c1');
    const left = t.key('ArrowLeft');
    assert.equal(t.focused().id, 'c1', 'nothing to the left: the focus stays');
    assert.equal(left.defaultPrevented, true, 'and the page does not scroll sideways');
    assert.equal(t.document.documentElement.getAttribute('data-nav'), 'keys', 'the focus ring is on');
    t.document.dispatchEvent(new t.window.Event('mousedown'));
    assert.equal(t.document.documentElement.getAttribute('data-nav'), null, 'and off with the mouse');
});

test('focus nav: Up and Down never cross between the sidebar and the page; Left and Right do', () => {
    const t = open(`
        <aside class="sidebar"><div id="nav" tabindex="0" role="button" data-rect="0,0,200,40">Home</div><div id="nav2" tabindex="0" role="button" data-rect="0,600,200,40">Settings</div></aside>
        <main class="content-area"><button id="play" data-rect="300,300,100,40">Play</button><button id="more" data-rect="300,400,100,40">More</button></main>
        <div class="global-progress-bar"><button id="cancel" data-rect="300,700,40,40">x</button></div>`);
    t.$('#play').focus();
    t.key('ArrowUp');
    assert.equal(t.focused().id, 'play', 'nothing above Play in the page: it stays (the sidebar is not "up")');
    t.key('ArrowDown');
    assert.equal(t.focused().id, 'more');
    t.key('ArrowDown');
    assert.equal(t.focused().id, 'cancel', 'the end of the page: on to what is below it outside both');
    t.key('ArrowLeft');
    assert.equal(t.focused().id, 'nav2', 'Left crosses into the sidebar');
    t.key('ArrowUp');
    assert.equal(t.focused().id, 'nav');
});

test('focus nav: with nothing focused, the first arrow focuses the first control of the page', () => {
    const t = open('', { own: false });
    t.$('#home-page').innerHTML = '<button id="first" data-rect="0,0,10,10">A</button><button id="second" data-rect="0,20,10,10">B</button>';
    assert.equal(t.focused(), t.document.body);
    t.key('ArrowDown');
    assert.equal(t.focused().id, 'first');
});

// ---- activating ----

test('focus nav: Enter and Space press a div standing in for a button; a pad\'s Enter presses a button once', async () => {
    const t = open(`
        <div id="card" tabindex="0" role="button">Card</div>
        <button id="native">Native</button>
        <input type="checkbox" id="box">
        <input type="text" id="field">`);
    let card = 0;
    let native = 0;
    t.$('#card').addEventListener('click', () => card++);
    t.$('#native').addEventListener('click', () => native++);
    t.$('#card').focus();
    t.key('Enter');
    const space = t.key(' ');
    assert.equal(card, 2);
    assert.equal(space.defaultPrevented, true, 'Space does not scroll the page');
    t.$('#native').focus();
    await t.clock.advance(1000); // not the keyboard's Enter of a moment ago seen twice
    t.nav.press('Enter', 'pad');
    assert.equal(native, 1, 'a synthetic Enter has no default action, so the click comes from focus-nav');
    let ticked = 0;
    t.$('#box').addEventListener('click', () => ticked++);
    t.$('#box').focus();
    await t.clock.advance(1000);
    t.key('Enter');
    assert.equal(ticked, 1, 'Enter ticks a checkbox (a click; the browser toggles it)');
    t.$('#field').focus();
    assert.equal(t.key('Enter').defaultPrevented, false, 'Enter in a text field is left alone');
});

test('focus nav: the context menu key opens a card\'s menu where the card is', () => {
    const t = open('<div id="card" tabindex="0" role="button">Card</div>');
    const opened = [];
    t.$('#card').addEventListener('contextmenu', event => opened.push(event.type));
    t.$('#card').focus();
    t.key('ContextMenu');
    t.key('F10', { shiftKey: true });
    assert.deepEqual(opened, ['contextmenu', 'contextmenu']);
});

// ---- toggles, selects, text ----

test('focus nav: Left and Right switch a toggle group and stay put at either end', () => {
    const t = open(`
        <div class="toggle-group small" id="group">
            <button class="toggle-btn active" data-value="false" data-rect="0,0,40,20">OFF</button>
            <button class="toggle-btn" data-value="true" data-rect="40,0,40,20">ON</button>
        </div>
        <button id="beside" data-rect="200,0,40,20">Beside</button>`);
    const group = t.$('#group');
    group.addEventListener('click', event => {
        group.querySelectorAll('.toggle-btn').forEach(button => button.classList.toggle('active', button === event.target));
    });
    const off = group.querySelector('[data-value="false"]');
    const on = group.querySelector('[data-value="true"]');
    off.focus();
    t.key('ArrowRight');
    assert.equal(t.focused(), on);
    assert.equal(on.classList.contains('active'), true, 'ON chosen');
    t.key('ArrowRight');
    assert.equal(t.focused(), on, 'the end: not on to the next control');
    t.key('ArrowLeft');
    assert.equal(off.classList.contains('active'), true, 'OFF again');
    on.disabled = true;
    t.key('ArrowRight');
    assert.equal(t.focused(), off, 'a disabled side is not chosen');
});

test('focus nav: a toggle switched with Right is saved like a click (test mode section)', async () => {
    const values = { ForgeEverywhere: null, Hotkeys: null };
    const saves = [];
    const backend = {
        handle(command, data) {
            if (command === 'get-test-mode-settings') {
                return { supported: true, installed: true, fixInstalled: true, fix: 'XML2 Fix', file: 'xml2-fix.ini', keys: ['ForgeEverywhere', 'Hotkeys'], values: Object.assign({}, values), defaults: {} };
            }
            if (command === 'set-test-mode-settings') {
                saves.push({ ...data.values });
                Object.assign(values, data.values);
                return { success: true, values: Object.assign({}, values) };
            }
            return null;
        }
    };
    const p = page({
        scripts: ['core/utils.js', 'core/i18n.js', 'core/focus-nav.js', 'app/test-mode-view.js'],
        backend,
        body: '<div id="xml1-page"><div id="xml1-button-group"></div><div id="xml1-testmode-badge" hidden></div><div id="xml1-testmode-panel"></div></div>'
    });
    p.window.Xml1Port = { status: { fix: { installed: true, version: '1.6.0' } }, starting: null, isBuilding: () => false };
    p.window.TestModeView.render('xml1');
    await p.clock.advance(0);
    const off = p.document.querySelector('.ul-testmode-toggle[data-key="Hotkeys"] .toggle-btn[data-value="0"]');
    off.focus();
    off.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    const on = p.document.querySelector('.ul-testmode-toggle[data-key="Hotkeys"] .toggle-btn[data-value="1"]');
    assert.equal(p.document.activeElement, on);
    assert.equal(on.classList.contains('active'), true);
    await p.clock.advance(400);
    assert.deepEqual(saves, [{ Hotkeys: true }]);
});

test('focus nav: a select is picked in place: Enter, Down, Enter keeps it (one change); Escape puts it back', () => {
    const t = open(`
        <select id="theme" data-rect="0,0,100,20">
            <option value="tactical">Tactical</option>
            <option value="dark" disabled>Dark</option>
            <option value="navy">Navy</option>
        </select>
        <button id="below" data-rect="0,100,100,20">Below</button>`);
    const select = t.$('#theme');
    const changes = [];
    select.addEventListener('change', () => changes.push(select.value));
    select.focus();
    t.key('ArrowDown');
    assert.equal(t.focused().id, 'below', 'not picking: Down moves on, the value stays');
    assert.equal(select.value, 'tactical');

    select.focus();
    t.key('Enter');
    assert.equal(select.classList.contains('is-picking'), true);
    t.key('ArrowDown');
    assert.equal(select.value, 'navy', 'a disabled option is skipped');
    assert.equal(t.focused(), select, 'the focus stays while picking');
    t.key('ArrowDown');
    assert.equal(select.value, 'navy', 'the last option: stays');
    assert.deepEqual(changes, [], 'no change event while stepping');
    t.key('Enter');
    assert.deepEqual(changes, ['navy'], 'one change on Enter');
    assert.equal(select.classList.contains('is-picking'), false);

    t.key(' ');
    t.key('ArrowUp');
    assert.equal(select.value, 'tactical');
    t.key('Escape');
    assert.equal(select.value, 'navy', 'Escape puts the old value back');
    assert.deepEqual(changes, ['navy'], 'without a change event');
    assert.equal(t.focused(), select, 'and does not go back a page');
});

test('focus nav: in a text field Left / Right move the caret, Up / Down and the field\'s ends leave it', () => {
    const t = open(`
        <input type="text" id="search" data-rect="0,0,200,20">
        <button id="clear" data-rect="210,0,20,20">x</button>
        <button id="below" data-rect="0,100,100,20">Below</button>`);
    const search = t.$('#search');
    search.value = 'mua';
    search.focus();
    search.selectionStart = search.selectionEnd = 1;
    assert.equal(t.key('ArrowRight').defaultPrevented, false, 'mid-text: the caret moves');
    assert.equal(t.focused(), search);
    assert.equal(t.key('Backspace').defaultPrevented, false, 'Backspace deletes, it does not go back');
    search.selectionStart = search.selectionEnd = 3;
    t.key('ArrowRight');
    assert.equal(t.focused().id, 'clear', 'at the end: on to the clear button');
    search.focus();
    t.key('ArrowDown');
    assert.equal(t.focused().id, 'below');
});

// ---- popups ----

test('focus nav: the message box takes the focus, keeps Tab and the arrows inside, and gives it back', async () => {
    const t = open('<button id="opener" data-rect="0,0,50,20">Uninstall...</button><button id="other" data-rect="0,50,50,20">Other</button>');
    t.$('#opener').focus();
    const answer = t.window.showMessageBox('Uninstall?', 'Really?', ['Cancel', { label: 'Uninstall', danger: true }]);
    await t.clock.advance(0);
    t.nav.sync();
    const buttons = t.document.querySelectorAll('#message-box .mb-buttons button');
    assert.equal(t.focused(), buttons[0], 'Cancel has the focus, not the danger button');
    t.key('Tab');
    assert.equal(t.focused(), buttons[1]);
    t.key('Tab');
    assert.equal(t.focused(), buttons[0], 'Tab wraps inside the box');
    t.key('Tab', { shiftKey: true });
    assert.equal(t.focused(), buttons[1]);
    t.key('ArrowDown');
    t.key('ArrowUp');
    assert.equal(t.$('#message-box').contains(t.focused()), true, 'the arrows stay inside');
    t.$('#other').focus();
    assert.equal(t.$('#message-box').contains(t.focused()), true, 'focus sent outside comes back');
    t.key('Escape');
    assert.equal(await answer, 0, 'Escape is Cancel');
    t.nav.sync();
    assert.equal(t.focused().id, 'opener', 'back on the button that opened it');
    assert.equal(buttons.some(button => t.nav.isFocusable(button)), false, "the hidden box's buttons (still in the page) are out of reach");
});

test('focus nav: Escape presses the message box button marked cancel; a danger button is never focused first', async () => {
    const t = open('<button id="opener">Open</button>');
    t.$('#opener').focus();
    const update = t.window.showMessageBox('Update?', '', ['Update', { label: 'Not now', cancel: true }]);
    await t.clock.advance(0);
    t.nav.sync();
    assert.equal(t.focused().textContent, 'Update');
    t.key('Escape');
    assert.equal(await update, 1, 'Not now');
    t.nav.sync();

    const remove = t.window.showMessageBox('Remove?', '', [{ label: 'Remove', danger: true }, 'Keep']);
    await t.clock.advance(0);
    t.nav.sync();
    assert.equal(t.focused().textContent, 'Keep');
    t.nav.press('Enter', 'pad');
    assert.equal(await remove, 1, "a pad's A presses the focused button");
});

test('focus nav: a popup traps the focus, a message box over it closes first, and each gives the focus back', async () => {
    const t = open(`
        <button id="opener">Manage install</button>
        <div class="component-selection-backdrop" id="popup" style="display: none">
            <div class="component-selection-popup">
                <button class="popup-close">x</button>
                <button class="btn-uninstall" id="uninstall">Uninstall</button>
                <button class="btn-apply" id="apply">Apply</button>
            </div>
        </div>`);
    const popup = t.$('#popup');
    popup.querySelector('.popup-close').addEventListener('click', () => popup.classList.remove('active'));
    t.$('#opener').focus();
    popup.style.display = 'flex';
    t.nav.sync();
    assert.equal(t.focused().id, 'apply', 'not the close button, not Uninstall');
    popup.classList.add('active');
    t.nav.sync();
    assert.equal(t.focused().id, 'apply', 'still there once it has faded in');

    t.$('#uninstall').focus();
    const confirm = t.window.showMessageBox('Uninstall?', '', ['Cancel', { label: 'Uninstall', danger: true }]);
    await t.clock.advance(0);
    t.nav.sync();
    assert.equal(t.$('#message-box').contains(t.focused()), true, 'the message box on top has it');
    t.key('Escape');
    assert.equal(await confirm, 0);
    t.nav.sync();
    assert.equal(t.focused().id, 'uninstall', 'back on Uninstall in the popup');

    t.key('Escape');
    assert.equal(popup.classList.contains('active'), false, 'Escape pressed its close button');
    t.nav.sync();
    assert.equal(t.focused().id, 'opener', 'closed (still fading out): back on the opener');
});

test('focus nav: Escape in the card menu leaves it to views.js and does not go back a page', () => {
    const t = open('<div id="card" tabindex="0" role="button">Card</div><div class="library-card-menu" role="menu" hidden><button class="library-card-menu-item">Pin</button></div>', { own: false });
    wireNavigation(t);
    t.$('#library').click();
    t.nav.sync();
    t.$('#home').click();
    t.nav.sync();
    const menu = t.$('.library-card-menu');
    t.$('#card').focus();
    menu.hidden = false;
    t.nav.sync();
    assert.equal(t.focused().textContent, 'Pin');
    let seen = 0;
    t.document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            seen++;
            menu.hidden = true;
        }
    });
    t.key('Escape');
    assert.equal(seen, 1, "the page's own Escape listener closes the menu");
    t.nav.sync();
    assert.equal(t.$('#home-page').style.display, 'block', 'still on Home');
    assert.equal(t.focused().id, 'card');
});

// ---- pages ----

test('focus nav: Escape and Backspace go back through the pages, to the control that had the focus', () => {
    const t = open('', { own: false });
    wireNavigation(t);
    const visible = () => t.document.querySelectorAll('.page-section').find(section => section.style.display === 'block');
    t.$('#library').focus();
    t.key('Enter');
    t.nav.sync();
    assert.equal(visible().id, 'library-page');
    const chip = t.$('.chip[data-filter="installed"]');
    chip.focus();
    t.$('#settings').click();
    t.nav.sync();
    assert.equal(visible().id, 'settings-page');
    t.$('#theme-select').focus();

    t.key('Escape');
    assert.equal(visible().id, 'library-page', 'back to the Library');
    assert.equal(t.focused(), chip, 'onto the chip it was left on');
    t.key('Backspace');
    assert.equal(visible().id, 'home-page');
    t.key('Escape');
    assert.equal(visible().id, 'home-page', 'Home with nothing behind it: stays');
});

test('focus nav: activating a card from the keyboard takes the focus into the page it opens', async () => {
    const t = open('', { own: false });
    wireNavigation(t);
    t.$('#library').click();
    t.nav.sync();
    t.$('#game-pages').innerHTML = '<div class="page-section game-page" id="xml1-page" style="display: none"><div class="button-group"><button id="play">Play</button></div></div>';
    t.$('#library-grid').innerHTML = '<article class="library-card" data-game="xml1" tabindex="0" role="button">X-Men Legends</article>';
    t.$('.library-card').addEventListener('click', () => t.$('.game-item[data-game="xml1"]').click());
    t.$('.library-card').focus();
    t.key('Enter');
    t.nav.sync();
    assert.equal(t.focused().id, 'play');
    t.key('Escape');
    assert.equal(t.focused().getAttribute('data-game'), 'xml1', 'Back: on the card again');
});

test('focus nav: a game page\'s Play, rendered after the page shows, takes the focus from the first link', async () => {
    const t = open('', { own: false });
    wireNavigation(t);
    t.$('#game-pages').innerHTML = `
        <div class="page-section game-page" id="mua-page" style="display: none">
            <div class="button-group" id="mua-button-group"></div>
            <p><a href="#" id="link">MUA Controller Fix</a></p>
        </div>`;
    t.$('#library').click();
    t.nav.sync();
    t.$('#library-grid').innerHTML = '<article class="library-card" data-game="mua" tabindex="0" role="button">MUA</article>';
    t.$('.library-card').addEventListener('click', () => t.$('.game-item[data-game="mua"]').click());
    t.$('.library-card').focus();
    t.key('Enter');
    t.nav.sync();
    assert.equal(t.focused().id, 'link', 'only the link so far');
    t.$('#mua-button-group').innerHTML = '<button id="mua-play-button" data-autofocus>Play</button>';
    t.nav.sync();
    assert.equal(t.focused().id, 'mua-play-button', 'Play once it is there');

    // Moved on before it came: left where it is.
    t.key('Escape');
    t.$('#mua-button-group').innerHTML = '';
    t.$('.library-card').focus();
    t.key('Enter');
    t.nav.sync();
    assert.equal(t.focused().id, 'link');
    t.$('.game-item[data-game="mua"]').focus(); // the player went on to the sidebar
    t.$('#mua-button-group').innerHTML = '<button id="mua-play-button" data-autofocus>Play</button>';
    t.nav.sync();
    assert.equal(t.focused().getAttribute('data-game'), 'mua', 'not pulled away once the player moved');
});

test('focus nav: back to a page rendered again (the Library), onto the same card', () => {
    const t = open('', { own: false });
    wireNavigation(t);
    const grid = '<article class="library-card" data-game="mua" tabindex="0" role="button">MUA</article><article class="library-card" data-game="xml1" tabindex="0" role="button">XML1</article>';
    t.$('#library').click();
    t.nav.sync();
    t.$('#library-grid').innerHTML = grid;
    t.$('.library-card[data-game="xml1"]').focus();
    t.key('Tab'); // the keyboard is in use
    t.$('#settings').click();
    t.nav.sync();
    t.$('#library-grid').innerHTML = grid; // what renderLibrary does on the next visit
    t.key('Escape');
    assert.equal(t.focused(), t.$('.library-card[data-game="xml1"]'));
});

test('focus nav: LB / RB go to the previous / next sidebar page, wrapping; a game page counts as the Library', () => {
    const t = open('', { own: false });
    t.$('#game-pages').innerHTML = '<div class="page-section game-page" id="mua-page" style="display: none"></div>';
    wireNavigation(t);
    const active = () => t.document.querySelector('.nav-item.active');
    t.nav.section(1);
    assert.equal(active().id, 'library');
    assert.equal(t.focused().id, 'library', 'the focus on its sidebar item');
    t.nav.section(-1);
    t.nav.section(-1);
    assert.equal(active().id, 'settings', 'from Home back round to Settings');
    t.$('.game-item[data-game="mua"]').click();
    assert.equal(active(), null);
    t.nav.section(1);
    assert.equal(active().id, 'downloads');
});

test('focus nav: a list rendered again keeps the focus on the same row', () => {
    const t = open('<div id="list"></div>');
    const rows = '<div class="download-row" data-game="mua" data-op="verify" tabindex="0" role="button">MUA</div><div class="download-row" data-game="xml1" data-op="install" tabindex="0" role="button">XML1</div>';
    t.$('#list').innerHTML = rows;
    t.$('.download-row[data-game="xml1"]').focus();
    t.key('Tab'); // the keyboard is in use
    t.$('.download-row[data-game="xml1"]').focus();
    t.$('#list').innerHTML = rows;
    t.document.activeElement = t.document.body; // the browser drops the focus with the removed row
    t.nav.sync();
    assert.equal(t.focused(), t.$('.download-row[data-game="xml1"]'));
});

// ---- the Gamepad API ----

function pad({ buttons = [], axes = [0, 0] } = {}) {
    const list = Array.from({ length: 17 }, (_, i) => ({ pressed: buttons.includes(i), value: buttons.includes(i) ? 1 : 0 }));
    return { connected: true, mapping: 'standard', buttons: list, axes };
}

test('gamepad: the D-pad repeats while held, buttons fire once, the stick follows its stronger axis', () => {
    const { window } = open();
    const step = (...args) => [...window.GamepadNav.step(...args)];
    assert.deepEqual(step([pad({ buttons: [13] })], 0), ['ArrowDown']);
    assert.deepEqual(step([pad({ buttons: [13] })], 100), []);
    assert.deepEqual(step([pad({ buttons: [13] })], 400), ['ArrowDown'], 'repeats after 400 ms');
    assert.deepEqual(step([pad({ buttons: [13] })], 450), []);
    assert.deepEqual(step([pad({ buttons: [13] })], 520), ['ArrowDown'], 'then every 120 ms');
    assert.deepEqual(step([pad()], 600), []);
    assert.deepEqual(step([pad({ buttons: [0] })], 700), ['Enter']);
    assert.deepEqual(step([pad({ buttons: [0] })], 2000), [], 'A held: once');
    assert.deepEqual(step([pad({ buttons: [1, 4] })], 2100), ['Escape', 'PrevSection']);
    assert.deepEqual(step([pad({ buttons: [5, 3] })], 2200), ['ContextMenu', 'NextSection']);
    assert.deepEqual(step([pad({ axes: [0.2, 0.8] })], 3000), ['ArrowDown'], 'stick down');
    assert.deepEqual(step([pad({ axes: [-0.9, 0.6] })], 3100), ['ArrowLeft'], 'a diagonal: the stronger axis only');
    assert.deepEqual(step([pad({ axes: [0.3, -0.4] })], 3200), [], 'inside the dead zone');
});

test('gamepad: nothing while the launcher is in the background; a button held then waits for its release', () => {
    const { window } = open();
    const step = (...args) => [...window.GamepadNav.step(...args)];
    assert.deepEqual(step([pad({ buttons: [0] })], 0, false), []);
    assert.deepEqual(step([pad({ buttons: [0] })], 100, true), [], 'A still held from the game: ignored');
    assert.deepEqual(step([pad()], 200, true), []);
    assert.deepEqual(step([pad({ buttons: [0] })], 300, true), ['Enter']);
});

test('gamepad: polling the pad moves the focus, presses, closes the message box and switches pages', async () => {
    const t = open(`
        <div id="a" tabindex="0" role="button" data-rect="0,0,100,40">A</div>
        <div id="b" tabindex="0" role="button" data-rect="0,100,100,40">B</div>`, { own: false });
    t.document.querySelector('.window').hidden = true;
    let state = pad();
    t.window.navigator.getGamepads = () => [state];
    const poll = next => {
        state = next;
        t.window.GamepadNav.poll();
        state = pad();
        t.window.GamepadNav.poll();
    };
    let clicked = 0;
    t.$('#b').addEventListener('click', () => clicked++);
    t.$('#a').focus();
    poll(pad({ buttons: [13] }));
    assert.equal(t.focused().id, 'b', 'D-pad down');
    poll(pad({ buttons: [0] }));
    assert.equal(clicked, 1, 'A');

    const answer = t.window.showMessageBox('Title', '', ['OK']);
    await t.clock.advance(0);
    t.nav.sync();
    poll(pad({ buttons: [1] }));
    assert.equal(await answer, 0, 'B closes the message box');

    t.document.querySelector('.window').hidden = false;
    wireNavigation(t);
    poll(pad({ buttons: [5] }));
    assert.equal(t.document.querySelector('.nav-item.active').id, 'library', 'RB: next page');

    t.document.focused = false;
    poll(pad({ buttons: [4] }));
    assert.equal(t.document.querySelector('.nav-item.active').id, 'library', 'the launcher in the background: LB ignored');
});

test('gamepad: a pad that also arrives as arrow keys (Steam Input) moves once, then only the keys count', () => {
    const t = open(`
        <button id="a" data-rect="0,0,100,40">A</button>
        <button id="b" data-rect="0,100,100,40">B</button>
        <button id="c" data-rect="0,200,100,40">C</button>`);
    t.$('#a').focus();
    t.nav.press('ArrowDown', 'pad');
    t.key('ArrowDown'); // the same press, as Steam Input's key
    assert.equal(t.focused().id, 'b', 'one move, not two');
    assert.equal(t.nav.isPadMuted(), true);
    t.nav.press('ArrowDown', 'pad');
    assert.equal(t.focused().id, 'b', 'the pad is ignored from then on');
    t.key('ArrowDown');
    assert.equal(t.focused().id, 'c', 'the keys still work');
});
