'use strict';
// How online works, simplified (owner, 2026-10-22: the old block was a wall of text nobody read): two cards -
// Host a game and Join a game - of three short steps with an icon each, always shown; under them two folds,
// closed by default, that the keyboard and a pad open and close (core/focus-nav.js): Good to know (one line
// each) and What the messages mean (every status error). The game's menus stay in English in every language,
// and every fact of the old text is still there. The real online-view.js runs on online_fixture.js's backend.

const assert = require('node:assert/strict');
const { test } = require('./harness');

const { ERRORS, open } = require('./online_fixture');

const SCRIPTS = ['core/utils.js', 'core/i18n.js', 'core/focus-nav.js', 'app/online-browse.js', 'app/online-view.js'];

const CARDS = {
    en: {
        titles: ['Host a game', 'Join a game'],
        host: ['Press Host a game', 'In the game: Play Online, then Host', 'Send friends your code (it’s already copied)'],
        join: ['Paste the code and press Join, or pick a game in Browse games', 'In the game: Play Online, then Join Game',
            'Game already running? You join at the next level']
    },
    fr: {
        titles: ['Heberger une partie', 'Rejoindre une partie'],
        host: ['Appuyez sur Heberger une partie', 'Dans le jeu : Play Online, puis Host', 'Envoyez votre code a vos amis (il est deja copie)'],
        join: ['Collez le code et appuyez sur Rejoindre, ou choisissez une partie dans Parcourir les parties', 'Dans le jeu : Play Online, puis Join Game',
            'Partie deja en cours ? Vous entrez au prochain niveau']
    },
    es: {
        titles: ['Alojar una partida', 'Unirse a una partida'],
        host: ['Pulsa Alojar una partida', 'En el juego: Play Online y luego Host', 'Envia tu codigo a tus amigos (ya esta copiado)'],
        join: ['Pega el codigo y pulsa Unirse, o elige una partida en Explorar partidas', 'En el juego: Play Online y luego Join Game',
            '¿Partida ya en marcha? Entras en el proximo nivel']
    }
};
const ICONS = { host: ['play', 'gamepad', 'copy'], join: ['clipboard', 'gamepad', 'door'] };
const NOTES = ['sameVersion', 'noPorts', 'public', 'publicIp', 'soloSegment', 'heroes', 'keepOpen', 'testMode', 'lan'];
const FOLD_TITLES = { en: ['Good to know', 'What the messages mean'], fr: ['Bon a savoir', 'Ce que veulent dire les messages'],
    es: ['Conviene saber', 'Que significan los mensajes'] };

async function openHelp(options = {}) {
    const t = await open(Object.assign({ scripts: SCRIPTS }, options));
    const good = () => t.$('.ul-online-good');
    const messages = () => t.$('.ul-online-messages');
    const lines = card => [...t.document.querySelectorAll(`#xml1-online-panel .ul-online-howto-card[data-card="${card}"] .ul-online-howto-line`)]
        .map(line => line.textContent);
    return Object.assign(t, { good, messages, lines });
}

test('How online works: the Host and Join cards, three steps each with an icon, in en, fr and es', async () => {
    for (const language of ['en', 'fr', 'es']) {
        const t = await openHelp({ language });
        const expected = CARDS[language];
        const titles = [...t.document.querySelectorAll('#xml1-online-panel .ul-online-howto-title')].map(title => title.textContent.trim());
        assert.deepEqual(titles, expected.titles, `${language}: the two cards`);
        assert.deepEqual(t.lines('host'), expected.host, `${language}: Host's steps`);
        assert.deepEqual(t.lines('join'), expected.join, `${language}: Join's steps`);
        for (const card of ['host', 'join']) {
            const box = t.$(`.ul-online-howto-card[data-card="${card}"]`);
            assert.ok(box.querySelector('.ul-online-howto-title svg[aria-hidden="true"]'), `${language}: ${card}'s title icon`);
            const steps = box.querySelectorAll('.ul-online-howto-step');
            assert.equal(steps.length, 3);
            steps.forEach(step => assert.ok(step.querySelector('.ul-online-howto-step-icon svg[aria-hidden="true"]'), `${language}: a step icon`));
        }
        // The example code, as the page shows a real one.
        assert.equal(t.text('.ul-online-howto-card[data-card="host"] [data-step="share"] .ul-online-howto-code'), 'ABCD-EFGH');
        // The game's own menus stay in English.
        for (const menu of ['Play Online', 'Host', 'Join Game', 'Joined Game']) assert.ok(t.text('.ul-online-howto').includes(menu), `${language}: ${menu}`);
        // The folds' titles, closed.
        assert.deepEqual([t.good(), t.messages()].map(fold => fold.querySelector('summary').textContent), FOLD_TITLES[language]);
        assert.equal(t.good().open, false, `${language}: Good to know is closed by default`);
        assert.equal(t.messages().open, false, `${language}: the messages are closed by default`);
    }
});

