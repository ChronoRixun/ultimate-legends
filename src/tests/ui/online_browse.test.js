'use strict';
// The Online section's public games (launcher 0.4.0, contract v1.3): Host's List my game publicly and
// room name (Public / RoomName written with Host=broker, removed by Join and by Play), the room card's
// Public / Private, the code copied by itself when it first appears, and Browse games - the broker's
// public rooms (get-public-rooms, faked here) with the level the room sends (zone_name), Join gated by
// version (none at all for a build without GameVersion), fullness and the section's own reasons, rooms
// with a password left out (contract v1.4), its empty / loading / error states and its 10 s refresh. The real HTTPS fetch
// and its pin are tools/dev/online_cdp.py's (a local self-signed server).

const assert = require('node:assert/strict');
const { test } = require('./harness');
const { open, host } = require('./online_fixture');

function room(fields = {}) {
    return Object.assign({
        code: 'ABCD2345', name: 'Saturday run', host_display_name: 'Logan', game_mode: 'campaign',
        zone: 'nyc/alison/nyc1_1_3', zone_name: 'Alison Rescue', version_token: 'LC31', players: 2, max_players: 4,
        in_progress: true, joinable: true, password_protected: false
    }, fields);
}

// The page opened and its first list fetched: the section's first tick (500 ms), then one poll (250 ms).
async function browse(options = {}, port = {}) {
    const t = await open(options, port);
    await t.clock.advance(1000);
    const rows = () => t.document.querySelectorAll('#xml1-online-panel .ul-online-room');
    const row = code => t.$(`.ul-online-room[data-code="${code}"]`);
    const rowText = (code, part) => {
        const element = row(code) && row(code).querySelector(part);
        return element ? element.textContent.replace(/\s+/g, ' ').trim() : null;
    };
    const join = code => row(code).querySelector('.ul-online-room-join');
    const status = () => (t.visible('.ul-online-browse-status') ? t.text('.ul-online-browse-status') : null);
    return Object.assign(t, { rows, row, rowText, join, status });
}

// ---- Host: public or private ----

test('public: List my game publicly is off by default; Host writes Public=0 and no RoomName', async () => {
    const t = await open({ online: { RoomName: 'old name' } });
    const toggle = value => t.$(`.ul-online-public-toggle .toggle-btn[data-value="${value}"]`);
    assert.equal(t.text('.ul-online-public-label'), 'List my game publicly');
    assert.equal(toggle('0').getAttribute('aria-pressed'), 'true', 'off');
    assert.equal(t.$('.ul-online-room-name-input').disabled, true, 'no name for a private game');
    await host(t);
    assert.deepEqual(t.backend.starts, [{ mode: 'host', public: false, roomName: '' }]);
    assert.equal(t.backend.online.Public, '0');
    assert.equal(t.backend.online.RoomName, undefined, 'an old RoomName goes');
});

test('public: on, with a room name: Public=1 and RoomName (trimmed) written with Host=broker', async () => {
    const t = await open({ online: { JoinCode: 'ZZZZ9999' } });
    t.$('.ul-online-public-toggle .toggle-btn[data-value="1"]').click();
    assert.equal(t.$('.ul-online-public-toggle .toggle-btn[data-value="1"]').getAttribute('aria-pressed'), 'true');
    const name = t.$('.ul-online-room-name-input');
    assert.equal(name.disabled, false);
    assert.equal(name.getAttribute('maxlength'), '32');
    name.value = '  Saturday run  ';
    name.dispatchEvent(new t.window.Event('input', { bubbles: true }));
    await host(t);
    assert.deepEqual(t.backend.starts, [{ mode: 'host', public: true, roomName: 'Saturday run' }]);
    assert.equal(t.backend.online.Host, 'broker');
    assert.equal(t.backend.online.Public, '1');
    assert.equal(t.backend.online.RoomName, 'Saturday run');
    assert.equal(t.backend.online.JoinCode, undefined);
    assert.equal(t.backend.online.Broker, 'broker.example:7777', 'the builder\'s keys stay');
});

