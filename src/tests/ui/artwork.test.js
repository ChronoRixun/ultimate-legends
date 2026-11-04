'use strict';
const assert = require('node:assert/strict');
const { page, test, settle, MouseEvent } = require('./harness');

function setup({ record = {}, picked, choice = 0, imageFails = false, convert = false, focus = false, game = 'mua' } = {}) {
    const calls = [];
    const backend = { handle(command, data) {
        calls.push({ command, data });
        if (command === 'get-artwork') return data.game === game ? { ...record } : {};
        if (command === 'pick-artwork') return picked || { record: 'abc.png', preview: `/custom-art/${game}/${data.kind}/abc.png`, convert };
        if (command === 'confirm-artwork') {
            if (!data.cancel) record[data.kind] = `/custom-art/${game}/${data.kind}/abc.png`;
            return true;
        }
        if (command === 'reset-artwork') {
            if (data.kind) delete record[data.kind];
            else { delete record.capsule; delete record.hero; }
            return true;
        }
        return null;
    } };
    const scripts = ['core/utils.js', 'core/i18n.js', 'ui/artwork.js', 'app/views.js'];
    if (focus) scripts.push('core/focus-nav.js', 'ui/message-box.js');
    const p = page({ scripts, backend });
    const images = [];
    p.window.Image = class {
        constructor() { this.naturalWidth = 600; this.naturalHeight = 900; images.push(this); }
        set src(value) {
            this.url = value;
            Promise.resolve().then(() => {
                if (imageFails && this.onerror) this.onerror(new Error('decode'));
                else if (this.onload) this.onload();
            });
        }
    };
    if (!focus) p.window.showMessageBox = async (...args) => { p.messages.push(args); return choice; };
    p.window.innerWidth = 1280;
    p.window.innerHeight = 800;
    // The production library filter uses one :not() selector; the tiny DOM intentionally
    // implements only simple selectors. Adapt that existing selector in this fixture.
    const query = p.document.querySelectorAll.bind(p.document);
    p.document.querySelectorAll = selector => selector === '#library-grid .library-card:not(.library-card-empty)'
        ? query('#library-grid .library-card').filter(card => !card.classList.contains('library-card-empty'))
        : query(selector);
    return { ...p, calls, record, images, game, art: p.window.Artwork, utils: p.window.GameUtils };
}

test('artwork: defaults, managed overrides, and reset cover both card and banner', async () => {
    const p = setup({ record: { capsule: '/custom-art/mua/capsule/12.png', hero: '/custom-art/mua/hero/34.jpg' } });
    const defaults = p.utils.GAME_CONFIGS.mua;
    assert.equal(p.utils.getGameConfig('mua').capsulePath, defaults.capsulePath);
    await p.art.loadAll();
    assert.equal(p.utils.getGameConfig('mua').capsulePath, '/custom-art/mua/capsule/12.png');
    assert.equal(p.utils.getHeroImagePath('mua'), '/custom-art/mua/hero/34.jpg');
    assert.equal(p.art.menuItems('mua').length, 3);
    await p.art.reset('mua');
    assert.equal(p.utils.getGameConfig('mua').capsulePath, defaults.capsulePath);
    assert.equal(p.utils.getHeroImagePath('mua'), defaults.heroImagePath);
    assert.equal(p.art.menuItems('mua').length, 2);
});

async function renderArtworkSurfaces(p) {
    p.window.AppViews.renderLibrary();
    p.window.AppViews.renderGamePages();
    await p.window.AppViews.refreshHomeInstalledClients(async game => ({ status: game === p.game ? 'installed' : 'not-setup' }));
    await settle();
    return {
        library: p.document.querySelector(`.library-card[data-game="${p.game}"]`),
        home: p.document.querySelector(`.client-card[data-game="${p.game}"]`),
        banner: p.document.getElementById(`${p.game}-page`),
        hub: p.document.getElementById('hub-hero')
    };
}

test('artwork: custom capsules enable card scrims without changing default cards or banners', async () => {
    const p = setup({ record: { capsule: '/custom-art/mua/capsule/12.png' } });
    await p.art.loadAll();
    const surface = await renderArtworkSurfaces(p);
    assert.ok(surface.library.classList.contains('has-custom-art'), 'library custom capsule needs its contrast scrim');
    assert.ok(surface.home.classList.contains('has-custom-art'), 'home custom capsule needs its contrast scrim');
    assert.equal(surface.banner.classList.contains('has-custom-banner'), false);
    assert.equal(surface.hub.classList.contains('has-custom-banner'), false);
    assert.equal(p.document.querySelector('.library-card[data-game="muac"]').classList.contains('has-custom-art'), false);
    await p.art.reset('mua');
    assert.equal(surface.library.classList.contains('has-custom-art'), false);
    assert.equal(surface.home.classList.contains('has-custom-art'), false);
});