test('How online works: the icons are the ones the owner chose, inline SVG (no icon dependency, no game art)', async () => {
    const source = require('fs').readFileSync(require('path').resolve(__dirname, '../../launcher-ui/assets/js/app/online-view.js'), 'utf8');
    for (const [card, icons] of Object.entries(ICONS)) {
        assert.match(source, new RegExp(`id: '${card}', icon: '${card === 'host' ? 'crown' : 'people'}', steps: \\[${icons.map((glyph, i) => `\\['\\w+', '${glyph}'\\]`).join(', ')}\\]`));
    }
    const t = await openHelp();
    assert.equal(t.document.querySelectorAll('#xml1-online-panel .ul-online-help img').length, 0, 'no images');
    for (const svg of t.document.querySelectorAll('#xml1-online-panel .ul-online-help svg')) {
        assert.equal(svg.getAttribute('stroke'), 'currentColor', 'drawn in the text colour, as the launcher\'s icons');
    }
});

test('How online works: the folds open and close from the keyboard (Enter, Space) and from a pad (A)', async () => {
    const t = await openHelp();
    for (const fold of [t.good(), t.messages()]) {
        const summary = fold.querySelector('summary');
        summary.focus();
        t.window.FocusNav.press('Enter', 'key');
        assert.equal(fold.open, true, 'Enter opens it');
        await t.clock.advance(500);
        t.window.FocusNav.press(' ', 'key');
        assert.equal(fold.open, false, 'Space closes it');
        await t.clock.advance(500);
        t.window.FocusNav.press('Enter', 'pad');
        assert.equal(fold.open, true, 'a pad\'s A opens it');
        await t.clock.advance(500);
        t.window.FocusNav.press('Enter', 'pad');
        assert.equal(fold.open, false, 'and closes it');
        await t.clock.advance(500);
        assert.equal(t.document.activeElement, summary, 'the focus stays on it');
        summary.click();
        assert.equal(fold.open, true, 'a click opens it too');
        summary.click();
    }
    assert.deepEqual(t.backend.launches, [], 'nothing started');
});

test('How online works: Good to know holds its one-line items, and the messages fold every error', async () => {
    for (const language of ['en', 'fr', 'es']) {
        const t = await openHelp({ language });
        const notes = [...t.good().querySelectorAll('.ul-online-help-notes li')];
        assert.deepEqual(notes.map(note => note.dataset.note), NOTES, `${language}: the items, in order`);
        notes.forEach(note => assert.ok(note.textContent.length > 0 && !note.textContent.includes('{{'), `${language}: ${note.dataset.note} says something`));
        for (const id of ERRORS) {
            assert.ok(t.messages().querySelector(`.ul-online-help-error[data-error="${id}"] dt`), `${language}: ${id}'s title`);
            assert.ok(t.messages().querySelector(`.ul-online-help-error[data-error="${id}"] dd`).textContent.length > 0, `${language}: ${id}'s text`);
        }
        assert.equal(t.$('.ul-online-good .ul-online-help-errors'), null, 'the error list is in its own fold');
        // The menus stay in English here too.
        assert.match(t.text('.ul-online-help-notes'), /LAN.*Connect by IP/);
    }
});

test('How online works: the public-IP note is still there, with the same words as by the toggle', async () => {
    for (const language of ['en', 'fr', 'es']) {
        const t = await openHelp({ language });
        const note = t.$('.ul-online-good [data-note="publicIp"]');
        assert.equal(note.textContent, t.text('.ul-online-host .ul-online-ip-note'), `${language}: the same line`);
        assert.equal(note.textContent.includes(language === 'en' ? 'internet address' : language === 'fr' ? 'adresse internet' : 'direccion de internet'), true);
    }
});

test('How online works: every fact of the old text is still there (cards or folds)', async () => {
    const t = await openHelp();
    const text = t.text('.ul-online-help');
    for (const fact of [
        // The old steps.
        /Press Host a game/, /In the game: Play Online, then Host/, /Your room opens then/, /ABCD-EFGH/, /new or saved campaign as usual/,
        /already copied/, /A chat message is fine/, /Copy copies it again/, /Paste the code and press Join/, /Lower case, spaces and dashes are fine/,
        /Play Online, then Join Game/, /Select the host’s game/, /Connected – playing together\./,
        // The old notes.
        /List my game publicly puts your game in Browse games for everyone with the launcher; off, only friends with the code can join/,
        /Wait on Joined Game/, /next level/, /enough heroes for everyone/, /solo story parts, players without a hero stay connected and watch the shared camera, then rejoin/,
        /can see your internet address\. Share a private code to play only with friends/,
        /keep the launcher open while you play, to show your code and follow the game, even with Close launcher after game launch on\. Play still closes it/,
        /No port forwarding or router setup needed: the online service connects you/,
        /same version: Rebuild \(Build section\) when it says an update is available/,
        /LAN and Connect by IP still work with Play, which never opens a room/,
        /Test mode turns online play off: turn it off to host or join/,
        /What the messages mean/
    ]) {
        assert.match(text, fact);
    }
});