test('public: a room name the ini can\'t hold shows an inline error and starts nothing', async () => {
    const t = await open();
    t.$('.ul-online-public-toggle .toggle-btn[data-value="1"]').click();
    const name = t.$('.ul-online-room-name-input');
    const error = () => (t.visible('.ul-online-room-name-error') ? t.text('.ul-online-room-name-error') : null);
    for (const bad of ['run; Host=evil', '"quoted"', 'café', 'x'.repeat(33)]) {
        name.value = bad;
        name.dispatchEvent(new t.window.Event('input', { bubbles: true }));
        assert.match(error() || '', /up to 32 letters, digits, spaces/, `${JSON.stringify(bad)}: the error`);
        assert.equal(name.getAttribute('aria-invalid'), 'true');
    }
    t.$('.ul-online-host-button').click();
    await t.clock.advance(1500);
    assert.deepEqual(t.backend.launches, [], 'nothing started or written');
    assert.ok(t.document.activeElement === name, 'the focus goes to the name');
    name.value = 'X-Men: 4 heroes & co. #1!';
    name.dispatchEvent(new t.window.Event('input', { bubbles: true }));
    assert.equal(error(), null);
    // Private: the name is not checked (nor written).
    name.value = 'bad;';
    t.$('.ul-online-public-toggle .toggle-btn[data-value="0"]').click();
    assert.equal(error(), null);
    await host(t);
    assert.deepEqual(t.backend.starts.map(p => [p.public, p.roomName]), [[false, '']]);
});

test('public: Join and Play remove Public and RoomName too (one-shot, like Host / JoinCode)', async () => {
    let t = await open({ online: { Host: 'broker', Public: '1', RoomName: 'Saturday run' } });
    t.type('ABCD-2345');
    t.$('.ul-online-join-button').click();
    await t.clock.advance(1500);
    assert.deepEqual(Object.keys(t.backend.online).sort(), ['Broker', 'BrokerPin', 'GameVersion', 'JoinCode']);

    t = await open({ online: { Host: 'broker', Public: '1', RoomName: 'Saturday run', JoinCode: 'ABCD2345' } });
    const started = t.window.GameUtils.launchGame('xml1', 'xml1');
    await t.clock.advance(1500);
    assert.equal((await started).accepted, true);
    assert.deepEqual(t.backend.launches, [{ game: 'xml1' }]);
    assert.deepEqual(Object.keys(t.backend.online).sort(), ['Broker', 'BrokerPin', 'GameVersion'], 'Play: all four gone');
});

test('public: the room card says Public or Private, with the room name, from online-status.json', async () => {
    let t = await open();
    t.$('.ul-online-public-toggle .toggle-btn[data-value="1"]').click();
    await host(t);
    t.backend.write({ role: 'host', state: 'room', code: 'ABCD2345', players: 1, max_players: 4, public: true, room_name: 'Saturday run' });
    await t.clock.advance(600);
    assert.equal(t.text('.ul-online-visibility'), 'Public');
    assert.equal(t.text('.ul-online-room-title'), 'Saturday run');
    assert.equal(t.text('.ul-online-visibility-note'), 'Listed in Browse games');

    t.backend.write({ role: 'host', state: 'room', code: 'ABCD2345', players: 1, max_players: 4, public: false, room_name: '' });
    await t.clock.advance(600);
    assert.equal(t.text('.ul-online-visibility'), 'Private', 'what the fix says wins');
    assert.ok(!t.$('.ul-online-room-title'));
    assert.equal(t.text('.ul-online-visibility-note'), 'Only friends with the code can join');

    t = await open();
    await host(t);
    t.backend.write({ role: 'host', state: 'room', code: 'ABCD2345', players: 1 });
    await t.clock.advance(600);
    assert.equal(t.text('.ul-online-visibility'), 'Private', 'a status without the field: what was asked');
});

// ---- the code on the clipboard by itself ----

test('auto-copy: the code goes on the clipboard when it first appears, with a Copied note; Copy stays', async () => {
    const t = await open();
    await host(t);
    t.backend.write({ role: 'host', state: 'connecting' });
    await t.clock.advance(600);
    assert.deepEqual(t.clipboard, [], 'no code, nothing copied');
    t.backend.write({ role: 'host', state: 'room', code: 'WXYZ6789', players: 1 });
    await t.clock.advance(600);
    assert.deepEqual(t.clipboard, ['WXYZ-6789']);
    assert.equal(t.text('.ul-online-copied'), 'Copied to the clipboard');
    assert.equal(t.text('.ul-online-copy'), 'Copy', 'the button stays');
    assert.equal(t.toasts.length, 0, 'no toast for the automatic copy');
    t.backend.write({ role: 'host', state: 'room', code: 'WXYZ6789', players: 2 });
    await t.clock.advance(600);
    t.backend.write({ role: 'host', state: 'in_game', code: 'WXYZ6789', players: 2 });
    await t.clock.advance(600);
    assert.deepEqual(t.clipboard, ['WXYZ-6789'], 'once: a player joining or the session starting copies nothing');
});

