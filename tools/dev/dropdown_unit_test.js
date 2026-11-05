// Run: node --test --test-isolation=none tools/dev/dropdown_unit_test.js
// Behavior tests using a small DOM adapter; browser/layout coverage is separate.
// Export the same cases to src/tests/ui/run.js, and support a focused Node test run.
const cases = [];
const test = (name, run) => cases.push({ name, run });
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDOM } = require('./dropdown_test_dom');
const repo = path.resolve(__dirname, '../..');
const context = vm.createContext(createDOM());
const { document, window, Event } = context;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const load = file => vm.runInContext(fs.readFileSync(path.join(repo, 'src/launcher-ui/assets/js', file), 'utf8'), context, { filename: file });
load('ui/dropdown.js');
const menu = () => document.getElementById('launcher-dropdown-list');
const key = (button, value, modifiers = {}) => button.dispatchEvent(new Event('keydown', { key: value, bubbles: true, cancelable: true, ...modifiers }));

async function fixture(markup) {
    window.LauncherDropdowns.close();
    document.body.replaceChildren();
    // The shared menu is body-level and is not normally removed by application renders.
    if (retainedMenu) document.body.append(retainedMenu);
    const host = document.createElement('div');
    host.innerHTML = markup || '<label for="channel">Update channel</label><select id="channel" class="setting-select"><option value="stable">Stable</option><option value="beta">Beta</option><option value="dev" disabled>Development</option><option value="nightly">Nightly</option></select>';
    document.body.append(host);
    await tick();
    const select = host.querySelector('select');
    return { host, select, button: select.nextElementSibling };
}
let retainedMenu;

for (const pad of [false, true]) test(`a busy channel keeps ${pad ? 'pad' : 'keyboard'} focus while refusing a second pick`, async () => {
        const { select, button } = await fixture();
        select.dataset.keepFocus = 'true';
        select.addEventListener('change', () => { select.disabled = true; });
        button.focus();
        const press = value => pad
            ? window.LauncherDropdowns.handleKey(button, new Event('keydown', { key: value, bubbles: true, cancelable: true }))
            : key(button, value);
        press('Enter'); press('ArrowDown'); press('Enter');
        await tick();
        assert.equal(select.value, 'beta');
        assert.equal(select.disabled, true);
        assert.equal(button.disabled, false);
        assert.equal(button.getAttribute('aria-disabled'), 'true');
        assert.equal(document.activeElement, button);
        press('Enter');
        button.click();
        assert.equal(menu().hidden, true, 'busy choice cannot reopen');
        select.disabled = false;
        await tick();
        assert.equal(document.activeElement, button);
        assert.equal(button.getAttribute('aria-disabled'), 'false');
});

