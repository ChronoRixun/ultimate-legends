'use strict';
// Launcher 0.4.0's release fixes to the Online section (Legends Classic 0.3.0 + XML2 Fix 1.8.0), one block per
// review item, on online_fixture.js's fake backend (which follows fix/online_launch.cpp's order; the C++ order
// itself is src/tests/online_launch_tests.cpp's):
//
//   B1  XML2 Fix 1.8.0 enforced: old / unreadable / missing DLLs block Host and Join (Verify Files), the DLL is
//       checked again after the update, Play stays.
//   S1  `ended` carrying an error shows that error.
//   S2  a status file that can't be deleted refuses the start instead of being taken for a room.
//   S3  a refused, cancelled or failed start leaves no [Online] key armed and says why.
//   S4  offline mode fetches nothing and asks before Host / Join / Refresh.
//   S5  Close on launch never closes the launcher for an online start; the code is copied once.
//   S7  joining a campaign under way: Joined Game, the next level change.
//   S8  contract v1.5's room_closed, distinct from room_full.
//   S9  the public games' internet-address note.
// (S6, the controller navigation of #11 together with this section, is focus_nav_online.test.js's on the
// integration branch.)

const assert = require('node:assert/strict');
const { test } = require('./harness');

const { ERRORS, LAUNCH_KEYS, open, host, joinWith } = require('./online_fixture');

const ROOM_CLOSED_TEXT = "That game can't take new players right now. Try again in a moment.";

function room(fields = {}) {
    return Object.assign({ code: 'ABCD2345', name: 'Saturday', host_display_name: 'Logan', game_mode: 'campaign', zone: 'nyc/alison/nyc1_1_3',
        zone_name: 'Alison Rescue', version_token: 'LC31', players: 1, max_players: 4, in_progress: false, joinable: true, password_protected: false }, fields);
}

// Play (a normal start), with the fake clock driving its progress poll.
async function play(t) {
    const started = t.window.GameUtils.launchGame('xml1', 'xml1');
    await t.clock.advance(1500);
    return started;
}

const builderKeys = backend => Object.keys(backend.online).filter(key => !LAUNCH_KEYS.includes(key)).sort();

// ---- B1: XML2 Fix 1.8.0 ----