test('auto-copy: no note when the copy fails, the old copy command otherwise; nothing copied for a room taken up after a launcher restart', async () => {
    let t = await open();
    t.window.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    t.document.execCommand = () => false;
    await host(t);
    t.backend.write({ role: 'host', state: 'room', code: 'WXYZ6789', players: 1 });
    await t.clock.advance(600);
    assert.ok(!t.$('.ul-online-copied'), 'no Copied note');
    assert.equal(t.text('.ul-online-copy'), 'Copy');

    // The old copy command works where the Clipboard API is refused; the focus stays where it was.
    t = await open();
    t.window.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    const copied = [];
    t.document.execCommand = command => {
        const area = t.document.querySelector('textarea');
        copied.push([command, area && area.value]);
        return true;
    };
    t.document.createElement = (create => tag => {
        const element = create(tag);
        if (tag === 'textarea') element.select = () => element.focus();
        return element;
    })(t.document.createElement.bind(t.document));
    await host(t);
    t.$('.ul-online-session').focus();
    t.backend.write({ role: 'host', state: 'room', code: 'WXYZ6789', players: 1 });
    await t.clock.advance(600);
    assert.deepEqual(copied, [['copy', 'WXYZ-6789']]);
    assert.equal(t.text('.ul-online-copied'), 'Copied to the clipboard');
    assert.ok(t.document.activeElement === t.$('.ul-online-copy') || t.document.activeElement === t.$('.ul-online-session'),
        'the focus is not left on the copy\'s textarea');

    t = await open({ running: true, status: { v: 1, role: 'host', state: 'room', code: 'MNPQ7777', players: 2 } });
    await t.clock.advance(600);
    assert.equal(t.text('.ul-online-code'), 'MNPQ-7777');
    assert.deepEqual(t.clipboard, [], 'the clipboard is left alone');
});

// ---- Browse games ----

test('browse: each row says name, host, mode and level, N of 4, In progress, and has Join', async () => {
    const t = await browse({ rooms: [room(), room({ code: 'WXYZ6789', name: '', host_display_name: 'Ororo', game_mode: 'danger_room',
        zone: 'danger/dr_1', zone_name: '', players: 1, in_progress: false })] });
    assert.equal(t.text('.ul-online-browse-head .ul-online-card-title'), 'Browse games');
    assert.equal(t.rows().length, 2);
    assert.equal(t.rowText('ABCD2345', '.ul-online-room-name'), 'Saturday run');
    assert.equal(t.rowText('ABCD2345', '.ul-online-room-host'), 'Hosted by Logan');
    assert.equal(t.rowText('ABCD2345', '.ul-online-room-where'), 'Campaign · Alison Rescue', 'the level as the room names it (zone_name)');
    assert.equal(t.rowText('ABCD2345', '.ul-online-room-players'), '2 of 4');
    assert.equal(t.rowText('ABCD2345', '.ul-online-room-badge'), 'In progress');
    assert.equal(t.join('ABCD2345').disabled, false);
    assert.equal(t.join('ABCD2345').getAttribute('aria-label'), 'Join Saturday run');
    assert.equal(t.rowText('WXYZ6789', '.ul-online-room-name'), 'Ororo’s game', 'no name: the host\'s game');
    assert.equal(t.rowText('WXYZ6789', '.ul-online-room-where'), 'Danger Room · dr_1');
    assert.equal(t.rowText('WXYZ6789', '.ul-online-room-players'), '1 of 4');
    assert.ok(!t.row('WXYZ6789').querySelector('.ul-online-room-badge'), 'not in progress: no badge');
    assert.equal(t.status(), null, 'no status line with rooms');
});