test('dynamic selects get a named focusable combobox and listbox with selected/disabled options', async () => {
    const { select, button } = await fixture();
    assert.ok(button, 'select has no in-page trigger');
    assert.equal(button.getAttribute('role'), 'combobox');
    assert.equal(button.textContent, 'Stable');
    assert.equal(select.tabIndex, -1);
    assert.equal(select.getAttribute('aria-hidden'), 'true');
    assert.equal(document.getElementById(button.getAttribute('aria-labelledby')).textContent, 'Update channel');
    button.click();
    assert.equal(menu().getAttribute('role'), 'listbox');
    assert.equal(menu().children.length, 4);
    assert.equal(menu().children[0].getAttribute('aria-selected'), 'true');
    assert.equal(menu().children[2].getAttribute('aria-disabled'), 'true');
});
test('arrow navigation previews then commits one input/change from original select', async () => {
    const { host, select, button } = await fixture();
    const events = [];
    for (const type of ['input', 'change']) host.addEventListener(type, event => events.push([type, event.target, event.target.value]));
    button.focus(); key(button, 'ArrowDown'); key(button, 'ArrowDown'); key(button, 'ArrowDown');
    assert.equal(select.value, 'stable');
    assert.equal(events.length, 0);
    key(button, 'Enter');
    assert.equal(select.value, 'nightly');
    assert.deepEqual(events, [['input', select, 'nightly'], ['change', select, 'nightly']]);
    assert.equal(document.activeElement, button);
    button.click(); key(button, 'Enter');
    assert.equal(events.length, 2);
});
test('Home/End, Space, Escape, Tab and type-ahead preserve cancel/commit behavior', async () => {
    const { select, button } = await fixture();
    key(button, ' '); key(button, 'End'); key(button, 'Home'); key(button, 'b'); key(button, 'Escape');
    assert.equal(menu().hidden, true); assert.equal(select.value, 'stable');
    key(button, 'b'); key(button, ' ');
    assert.equal(select.value, 'beta');
    key(button, 'ArrowUp'); key(button, 'Home'); key(button, 'Tab');
    assert.equal(menu().hidden, true); assert.equal(select.value, 'beta');
});
test('click commits and outside pointer/click plus focus/window blur dismiss', async () => {
    const { select, button } = await fixture();
    button.focus(); button.click(); menu().children[1].click();
    assert.equal(select.value, 'beta'); assert.equal(menu().hidden, true);
    button.click(); document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, pointerType: 'touch' }));
    assert.equal(menu().hidden, true);
    button.click(); document.body.click(); assert.equal(menu().hidden, true);
    button.click(); document.body.focus(); assert.equal(menu().hidden, true);
    button.focus(); button.click(); window.dispatchEvent(new Event('blur')); assert.equal(menu().hidden, true);
});
test('programmatic values, labels, selectedIndex and disabled state synchronize', async () => {
    const { select, button } = await fixture();
    select.value = 'beta'; assert.equal(button.textContent, 'Beta');
    select.options[1].textContent = 'Bêta'; await tick(); assert.equal(button.textContent, 'Bêta');
    select.selectedIndex = 0; assert.equal(button.textContent, 'Stable');
    button.click(); select.disabled = true; await tick();
    assert.equal(button.disabled, true); assert.equal(menu().hidden, true);
});
test('an open menu reflects programmatic selection and keeps an enabled active descendant after option changes', async () => {
    const { select, button } = await fixture();
    button.click(); select.value = 'beta';
    assert.equal(menu().children[1].getAttribute('aria-selected'), 'true');
    select.options[0].disabled = true;
    await tick();
    const active = document.getElementById(button.getAttribute('aria-activedescendant'));
    assert.equal(active.getAttribute('aria-disabled'), 'false');
    select.replaceChildren(); await tick();
    assert.equal(button.hasAttribute('aria-activedescendant'), false);
});
test('hidden/detached triggers dismiss; enhancement is idempotent', async () => {
    const { host, button } = await fixture();
    window.LauncherDropdowns.enhance(host); assert.equal(host.querySelectorAll('button').length, 1);
    button.click(); host.hidden = true; await tick(); assert.equal(menu().hidden, true);
    host.hidden = false; button.click(); host.remove(); await tick(); assert.equal(menu().hidden, true);
});
test('hiding a source select hides its trigger and closes the popup', async () => {
    const { select, button } = await fixture();
    button.click(); select.hidden = true; await tick();
    assert.equal(button.hidden, true);
    assert.equal(menu().hidden, true);
    select.hidden = false; await tick();
    assert.equal(button.hidden, false);
});
test('positions above a bottom-edge trigger and scrolls active long-list entries', async () => {
    const { button } = await fixture(`<select>${Array.from({ length: 60 }, (_, i) => `<option>${i}</option>`).join('')}</select>`);
    button.rect = { left: 1150, top: 760, bottom: 796, right: 1390, width: 240, height: 36 };
    button.click();
    assert.equal(menu().style.left, '1032px');
    assert.equal(menu().style.top, '436px');
    assert.equal(menu().style.maxHeight, '320px');
    key(button, 'End'); assert.ok(menu().scrollTop > 0);
    window.dispatchEvent(new Event('resize')); assert.equal(menu().hidden, true);
});
test('repeated-letter type-ahead cycles and disabled optgroups cannot be chosen', async () => {
    const { select, button } = await fixture('<select><option value="b1">Beta one</option><optgroup disabled><option value="b2">Beta two</option></optgroup><option value="b3">Beta three</option></select>');
    key(button, 'b'); key(button, 'b'); key(button, 'Enter');
    assert.equal(select.value, 'b1');
    button.click(); menu().children[1].click(); assert.equal(select.value, 'b1'); assert.equal(menu().hidden, false);
    key(button, 'End'); key(button, 'Enter'); assert.equal(select.value, 'b3');
});
test('empty/all-disabled selects and modifier shortcuts do not change values or throw', async () => {
    const { select, button } = await fixture('<select><option value="x" disabled>X</option></select>');
    key(button, 'ArrowDown', { ctrlKey: true }); assert.equal(button.getAttribute('aria-expanded'), 'false');
    for (const value of ['ArrowDown', 'End', 'Home', 'q', 'Enter', 'Escape']) key(button, value);
    assert.equal(select.value, 'x');
    select.replaceChildren(); await tick();
    for (const value of ['ArrowDown', 'End', 'Home', 'q', 'Enter', 'Escape']) key(button, value);
    assert.equal(select.value, '');
});
test('only one dropdown opens, menu scrolling stays open and page scrolling closes', async () => {
    const { host, button } = await fixture();
    const second = document.createElement('select');
    second.innerHTML = '<option>Other</option>';
    host.append(second); await tick();
    button.click(); second.nextElementSibling.click();
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(second.nextElementSibling.getAttribute('aria-expanded'), 'true');
    menu().dispatchEvent(new Event('scroll'));
    assert.equal(menu().hidden, false);
    document.body.dispatchEvent(new Event('scroll'));
    assert.equal(menu().hidden, true);
});
test('Escape is consumed by an open dropdown before a parent modal handles it', async () => {
    const { host, button } = await fixture();
    let escapes = 0;
    host.addEventListener('keydown', event => { if (event.key === 'Escape') escapes++; });
    button.click(); key(button, 'Escape');
    assert.equal(escapes, 0);
    key(button, 'Escape'); assert.equal(escapes, 1);
});
test('actual theme/language handlers persist properties and reload through the shared control', async () => {
    const markup = fs.readFileSync(path.join(repo, 'src/launcher-ui/main.html'), 'utf8').match(/<body[^>]*>([\s\S]*)<\/body>/)[1];
    await fixture(`<div>${markup}</div>`);
    load('core/utils.js'); load('core/i18n.js'); load('app/main.js');
    const properties = {};
    window.executeCommand = async (command, payload) => {
        if (command === 'set-property') { Object.assign(properties, payload); return true; }
        if (command === 'get-property') return properties[payload] ?? null;
        return null;
    };
    vm.runInContext("refreshLocalizedUI = async () => window.LauncherI18n.applyStaticTranslations()", context);
    await vm.runInContext('loadLauncherSettings()', context);
    vm.runInContext('setupThemeSelect()', context);
    const theme = document.getElementById('theme-select');
    theme.nextElementSibling.click(); key(theme.nextElementSibling, 'End'); key(theme.nextElementSibling, 'Enter');
    await tick(); assert.equal(properties['launcher-theme'], 'navy-gradient');
    theme.value = 'dark'; await vm.runInContext('loadLauncherSettings()', context);
    assert.equal(theme.nextElementSibling.textContent, 'Navy Gradient');
    await vm.runInContext('setupLanguageSelect()', context);
    const language = document.getElementById('language-select');
    key(language.nextElementSibling, ' '); key(language.nextElementSibling, 'Home'); key(language.nextElementSibling, 'ArrowDown'); key(language.nextElementSibling, 'Enter');
    await tick(); assert.equal(properties['launcher-language'], 'fr');
    assert.equal(language.nextElementSibling.textContent, 'Francais');
});
test('actual XML1/XML2 display rendering, custom values and delegated saves use unchanged payloads', async () => {
    await fixture('<div></div><select><option>fixture</option></select>');
    window.LauncherI18n.setLanguage('en');
    load('app/display-view.js');
    const values = { Mode: 'borderless', FrameRate: 180 };
    const writes = [];
    window.executeCommand = async (command, payload) => {
        if (command === 'get-display-settings') return {
            installed: true, fixInstalled: true, desktop: { width: 1280, height: 800, refresh: 60 },
            modes: [{ width: 800, height: 600 }], values: { ...values }
        };
        if (command === 'set-display-settings') {
            writes.push(JSON.stringify(payload)); Object.assign(values, payload.values);
            return { success: true, values: { ...values } };
        }
        throw new Error(`Unexpected command ${command}`);
    };
    for (const game of ['xml2', 'xml1']) {
        values.Mode = 'borderless';
        delete values.Width;
        delete values.Height;
        const panel = document.createElement('div'); panel.id = `${game}-display-panel`; document.body.append(panel);
        window.DisplayView.render(game); await tick();
        assert.equal(panel.querySelectorAll('[role="combobox"]').length, 4);
        const find = name => panel.querySelector(`select[data-key="${name}"]`);
        assert.equal(find('FrameRate').nextElementSibling.textContent, '180 fps (from xml2-fix.ini)');
        const resolution = find('Resolution');
        resolution.nextElementSibling.click(); key(resolution.nextElementSibling, 'End'); key(resolution.nextElementSibling, 'Enter');
        await new Promise(resolve => setTimeout(resolve, 280));
        assert.equal(writes.at(-1), JSON.stringify({ game, values: { Width: 800, Height: 600 } }));
        const mode = find('Mode');
        mode.nextElementSibling.click(); key(mode.nextElementSibling, 'Home'); key(mode.nextElementSibling, 'Enter');
        await new Promise(resolve => setTimeout(resolve, 280));
        assert.equal(writes.at(-1), JSON.stringify({ game, values: { Mode: null } }));
        assert.equal(resolution.disabled, true);
        assert.equal(resolution.nextElementSibling.disabled, true);
        panel.remove();
    }
});

