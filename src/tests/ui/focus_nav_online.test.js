'use strict';
// PR #11's controller navigation (core/focus-nav.js, core/gamepad-nav.js) driving PR #12's Online section, loaded
// together as in the launcher: a pad's D-pad and A (through GamepadNav's poller, the Gamepad API) reach every
// control of the section - List my game publicly, the room name, Host, the code field and Enter in it, Join,
// Refresh, a row's Join, Copy, Try again and How online works - and never stop on its notes. The harness has no
// layout: each control gets the box it has in the launcher's two-column section (rectOf below).
// The real hardware pass (a Steam Deck, Steam Input) is the release checklist's D7.

const assert = require('node:assert/strict');
const { test } = require('./harness');

const { open } = require('./online_fixture');

const SCRIPTS = ['core/utils.js', 'core/i18n.js', 'core/focus-nav.js', 'core/gamepad-nav.js', 'app/online-browse.js', 'app/online-view.js'];

function box(left, top, width, height) {
    return { left, top, width, height, right: left + width, bottom: top + height };
}

// The section as it is laid out: Host card left, Join card right, Browse games under them, the session in
// their place while one runs, How online works at the bottom; Play above.
function rectOf(element) {
    const has = name => element.classList.contains(name);
    if (element.id === 'xml1-play-button') return box(20, 20, 100, 40);
    if (has('toggle-btn') && element.closest('.ul-online-public-toggle')) return element.dataset.value === '1' ? box(90, 100, 60, 30) : box(20, 100, 60, 30);
    if (has('ul-online-room-name-input')) return box(20, 150, 260, 30);
    if (has('ul-online-host-button')) return box(20, 200, 140, 36);
    if (has('ul-online-code-input')) return box(340, 100, 180, 30);
    if (has('ul-online-join-button')) return box(530, 100, 80, 36);
    if (has('ul-online-browse-refresh')) return box(530, 260, 80, 30);
    if (has('ul-online-room-join')) {
        const rows = [...element.closest('.ul-online-rooms').querySelectorAll('.ul-online-room')];
        return box(530, 300 + 50 * rows.indexOf(element.closest('.ul-online-room')), 80, 30);
    }
    if (has('ul-online-copy')) return box(300, 120, 80, 36);
    if (has('ul-online-again')) return box(20, 220, 100, 36);
    if (has('ul-online-testmode-off')) return box(140, 220, 140, 36);
    // The folds under How online works, one above the other: blocks the section's width.
    if (element.tagName === 'SUMMARY') return element.closest('.ul-online-messages') ? box(20, 660, 600, 24) : box(20, 620, 600, 24);
    if (has('ul-online-ip-note')) return element.closest('.ul-online-browse') ? box(20, 290, 400, 18) : box(20, 135, 260, 18);
    return box(0, 0, 0, 0);
}

function room(fields = {}) {
    return Object.assign({ code: 'WXYZ6789', name: 'Saturday', host_display_name: 'Logan', game_mode: 'campaign', zone_name: 'Alison Rescue',
        version_token: 'LC31', players: 1, max_players: 4, in_progress: false, joinable: true }, fields);
}

async function openWithPad(options = {}) {
    let pad = { connected: true, buttons: [], axes: [0, 0] };
    const t = await open(Object.assign({ scripts: SCRIPTS, rooms: [room()] }, options, {
        beforeRender(window) {
            // Only the Online page's controls (and Play) can have the focus: the launcher's own window is hidden.
            window.document.querySelector('.window').hidden = true;
            window.FocusNav.setRectSource(rectOf);
            window.navigator.getGamepads = () => [pad];
        }
    }));
    await t.clock.advance(1000); // the first list
    const BUTTON = { up: 12, down: 13, left: 14, right: 15, a: 0, b: 1 };
    // One press and release of a pad button, read by GamepadNav's poller as the launcher reads it.
    const press = async name => {
        const buttons = [];
        buttons[BUTTON[name]] = { pressed: true, value: 1 };
        pad = { connected: true, buttons, axes: [0, 0] };
        t.window.GamepadNav.poll();
        pad = { connected: true, buttons: [], axes: [0, 0] };
        t.window.GamepadNav.poll();
        await t.clock.advance(0);
    };
    const at = () => {
        const e = t.document.activeElement;
        if (!e || e === t.document.body) return null;
        for (const name of ['ul-online-room-name-input', 'ul-online-host-button', 'ul-online-code-input', 'ul-online-join-button', 'ul-online-browse-refresh',
            'ul-online-room-join', 'ul-online-copy', 'ul-online-again', 'ul-online-testmode-off']) {
            if (e.classList.contains(name)) return name;
        }
        if (e.closest('.ul-online-public-toggle')) return `public:${e.dataset.value}`;
        if (e.id === 'xml1-play-button') return 'play';
        return e.tagName.toLowerCase();
    };
    return Object.assign(t, { press, at, nav: t.window.FocusNav });
}