test('B1: an XML2 Fix older than 1.8.0, unreadable or missing blocks Host and Join with Verify Files; current and newer don\'t', async () => {
    const cases = [
        [{ fixVersion: '1.7.1' }, /needs XML2 Fix 1\.8\.0 or later; this folder has 1\.7\.1\. Use Verify Files/, 'fixOld'],
        [{ fixVersion: '1.7.0' }, /this folder has 1\.7\.0/, 'fixOld'],
        [{ fixVersion: null }, /version of the XML2 Fix in this folder can’t be read.*1\.8\.0 or later\. Use Verify Files/, 'fixUnknown'],
        [{ fixInstalled: false }, /Install the XML2 Fix first \(Verify Files/, 'noFix']
    ];
    for (const [options, reason, id] of cases) {
        const t = await open(Object.assign({ online: { JoinCode: 'ZZZZ9999' } }, options));
        assert.match(t.blockedText() || '', reason, `${id}: the reason`);
        assert.equal(t.document.getElementById('xml1-online-panel').dataset.blocked, id);
        t.controls().forEach(control => assert.equal(control.disabled, true, `${id}: Host, Join and the field are off`));
        t.$('.ul-online-host-button').click();
        t.type('ABCD2345');
        t.key('Enter');
        await t.clock.advance(1500);
        assert.deepEqual(t.backend.launches, [], `${id}: nothing started`);
        // Play is not the Online section's: it still starts, and removes the stale key.
        const answer = await play(t);
        assert.equal(answer.accepted, true, `${id}: Play still works`);
        assert.deepEqual(t.backend.armed(), [], `${id}: and no key is armed`);
    }
    for (const version of ['1.8.0', '1.8.0.2', '1.8.1', '1.10.0', '2.0.0']) {
        const t = await open({ fixVersion: version });
        assert.equal(t.blockedText(), null, `${version}: online play`);
        t.controls().forEach(control => assert.equal(control.disabled, false));
    }
});

test('B1: the DLL is checked again after the update: an old one left there refuses the start, no key armed', async () => {
    // The page saw 1.8.0; the start's update (or a skipped one) leaves 1.7.1 in the folder.
    for (const [after, text] of [['1.7.1', /too old for online play \(it needs 1\.8\.0 or later\)\. Use Verify Files/],
        [null, /can’t be read \(online play needs 1\.8\.0 or later\)/]]) {
        const t = await open({ online: { JoinCode: 'ZZZZ9999' } });
        t.backend.fixAfterUpdate = after;
        await host(t, { running: false });
        assert.match(t.phase(), text);
        assert.deepEqual(t.backend.armed(), [], 'Host never written, the stale JoinCode removed');
        assert.deepEqual(builderKeys(t.backend), ['Broker', 'BrokerPin', 'GameVersion'], 'the builder\'s keys untouched');
        assert.equal(t.text('.ul-online-again'), 'Try again');
        assert.ok(t.backend.calls.includes('get-launch-outcome'), 'the page asked what became of the start');
    }
    // An update that brings 1.7.1 up to 1.8.0 (the page blocked it: Verify Files did it here) starts.
    const t = await open();
    t.backend.fixAfterUpdate = '1.8.0';
    await joinWith(t, 'ABCD2345');
    assert.equal(t.backend.online.JoinCode, 'ABCD2345');
    assert.equal(t.phase(), 'Open Play Online → Join Game in the game.');
});

test('B1: a failed update stops an online start (no fall-through to the old DLL); a cancelled one goes back quietly', async () => {
    let t = await open();
    t.backend.workerFails = { reason: 'update_failed', error: 'hash mismatch for dinput.dll' };
    await host(t, { running: false });
    assert.match(t.phase(), /The XML2 Fix update failed, so the game was not started online: hash mismatch for dinput\.dll/);
    assert.deepEqual(t.backend.armed(), []);

    t = await open();
    t.type('ABCD2345');
    t.backend.workerFails = { reason: 'update_cancelled', error: 'The patch update was cancelled.' };
    t.$('.ul-online-join-button').click();
    await t.clock.advance(2100);
    assert.equal(t.visible('.ul-online-idle'), true, 'the player cancelled it: back to Host / Join');
    assert.equal(t.input().value, 'ABCD-2345', 'the code still typed');
    assert.deepEqual(t.backend.armed(), []);
});

// ---- S1: ended keeps the error ----

test('S1: `ended` carrying an error shows that error (every v1.5 id and an unknown one), with no `error` read before', async () => {
    const titles = {
        broker_unreachable: /Can’t reach the online service/, broker_rejected: /This game version can’t go online/, code_not_found: /Code not found/,
        code_expired: /Code expired/, room_full: /The game is full/, room_closed: /Can’t join right now/, version_mismatch: /Different game version/,
        test_mode_on: /Test mode is on/, tls_pin_mismatch: /could not be verified/, internal: /Something went wrong/
    };
    assert.deepEqual(Object.keys(titles).sort(), [...ERRORS].sort(), 'all ten ids');
    for (const role of ['host', 'join']) {
        for (const id of [...ERRORS, 'something_new']) {
            const t = await open();
            if (role === 'host') await host(t);
            else await joinWith(t, 'ABCD2345');
            t.backend.write({ role, state: 'room', code: 'ABCD2345', players: 1 });
            await t.clock.advance(600);
            // The game hit the error and closed before the next read: the first the page sees is `ended`.
            t.backend.write({ role, state: 'ended', code: 'ABCD2345', error: id, message: `log for ${id}` });
            t.backend.running = false;
            await t.clock.advance(600);
            if (id === 'something_new') {
                assert.match(t.phase(), /The game reported a problem \(something_new\)/, `${role}: an id the launcher doesn't know yet`);
                assert.match(t.text('.ul-online-error'), /report it with the game’s xml2-fix\.log/);
            } else {
                assert.match(t.phase(), titles[id], `${role} ${id}: its title, not "The online game has ended."`);
                assert.ok(t.$(`.ul-online-error[data-error="${id}"]`), `${role} ${id}: the known explanation`);
            }
            assert.match(t.text('.ul-online-error-detail'), new RegExp(`log for ${id}`), 'with the details');
            assert.equal(t.text('.ul-online-again'), 'Try again', 'and Try again');
            assert.ok(!t.$('.ul-online-copy'), 'no Copy with an error');
        }
    }
    const t = await open();
    await host(t);
    t.backend.write({ role: 'host', state: 'ended', code: 'ABCD2345', error: null });
    await t.clock.advance(600);
    assert.equal(t.phase(), 'The online game has ended.', 'an error-free end is unchanged');
    assert.equal(t.text('.ul-online-again'), 'OK');
});

// ---- S2: a status file that can't be deleted ----

test('S2: Play with a status file held against deletion is refused, and the old room is never taken up', async () => {
    const stale = { v: 1, role: 'host', state: 'room', code: 'PQRS2345', players: 2 };
    const t = await open({ status: stale });
    t.backend.statusLocked = true;
    const answer = await play(t);
    assert.equal(answer.accepted, false);
    assert.equal(answer.reason, 'status_locked', 'the refusal is propagated, with its reason');
    assert.match(answer.error, /could not be deleted/);
    t.backend.running = true; // started some other way meanwhile
    await t.clock.advance(2500);
    assert.equal(t.visible('.ul-online-session'), true, 'a game running with a live status is taken up (a launcher restart)…');
    // …but the launcher itself never started a game over the old file.
    assert.deepEqual(t.backend.outcomes, {}, 'nothing was started by the launcher');

    const u = await open({ status: stale });
    u.backend.statusLocked = true;
    await host(u, { running: false });
    assert.match(u.phase(), /A file from an earlier online game \(online-status\.json\) could not be deleted, so the game was not started/);
    assert.ok(!u.$('.ul-online-code'), 'the old code is not shown');
    assert.deepEqual(u.backend.armed(), []);

    // No file at all: Play and Host start.
    const v = await open();
    assert.equal((await play(v)).accepted, true);
    const w = await open();
    await host(w);
    assert.equal(w.backend.online.Host, 'broker');
});

// ---- S3: nothing left armed ----

test('S3: every refusal or failure leaves no launch key armed, and the page says why', async () => {
    const atAcceptance = [
        ['test_mode_on', /Test mode is on: turn it off/],
        ['busy', /A build is running in the game folder/],
        ['not_built', /The game has not finished building/]
    ];
    for (const [reason, text] of atAcceptance) {
        const t = await open({ online: { Host: 'broker', Public: '1', RoomName: 'old' } });
        t.backend.refuse = reason;
        await host(t, { running: false });
        assert.match(t.phase(), text, `${reason}: said`);
        assert.deepEqual(t.backend.armed(), [], `${reason}: no key armed`);
        assert.deepEqual(builderKeys(t.backend), ['Broker', 'BrokerPin', 'GameVersion']);
    }
    const inWorker = [
        [{ reason: 'launch_failed', error: 'Failed to launch XMen2.exe. Error code: 5' }, /The game could not be started: Failed to launch XMen2\.exe\. Error code: 5/],
        [{ reason: 'launch_cancelled', error: 'X-Men Legends requires administrator permission to launch.' }, /needs administrator permission, and the prompt was declined/],
        [{ reason: 'write_failed', error: 'xml2-fix.ini is read-only.' }, /could not be saved: xml2-fix\.ini is read-only/]
    ];
    for (const [fail, text] of inWorker) {
        const t = await open({ online: { JoinCode: 'ZZZZ9999' } });
        t.backend.workerFails = fail;
        await joinWith(t, 'ABCD2345', { running: false });
        assert.match(t.phase(), text, `${fail.reason}: said`);
        assert.deepEqual(t.backend.armed(), [], `${fail.reason}: no key armed`);
        assert.equal(t.backend.barrier, false, `${fail.reason}: the barrier released`);
        t.$('.ul-online-again').click();
        await t.clock.advance(0);
        assert.equal(t.visible('.ul-online-idle'), true, 'Try again');
    }
});

test('S3: a launch already running is not disturbed: its keys stay, the page says it is busy', async () => {
    const t = await open({ online: { Host: 'broker', Public: '0' } });
    t.backend.barrier = true; // another start holds the barrier (and armed Host a moment ago)
    t.type('ABCD2345');
    t.$('.ul-online-join-button').click();
    await t.clock.advance(1500);
    assert.match(t.phase(), /A game is already starting or running from the launcher/);
    assert.equal(t.backend.online.Host, 'broker', 'the other start\'s keys are not removed');
    assert.equal(t.backend.online.JoinCode, undefined, 'and none written');
});

test('S3: keys that could not be removed after a failed start are said, with what to do', async () => {
    const t = await open();
    t.backend.workerFails = { reason: 'launch_failed', error: 'Error code: 2', cleanupError: 'xml2-fix.ini is read-only.' };
    await host(t, { running: false });
    assert.match(t.text('.ul-online-cleanup'), /could not be removed \(xml2-fix\.ini is read-only\.\)\. Press Play here once before you start the game from Steam/);
});

test('S3: the start the page follows is the one the backend accepted (structured, not "handed over")', async () => {
    const t = await open();
    await host(t);
    const launch = t.backend.launches[0];
    assert.deepEqual(launch, { game: 'xml1', online: { mode: 'host', public: false, roomName: '' } });
    const outcomes = t.backend.calls.filter(c => c === 'get-launch-outcome').length;
    assert.ok(outcomes >= 1, 'asked');
    await t.clock.advance(2000);
    assert.equal(t.backend.calls.filter(c => c === 'get-launch-outcome').length, outcomes, 'and no more once it started');
});

// ---- S4: offline mode ----

test('S4: offline, nothing is fetched or written; Host, Join and Refresh ask to restart online; Play works', async () => {
    const t = await open({ offline: true, rooms: [room()] });
    const choices = [];
    t.window.showMessageBox = async (...args) => {
        t.messages.push(args);
        return choices.shift();
    };
    assert.match(t.text('.ul-online-offline'), /Offline mode: online play and Browse games need the internet/);
    assert.equal(t.visible('.ul-online-offline'), true);
    assert.match(t.text('.ul-online-browse-status'), /Offline mode: the public game list is not loaded/, 'not "no public games"');
    assert.doesNotMatch(t.text('.ul-online-browse-status'), /No public games/);
    await t.clock.advance(35000);
    assert.equal(t.backend.calls.filter(c => c === 'get-public-rooms').length, 0, 'no automatic refresh, not even a backend request');
    assert.equal(t.rowsShown = t.document.querySelectorAll('#xml1-online-panel .ul-online-room').length, 0);
    t.controls().forEach(control => assert.equal(control.disabled, false, 'Host and Join stay on (they ask first)'));

    choices.push(1); // Cancel
    t.$('.ul-online-browse-refresh').click();
    await t.clock.advance(0);
    assert.equal(t.messages.length, 1, 'Refresh: the relaunch-or-cancel question');
    assert.equal(t.backend.calls.filter(c => c === 'get-public-rooms').length, 0, 'cancelled: no fetch');

    choices.push(1);
    t.$('.ul-online-host-button').click();
    await t.clock.advance(1500);
    choices.push(1);
    t.type('ABCD2345');
    t.key('Enter');
    await t.clock.advance(1500);
    assert.equal(t.messages.length, 3, 'Host and Join asked too');
    assert.deepEqual(t.backend.launches, [], 'nothing started, nothing written');
    assert.equal(t.visible('.ul-online-idle'), true);

    choices.push(0); // Relaunch online
    t.$('.ul-online-host-button').click();
    await t.clock.advance(0);
    assert.ok(t.backend.calls.includes('relaunch-online'), 'the launcher restarts online when asked');
    assert.deepEqual(t.backend.launches, []);

    const answer = await play(t);
    assert.equal(answer.accepted, true, 'Play is not online play: it starts offline');
});

// ---- S5: Close on launch ----

test('S5: Close on launch closes the launcher after Play, never after Host / Join; the code is copied once', async () => {
    const normal = await open({ closeOnLaunch: true });
    await play(normal);
    assert.equal(normal.backend.launcherClosed, true, 'a normal start honours the setting');

    const t = await open({ closeOnLaunch: true });
    await host(t, { running: false });
    assert.equal(t.backend.launcherClosed, false, 'an online start keeps the launcher (the setting itself unchanged)');
    t.backend.running = true;
    await t.clock.advance(600);
    t.backend.write({ role: 'host', state: 'connecting' });
    await t.clock.advance(1200);
    t.backend.write({ role: 'host', state: 'room', code: 'WXYZ6789', players: 1, max_players: 4 });
    const polls = t.backend.calls.filter(c => c === 'get-online-status').length;
    await t.clock.advance(3000);
    assert.ok(t.backend.calls.filter(c => c === 'get-online-status').length >= polls + 5, 'still polling about every 500 ms');
    assert.deepEqual(t.clipboard, ['WXYZ-6789'], 'copied by itself exactly once');
    assert.equal(t.text('.ul-online-copied'), 'Copied to the clipboard');
    t.backend.write({ role: 'host', state: 'room', code: 'WXYZ6789', players: 2, max_players: 4 });
    await t.clock.advance(1200);
    assert.deepEqual(t.clipboard, ['WXYZ-6789'], 'not again when a player joins');
});

// ---- S7: joining late ----

test('S7: How online works explains Joined Game and the next level change, in en, fr and es, menu names in English', async () => {
    const expected = {
        en: /Joining a campaign already in progress\? Wait on Joined Game\. You enter at the next level change; the party needs enough heroes for everyone\./,
        fr: /campagne deja en cours \? Attendez sur Joined Game\. Vous entrez au prochain changement de niveau/,
        es: /campana ya en curso\? Espera en Joined Game\. Entras en el proximo cambio de nivel/
    };
    for (const language of ['en', 'fr', 'es']) {
        const t = await open({ language });
        const note = t.$('.ul-online-help-notes [data-note="lateJoin"]');
        assert.match(note.textContent, expected[language], `${language}: the late join`);
        assert.match(t.text('.ul-online-help-notes [data-note="soloSegment"]'), language === 'en' ? /solo story segment.*shared camera/ : /./);
        assert.match(t.text('.ul-online-help-steps'), /Play Online → Join Game/, `${language}: the game's menus stay in English`);
        assert.equal(t.$('.ul-online-help-error[data-error="room_full"] dd').textContent.includes('right now'), false, 'room_full is only a full room');
    }
});

test('S7: joining a public game In progress says to wait on Joined Game; another row doesn\'t', async () => {
    for (const [inProgress, shown] of [[true, true], [false, false]]) {
        const t = await open({ rooms: [room({ code: 'WXYZ6789', in_progress: inProgress })] });
        await t.clock.advance(1000);
        t.document.querySelector('#xml1-online-panel .ul-online-room[data-code="WXYZ6789"] .ul-online-room-join').click();
        await t.clock.advance(1500);
        t.backend.running = true;
        t.backend.write({ role: 'join', state: 'joined', code: 'WXYZ6789', players: 2 });
        await t.clock.advance(600);
        assert.equal(!!t.$('.ul-online-late-join'), shown, `in_progress ${inProgress}`);
        if (shown) assert.match(t.text('.ul-online-late-join'), /Wait on Joined Game\. You enter at the next level change/);
        t.backend.write({ role: 'join', state: 'in_game', code: 'WXYZ6789', players: 2 });
        await t.clock.advance(600);
        assert.ok(!t.$('.ul-online-late-join'), 'gone once in the game');
    }
    // A code typed by hand: nothing known about the game, no note.
    const u = await open();
    await joinWith(u, 'ABCD2345');
    assert.ok(!u.$('.ul-online-late-join'));
});

// ---- S8: room_closed (contract v1.5) ----

test('S8: room_closed is a known error with the agreed text, distinct from room_full, for a joiner and a host', async () => {
    for (const role of ['join', 'host']) {
        const t = await open();
        if (role === 'host') await host(t);
        else await joinWith(t, 'ABCD2345');
        t.backend.write({ v: 1, role, state: 'error', error: 'room_closed' });
        await t.clock.advance(600);
        const box = t.$('.ul-online-error[data-error="room_closed"]');
        assert.ok(box, `${role}: the known room_closed path`);
        assert.equal(box.textContent.trim(), ROOM_CLOSED_TEXT, `${role}: exactly the agreed text`);
        assert.doesNotMatch(t.phase(), /reported a problem/, `${role}: not the unknown-id fallback`);
        assert.doesNotMatch(t.text('.ul-online-session'), /full/i, `${role}: not room_full's words`);
        assert.equal(t.text('.ul-online-again'), 'Try again');
        t.backend.running = false;
        t.$('.ul-online-again').click();
        await t.clock.advance(0);
        assert.equal(t.visible('.ul-online-idle'), true, `${role}: Try again goes back to Host / Join`);
        if (role === 'join') {
            assert.equal(t.input().value, 'ABCD-2345');
            t.$('.ul-online-join-button').click();
            await t.clock.advance(1500);
            assert.deepEqual(t.backend.starts.map(s => s.code), ['ABCD2345', 'ABCD2345'], 'and joins again with the same code');
        }
    }
    const t = await open();
    await joinWith(t, 'ABCD2345');
    t.backend.write({ v: 1, role: 'join', state: 'error', error: 'room_full' });
    await t.clock.advance(600);
    assert.match(t.phase(), /The game is full/, 'room_full keeps its own title');
    assert.ok(t.$('.ul-online-error[data-error="room_full"]'));
    assert.notEqual(t.text('.ul-online-error'), ROOM_CLOSED_TEXT);
    // The help lists it with the same words.
    assert.equal(t.$('.ul-online-help-error[data-error="room_closed"] dd').textContent, ROOM_CLOSED_TEXT);
    assert.equal(t.$('.ul-online-help-error[data-error="room_closed"] dt').textContent, 'Can’t join right now');
    // And in fr / es.
    for (const [language, text] of [['fr', /ne peut pas accueillir de nouveaux joueurs pour le moment/], ['es', /no puede aceptar jugadores nuevos ahora mismo/]]) {
        const u = await open({ language });
        assert.match(u.$('.ul-online-help-error[data-error="room_closed"] dd').textContent, text);
    }
});

// ---- S9: the internet address of a public game ----

test('S9: a calm note by the Public toggle, under Browse games and in How online works, in en/fr/es, never a focus stop', async () => {
    const expected = {
        en: 'Public games connect you directly to other players, so they can see your internet address. Share a private code to play only with friends.',
        fr: /directement aux autres joueurs, qui peuvent donc voir votre adresse internet/,
        es: /directamente con los demas jugadores, asi que pueden ver tu direccion de internet/
    };
    for (const language of ['en', 'fr', 'es']) {
        const t = await open({ language });
        const notes = t.document.querySelectorAll('#xml1-online-panel .ul-online-ip-note');
        assert.equal(notes.length, 2, `${language}: by the toggle and under Browse games`);
        assert.ok(notes[0].closest('.ul-online-host'), 'one in the Host card');
        assert.ok(notes[1].closest('.ul-online-browse'), 'one in Browse games');
        const help = t.$('.ul-online-help-notes [data-note="publicIp"]');
        for (const note of [...notes, help]) {
            if (typeof expected[language] === 'string') assert.equal(note.textContent, expected[language]);
            else assert.match(note.textContent, expected[language]);
            assert.ok(['P', 'LI'].includes(note.tagName), 'text, not a control');
            assert.equal(note.hasAttribute('tabindex'), false, 'no focus stop');
            assert.equal(note.querySelectorAll('a, button, input, [tabindex]').length, 0);
        }
        assert.equal(t.visible('.ul-online-host .ul-online-ip-note'), true, 'shown whether or not Public is on');
    }
});

// ---- the browser's Refresh keeps the player's focus ----

test('browse: a slow manual Refresh gives the focus back only if the player has not moved it', async () => {
    const t = await open({ rooms: [room()] });
    await t.clock.advance(1000);
    const handle = t.backend.handle.bind(t.backend);
    t.backend.handle = (command, data) => (command === 'get-public-rooms' && !data.refresh
        ? new Promise(resolve => t.clock.setTimeout(() => resolve(handle(command, data)), 2000))
        : handle(command, data));
    const refresh = t.$('.ul-online-browse-refresh');
    // (Chromium drops the focus of a button that becomes disabled: Refresh is, while it fetches.)
    const press = () => {
        refresh.focus();
        refresh.click();
        t.document.activeElement = t.document.body;
    };
    press();
    await t.clock.advance(500);
    t.$('.ul-online-host-button').focus(); // the player moved on meanwhile
    await t.clock.advance(3000);
    assert.equal(refresh.disabled, false, 'the slow answer came');
    assert.ok(t.document.activeElement === t.$('.ul-online-host-button'), 'the focus stays where the player put it');

    press();
    await t.clock.advance(3000);
    assert.ok(t.document.activeElement === refresh, 'not moved: back on Refresh when the answer comes');
});