test('browse: the level is the room\'s zone_name, else the last part of its zone; the launcher has no zone table', async () => {
    const t = await browse({ rooms: [
        room({ code: 'AAAA2222', zone_name: 'Alison Rescue' }),
        room({ code: 'BBBB3333', zone_name: '', zone: 'nyc/alison/nyc1_1_3' }),
        room({ code: 'CCCC4444', zone_name: null, zone: 'NYC\\Alison\\nyc1_1_2' }),
        room({ code: 'DDDD5555', zone_name: '   ', zone: '' }),
        room({ code: 'EEEE6666', zone_name: 'x'.repeat(80) })
    ] });
    assert.equal(t.rowText('AAAA2222', '.ul-online-room-where'), 'Campaign · Alison Rescue');
    assert.equal(t.rowText('BBBB3333', '.ul-online-room-where'), 'Campaign · nyc1_1_3', 'empty zone_name: the zone\'s last part');
    assert.equal(t.rowText('CCCC4444', '.ul-online-room-where'), 'Campaign · nyc1_1_2', 'no zone_name; a \\ path');
    assert.equal(t.rowText('DDDD5555', '.ul-online-room-where'), 'Campaign', 'neither: the mode alone');
    assert.ok(t.rowText('EEEE6666', '.ul-online-room-where').length <= 'Campaign · '.length + 48, 'zone_name cut at 48');
    assert.equal(t.window.OnlineZones, undefined, 'no zone table in the launcher (contract v1.4)');
});

test('browse: another build\'s room says Different game version and can\'t be joined', async () => {
    let t = await browse({ rooms: [room({ version_token: 'LC30' }), room({ code: 'WXYZ6789' })], versionToken: 'LC31' });
    assert.equal(t.join('ABCD2345').disabled, true);
    assert.equal(t.rowText('ABCD2345', '.ul-online-room-reason'), 'Different game version');
    assert.equal(t.row('ABCD2345').dataset.reason, 'differentVersion');
    assert.equal(t.join('WXYZ6789').disabled, false, 'the same build: Join');
    assert.ok(!t.row('WXYZ6789').querySelector('.ul-online-room-reason'));

});

test('browse: no GameVersion in this folder\'s ini (an old build): every row greyed out, "Rebuild to play online"', async () => {
    const t = await browse({ rooms: [room(), room({ code: 'WXYZ6789', version_token: 'LC30' }), room({ code: 'MNPQ7777', players: 4 })], versionToken: '' });
    for (const code of ['ABCD2345', 'WXYZ6789', 'MNPQ7777']) {
        assert.equal(t.join(code).disabled, true, `${code}: no Join`);
        assert.equal(t.rowText(code, '.ul-online-room-reason'), 'Rebuild to play online', `${code}: the reason`);
        assert.ok(t.row(code).classList.contains('is-off'), `${code}: greyed out`);
    }
});

test('browse: full rooms say Full, closed ones Can\'t join right now; rooms with a password are not listed', async () => {
    const t = await browse({ rooms: [
        room({ code: 'AAAA2222', players: 4, max_players: 4 }),
        room({ code: 'BBBB3333', password_protected: true }),
        room({ code: 'CCCC4444', joinable: false }),
        room({ code: 'DDDD5555', players: 3 })
    ] });
    assert.equal(t.rowText('AAAA2222', '.ul-online-room-reason'), 'Full');
    assert.equal(t.rowText('AAAA2222', '.ul-online-room-players'), '4 of 4');
    assert.ok(!t.row('BBBB3333'), 'a password: hidden (no client sends one in 0.3.0)');
    assert.equal(t.rowText('CCCC4444', '.ul-online-room-reason'), 'Can’t join right now');
    assert.ok(t.row('CCCC4444').classList.contains('is-off'), 'listed, greyed out');
    assert.deepEqual(['AAAA2222', 'CCCC4444', 'DDDD5555'].map(code => t.join(code).disabled), [true, true, false]);
    assert.equal(t.rows().length, 3);

    const only = await browse({ rooms: [room({ password_protected: true })] });
    assert.equal(only.rows().length, 0);
    assert.match(only.status() || '', /No public games right now/, 'only password rooms: the empty list');
});

