'use strict';
// The X-Men Legends page's Online section (launcher 0.4.0): Host a game / Join a game against the
// launcher <-> XML2 Fix contract (v1.5). The real online-view.js and GameUtils.launchGame (utils.js) run
// against online_fixture.js's fake backend, which keeps the port's [Online] keys and online-status.json the
// way the C++ does. A test writes the status file as the fix would: every state and error id must render.
// That the rest of the ini stays byte for byte is the real WritePrivateProfileString's job:
// tools/dev/online_cdp.py checks it; src/tests/online_rules_tests.cpp the keys each start writes and
// src/tests/online_launch_tests.cpp the order of a start (armed last, disarmed on every failure).
// The public games (v1.3) are online_browse.test.js's; the release fixes of 0.4.0 (B1, S1-S5, S7-S9)
// online_release.test.js's.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('./harness');

const { ALPHABET, ERRORS, REQUIRED_FIX, open, host, joinWith } = require('./online_fixture');

test('online: Host a game and Join a game, with the help, on a built game', async () => {
    const t = await open();
    assert.equal(t.text('.ul-online-host .ul-online-card-title'), 'Host a game');
    assert.equal(t.text('.ul-online-join .ul-online-card-title'), 'Join a game');
    assert.equal(t.blockedText(), null, 'nothing in the way');
    t.controls().forEach(control => assert.equal(control.disabled, false));
    assert.equal(t.text('.ul-online-help-title'), 'How online works');
    const help = t.text('.ul-online-help');
    assert.match(help, /port forwarding/);
    assert.match(help, /LAN and Connect by IP still work/);
    assert.match(t.text('.ul-online-howto-card[data-card="host"]'), /In the game: Play Online, then Host/);
    assert.match(t.text('.ul-online-howto-card[data-card="join"]'), /In the game: Play Online, then Join Game/);
    assert.equal(ERRORS.length, 10, 'contract v1.5: ten ids');
    for (const id of ERRORS) assert.ok(t.$(`.ul-online-messages .ul-online-help-error[data-error="${id}"] dt`), `the help explains ${id}`);
    assert.deepEqual(t.backend.launches, [], 'opening the page starts and writes nothing');
});

test('online: Host is one launch-game { online: host }; the backend arms Host once it has started the game', async () => {
    const t = await open({ online: { JoinCode: 'ZZZZ9999' }, status: { v: 1, role: 'host', state: 'room', code: 'OLDC0DE0', players: 1 } });
    t.$('.ul-online-host-button').click();
    assert.equal(t.phase(), 'Connecting…', 'Connecting… at the click');
    await t.clock.advance(1500);
    assert.deepEqual(t.backend.launches, [{ game: 'xml1', online: { mode: 'host', public: false, roomName: '' } }], 'private by default');
    assert.equal(t.backend.online.Host, 'broker');
    assert.equal(t.backend.online.JoinCode, undefined, 'JoinCode removed');
    assert.equal(t.backend.online.Broker, 'broker.example:7777', 'the builder\'s Broker kept');
    assert.equal(t.backend.online.BrokerPin, 'ab'.repeat(32), 'and its BrokerPin');
    assert.equal(t.backend.online.GameVersion, 'LC33', 'and its GameVersion');
    const order = t.backend.calls.filter(c => c === 'launch-game' || c === 'get-launch-outcome');
    assert.deepEqual(order.slice(0, 2), ['launch-game', 'get-launch-outcome'], 'the start, then what became of it');
    assert.equal(t.phase(), 'Connecting…', 'the stale status of an earlier room is gone: still connecting');
});

test('online: a stale room is never shown, even when a poll lands between Host and the start', async () => {
    const t = await open({ status: { v: 1, role: 'host', state: 'room', code: 'PQRS2345', players: 1 } });
    // The redist check takes a while: the 500 ms polls run before launch-game deletes the file.
    const handle = t.backend.handle.bind(t.backend);
    t.backend.handle = (command, data) => (command === 'get-missing-redists-for-game'
        ? new Promise(resolve => t.clock.setTimeout(() => resolve(handle(command, data)), 1200))
        : handle(command, data));
    t.$('.ul-online-host-button').click();
    await t.clock.advance(1100);
    assert.ok(t.backend.calls.filter(c => c === 'get-online-status').length >= 2, 'polled meanwhile');
    assert.ok(!t.$('.ul-online-code'), 'the old code is not shown');
    assert.equal(t.phase(), 'Connecting…');
    await t.clock.advance(1500);
    assert.deepEqual(t.backend.starts.map(p => p.mode), ['host']);
    t.backend.running = true;
    await t.clock.advance(600);
    assert.ok(!t.$('.ul-online-code'), 'still nothing until the fix writes the new room');
    t.backend.write({ role: 'host', state: 'room', code: 'NEWCQDE2', players: 1 });
    await t.clock.advance(600);
    assert.equal(t.text('.ul-online-code'), 'NEWC-QDE2');
});