async function channelFixture(commandHandler) {
    const markup = fs.readFileSync(path.join(repo, 'src/launcher-ui/main.html'), 'utf8').match(/<body[^>]*>([\s\S]*)<\/body>/)[1];
    await fixture(`<div>${markup}</div>`);
    window.LauncherI18n.setLanguage('en');
    window.LauncherUpdate = null;
    // Installation-change listeners on main.js refresh unrelated pages. Keep this fixture
    // scoped to the channel handler/CEF boundary, without initializing the whole application.
    vm.runInContext('initializeSettingsPage = async () => {}', context);
    window.executeCommand = commandHandler;
    // Advance backend polling promptly, keeping the production polling/choose code intact.
    context.setTimeout = (fn, delay) => setTimeout(fn, delay === 1000 ? 0 : delay);
    load('app/update-channel.js');
    await window.UpdateChannel.init();
    await tick();
    const select = document.getElementById('update-channel-select');
    return { select, button: select.nextElementSibling };
}

test('real update-channel selection emits the original value/change and persists Beta across reload', async () => {
    const saved = { channel: 'stable' };
    const writes = [];
    const { select, button } = await channelFixture(async (command, payload) => {
        if (command === 'set-update-channel') { writes.push(JSON.stringify(payload)); saved.channel = payload.channel; }
        assert.ok(['get-update-channel', 'set-update-channel'].includes(command), command);
        return { channel: saved.channel, checking: false, items: [] };
    });
    const changes = [];
    select.parentElement.addEventListener('change', event => changes.push([event.target, event.target.value]), true);
    button.focus(); key(button, 'Enter'); key(button, 'ArrowDown');
    assert.equal(writes.length, 0);
    key(button, 'Enter'); await tick(); await tick(); await tick();
    assert.equal(changes.length, 1);
    assert.ok(changes[0][0] === select, 'change source must remain the original select');
    assert.equal(changes[0][1], 'beta');
    assert.deepEqual(writes, ['{"channel":"beta"}']);
    assert.equal(saved.channel, 'beta');
    assert.equal(button.textContent, 'Beta');
    select.value = 'stable'; window.UpdateChannel.status = null;
    await window.UpdateChannel.init();
    assert.equal(select.value, 'beta'); assert.equal(button.textContent, 'Beta');
    assert.equal(writes.length, 1);
});