test('browse: Join on a row is the code flow with the row\'s code', async () => {
    const t = await browse({ rooms: [room({ code: 'WXYZ6789' })], online: { Host: 'broker', Public: '1' } });
    t.join('WXYZ6789').click();
    await t.clock.advance(1500);
    assert.deepEqual(t.backend.launches, [{ game: 'xml1', online: { mode: 'join', code: 'WXYZ6789' } }], 'exactly the code join');
    assert.equal(t.backend.online.JoinCode, 'WXYZ6789');
    assert.equal(t.backend.online.Host, undefined);
    assert.equal(t.backend.online.Public, undefined);
    assert.equal(t.input().value, 'WXYZ-6789', 'the code in the field too (Try again)');
    assert.equal(t.phase(), 'Looking for the game…');
    assert.equal(t.visible('.ul-online-browse'), false, 'the list goes with Host / Join while the session runs');
});

test('browse: Join is off on every row while the section\'s own reason holds', async () => {
    for (const [options, port, id] of [[{ testMode: true }, {}, 'testMode'], [{ running: true }, {}, 'running'], [{}, { building: true }, 'building']]) {
        const t = await browse(Object.assign({ rooms: [room()] }, options), port);
        assert.equal(t.document.getElementById('xml1-online-panel').dataset.blocked, id);
        assert.equal(t.join('ABCD2345').disabled, true, `${id}: Join off`);
        assert.ok(!t.row('ABCD2345').querySelector('.ul-online-room-reason'), `${id}: the reason is the section's, above`);
    }
});

test('browse: what the broker sends is text, and a row without a valid code is left out', async () => {
    const t = await browse({ rooms: [
        room({ name: '<img src=x onerror=alert(1)>', host_display_name: '<b>Logan</b>' }),
        room({ code: 'OOOO0000' }), room({ code: null }), 'nonsense', null,
        room({ code: 'wxyz-6789', name: 'x'.repeat(200) })
    ] });
    assert.equal(t.rows().length, 2);
    assert.equal(t.rowText('ABCD2345', '.ul-online-room-name'), '<img src=x onerror=alert(1)>');
    assert.ok(!t.row('ABCD2345').querySelector('img') && !t.row('ABCD2345').querySelector('b'), 'no markup from the broker');
    assert.ok(t.row('WXYZ6789'), 'a code in another form is read as the code');
    assert.ok(t.rowText('WXYZ6789', '.ul-online-room-name').length <= 48, 'a long name is cut');
});

test('browse: loading, then the empty list in plain words', async () => {
    const t = await open({ rooms: [] });
    assert.equal(t.text('.ul-online-browse-status'), 'Looking for public games…');
    await t.clock.advance(1000);
    assert.equal(t.text('.ul-online-browse-status'), 'No public games right now – host one and turn on List my game publicly.');
    assert.equal(t.visible('.ul-online-rooms'), false);
});

test('browse: errors in plain words (unreachable, rate-limited, busy, bad pin, a bad answer); the last list stays', async () => {
    const texts = {
        unreachable: /Can’t reach the online service. Check your internet connection/,
        rate_limited: /refreshed too often/,
        busy: /The online service is busy/,
        bad_pin: /The online service could not be verified/,
        bad_response: /The game list could not be read/
    };
    for (const [error, pattern] of Object.entries(texts)) {
        const t = await browse({ rooms: { ok: false, error, status: 0, rooms: [], ts: 0 } });
        assert.match(t.status() || '', pattern, error);
        assert.ok(t.$('.ul-online-browse-status').classList.contains('is-error'));
        assert.equal(t.rows().length, 0);
    }
    const t = await browse({ rooms: [room()] });
    assert.equal(t.rows().length, 1);
    t.backend.roomsResult = { ok: false, error: 'unreachable', status: 0, rooms: [], ts: 0 };
    t.$('.ul-online-browse-refresh').click();
    await t.clock.advance(600);
    assert.match(t.status() || '', /Can’t reach the online service/);
    assert.equal(t.rows().length, 1, 'a failed refresh keeps the last list');
});

