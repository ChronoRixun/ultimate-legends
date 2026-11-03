// Real browser DOM and production settings/display handlers; only the CEF boundary is stubbed.
(async () => {
    const results = [];
    const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    const equal = (actual, expected) => assert(actual === expected, `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
    const key = (el, value) => el.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
    const button = select => document.getElementById(`${select.id}-button`) || select.nextElementSibling;
    const list = () => document.querySelector('.launcher-dropdown-list:not([hidden])');
    const test = async (name, fn) => {
        try { await fn(); results.push({ name, ok: true }); }
        catch (error) { results.push({ name, ok: false, error: String(error.stack || error) }); }
        window.LauncherDropdowns?.close();
        document.querySelectorAll('[data-test-fixture]').forEach(el => el.remove());
        await tick();
    };
    const make = async (markup = '<option value="stable">Stable</option><option value="beta">Beta</option><option value="dev" disabled>Development</option><option value="nightly">Nightly</option>') => {
        const host = document.createElement('div');
        host.dataset.testFixture = '';
        host.style.cssText = 'position:fixed;left:30px;top:100px;z-index:20000';
        host.innerHTML = `<label for="test-channel">Update channel</label><select id="test-channel" class="setting-select">${markup}</select>`;
        document.body.append(host);
        await tick();
        const select = host.querySelector('select');
        return { host, select, trigger: button(select) };
    };
    document.body.classList.remove('hidden');
    document.getElementById('settings-page').style.display = 'block';
    await tick();

    await test('renders an accessible in-page listbox and hides the native popup control', async () => {
        const { select, trigger } = await make();
        assert(trigger?.getAttribute('role') === 'combobox', 'missing combobox');
        equal(getComputedStyle(select).display, 'none');
        equal(select.tabIndex, -1);
        equal(trigger.textContent.trim(), 'Stable');
        assert(trigger.getAttribute('aria-labelledby'), 'missing accessible label');
        trigger.click();
        equal(trigger.getAttribute('aria-expanded'), 'true');
        equal(list().getAttribute('role'), 'listbox');
        equal(list().querySelectorAll('[role="option"]').length, 4);
        equal(list().querySelector('[aria-selected="true"]').textContent, 'Stable');
    });
    await test('keyboard previews, skips disabled choices, commits exactly one bubbling change', async () => {
        const { select, trigger, host } = await make();
        const changes = [];
        host.addEventListener('change', event => changes.push([event.target, event.target.value]));
        trigger.focus();
        key(trigger, 'ArrowDown');
        key(trigger, 'ArrowDown');
        equal(select.value, 'stable');
        key(trigger, 'ArrowDown');
        key(trigger, 'Enter');
        equal(select.value, 'nightly');
        equal(changes.length, 1);
        equal(changes[0][0], select);
        equal(changes[0][1], 'nightly');
        equal(document.activeElement, trigger);
        trigger.click();
        key(trigger, 'Enter');
        equal(changes.length, 1);
    });
    await test('Home/End, Space, Escape, Tab and type-ahead work without premature saving', async () => {
        const { select, trigger } = await make();
        key(trigger, ' ');
        key(trigger, 'End');
        key(trigger, 'Home');
        key(trigger, 'b');
        key(trigger, 'Escape');
        equal(select.value, 'stable');
        equal(list(), null);
        key(trigger, 'b');
        key(trigger, ' ');
        equal(select.value, 'beta');
        key(trigger, 'ArrowUp');
        key(trigger, 'Home');
        key(trigger, 'Tab');
        equal(list(), null);
        equal(select.value, 'beta');
    });
    await test('mouse/touch click selects, outside click and focus/window blur dismiss', async () => {
        const { select, trigger } = await make();
        trigger.focus();
        trigger.click();
        list().querySelectorAll('[role="option"]')[1].click();
        equal(select.value, 'beta');
        equal(list(), null);
        trigger.click();
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
        equal(list(), null);
        trigger.click();
        document.body.click();
        equal(list(), null);
        trigger.click();
        document.getElementById('minimize-button').focus();
        equal(list(), null);
        trigger.focus(); trigger.click();
        window.dispatchEvent(new Event('blur'));
        equal(list(), null);
    });
    await test('programmatic values, translated labels and disabled states stay synchronized', async () => {
        const { select, trigger } = await make();
        select.value = 'beta';
        equal(trigger.textContent.trim(), 'Beta');
        select.options[1].textContent = 'Bêta';
        await tick();
        equal(trigger.textContent.trim(), 'Bêta');
        select.selectedIndex = 0;
        equal(trigger.textContent.trim(), 'Stable');
        trigger.click();
        select.disabled = true;
        await tick();
        equal(trigger.disabled, true);
        equal(list(), null);
    });
    await test('one menu at a time, detached/hidden controls close and new renders enhance', async () => {
        const first = await make();
        const secondHost = document.createElement('div');
        secondHost.dataset.testFixture = '';
        secondHost.innerHTML = '<select id="second-select"><option>One</option><option>Two</option></select>';
        document.body.append(secondHost);
        await tick();
        first.trigger.click();
        const second = document.getElementById('second-select-button');
        second.click();
        equal(first.trigger.getAttribute('aria-expanded'), 'false');
        equal(document.querySelectorAll('.launcher-dropdown-list:not([hidden])').length, 1);
        secondHost.hidden = true;
        await tick();
        equal(list(), null);
        first.trigger.click();
        first.host.remove();
        await tick();
        equal(list(), null);
    });
    await test('menu flips up, scrolls long lists and stays in the viewport', async () => {
        const { trigger, host } = await make(Array.from({ length: 80 }, (_, i) => `<option value="${i}">Resolution ${i}</option>`).join(''));
        host.style.top = 'auto'; host.style.bottom = '8px'; host.style.left = 'auto'; host.style.right = '4px';
        trigger.click();
        const menu = list();
        const bounds = menu.getBoundingClientRect();
        assert(bounds.bottom <= trigger.getBoundingClientRect().top, 'menu did not flip up');
        assert(bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight, 'menu clips viewport');
        assert(menu.scrollHeight > menu.clientHeight, 'long list cannot scroll');
        key(trigger, 'End');
        assert(menu.scrollTop > 0, 'keyboard active option is not scrolled into view');
        window.dispatchEvent(new Event('resize'));
        equal(list(), null);
    });
    const properties = {};
    const calls = [];
    window.executeCommand = async (command, payload) => {
        calls.push([command, payload]);
        if (command === 'get-property') return properties[payload] ?? null;
        if (command === 'set-property') { Object.assign(properties, payload); return true; }
        if (command === 'get-display-settings') return {
            installed: true, fixInstalled: true, desktop: { width: 1280, height: 800, refresh: 60 },
            modes: [{ width: 800, height: 600 }], values: { Mode: 'borderless', FrameRate: 180 }
        };
        if (command === 'set-display-settings') return { success: true, values: payload.values };
        return null;
    };
    await test('real theme setting persists via unchanged handler and reloads into the trigger', async () => {
        await loadLauncherSettings();
        setupThemeSelect();
        const select = document.getElementById('theme-select');
        const trigger = button(select);
        trigger.click();
        key(trigger, 'End'); key(trigger, 'Enter');
        await tick();
        equal(properties[PROPERTY_KEYS.LAUNCHER.THEME], 'navy-gradient');
        select.value = 'dark';
        await loadLauncherSettings();
        equal(select.value, 'navy-gradient');
        equal(trigger.textContent.trim(), 'Navy Gradient');
    });
    await test('real language setting persists and translated choices refresh', async () => {
        window.AppViews = null;
        // Keep this test within Settings; navigation would call unrelated game backends.
        const originalRefresh = refreshLocalizedUI;
        refreshLocalizedUI = async () => window.LauncherI18n.applyStaticTranslations();
        try {
            await setupLanguageSelect();
            const select = document.getElementById('language-select');
            const trigger = button(select);
            trigger.click(); key(trigger, 'Home'); key(trigger, 'ArrowDown'); key(trigger, 'Enter');
            await tick();
            equal(properties[PROPERTY_KEYS.LAUNCHER.LANGUAGE], 'fr');
            equal(trigger.textContent.trim(), 'Francais');
            select.value = 'en';
            await setupLanguageSelect();
            equal(select.value, 'fr');
        } finally { refreshLocalizedUI = originalRefresh; window.LauncherI18n.setLanguage('en'); }
    });
    await test('real display controls retain custom values and save mode/resolution/default through delegation', async () => {
        const host = document.createElement('div');
        host.id = 'xml2-display-panel'; host.dataset.testFixture = '';
        document.body.append(host);
        window.DisplayView.render('xml2');
        await tick();
        equal(host.querySelectorAll('[role="combobox"]').length, 4);
        const frame = host.querySelector('select[data-key="FrameRate"]');
        equal(button(frame).textContent.trim(), '180 fps (from xml2-fix.ini)');
        const mode = host.querySelector('select[data-key="Mode"]');
        const resolution = host.querySelector('select[data-key="Resolution"]');
        button(resolution).click(); key(button(resolution), 'End'); key(button(resolution), 'Enter');
        await tick(300);
        let save = calls.filter(([name]) => name === 'set-display-settings').at(-1)[1];
        equal(JSON.stringify(save), JSON.stringify({ game: 'xml2', values: { Width: 800, Height: 600 } }));
        button(mode).click(); key(button(mode), 'Home'); key(button(mode), 'Enter');
        await tick(300);
        save = calls.filter(([name]) => name === 'set-display-settings').at(-1)[1];
        equal(JSON.stringify(save), JSON.stringify({ game: 'xml2', values: { Mode: null } }));
        equal(button(resolution).disabled, true);
    });
    await test('real update-channel control saves Beta, reloads it, and focuses its visible trigger', async () => {
        let saved = 'stable'; const writes = []; const changes = [];
        initializeSettingsPage = async () => {};
        window.LauncherUpdate = null;
        window.executeCommand = async (command, payload) => {
            if (command === 'set-update-channel') { writes.push(JSON.stringify(payload)); saved = payload.channel; }
            assert(['get-update-channel', 'set-update-channel'].includes(command), `Unexpected command ${command}`);
            return { channel: saved, checking: false, items: [] };
        };
        await window.UpdateChannel.init();
        const select = document.getElementById('update-channel-select');
        const trigger = button(select);
        select.parentElement.addEventListener('change', event => changes.push([event.target, event.target.value]), true);
        trigger.focus(); key(trigger, 'Enter'); key(trigger, 'End'); key(trigger, 'Enter');
        await tick(1100);
        equal(writes.length, 1); equal(writes[0], '{"channel":"beta"}');
        equal(changes.length, 1); equal(changes[0][0], select); equal(changes[0][1], 'beta');
        select.value = 'stable'; window.UpdateChannel.status = null;
        await window.UpdateChannel.init();
        equal(select.value, 'beta'); equal(trigger.textContent.trim(), 'Beta');
        window.UpdateChannel.openSetting(); await tick();
        equal(document.activeElement, trigger);
    });
    await test('real Models costume select enhances and retains focus after a redraw', async () => {
        const host = document.createElement('div'); host.id = 'xml1-models-panel'; host.dataset.testFixture = '';
        document.body.append(host);
        const state = window.ModelsView._state('xml1');
        const status = { tool: { found: true }, port: { built: true }, settings: { mode: 'xml2', costumes: {} }, installed: [] };
        Object.assign(state, { status, chosen: null, job: null,
            scan: { heroes: { cyclops: { tiers: { xml2: { costumes: ['0101', '0102'] } } } } },
            plan: { rows: [{ hero: 'cyclops', name: 'Cyclops', tier: 'xml2', source: '0101' }] } });
        window.executeCommand = async command => { equal(command, 'get-models-status'); return status; };
        window.ModelsView.render('xml1'); await tick();
        let select = host.querySelector('select'); const trigger = button(select);
        equal(getComputedStyle(select).display, 'none');
        equal(trigger.dataset.focus, 'costume-cyclops');
        trigger.focus(); window.ModelsView.render('xml1'); await tick();
        select = host.querySelector('select');
        equal(document.activeElement, button(select)); equal(button(select).id, trigger.id);
    });
    await test('released FocusNav capture drives an in-page picker with controller keys', async () => {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script'); script.src = 'assets/js/core/focus-nav.js';
            script.onload = resolve; script.onerror = reject; document.head.append(script);
        });
        const { select, trigger } = await make();
        trigger.focus();
        window.FocusNav.press('Enter'); window.FocusNav.press('ArrowDown'); window.FocusNav.press('Enter');
        equal(select.value, 'beta'); equal(list(), null);
        window.FocusNav.press('Enter'); window.FocusNav.press('ArrowUp'); window.FocusNav.press('Escape');
        equal(select.value, 'beta'); equal(list(), null);
    });
    const output = document.createElement('pre');
    output.id = 'dropdown-test-results';
    output.textContent = JSON.stringify(results);
    document.body.append(output);
})();