test('real update-channel busy state keeps focus, locks the choice, and restores Stable after a refused save', async () => {
    let refuse;
    const { select, button } = await channelFixture(async command => {
        if (command === 'set-update-channel') return new Promise((_, reject) => { refuse = reject; });
        return { channel: 'stable', checking: false, items: [] };
    });
    button.focus(); key(button, 'Enter'); key(button, 'End'); key(button, 'Enter'); await tick();
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(document.activeElement, button);
    key(button, 'Enter');
    assert.equal(menu().hidden, true);
    const originalConsole = context.console;
    context.console = { ...console, error: (...args) => {
        if (args[0] !== 'update channel: switching failed') originalConsole.error(...args);
    } };
    try { refuse(new Error('test: refused save')); await tick(); }
    finally { context.console = originalConsole; }
    assert.equal(select.value, 'stable'); assert.equal(button.textContent, 'Stable');
    assert.equal(button.disabled, false);
});

test('cancelling or confirming the same update channel does not save', async () => {
    let writes = 0;
    const { button } = await channelFixture(async command => {
        if (command === 'set-update-channel') writes++;
        return { channel: 'stable', checking: false, items: [] };
    });
    key(button, 'Enter'); key(button, 'End'); key(button, 'Escape');
    key(button, 'Enter'); key(button, 'Enter'); await tick();
    assert.equal(writes, 0);
});