test('online: every host state renders: connecting, room (the code, Copy, players), in_game, ended', async () => {
    const t = await open();
    await host(t, { running: false });
    assert.equal(t.phase(), 'Connecting…', 'the game not up yet: Connecting…');
    t.backend.running = true;
    await t.clock.advance(600);
    assert.equal(t.phase(), 'Open Play Online in the game – your code appears here.', 'the game up, no status yet: where to go (contract v1.2)');
    t.backend.write({ role: 'host', state: 'connecting' });
    await t.clock.advance(600);
    assert.equal(t.phase(), 'Open Play Online in the game – your code appears here.', 'connecting until Play Online opens the room');
    assert.ok(t.$('.ul-online-spinner'), 'still busy');
    assert.ok(!t.$('.ul-online-code'), 'no code while connecting');

    t.backend.write({ role: 'host', state: 'room', code: 'ABCD2345', players: 1 });
    await t.clock.advance(600);
    assert.equal(t.text('.ul-online-code'), 'ABCD-2345', 'the code, as XXXX-XXXX');
    assert.equal(t.$('.ul-online-code').dataset.code, 'ABCD2345');
    assert.equal(t.text('.ul-online-copy'), 'Copy');
    assert.equal(t.text('.ul-online-code-hint'), 'Send this code to your friends. In the game: Play Online → Host.');
    assert.equal(t.text('.ul-online-players'), '1 player in the room (you)');
    assert.equal(t.$('.ul-online-players').classList.contains('is-new'), false);

    t.backend.write({ role: 'host', state: 'room', code: 'ABCD2345', players: 3 });
    await t.clock.advance(600);
    assert.equal(t.text('.ul-online-players'), '3 players in the room', 'the count follows');
    assert.equal(t.$('.ul-online-players').classList.contains('is-new'), true, 'and shows it changed');

    t.backend.write({ role: 'host', state: 'in_game', code: 'ABCD2345', players: 3 });
    await t.clock.advance(600);
    assert.equal(t.phase(), 'Connected – playing together.', 'in_game: the session runs over the room');
    assert.equal(t.text('.ul-online-code'), 'ABCD-2345', 'the code stays up');

    t.backend.write({ role: 'host', state: 'ended', code: 'ABCD2345', players: 0 });
    await t.clock.advance(600);
    assert.equal(t.phase(), 'The online game has ended.');
    assert.ok(!t.$('.ul-online-copy'));
    assert.equal(t.text('.ul-online-again'), 'OK');
    const polls = t.backend.calls.filter(c => c === 'get-online-status').length;
    await t.clock.advance(1000);
    assert.ok(t.backend.calls.filter(c => c === 'get-online-status').length <= polls + 1, 'no more 500 ms polling once it ended');
});

test('online: players count the host; "N of M" when the fix gives max_players (contract v1.1)', async () => {
    const t = await open();
    await host(t);
    t.backend.write({ role: 'host', state: 'room', code: 'ABCD2345', players: 1, max_players: 4 });
    await t.clock.advance(600);
    assert.equal(t.text('.ul-online-players'), '1 of 4 players in the room (you)', 'the host alone is 1');
    t.backend.write({ role: 'host', state: 'room', code: 'ABCD2345', players: 3, max_players: 4 });
    await t.clock.advance(600);
    assert.equal(t.text('.ul-online-players'), '3 of 4 players in the room');
    assert.equal(t.$('.ul-online-players').classList.contains('is-new'), true);
    t.backend.write({ role: 'host', state: 'in_game', code: 'ABCD2345', players: 4, max_players: 4 });
    await t.clock.advance(600);
    assert.equal(t.text('.ul-online-players'), '4 of 4 players in the room');
    t.backend.write({ role: 'host', state: 'in_game', code: 'ABCD2345', players: 4, max_players: 'four' });
    await t.clock.advance(600);
    assert.equal(t.text('.ul-online-players'), '4 players in the room', 'a max_players that is not a count: the plain count');
    const view = t.window.OnlineView;
    assert.equal(view.readStatus({ v: 1, role: 'host', state: 'room', players: 2, max_players: 4 }).maxPlayers, 4);
    assert.equal(view.readStatus({ v: 1, role: 'host', state: 'room', players: 2 }).maxPlayers, null, 'v1 without it');
    assert.equal(view.readStatus({ v: 1, role: 'host', state: 'room', players: 2, max_players: 0 }).maxPlayers, null);
});