test('artwork: custom banners protect game-page and home text independently of capsule choice', async () => {
    const p = setup({ record: { hero: '/custom-art/mua/hero/34.jpg' } });
    await p.art.loadAll();
    const surface = await renderArtworkSurfaces(p);
    assert.ok(surface.banner.classList.contains('has-custom-banner'), 'game-page custom banner needs its contrast scrim');
    assert.ok(surface.hub.classList.contains('has-custom-banner'), 'home custom banner needs its contrast scrim');
    assert.equal(surface.library.classList.contains('has-custom-art'), false);
    assert.equal(surface.home.classList.contains('has-custom-art'), false);
    assert.equal(p.document.getElementById('muac-page').classList.contains('has-custom-banner'), false);
    p.document.getElementById('hub-hero-next').click();
    assert.equal(surface.hub.classList.contains('has-custom-banner'), false, 'the next game uses its default banner');
    p.document.getElementById('hub-hero-prev').click();
    assert.ok(surface.hub.classList.contains('has-custom-banner'));
    await p.art.reset('mua');
    assert.equal(surface.banner.classList.contains('has-custom-banner'), false);
    assert.equal(surface.hub.classList.contains('has-custom-banner'), false);
});

test('artwork: live changes add contrast and broken custom copies restore exact default markup', async () => {
    const p = setup({ game: 'muac' });
    const surface = await renderArtworkSurfaces(p);
    // Select MUA 2006 in Home's carousel as well as its library/game page.
    for (let step = 0; step < 5 && surface.hub.dataset.game !== 'muac'; step++) p.document.getElementById('hub-hero-next').click();
    assert.equal(surface.hub.dataset.game, 'muac');
    assert.equal(surface.library.querySelector('.library-card-title').textContent, 'Marvel: Ultimate Alliance (2006 PC)');
    const libraryClass = surface.library.className, bannerClass = surface.banner.className;
    const defaultCard = surface.library.innerHTML;
    await p.art.change('muac', 'capsule');
    assert.ok(surface.library.classList.contains('has-custom-art'));
    assert.ok(surface.home.classList.contains('has-custom-art'));
    assert.equal(surface.banner.className, bannerClass);
    await p.art.change('muac', 'hero');
    assert.ok(surface.banner.classList.contains('has-custom-banner'));
    assert.ok(surface.hub.classList.contains('has-custom-banner'));
    surface.library.querySelector('img').dispatchEvent(new p.window.Event('error'));
    await settle();
    assert.equal(surface.library.className, libraryClass);
    assert.equal(surface.library.innerHTML, defaultCard);
    assert.ok(surface.banner.classList.contains('has-custom-banner'), 'broken capsule must not clear banner contrast');
    await p.art.reset('muac');
    assert.equal(surface.banner.className, bannerClass);
    assert.equal(surface.hub.classList.contains('has-custom-banner'), false);
});

test('artwork: invalid remote and traversal resources never override defaults', async () => {
    const p = setup({ record: { capsule: 'https://example.invalid/image.png', hero: '/custom-art/mua/hero/../../secret.png' } });
    await p.art.load('mua');
    assert.equal(p.utils.getGameConfig('mua').capsulePath, p.utils.GAME_CONFIGS.mua.capsulePath);
    assert.equal(p.utils.getHeroImagePath('mua'), p.utils.GAME_CONFIGS.mua.heroImagePath);
    assert.equal(p.images.length, 0);
});

test('artwork: missing or undecodable custom copies silently clear only the broken record', async () => {
    const p = setup({ record: { capsule: '/custom-art/mua/capsule/12.png', hero: '/custom-art/mua/hero/34.jpg' } });
    await p.art.load('mua');
    p.images[0].onerror();
    await settle();
    assert.equal(p.utils.getGameConfig('mua').capsulePath, p.utils.GAME_CONFIGS.mua.capsulePath);
    assert.equal(p.utils.getHeroImagePath('mua'), '/custom-art/mua/hero/34.jpg');
    const cleared = p.calls.find(c => c.command === 'reset-artwork');
    assert.equal(cleared.data.kind, 'capsule');
    assert.equal(cleared.data.record, '12.png');
    assert.equal(p.toasts.length, 0);
});

test('artwork: an old broken-image event cannot clear replacement artwork', async () => {
    const p = setup({ record: { capsule: '/custom-art/mua/capsule/12.png' } });
    await p.art.load('mua');
    p.record.capsule = '/custom-art/mua/capsule/34.png';
    await p.art.load('mua');
    p.images[0].onerror();
    await settle();
    assert.equal(p.utils.getGameConfig('mua').capsulePath, '/custom-art/mua/capsule/34.png');
    assert.equal(p.calls.filter(c => c.command === 'reset-artwork').length, 0);
});