test('Open Update channel focuses and scrolls the visible replacement', async () => {
    const { button } = await channelFixture(async () => ({ channel: 'stable', items: [] }));
    window.UpdateChannel.openSetting(); await tick();
    assert.ok(document.activeElement === button, 'visible channel trigger should receive focus');
    assert.equal(button.lastScrollIntoView.block, 'center');
});

test('update-channel status redraw preserves the open picker preview until Escape', async () => {
    const { select, button } = await channelFixture(async () => ({ channel: 'stable', items: [] }));
    key(button, 'Enter'); key(button, 'End');
    const preview = button.getAttribute('aria-activedescendant');
    assert.ok(select.classList.contains('is-picking'));
    window.UpdateChannel.render(); await tick();
    assert.equal(button.getAttribute('aria-activedescendant'), preview);
    assert.equal(select.value, 'stable');
    key(button, 'Escape'); assert.equal(select.classList.contains('is-picking'), false);
});

test('the real update-channel handler also saves Stable without starting an unapproved downgrade', async () => {
    let saved = 'beta'; const writes = [];
    const { select, button } = await channelFixture(async (command, payload) => {
        if (command === 'set-update-channel') { writes.push(JSON.stringify(payload)); saved = payload.channel; }
        assert.ok(['get-update-channel', 'set-update-channel'].includes(command), command);
        return { channel: saved, checking: false, items: [] };
    });
    key(button, 'Enter'); key(button, 'Home'); key(button, 'Enter');
    await tick(); await tick(); await tick();
    assert.equal(select.value, 'stable'); assert.equal(button.textContent, 'Stable');
    assert.deepEqual(writes, ['{"channel":"stable"}']);
});

test('Models costume metadata and focus survive the page re-render', async () => {
    const { host } = await fixture('<div id="xml1-models-panel"></div><select><option>fixture</option></select>');
    const panel = host.querySelector('#xml1-models-panel');
    load('app/models-view.js');
    const state = window.ModelsView._state('xml1');
    const status = { tool: { found: true }, port: { built: true }, settings: { mode: 'xml2', costumes: {} }, installed: [] };
    state.status = status;
    state.scan = { heroes: { cyclops: { tiers: { xml2: { costumes: ['0101', '0102'] } } } } };
    state.plan = { rows: [{ hero: 'cyclops', name: 'Cyclops', tier: 'xml2', source: '0101' }] };
    window.executeCommand = async command => { assert.equal(command, 'get-models-status'); return status; };
    window.ModelsView.render('xml1'); await tick();
    let source = panel.querySelector('select');
    const oldButton = source.nextElementSibling;
    assert.equal(oldButton.dataset.focus, 'costume-cyclops');
    oldButton.focus();
    window.ModelsView.render('xml1'); await tick();
    source = panel.querySelector('select');
    assert.notEqual(source.nextElementSibling, oldButton);
    assert.equal(document.activeElement, source.nextElementSibling);
    assert.equal(source.nextElementSibling.id, oldButton.id);
});