test('online: the XML2 Fix online play needs is the backend\'s one number, named in the update hints', async () => {
    const t = await open();
    const required = t.window.OnlineView.requiredFix('xml1');
    assert.equal(required, REQUIRED_FIX, 'get-online-status\'s requiredFix (online_launch::required_fix)');
    assert.equal(required, '1.8.0', 'Legends Classic 0.3.0\'s XML2 Fix (1.7.x has no online rooms)');
    for (const id of ['broker_rejected', 'version_mismatch']) {
        const help = t.text(`.ul-online-help-error[data-error="${id}"] dd`);
        assert.ok(help.includes(`XML2 Fix ${required} or later`), `${id}: the help names ${required}`);
        assert.match(help, /Rebuild/, `${id}: the update is a Rebuild`);
    }
    await host(t);
    t.backend.write({ role: 'host', state: 'error', error: 'version_mismatch' });
    await t.clock.advance(600);
    assert.ok(t.text('.ul-online-error').includes(`XML2 Fix ${required} or later`), 'and so does the error itself');
    // (Old, unreadable, missing and newer DLLs: online_release.test.js, B1.)
});

test('online: Copy puts XXXX-XXXX on the clipboard', async () => {
    const t = await open();
    await host(t);
    t.backend.write({ role: 'host', state: 'room', code: 'WXYZ6789', players: 1 });
    await t.clock.advance(600);
    assert.deepEqual(t.clipboard, ['WXYZ-6789'], 'copied by itself when it appeared');
    t.$('.ul-online-copy').click();
    await t.clock.advance(0);
    assert.deepEqual(t.clipboard, ['WXYZ-6789', 'WXYZ-6789'], 'and again with Copy');
    assert.equal(t.toasts.length, 1);
    assert.match(String(t.toasts[0][0]), /WXYZ-6789 copied/);
});

test('online: a room that opens late (Play Online entered after a while) is waited for, not timed out', async () => {
    const t = await open();
    await host(t);
    t.backend.write({ role: 'host', state: 'connecting' });
    await t.clock.advance(90000);
    assert.equal(t.phase(), 'Open Play Online in the game – your code appears here.', 'still waiting after 90 s with the game up');
    t.backend.write({ role: 'host', state: 'room', code: 'ABCD2345', players: 1, max_players: 4 });
    await t.clock.advance(600);
    assert.equal(t.text('.ul-online-code'), 'ABCD-2345');
    assert.equal(t.phase(), 'Your room is open.');
});

test('online: every join state renders: looking, found it, in the game', async () => {
    const t = await open();
    await joinWith(t, 'abcd-2345', { running: false });
    assert.equal(t.phase(), 'Looking for the game…', 'the game not up yet');
    assert.match(t.text('.ul-online-join-code'), /ABCD-2345/);
    t.backend.running = true;
    await t.clock.advance(600);
    assert.equal(t.phase(), 'Open Play Online → Join Game in the game.', 'the game up: where to go (contract v1.2)');
    t.backend.write({ role: 'join', state: 'connecting', code: 'ABCD2345' });
    await t.clock.advance(600);
    assert.equal(t.phase(), 'Open Play Online → Join Game in the game.');
    t.backend.write({ role: 'join', state: 'joined', code: 'ABCD2345', players: 2 });
    await t.clock.advance(600);
    assert.equal(t.phase(), 'Found it. In the game: Play Online → Join Game, pick the game.');
    t.backend.write({ role: 'join', state: 'in_game', code: 'ABCD2345', players: 2 });
    await t.clock.advance(600);
    assert.equal(t.phase(), 'Connected – playing together.');
    assert.ok(!t.$('.ul-online-code'), 'a joiner is not shown a code to send');
    t.backend.write({ role: 'join', state: 'ended' });
    await t.clock.advance(600);
    assert.equal(t.phase(), 'The online game has ended.');
});

