'use strict';
const assert = require('node:assert/strict');
const { page, test, settle, MouseEvent } = require('./harness');

function setup({ record = {}, picked, choice = 0, imageFails = false, convert = false, focus = false, game = 'mua', width = 600, height = 900 } = {}) {
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
            else { delete record.capsule; delete record.hero; delete record.icon; }
            return true;
        }
        return null;
    } };
    const scripts = ['core/utils.js', 'core/i18n.js', 'ui/artwork.js', 'app/views.js'];
    if (focus) scripts.push('core/focus-nav.js', 'ui/message-box.js');
    const p = page({ scripts, backend });
    const images = [];
    p.window.Image = class {
        constructor() { this.naturalWidth = width; this.naturalHeight = height; images.push(this); }
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
    assert.equal(p.art.menuItems('mua').length, 4);
    await p.art.reset('mua');
    assert.equal(p.utils.getGameConfig('mua').capsulePath, defaults.capsulePath);
    assert.equal(p.utils.getHeroImagePath('mua'), defaults.heroImagePath);
    assert.equal(p.art.menuItems('mua').length, 3);
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
    assert.match(menu.textContent, /Change icon\.\.\./);
    assert.doesNotMatch(menu.textContent, /Reset artwork/);
    assert.doesNotMatch(menu.textContent, /Reset icon/);
    p.record.hero = '/custom-art/mua/hero/12.png';
    await p.art.load('mua');
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    assert.match(menu.textContent, /Reset artwork/);
    p.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(menu.hidden, true);
});