test('the actual Models costume handler saves the same hero/tier/source payload', async () => {
    const { host } = await fixture('<div id="xml1-models-panel"></div><select><option>fixture</option></select>');
    const panel = host.querySelector('#xml1-models-panel');
    const state = window.ModelsView._state('xml1');
    const status = { tool: { found: true }, port: { built: true }, settings: { mode: 'xml2', costumes: {} }, installed: [] };
    const rows = [{ hero: 'cyclops', name: 'Cyclops', tier: 'xml2', source: '0101' }];
    Object.assign(state, { status, chosen: null, plan: { rows }, job: null });
    const writes = [];
    window.executeCommand = async (command, payload) => {
        if (command === 'get-models-status') return status;
        if (command === 'set-models-settings') {
            writes.push(JSON.stringify(payload)); status.settings.costumes = payload.costumes;
            rows[0].source = '0102';
            return { success: true, settings: status.settings };
        }
        if (command === 'models-run') return { success: true, id: 'fixture-plan' };
        if (command === 'get-models-job') return {
            finished: true, exitCode: 0,
            lines: [JSON.stringify({ event: 'result', rows })]
        };
        throw new Error(`Unexpected command ${command}`);
    };
    window.ModelsView.render('xml1'); await tick();
    const select = panel.querySelector('select'); const button = select.nextElementSibling;
    key(button, 'Enter'); key(button, 'End'); key(button, 'Enter'); await tick(); await tick();
    assert.deepEqual(writes, ['{"costumes":{"cyclops":"xml2:0102"}}']);
    assert.equal(status.settings.costumes.cyclops, 'xml2:0102');
});

test('FocusNav capture routes A/D-pad/B through the dropdown and keeps closed-control spatial navigation', async () => {
    await fixture('<select id="pad-select"><option value="stable">Stable</option><option value="beta">Beta</option></select><button id="next">Next</button>');
    load('core/focus-nav.js');
    const select = document.getElementById('pad-select'); const button = select.nextElementSibling;
    const next = document.getElementById('next');
    button.rect = { left: 20, right: 220, top: 100, bottom: 136, width: 200, height: 36 };
    next.rect = { left: 20, right: 220, top: 180, bottom: 216, width: 200, height: 36 };
    button.focus(); window.FocusNav.press('ArrowDown'); assert.equal(document.activeElement, next);
    button.focus(); window.FocusNav.press('Enter'); window.FocusNav.press('ArrowDown'); window.FocusNav.press('Enter');
    assert.equal(select.value, 'beta'); assert.equal(menu().hidden, true);
    window.FocusNav.press('Enter'); window.FocusNav.press('ArrowUp'); window.FocusNav.press('Escape');
    assert.equal(select.value, 'beta'); assert.equal(menu().hidden, true);
});