test('online: every error id renders in plain words, for a host and a joiner', async () => {
    const titles = {
        broker_unreachable: /Can’t reach the online service/,
        broker_rejected: /This game version can’t go online/,
        code_not_found: /Code not found/,
        code_expired: /Code expired/,
        room_full: /The game is full/,
        room_closed: /Can’t join right now/,
        version_mismatch: /Different game version/,
        test_mode_on: /Test mode is on/,
        tls_pin_mismatch: /could not be verified/,
        internal: /Something went wrong/
    };
    for (const role of ['host', 'join']) {
        for (const id of ERRORS) {
            const t = await open();
            if (role === 'host') await host(t);
            else await joinWith(t, 'ABCD2345');
            t.backend.write({ role, state: 'error', error: id, message: `log text for ${id}` });
            await t.clock.advance(600);
            assert.match(t.phase(), titles[id], `${role} ${id}: its title`);
            const box = t.$(`.ul-online-error[data-error="${id}"]`);
            assert.ok(box, `${role} ${id}: its explanation`);
            assert.ok(box.textContent.trim().length > 40, `${role} ${id}: says what to do`);
            assert.match(t.text('.ul-online-error-detail'), new RegExp(`log text for ${id}`), 'the fix\'s message as a detail');
            assert.equal(t.text('.ul-online-again'), 'Try again');
            assert.equal(!!t.$('.ul-online-session .ul-online-testmode-off'), id === 'test_mode_on', 'Turn test mode off for test_mode_on only');
            assert.ok(!t.$('.ul-online-code'), 'no code with an error');
        }
    }
    const t = await open();
    await host(t);
    t.backend.write({ role: 'host', state: 'error', error: 'something_new' });
    await t.clock.advance(600);
    assert.match(t.phase(), /The game reported a problem \(something_new\)/, 'an id the launcher does not know yet');
    t.backend.write({ role: 'host', state: 'error', error: null });
    const u = await open();
    await host(u);
    u.backend.write({ role: 'host', state: 'error' });
    await u.clock.advance(600);
    assert.match(u.phase(), /Something went wrong/, 'an error without an id is internal');
});

test('online: Try again goes back to Host / Join, with the joiner\'s code still typed', async () => {
    const t = await open();
    await joinWith(t, 'abcd 2345');
    t.backend.write({ role: 'join', state: 'error', error: 'code_not_found' });
    t.backend.running = false;
    await t.clock.advance(600);
    t.$('.ul-online-again').focus();
    t.$('.ul-online-again').click();
    await t.clock.advance(0);
    assert.equal(t.visible('.ul-online-join-button'), true);
    assert.equal(t.visible('.ul-online-session'), false);
    assert.equal(t.input().value, 'ABCD-2345', 'the code is still there, as the host sees it');
    assert.ok(t.document.activeElement === t.input(), 'the focus goes back to the code field');
    t.$('.ul-online-join-button').click();
    await t.clock.advance(1500);
    assert.deepEqual(t.backend.starts.map(p => p.code), ['ABCD2345', 'ABCD2345'], 'a second try with the same code');
});

test('online: Join takes lower case, spaces and dashes; writes JoinCode and removes Host', async () => {
    const t = await open({ online: { Host: 'broker' } });
    await joinWith(t, '  abcd – efgh ');
    assert.deepEqual(t.backend.launches, [{ game: 'xml1', online: { mode: 'join', code: 'ABCDEFGH' } }], 'normalised before it is sent');
    assert.equal(t.backend.online.JoinCode, 'ABCDEFGH');
    assert.equal(t.backend.online.Host, undefined, 'Host removed');
    assert.equal(t.backend.online.Broker, 'broker.example:7777');
});

test('online: Enter in the code field joins', async () => {
    const t = await open();
    t.type('wxyz-6789');
    t.key('Enter');
    await t.clock.advance(1500);
    assert.deepEqual(t.backend.starts, [{ mode: 'join', code: 'WXYZ6789' }]);
});