test('artwork: every supported language supplies the new artwork labels', () => {
    const p = setup();
    const labels = {
        en: ['Change icon...', 'Reset icon'],
        fr: ['Changer l’icône...', 'Réinitialiser l’icône'],
        es: ['Cambiar icono...', 'Restablecer icono'],
        ru: ['Изменить значок...', 'Сбросить значок']
    };
    p.art.records.mua = { icon: '/custom-art/mua/icon/12.png' };
    for (const language of ['en', 'fr', 'es', 'ru']) {
        p.window.LauncherI18n.setLanguage(language);
        assert.equal(p.art.menuItems('mua')[0].label, 'Change artwork...');
        assert.equal(p.art.menuItems('mua')[1].label, 'Change banner...');
        assert.equal(p.art.menuItems('mua')[2].label, labels[language][0]);
        assert.equal(p.art.menuItems('mua')[3].label, labels[language][1]);
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

test('artwork: icon preview updates existing sidebar nodes and survives a fresh UI session for every game', async () => {
    for (const game of ['mua', 'mua2', 'xml2', 'muac', 'xml1']) {
        const record = {};
        const p = setup({ game, record });
        p.window.AppViews.renderSidebarGames();
        const item = p.document.querySelector(`.sidebar .game-item[data-game="${game}"]`);
        const image = item.querySelector('img');
        const title = item.getAttribute('aria-label');
        const other = p.document.querySelector(`.sidebar .game-item[data-game="${game === 'mua' ? 'xml1' : 'mua'}"] img`);
        const otherSrc = other.getAttribute('src');
        const capsule = p.utils.getGameConfig(game).capsulePath;
        // Simulate the existing sidebar fallback when a bundled ICO could not load.
        image.setAttribute('src', capsule);
        await p.art.change(game, 'icon');
        assert.match(p.messages[0][1], /artwork-preview-icon/);
        assert.equal(p.calls.find(c => c.command === 'pick-artwork').data.title, 'Change icon...');
        assert.equal(image.getAttribute('src'), `/custom-art/${game}/icon/abc.png`);
        assert.equal(item.querySelector('img'), image, 'keep the live sidebar node and its focus/listeners');
        assert.equal(item.getAttribute('aria-label'), title);
        assert.equal(other.getAttribute('src'), otherSrc);
        assert.equal(p.utils.getGameConfig(game).capsulePath, capsule);
        const restarted = setup({ game, record });
        await restarted.art.loadAll();
        restarted.window.AppViews.renderSidebarGames();
        assert.equal(restarted.document.querySelector(`.game-item[data-game="${game}"] img`).getAttribute('src'), `/custom-art/${game}/icon/abc.png`);
        await restarted.art.reset(game, 'icon');
        assert.equal(restarted.document.querySelector(`.game-item[data-game="${game}"] img`).getAttribute('src'), restarted.utils.GAME_CONFIGS[game].iconPath);
    }
});

test('artwork: Reset icon preserves cards and banners; Reset artwork clears every kind', async () => {
    const record = { capsule: '/custom-art/mua/capsule/12.png', hero: '/custom-art/mua/hero/34.jpg', icon: '/custom-art/mua/icon/56.png' };
    const p = setup({ record });
    await p.art.loadAll();
    p.window.AppViews.renderLibrary();
    const card = p.document.querySelector('.library-card[data-game="mua"]');
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const reset = p.document.querySelectorAll('.library-card-menu-item').find(button => button.textContent === 'Reset icon');
    assert.ok(reset);
    reset.click();
    await settle();
    assert.equal(p.utils.getIconPath('mua'), p.utils.GAME_CONFIGS.mua.iconPath);
    assert.equal(p.utils.getGameConfig('mua').capsulePath, record.capsule);
    assert.equal(p.utils.getHeroImagePath('mua'), record.hero);
    assert.equal(p.calls.find(c => c.command === 'reset-artwork').data.kind, 'icon');
    await p.art.change('mua', 'icon');
    await p.art.reset('mua');
    assert.deepEqual(record, {});
    assert.equal(p.utils.getIconPath('mua'), p.utils.GAME_CONFIGS.mua.iconPath);
});

test('artwork: broken and stale icon errors restore only the current icon default', async () => {
    const p = setup({ record: { icon: '/custom-art/mua/icon/12.png', capsule: '/custom-art/mua/capsule/34.png' } });
    await p.art.loadAll();
    p.window.AppViews.renderSidebarGames();
    const image = p.document.querySelector('.game-item[data-game="mua"] img');
    p.record.icon = '/custom-art/mua/icon/56.png';
    await p.art.load('mua', true);
    // The original icon probe is after the capsule probe.
    p.images[1].onerror();
    await settle();
    assert.equal(image.getAttribute('src'), '/custom-art/mua/icon/56.png');
    assert.equal(p.calls.filter(c => c.command === 'reset-artwork').length, 0);
    const error = new p.window.Event('error');
    image.dispatchEvent(error);
    await settle();
    assert.equal(error.stopped, true, 'stop the sidebar capsule fallback for a managed icon failure');
    assert.equal(image.getAttribute('src'), p.utils.GAME_CONFIGS.mua.iconPath);
    assert.equal(p.utils.getGameConfig('mua').capsulePath, '/custom-art/mua/capsule/34.png');
    assert.equal(p.calls.find(c => c.command === 'reset-artwork').data.record, '56.png');
});

test('artwork: invalid icon records, refused files, oversized images and cancellation preserve the existing icon', async () => {
    for (const options of [
        { picked: { error: true } }, { imageFails: true }, { width: 4001, height: 4000 }, { width: 0 },
        { picked: { record: 'abc.png', preview: 'https://example.invalid/icon.png' } },
        { picked: { record: 'abc.png', preview: '/custom-art/mua/icon/../../abc.png' } }, { choice: 1 }
    ]) {
        const p = setup({ ...options, record: { icon: '/custom-art/mua/icon/12.png' } });
        // Install the existing state without loading probes that the decode-failure fixture would reject.
        p.art.records.mua = { icon: p.record.icon };
        await p.art.change('mua', 'icon');
        assert.equal(p.utils.getIconPath('mua'), '/custom-art/mua/icon/12.png');
        assert.equal(p.calls.some(c => c.command === 'confirm-artwork' && !c.data.cancel), false);
    }
    const p = setup({ record: { icon: '/custom-art/mua/hero/12.png' } });
    await p.art.loadAll();
    assert.equal(p.utils.getIconPath('mua'), p.utils.GAME_CONFIGS.mua.iconPath);
});

test('artwork: pad context menu reaches Change icon, Use artwork, Cancel and Reset icon', async () => {
    const p = setup({ focus: true });
    p.document.getElementById('home-page').style.display = 'none';
    p.document.getElementById('library-page').style.display = 'block';
    p.window.AppViews.renderLibrary();
    p.window.AppViews.renderSidebarGames();
    const nav = p.window.FocusNav;
    const card = p.document.querySelector('.library-card[data-game="mua"]');
    const reach = label => {
        // The harness has no layout: give buttons vertical rectangles so this exercises
        // real D-pad spatial navigation, including membership in the focus candidate list.
        nav.setRectSource(element => {
            const buttons = p.document.querySelectorAll('.library-card-menu-item, .mb-buttons button');
            const index = buttons.indexOf(element);
            return { left: 20, top: 20 + Math.max(0, index) * 40, width: 180, height: 30,
                right: 200, bottom: 50 + Math.max(0, index) * 40 };
        });
        for (let i = 0; i < 20 && p.document.activeElement.textContent !== label; i++) nav.press('ArrowDown', 'pad');
        assert.equal(p.document.activeElement.textContent, label);
    };
    const open = () => { card.focus(); nav.press('ContextMenu', 'pad'); nav.sync(); };
    open();
    reach('Change icon...');
    nav.press('Enter', 'pad');
    await settle(); nav.sync();
    const modal = p.document.getElementById('message-box');
    assert.ok(modal.querySelector('.artwork-preview-icon'));
    assert.equal(p.document.activeElement.textContent, 'Use artwork');
    nav.press('Enter', 'pad');
    await settle(); nav.sync();
    assert.equal(p.utils.getIconPath('mua'), '/custom-art/mua/icon/abc.png');
    assert.equal(p.document.activeElement, card);
    open(); reach('Change icon...'); nav.press('Enter', 'pad');
    await settle(); nav.sync();
    reach('Cancel'); nav.press('Enter', 'pad');
    await settle(); nav.sync();
    assert.equal(p.calls.filter(c => c.command === 'confirm-artwork' && c.data.cancel).length, 1);
    assert.equal(p.document.activeElement, card);
    open(); reach('Reset icon'); nav.press('Enter', 'pad');
    await settle(); nav.sync();
    assert.equal(p.utils.getIconPath('mua'), p.utils.GAME_CONFIGS.mua.iconPath);
    assert.equal(p.document.activeElement, card);
});

test('artwork: higher contrast band covers bright uninstalled custom cards only', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const css = fs.readFileSync(path.join(__dirname, '../../launcher-ui/assets/css/main.css'), 'utf8');
    const rule = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/([^{}]*\.library-card\.has-custom-art::after[^{}]*)\{([^{}]+)\}/);
    assert.ok(rule, 'custom art needs a title contrast band');
    assert.ok(rule[1].trim().split(',').every(selector => /has-custom-art|has-custom-banner/.test(selector)), 'default-art selectors must never receive this fade');
    assert.match(rule[2], /pointer-events: none/);
    const stops = Array.from(rule[2].matchAll(/rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)\s*([\d.]+)%/g), match => match.slice(1).map(Number));
    assert.ok(stops.length >= 2);
    assert.ok(stops.at(-1)[4] >= 70, 'the fade must reach above the bottom title band');
    // Contrast of white title text over near-white art, including its uninstalled dimming.
    // Test the resulting contrast instead of requiring one exact set of gradient stops.
    for (const picture of [255, 255 * 0.9]) for (const height of [15, 30]) {
        const next = stops.findIndex(stop => stop[4] >= height);
        assert.ok(next > 0, 'the gradient must cover both title lines');
        const from = stops[next - 1], to = stops[next];
        const mix = (height - from[4]) / (to[4] - from[4]);
        const color = from.slice(0, 4).map((value, i) => value + (to[i] - value) * mix);
        const linear = color.slice(0, 3).map(value => {
            const srgb = (value * color[3] + picture * (1 - color[3])) / 255;
            return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
        });
        const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
        assert.ok(1.05 / (luminance + 0.05) >= 7, `title contrast too low at ${height}% on artwork ${picture}`);
    }
    const p = setup({ game: 'muac', record: { capsule: '/custom-art/muac/capsule/12.png' } });
    await p.art.loadAll();
    const surface = await renderArtworkSurfaces(p);
    assert.equal(surface.library.classList.contains('is-installed'), false, 'exercise the dimmed library card');
    assert.ok(surface.library.classList.contains('has-custom-art'));
    const home = surface.home;
    assert.ok(home.classList.contains('has-custom-art'));
    await p.art.reset('muac');
    assert.equal(surface.library.classList.contains('has-custom-art'), false);
    assert.equal(home.classList.contains('has-custom-art'), false);
});