test('S6: How online works\' folds are controls for FocusNav (tabindex and a native summary), with the ring; the notes and steps never are', async () => {
    const t = await openWithPad();
    const summary = t.$('.ul-online-good summary');
    assert.equal(t.nav.isFocusable(summary), true, 'Good to know: D-pad reaches it');
    assert.equal(t.nav.isFocusable(t.$('.ul-online-messages summary')), true, 'What the messages mean too');
    summary.removeAttribute('tabindex');
    assert.equal(t.nav.isFocusable(summary), true, 'a <details> summary without a tabindex too (native support)');
    summary.setAttribute('tabindex', '0');
    const loose = t.document.createElement('summary');
    t.$('.ul-online-good').appendChild(loose);
    assert.equal(t.nav.isFocusable(loose), false, 'not a summary that isn\'t its details\' own');
    loose.remove();
    for (const note of t.document.querySelectorAll('#xml1-online-panel .ul-online-ip-note, #xml1-online-panel .ul-online-public-note, #xml1-online-panel .ul-online-help-notes li, ' +
        '#xml1-online-panel .ul-online-howto-step, #xml1-online-panel .ul-online-howto-code, #xml1-online-panel .ul-online-howto-card svg')) {
        assert.equal(t.nav.isFocusable(note), false, `a note is text: ${note.className || note.dataset.note}`);
    }
    // The one ring covers it from the keyboard and from a pad (main.css).
    const css = require('fs').readFileSync(require('path').resolve(__dirname, '../../launcher-ui/assets/css/main.css'), 'utf8');
    assert.match(css, /:root\[data-nav="keys"\] :focus,\s*\n:root :is\(button, a, select, summary, \[tabindex\]\):focus-visible \{\s*\n\s*outline: 2px solid/);
});

test('S6: a pad walks the idle section: public toggle, room name, Host, the code field, Join, Refresh, a row\'s Join, the help', async () => {
    const t = await openWithPad();
    t.document.getElementById('xml1-play-button').focus();
    await t.press('down');
    assert.equal(t.at(), 'public:0', 'down from Play: List my game publicly');
    await t.press('right');
    assert.equal(t.at(), 'public:1', 'right switches it on (a toggle group)');
    assert.equal(t.$('.ul-online-public-toggle .toggle-btn[data-value="1"]').getAttribute('aria-pressed'), 'true');
    assert.equal(t.$('.ul-online-room-name-input').disabled, false, 'the room name is on with it');
    await t.press('down');
    assert.equal(t.at(), 'ul-online-room-name-input', 'down: the room name (skipping the internet-address line)');
    await t.press('down');
    assert.equal(t.at(), 'ul-online-host-button', 'down: Host');
    await t.press('right');
    assert.equal(t.at(), 'ul-online-code-input', 'right: the code field');
    await t.press('right');
    assert.equal(t.at(), 'ul-online-join-button', 'right: Join');
    await t.press('down');
    assert.equal(t.at(), 'ul-online-browse-refresh', 'down: Refresh');
    const fetches = t.backend.fetches;
    await t.press('a');
    await t.clock.advance(600);
    assert.equal(t.backend.fetches, fetches + 1, 'A on Refresh fetches');
    assert.equal(t.at(), 'ul-online-browse-refresh', 'and the focus is back on Refresh');
    await t.press('down');
    assert.equal(t.at(), 'ul-online-room-join', 'down: the row\'s Join');
    await t.press('down');
    assert.equal(t.document.activeElement, t.$('.ul-online-good summary'), 'down: Good to know');
    await t.press('a');
    assert.equal(t.$('.ul-online-good').open, true, 'A opens it');
    await t.press('down');
    assert.equal(t.document.activeElement, t.$('.ul-online-messages summary'), 'down: What the messages mean');
    await t.press('a');
    assert.equal(t.$('.ul-online-messages').open, true, 'A opens it');
    await t.press('a');
    assert.equal(t.$('.ul-online-messages').open, false, 'A again closes it');
    await t.press('up');
    await t.press('up');
    assert.equal(t.at(), 'ul-online-room-join', 'up: back in the list');
    assert.deepEqual(t.backend.launches, [], 'walking started nothing');
});

test('S6: a pad joins from a row, gets Try again on room_closed, and back to the code field; Enter in the field joins', async () => {
    const t = await openWithPad();
    t.$('.ul-online-browse-refresh').focus();
    await t.press('down');
    assert.equal(t.at(), 'ul-online-room-join');
    await t.press('a');
    await t.clock.advance(1500);
    assert.deepEqual(t.backend.launches, [{ game: 'xml1', online: { mode: 'join', code: 'WXYZ6789' } }], 'A on a row\'s Join: the code join');
    t.backend.running = true;
    t.backend.write({ role: 'join', state: 'error', error: 'room_closed' });
    await t.clock.advance(600);
    assert.equal(t.at(), 'ul-online-again', 'the error: the focus on Try again');
    t.backend.running = false;
    await t.press('a');
    await t.clock.advance(600);
    assert.equal(t.at(), 'ul-online-code-input', 'A on Try again: back on the code field, the code in it');
    assert.equal(t.input().value, 'WXYZ-6789');
    await t.press('a'); // A in a text field is its own Enter
    await t.clock.advance(1500);
    assert.equal(t.backend.launches.length, 2, 'A (Enter) in the code field joins again');
    assert.deepEqual(t.backend.launches[1].online, { mode: 'join', code: 'WXYZ6789' });
});

test('S6: a pad hosts, the focus goes to Copy, A copies; B is not taken by the section', async () => {
    const t = await openWithPad();
    t.$('.ul-online-host-button').focus();
    await t.press('a');
    await t.clock.advance(1500);
    t.backend.running = true;
    t.backend.write({ role: 'host', state: 'room', code: 'ABCD2345', players: 1, max_players: 4 });
    await t.clock.advance(600);
    assert.equal(t.at(), 'ul-online-copy', 'the code up: the focus on Copy');
    assert.deepEqual(t.clipboard, ['ABCD-2345'], 'copied by itself once');
    await t.press('a');
    await t.clock.advance(0);
    assert.deepEqual(t.clipboard, ['ABCD-2345', 'ABCD-2345'], 'A on Copy copies again');
    t.backend.write({ role: 'host', state: 'room', code: 'ABCD2345', players: 2, max_players: 4 });
    await t.clock.advance(600);
    assert.equal(t.at(), 'ul-online-copy', 'a player joining keeps it on Copy');
    t.backend.write({ role: 'host', state: 'error', error: 'test_mode_on' });
    await t.clock.advance(600);
    assert.equal(t.at(), 'ul-online-again', 'an error: Try again');
    await t.press('right');
    assert.equal(t.at(), 'ul-online-testmode-off', 'right: Turn test mode off, next to it');
    await t.press('left');
    assert.equal(t.at(), 'ul-online-again');
});

test('S6: the room name and Host from a pad, a public game hosted with its name', async () => {
    const t = await openWithPad();
    t.$('.ul-online-public-toggle .toggle-btn[data-value="0"]').focus();
    await t.press('right');
    await t.press('down');
    assert.equal(t.at(), 'ul-online-room-name-input');
    t.$('.ul-online-room-name-input').value = 'Saturday'; // the on-screen keyboard's text
    await t.press('down');
    await t.press('a');
    await t.clock.advance(1500);
    assert.deepEqual(t.backend.launches, [{ game: 'xml1', online: { mode: 'host', public: true, roomName: 'Saturday' } }]);
});