test('online: a malformed code shows an inline error and starts nothing', async () => {
    const t = await open();
    const error = () => (t.visible('.ul-online-code-error') ? t.text('.ul-online-code-error') : null);

    t.type('abcd');
    assert.equal(error(), null, 'too short: not while typing');
    t.$('.ul-online-join-button').click();
    await t.clock.advance(0);
    assert.match(error(), /has 8 letters and digits; this one has 4/, 'too short: once Join is pressed');
    assert.equal(t.input().getAttribute('aria-invalid'), 'true');
    assert.ok(t.document.activeElement === t.input(), 'the focus stays on the field');

    t.type('');
    assert.match(error(), /Type the code your host sent you first/);
    t.type('ABCD-234O');
    assert.match(error(), /never 0, O, 1, I or L: “O”/, 'O is never in a code: at once');
    t.type('abcd2341');
    assert.match(error(), /“1”/);
    t.type('abcd_234');
    assert.match(error(), /“_”/);
    t.type('ABCD23456');
    assert.match(error(), /this one has 9/, 'too long: at once');
    t.$('.ul-online-join-button').click();
    await t.clock.advance(0);
    t.type('abcd-2345');
    assert.equal(error(), null, 'fixed: the error goes');
    assert.equal(t.input().getAttribute('aria-invalid'), 'false');
    assert.deepEqual(t.backend.launches, [], 'nothing was started or written for a bad code');
});

test('online: the code rules (normalise, check, display, status)', async () => {
    const t = await open();
    const view = t.window.OnlineView;
    assert.equal(view.normaliseCode(' ab-cd 23\t45 '), 'ABCD2345');
    assert.equal(view.normaliseCode('abcd—2345'), 'ABCD2345', 'a dash a chat app made');
    assert.deepEqual(JSON.parse(JSON.stringify(view.checkCode('abcd-2345'))), { code: 'ABCD2345' });
    for (const c of ALPHABET) assert.equal(view.checkCode(c.repeat(8)).code, c.repeat(8));
    for (const c of '0O1IL') assert.equal(view.checkCode(`ABCD234${c}`).error, 'chars', `${c} is not in the alphabet`);
    assert.equal(view.checkCode('abcd234l').error, 'chars', 'nor l in lower case');
    assert.equal(view.checkCode('').error, 'empty');
    assert.equal(view.checkCode('ABC').error, 'short');
    assert.equal(view.checkCode('ABCD23456').error, 'long');
    assert.equal(view.displayCode('ABCD2345'), 'ABCD-2345');
    assert.equal(view.readStatus({ v: 1, role: 'host', state: 'room', code: 'ABCD2345', players: 2 }).players, 2);
    assert.equal(view.readStatus({ v: 1, role: 'host', state: 'sleeping' }), null, 'a state not in the contract');
    assert.equal(view.readStatus({ role: 'host', state: 'room' }), null, 'no version');
    assert.equal(view.readStatus({ v: 1, role: 'spectator', state: 'room' }), null);
    assert.equal(view.readStatus([]), null);
    assert.equal(view.readStatus({ v: 1, role: 'host', state: 'room', code: 'nope' }).code, null, 'a code that is not one is not shown');
});

test('online: Play (a normal start) sends no online flag: launch-game removes Host and JoinCode', async () => {
    const t = await open({ online: { Host: 'broker', JoinCode: 'ABCD2345' }, status: { v: 1, role: 'host', state: 'room', code: 'ABCD2345' } });
    const started = t.window.GameUtils.launchGame('xml1', 'xml1');
    await t.clock.advance(1500);
    const answer = await started;
    assert.equal(answer.accepted, true, 'launch-game answers { accepted, launch }');
    assert.deepEqual(t.backend.launches, [{ game: 'xml1' }], 'no `online`: a normal start');
    assert.equal(t.backend.online.Host, undefined);
    assert.equal(t.backend.online.JoinCode, undefined);
    assert.equal(t.backend.online.Broker, 'broker.example:7777', 'Broker / BrokerPin stay');
    assert.equal(t.backend.status, null, 'and an old status goes');
});