test('FocusNav Backspace closes an open dropdown before navigating back', async () => {
    const { button } = await fixture();
    button.focus(); window.FocusNav.press('Enter'); window.FocusNav.press('Backspace');
    assert.equal(menu().hidden, true);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('GamepadNav polling routes real A/D-pad/B actions into the in-page picker', async () => {
    const { select, button } = await fixture();
    load('core/gamepad-nav.js');
    const pad = { connected: true, buttons: Array(16).fill(0), axes: [0, 0] };
    context.navigator.getGamepads = () => [pad];
    const tap = index => {
        pad.buttons[index] = 1; window.GamepadNav.poll();
        pad.buttons[index] = 0; window.GamepadNav.poll();
    };
    button.focus(); tap(0); tap(13); tap(0);
    assert.equal(select.value, 'beta'); assert.equal(menu().hidden, true);
    tap(0); tap(12); tap(1);
    assert.equal(select.value, 'beta'); assert.equal(menu().hidden, true);
    context.navigator.getGamepads = () => [];
});

test('Steam Input keyboard/gamepad echo does not double-activate the dropdown', async () => {
    await new Promise(resolve => setTimeout(resolve, 110));
    const { select, button } = await fixture();
    button.focus(); window.FocusNav.press('Enter', 'key'); window.FocusNav.press('Enter', 'pad');
    assert.equal(window.FocusNav.isPadMuted(), true);
    assert.equal(menu().hidden, false);
    window.FocusNav.press('ArrowDown', 'key'); window.FocusNav.press('Enter', 'key');
    assert.equal(select.value, 'beta'); assert.equal(menu().hidden, true);
});

test('save import enhances source, campaign and slot pickers and restores visible focus after redraw', async () => {
    await new Promise(resolve => setTimeout(resolve, 110));
    const { host } = await fixture('<div id="xml1-save-import"></div><select id="fixture-select"><option>Fixture</option></select>');
    const { reply } = require('../../src/tests/ui/fake_save_import_cli');
    const calls = []; let scenario = 'recomp'; let result;
    window.executeCommand = async (command, request) => {
        calls.push({ command, request });
        if (command === 'browse-folder') return 'C:\\Owned\\Recomp\\UDATA';
        if (command === 'browse-file') return 'C:\\Owned\\disk.qcow2';
        if (command === 'xml1-import-start') {
            result = reply(request.mode, request, scenario).at(-1);
            return { success: true, id: calls.length };
        }
        if (command === 'get-xml1-job') return { id: request.id, finished: true, active: false, exitCode: 0, result };
        return null;
    };
    load('app/xml1-save-import.js'); window.Xml1SaveImport.enabled = true; window.Xml1SaveImport.open(); await tick();
    const select = id => document.getElementById(`xml1-import-${id}`);
    const trigger = id => document.getElementById(`xml1-import-${id}-button`);
    const action = name => host.querySelector(`[data-import-act="${name}"]`);
    assert.equal(document.activeElement, trigger('source-type'));
    assert.equal(select('source-type').tabIndex, -1);
    trigger('source-type').click(); key(trigger('source-type'), 'End'); key(trigger('source-type'), 'Enter'); await tick();
    assert.equal(select('source-type').value, 'recomp');
    assert.equal(document.activeElement, trigger('source-type'), 'redraw restored the visible trigger');
    action('source').click(); await tick(); action('target').click(); await tick();
    assert.equal(trigger('slot').getAttribute('role'), 'combobox');
    await new Promise(resolve => setTimeout(resolve, 110));
    trigger('slot').focus(); trigger('slot').click(); key(trigger('slot'), 'ArrowDown'); key(trigger('slot'), 'Enter'); await tick();
    assert.equal(select('slot').value, '0');
    assert.equal(document.activeElement, trigger('slot'));
    assert.equal(action('preview').disabled, false);
    scenario = 'hdd-multiple';
    select('source-type').value = 'hdd'; select('source-type').dispatchEvent(new Event('change')); await tick();
    action('source').click(); await tick();
    assert.equal(trigger('campaign').getAttribute('role'), 'combobox');
    await new Promise(resolve => setTimeout(resolve, 110));
    trigger('campaign').focus(); trigger('campaign').click(); key(trigger('campaign'), 'End'); key(trigger('campaign'), 'Enter'); await tick();
    assert.equal(select('campaign').value, '1');
    assert.equal(calls.filter(call => call.command === 'xml1-import-start').at(-1).request.campaign, 'E:/UDATA/4156001e/Campaign B');
    assert.equal(document.activeElement.id, 'xml1-import-campaign-button');
    const unrelated = document.createElement('button'); host.append(unrelated); unrelated.focus();
    window.Xml1SaveImport.mount(); assert.equal(document.activeElement, unrelated);
});

test('recomp folder campaign selection keeps focus reachable when reinspection removes its picker', async () => {
    const { host } = await fixture('<div id="xml1-save-import"></div><select id="fixture-select"><option>Fixture</option></select>');
    const { reply } = require('../../src/tests/ui/fake_save_import_cli'); let result;
    window.executeCommand = async (command, request) => {
        if (command === 'browse-folder') return 'C:\\Owned\\Recomp\\UDATA';
        if (command === 'xml1-import-start') { result = reply(request.mode, request, 'recomp-multiple').at(-1); return { success: true, id: 1 }; }
        if (command === 'get-xml1-job') return { id: 1, finished: true, active: false, exitCode: 0, result };
        return null;
    };
    load('app/xml1-save-import.js'); window.Xml1SaveImport.enabled = true; window.Xml1SaveImport.open();
    const type = document.getElementById('xml1-import-source-type');
    type.value = 'recomp'; type.dispatchEvent(new Event('change'));
    host.querySelector('[data-import-act="source"]').click(); await tick();
    document.getElementById('xml1-import-campaign-button').focus();
    const campaign = document.getElementById('xml1-import-campaign');
    campaign.value = '1'; campaign.dispatchEvent(new Event('change')); await tick();
    assert.equal(document.getElementById('xml1-import-campaign-button'), null);
    assert.equal(host.querySelector('[data-import-act="preview"]').disabled, true);
    assert.equal(document.activeElement.dataset.importAct, 'target');
    assert.equal(document.activeElement.isConnected, true);
});

module.exports = cases.map(({ name, run }) => ({ name, async run() {
    try { await run(); }
    finally { window.LauncherDropdowns.close(); retainedMenu = menu(); }
} }));

if (require.main === module) {
    const { test: nodeTest } = require('node:test');
    for (const { name, run } of module.exports) nodeTest(name, run);
}