test('artwork: crop preview precedes confirmation and updates existing image nodes', async () => {
    const p = setup();
    const image = p.document.createElement('img');
    image.setAttribute('src', p.utils.GAME_CONFIGS.mua.capsulePath);
    p.document.body.appendChild(image);
    await p.art.change('mua', 'capsule');
    assert.equal(p.messages.length, 1);
    assert.match(p.messages[0][1], /artwork-preview-capsule/);
    assert.match(p.messages[0][1], /nothing is uploaded/);
    assert.equal(p.messages[0][2][1].cancel, true);
    assert.equal(image.getAttribute('src'), '/custom-art/mua/capsule/abc.png');
    assert.deepEqual(p.calls.filter(c => c.command !== 'get-artwork').map(c => c.command), ['pick-artwork', 'confirm-artwork']);
});

test('artwork: cancelling banner preview discards candidate and preserves defaults', async () => {
    const p = setup({ choice: 1 });
    await p.art.change('mua', 'hero');
    assert.match(p.messages[0][1], /artwork-preview-hero/);
    assert.equal(p.calls.at(-1).data.cancel, true);
    assert.equal(p.utils.getHeroImagePath('mua'), p.utils.GAME_CONFIGS.mua.heroImagePath);
});

test('artwork: refused files and failed preview decode never reach save', async () => {
    for (const options of [{ picked: { error: true } }, { imageFails: true }]) {
        const p = setup(options);
        await p.art.change('mua', 'capsule');
        assert.equal(p.messages.length, 0);
        assert.equal(p.calls.some(c => c.command === 'confirm-artwork' && !c.data.cancel), false);
        assert.equal(p.toasts.length, 1);
    }
});

test('artwork: WebP uses CEF canvas PNG before native save validation', async () => {
    const p = setup({ picked: { record: 'abc.webp', preview: '/custom-art/mua/capsule/abc.webp', convert: true } });
    const create = p.document.createElement.bind(p.document);
    let drawn = false;
    p.document.createElement = name => {
        const element = create(name);
        if (name === 'canvas') {
            element.getContext = () => ({ drawImage: () => { drawn = true; } });
            element.toDataURL = type => { assert.equal(type, 'image/png'); return 'data:image/png;base64,cG5n'; };
        }
        return element;
    };
    await p.art.change('mua', 'capsule');
    assert.equal(drawn, true);
    assert.equal(p.calls.find(c => c.command === 'confirm-artwork').data.png, 'cG5n');
});

test('artwork: library context menu exposes change actions and conditional reset', async () => {
    const p = setup();
    p.window.AppViews.renderLibrary();
    const card = p.document.querySelector('.library-card[data-game="mua"]');
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    let menu = p.document.querySelector('.library-card-menu');
    assert.match(menu.textContent, /Change artwork\.\.\./);
    assert.match(menu.textContent, /Change banner\.\.\./);
    assert.doesNotMatch(menu.textContent, /Reset artwork/);
    p.record.hero = '/custom-art/mua/hero/12.png';
    await p.art.load('mua');
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    assert.match(menu.textContent, /Reset artwork/);
    p.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(menu.hidden, true);
});

test('artwork: every supported language supplies the new artwork labels', () => {
    const p = setup();
    for (const language of ['en', 'fr', 'es', 'ru']) {
        p.window.LauncherI18n.setLanguage(language);
        assert.equal(p.art.menuItems('mua')[0].label, 'Change artwork...');
        assert.equal(p.art.menuItems('mua')[1].label, 'Change banner...');
    }
});

test('artwork: keyboard and pad reach the menu, preview, and Escape cancellation with focus restored', async () => {
    const p = setup({ focus: true });
    p.document.getElementById('home-page').style.display = 'none';
    p.document.getElementById('library-page').style.display = 'block';
    p.window.AppViews.renderLibrary();
    const nav = p.window.FocusNav;
    const card = p.document.querySelector('.library-card[data-game="mua"]');
    card.focus();
    nav.press('ContextMenu', 'key');
    nav.sync();
    const menu = p.document.querySelector('.library-card-menu');
    assert.equal(menu.hidden, false);
    for (let i = 0; i < 15 && p.document.activeElement.textContent !== 'Change artwork...'; i++) nav.press('Tab', 'key');
    assert.equal(p.document.activeElement.textContent, 'Change artwork...');
    nav.press('Enter', 'pad');
    nav.sync();
    await settle();
    nav.sync();
    const modal = p.document.getElementById('message-box');
    assert.equal(modal.classList.contains('visible'), true);
    assert.equal(p.document.activeElement.textContent, 'Use artwork');
    assert.ok(modal.querySelector('.artwork-preview-capsule'));
    nav.press('Escape', 'pad');
    await settle();
    nav.sync();
    assert.equal(modal.classList.contains('visible'), false);
    assert.equal(p.calls.find(c => c.command === 'confirm-artwork').data.cancel, true);
    assert.equal(p.document.activeElement, card);
});