test('online: off with a reason while not built, the folder is held, test mode is on or the game runs', async () => {
    const cases = [
        [{ installed: false }, {}, /Set up X-Men Legends first/, 'notSetUp'],
        [{ playable: false }, {}, /Build the game first/, 'notBuilt'],
        [{ fixInstalled: false }, {}, /Install the XML2 Fix first/, 'noFix'],
        [{ playable: false }, { building: true }, /A build is running/, 'building'],
        [{}, { starting: Promise.resolve() }, /A build is running/, 'building'],
        [{}, { working: true }, /XML2 Fix is being installed or updated/, 'updating'],
        [{}, { patchQueued() { return true; } }, /XML2 Fix is being installed or updated/, 'updating'],
        [{ testMode: true }, {}, /Test mode is on/, 'testMode'],
        [{ running: true }, {}, /X-Men Legends is running. Close it/, 'running']
    ];
    for (const [options, port, reason, id] of cases) {
        const t = await open(options, port);
        assert.match(t.blockedText() || '', reason, `${id}: the reason`);
        assert.equal(t.document.getElementById('xml1-online-panel').dataset.blocked, id);
        t.controls().forEach(control => assert.equal(control.disabled, true, `${id}: Host, Join and the field are off`));
        t.$('.ul-online-host-button').click();
        await t.clock.advance(1500);
        assert.deepEqual(t.backend.launches, [], `${id}: nothing started or written`);
        assert.equal(!t.$('.ul-online-testmode-off').hidden, id === 'testMode', `${id}: Turn test mode off only for test mode`);
    }
});

test('online: Turn test mode off from the Online section, and back on when it is off', async () => {
    let on = true;
    const turnedOff = [];
    const testModeView = {
        isOn: () => on,
        turnOff: async gameId => {
            turnedOff.push(gameId);
            on = false;
        }
    };
    const t = await open({}, {}, {});
    t.window.TestModeView = testModeView;
    t.window.dispatchEvent(new t.window.CustomEvent('ul-testmode-changed'));
    assert.match(t.blockedText(), /Test mode is on/, 'the Test mode section says on, before the file does');
    const off = t.$('.ul-online-testmode-off');
    assert.equal(off.tagName, 'BUTTON');
    off.click();
    await t.clock.advance(0);
    assert.deepEqual(turnedOff, ['xml1']);
    assert.equal(t.blockedText(), null, 'test mode off: Host and Join are on');
    t.controls().forEach(control => assert.equal(control.disabled, false));
});

test('online: a start the backend refuses says why (test mode on in the file, a build that just started)', async () => {
    let t = await open({ online: { JoinCode: 'ZZZZ9999' } });
    t.backend.refuse = 'test_mode_on';
    t.$('.ul-online-host-button').click();
    await t.clock.advance(1500);
    assert.equal(t.backend.outcomes[1], undefined, 'refused at acceptance: nothing started');
    assert.deepEqual(t.backend.armed(), [], 'and no key left armed (the stale JoinCode removed too)');
    assert.match(t.phase(), /Test mode is on: turn it off/);
    assert.ok(t.$('.ul-online-session .ul-online-testmode-off'), 'with Turn test mode off');

    t = await open();
    t.backend.refuse = 'busy';
    t.type('ABCD2345');
    t.$('.ul-online-join-button').click();
    await t.clock.advance(1500);
    assert.match(t.phase(), /A build is running in the game folder/);
    t.$('.ul-online-again').click();
    await t.clock.advance(0);
    assert.equal(t.visible('.ul-online-idle'), true, 'Try again: back to Host / Join');
});

test('online: the game closing without `ended`, or never starting, ends the session', async () => {
    let t = await open();
    await host(t);
    t.backend.write({ role: 'host', state: 'room', code: 'ABCD2345', players: 1 });
    await t.clock.advance(600);
    t.backend.running = false;
    await t.clock.advance(600);
    assert.equal(t.phase(), 'The game was closed.');

    t = await open();
    await host(t, { running: false });
    assert.equal(t.phase(), 'Connecting…', 'a slow start: still connecting');
    await t.clock.advance(15000);
    assert.equal(t.phase(), 'Connecting…');
    await t.clock.advance(6000);
    assert.match(t.phase(), /The game did not start/);
});

test('online: a room already open when the page loads (the launcher restarted) is shown', async () => {
    const t = await open({ running: true, status: { v: 1, role: 'host', state: 'room', code: 'MNPQ7777', players: 2 } });
    assert.equal(t.visible('.ul-online-session'), true);
    assert.equal(t.text('.ul-online-code'), 'MNPQ-7777');
    assert.equal(t.text('.ul-online-players'), '2 players in the room');
    const u = await open({ running: true, status: { v: 1, role: 'host', state: 'ended', code: 'MNPQ7777' } });
    assert.equal(u.visible('.ul-online-session'), false, 'an ended one is not');
    assert.match(u.blockedText(), /is running/);
});