test('browse: refreshes every 10 s while the page shows it; not while hidden or during a session; backs off after 429', async () => {
    const t = await browse({ rooms: [room()] });
    assert.equal(t.backend.fetches, 1, 'fetched when the page opened');
    await t.clock.advance(9000);
    assert.equal(t.backend.fetches, 1);
    await t.clock.advance(1600);
    assert.equal(t.backend.fetches, 2, 'again after 10 s');

    t.document.getElementById('xml1-page').style.display = 'none';
    await t.clock.advance(30000);
    assert.equal(t.backend.fetches, 2, 'not while the page is hidden');
    t.document.getElementById('xml1-page').style.display = '';
    await t.clock.advance(600);
    assert.equal(t.backend.fetches, 3, 'at once when it shows again (its 10 s are up)');

    t.document.visibilityState = 'hidden';
    await t.clock.advance(30000);
    assert.equal(t.backend.fetches, 3, 'not while the launcher window is hidden');
    t.document.visibilityState = 'visible';
    await t.clock.advance(600);
    assert.equal(t.backend.fetches, 4);

    t.backend.roomsResult = { ok: false, error: 'rate_limited', status: 429, rooms: [], ts: 0 };
    await t.clock.advance(10600);
    assert.equal(t.backend.fetches, 5);
    await t.clock.advance(20000);
    assert.equal(t.backend.fetches, 5, 'rate-limited: no refresh for 30 s');
    t.backend.roomsResult = { ok: true, error: null, status: 200, rooms: [room()], ts: 2 };
    await t.clock.advance(10600);
    assert.equal(t.backend.fetches, 6);

    await host(t);
    const during = t.backend.fetches;
    await t.clock.advance(30000);
    assert.equal(t.backend.fetches, during, 'not while hosting');
});

test('browse: Refresh fetches now; it and every Join are buttons a keyboard reaches; a refresh keeps the focus on the row', async () => {
    const t = await browse({ rooms: [room(), room({ code: 'WXYZ6789' })] });
    const refresh = t.$('.ul-online-browse-refresh');
    assert.equal(refresh.tagName, 'BUTTON');
    assert.equal(refresh.getAttribute('type'), 'button');
    for (const button of t.document.querySelectorAll('#xml1-online-panel .ul-online-room-join')) {
        assert.equal(button.tagName, 'BUTTON');
        assert.equal(button.hasAttribute('tabindex'), false);
    }
    refresh.focus();
    refresh.click();
    assert.equal(refresh.disabled, true, 'busy while it fetches');
    assert.equal(refresh.textContent, 'Refreshing…');
    await t.clock.advance(600);
    assert.equal(t.backend.fetches, 2);
    assert.equal(refresh.disabled, false);
    assert.ok(t.document.activeElement === refresh, 'the focus is back on Refresh');

    t.join('WXYZ6789').focus();
    t.backend.roomsResult = { ok: true, error: null, status: 200, rooms: [room({ code: 'WXYZ6789', players: 3 }), room()], ts: 3 };
    refresh.click();
    await t.clock.advance(600);
    assert.equal(t.rowText('WXYZ6789', '.ul-online-room-players'), '3 of 4', 'redrawn');
    assert.ok(t.document.activeElement === t.join('WXYZ6789'), 'the focus is still on that row\'s Join');

    t.backend.roomsResult = { ok: true, error: null, status: 200, rooms: [room()], ts: 4 };
    t.join('WXYZ6789').focus();
    refresh.click();
    await t.clock.advance(600);
    assert.ok(!t.row('WXYZ6789'));
    assert.ok(t.document.activeElement === refresh, 'that row gone: the focus goes to Refresh');
});

test('browse: every string is in en, fr and es; the help mentions public games', async () => {
    const t = await browse({ rooms: [] });
    assert.match(t.text('.ul-online-help-notes'), /List my game publicly/);
    for (const language of ['fr', 'es']) {
        t.window.LauncherI18n.setLanguage(language);
        for (const key of ['online.host.public', 'online.host.publicNote', 'online.host.roomName', 'online.host.roomNameError',
            'online.code.autoCopied', 'online.visibility.public', 'online.visibility.private', 'online.browse.title',
            'online.browse.empty', 'online.browse.differentVersion', 'online.browse.rebuild', 'online.browse.full', 'online.browse.inProgress',
            'online.browse.errors.rate_limited', 'online.browse.errors.busy', 'online.browse.errors.bad_response', 'online.help.public']) {
            const english = (() => {
                t.window.LauncherI18n.setLanguage('en');
                const text = t.window.LauncherI18n.t(key);
                t.window.LauncherI18n.setLanguage(language);
                return text;
            })();
            const translated = t.window.LauncherI18n.t(key);
            assert.notEqual(translated, key, `${language}: ${key}`);
            assert.notEqual(translated, english, `${language}: ${key} is translated`);
        }
    }
});