test('online: the keyboard (or a controller mapped to it) reaches every control, and the focus follows', async () => {
    const t = await open();
    for (const control of t.controls()) {
        assert.equal(control.hasAttribute('tabindex'), false, 'in the Tab order where it stands');
    }
    for (const summary of t.document.querySelectorAll('#xml1-online-panel .ul-online-fold summary')) {
        assert.equal(summary.getAttribute('tabindex'), '0', 'the help\'s fold summaries too, for core/focus-nav.js');
    }
    for (const button of [t.$('.ul-online-host-button'), t.$('.ul-online-join-button')]) {
        assert.equal(button.tagName, 'BUTTON');
        assert.equal(button.getAttribute('type'), 'button');
    }
    t.$('.ul-online-host-button').focus();
    t.$('.ul-online-host-button').click();
    assert.ok(t.document.activeElement === t.$('.ul-online-session'), 'Host went away: the focus is on the session, not lost');
    await t.clock.advance(1500);
    t.backend.running = true;
    t.backend.write({ role: 'host', state: 'room', code: 'ABCD2345', players: 1 });
    await t.clock.advance(600);
    assert.ok(t.document.activeElement === t.$('.ul-online-copy'), 'the code is up: the focus is on Copy');
    t.backend.write({ role: 'host', state: 'room', code: 'ABCD2345', players: 2 });
    await t.clock.advance(600);
    assert.ok(t.document.activeElement === t.$('.ul-online-copy'), 'a player joining keeps it on Copy');
    t.backend.write({ role: 'host', state: 'error', error: 'broker_unreachable' });
    await t.clock.advance(600);
    assert.ok(t.document.activeElement === t.$('.ul-online-again'), 'an error: on Try again');
    t.backend.running = false;
    t.$('.ul-online-again').click();
    await t.clock.advance(0);
    assert.ok(t.document.activeElement === t.$('.ul-online-host-button'), 'and back on Host');
});

test('online: no focus is taken from elsewhere on the page', async () => {
    const t = await open();
    t.document.getElementById('xml1-play-button').focus();
    await host(t);
    t.backend.write({ role: 'host', state: 'room', code: 'ABCD2345', players: 1 });
    await t.clock.advance(600);
    assert.equal(t.document.activeElement.id, 'xml1-play-button');
});

test('online: every string is in en, fr and es', async () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../launcher-ui/assets/js/core/i18n.js'), 'utf8');
    const tree = vm.runInContext(`(${/const translations = (\{[\s\S]*?\n    \});/.exec(source)[1]})`, vm.createContext({}));
    const keys = [];
    const walk = (prefix, value) => {
        if (typeof value === 'string') keys.push(prefix);
        else Object.keys(value).forEach(name => walk(`${prefix}.${name}`, value[name]));
    };
    walk('online', tree.en.online);
    assert.ok(keys.length > 60, `${keys.length} strings`);
    const lookup = (language, key) => key.split('.').reduce((value, part) => (value && value[part] !== undefined ? value[part] : undefined), tree[language]);
    for (const language of ['fr', 'es']) {
        // (The placeholder is a sample code: the same in every language.)
        const missing = keys.filter(key => key !== 'online.join.placeholder' && typeof lookup(language, key) !== 'string');
        assert.deepEqual(missing, [], `${language}: every online string`);
    }
    for (const id of ERRORS) assert.ok(keys.includes(`online.errors.${id}.title`) && keys.includes(`online.errors.${id}.body`), id);
});

// ---- the stylesheet: a hidden part of the section is display:none (main.css's display rules would
// otherwise win over the hidden attribute, as they did on the first Windows run) ----

const CSS = path.resolve(__dirname, '../../launcher-ui/assets/css/main.css');

// Every rule of main.css that sets display, with its selectors and source order (rules inside @media
// blocks included, as plain rules: what matters here is whether one could win).
function displayRules() {
    const css = fs.readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [];
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    let order = 0;
    while ((match = rule.exec(css))) {
        const display = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(match[2]);
        order++;
        if (!display) continue;
        const value = display[1].trim();
        for (const selector of match[1].split(',').map(text => text.trim()).filter(Boolean)) {
            rules.push({ selector, value: value.replace(/\s*!important$/, ''), important: /!important$/.test(value), order });
        }
    }
    return rules;
}

function specificity(selector) {
    const ids = (selector.match(/#[\w-]+/g) || []).length;
    const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]/g) || []).length;
    const tags = (selector.replace(/\[[^\]]*\]|[#.][\w-]+/g, ' ').match(/(^|[\s>])[a-zA-Z][\w-]*/g) || []).length;
    return [ids, classes, tags];
}

function later(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

// The display an element gets from main.css (null: none of its rules applies, so the browser's own
// [hidden] { display: none } does). Selectors the test DOM can't match (pseudo-classes, sibling
// combinators) are left out.
function computedDisplay(element, rules) {
    let winner = null;
    for (const r of rules) {
        if (/[:+~]/.test(r.selector)) continue;
        let matches = false;
        try {
            matches = element.matches(r.selector);
        } catch (_) {
            continue;
        }
        if (!matches) continue;
        // The cascade: !important, then specificity, then the later rule.
        const key = [r.important ? 1 : 0, ...specificity(r.selector), r.order];
        if (!winner || later(key, winner.key)) winner = { key, rule: r };
    }
    return winner ? winner.rule : null;
}

test('online: every hidden part of the section computes to display:none (main.css)', async () => {
    const rules = displayRules();
    assert.ok(rules.length > 100, `${rules.length} display rules read`);
    const checkHidden = (t, when) => {
        const hidden = t.document.getElementById('xml1-online-panel').querySelectorAll('[hidden]');
        assert.ok(hidden.length > 0, `${when}: something is hidden`);
        for (const element of hidden) {
            const winner = computedDisplay(element, rules);
            const name = `${element.tagName.toLowerCase()}.${element.className.split(/\s+/).join('.')}`;
            assert.ok(!winner || winner.value === 'none', `${when}: ${name} is hidden but "${winner && winner.selector}" makes it display:${winner && winner.value}`);
        }
    };

    let t = await open();
    checkHidden(t, 'idle');
    t = await open({ testMode: true }, { status: { fix: { installed: true, version: '1.0.0' } } });
    checkHidden(t, 'blocked by test mode');
    t = await open();
    t.type('ABCD');
    t.$('.ul-online-join-button').click();
    await t.clock.advance(0);
    checkHidden(t, 'a code error');
    t = await open();
    await host(t);
    t.backend.write({ role: 'host', state: 'room', code: 'ABCD2345', players: 1, max_players: 4 });
    await t.clock.advance(600);
    checkHidden(t, 'hosting');
    t.backend.write({ role: 'host', state: 'error', error: 'test_mode_on' });
    await t.clock.advance(600);
    checkHidden(t, 'an error');
    // v1.3: the public toggle and its name error, Browse games empty, with rows, with an error.
    t = await open({ rooms: [] });
    await t.clock.advance(1000);
    t.$('.ul-online-public-toggle .toggle-btn[data-value="1"]').click();
    checkHidden(t, 'public on, an empty list');
    t = await open({ rooms: [{ code: 'ABCD2345', name: 'A', players: 1, max_players: 4, version_token: 'LC31' }] });
    await t.clock.advance(1000);
    checkHidden(t, 'a list');
    t = await open({ rooms: { ok: false, error: 'busy', rooms: [] } });
    await t.clock.advance(1000);
    checkHidden(t, 'a list error');

    // And the rule itself: every ul-online-* class main.css gives a display has its [hidden] rule.
    const shown = new Set(rules.filter(r => r.value !== 'none').flatMap(r => (r.selector.match(/\.ul-online-[\w-]+/g) || []).slice(-1)));
    const covered = new Set(rules.filter(r => r.value === 'none' && /\[hidden\]$/.test(r.selector)).flatMap(r => (r.selector.match(/\.ul-online-[\w-]+(?=\[hidden\]$)/g) || [])));
    const missing = [...shown].filter(name => !covered.has(name) && !/^\.ul-online-(spinner|primary|code|code-input)$/.test(name));
    assert.deepEqual(missing, [], 'ul-online-* classes with a display and no [hidden] rule');
});
