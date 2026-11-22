// Local presentation options, applied when the game next starts. Each edit
// writes one [Remastered] key; opening this view never enables the profile.
(function () {
    'use strict';
    const state = {};
    const supported = game => ['xml1', 'xml2'].includes(id(game));
    const id = game => (GameUtils.getGameMapping && GameUtils.getGameMapping(game)) || game;
    const t = (key, values) => window.LauncherI18n.t(`remastered.${key}`, values);
    const esc = value => GameUtils.escapeHtml(value);
    const host = game => document.getElementById(`${game}-remastered-panel`);
    const get = game => state[game] || (state[game] = { data: null, busy: false, epoch: 0 });
    const building = game => id(game) === 'xml1' && window.Xml1Port &&
        (window.Xml1Port.starting || window.Xml1Port.isBuilding());
    const defaults = { Enabled: '0', MSAASamples: '4', Anisotropy: '0', AnisotropyOnPointArt: '0', CenteredHud: '0' };
    const choices = {
        Enabled: [['0', 'off'], ['1', 'on']],
        MSAASamples: [['0', 'savedFSAA'], ['2', 'x2'], ['4', 'x4'], ['6', 'x6'], ['8', 'x8']],
        Anisotropy: [['0', 'off'], ['2', 'x2'], ['4', 'x4'], ['8', 'x8'], ['16', 'x16']],
        AnisotropyOnPointArt: [['0', 'off'], ['1', 'on']],
        CenteredHud: [['0', 'off'], ['1', 'on']]
    };
    function value(data, key) {
        const raw = data && data.values && data.values[key];
        return raw === null || raw === undefined ? defaults[key] : String(raw);
    }
    function row(data, key) {
        const current = value(data, key);
        const options = choices[key].map(([v, label]) =>
            `<option value="${v}"${current === v ? ' selected' : ''}>${esc(t(label))}</option>`);
        if (!choices[key].some(([v]) => v === current)) {
            options.push(`<option value="${esc(current)}" selected disabled>${esc(t('invalid', { value: current }))}</option>`);
        }
        // The shared picker upgrades the source select synchronously below.
        return `<div class="ul-display-row" data-row="${key}"><div class="ul-display-info">
            <span class="ul-display-label">${esc(t(key))}</span>
            <span class="ul-display-description">${esc(t(`${key}Body`))}</span></div>
            <div class="ul-display-control"><select class="setting-select ul-remastered-select" data-key="${key}">
            ${options.join('')}</select></div></div>`;
    }
    function sync(game) {
        const h = host(game), s = get(game), data = s.data;
        if (!h || !data) return;
        h.querySelectorAll('select[data-key]').forEach(select => {
            select.value = value(data, select.dataset.key);
            select.disabled = !!(s.busy || building(game) || !data.available ||
                (select.dataset.key !== 'Enabled' && value(data, 'Enabled') !== '1'));
        });
        const status = h.querySelector('[role="status"]');
        if (status) status.textContent = building(game) ? t('building') : s.busy ? t('saving') :
            !data.available ? t('needsFix', { version: data.requiredFix || '1.12.0' }) : t('restart');
    }
    function body(game) {
        const h = host(game), data = get(game).data;
        if (!h || !data) return;
        // Not set up yet (no game or no XML2 Fix): only the set-up line, in the same empty box as Display and
        // Discord; the "update the Fix" status would only repeat it.
        const ready = data.installed && data.fixInstalled;
        h.innerHTML = `<div class="ul-display"><p class="ul-display-intro">${esc(t('intro'))}</p>
            ${ready ? `<p role="status" aria-live="polite" class="ul-display-status"></p>
            ${Object.keys(choices).map(key => row(data, key)).join('')}` :
                `<div class="ul-display-empty">${esc(t('setUp'))}</div>`}</div>`;
        sync(game);
        if (window.LauncherDropdowns) window.LauncherDropdowns.enhance(h);
    }
    async function load(game) {
        const s = get(game);
        if (s.busy) return;
        const epoch = ++s.epoch;
        try {
            const data = await window.executeCommand('get-remastered-settings', { game: id(game) });
            if (epoch !== s.epoch) return;
            s.data = data;
            body(game);
        } catch (error) {
            if (epoch === s.epoch) window.showToast(String(error.message || error), 'error');
        }
    }
    async function save(game, key, selected) {
        const s = get(game);
        if (!s.data || !s.data.available || s.busy || building(game) ||
            !choices[key] || !choices[key].some(([v]) => v === selected)) return;
        s.busy = true;
        ++s.epoch; // an older read cannot overwrite the result of this edit
        sync(game);
        try {
            const result = await window.executeCommand('set-remastered-settings', {
                game: id(game), values: { [key]: selected }
            });
            if (result && result.values) s.data.values = result.values;
            if (!result || !result.success) throw new Error((result && result.error) || t('failed'));
        } catch (error) {
            window.showToast(String(error.message || error), 'error');
        } finally {
            s.busy = false;
            sync(game);
        }
    }
    function render(game) {
        const h = host(game);
        if (!h) return;
        if (!h.dataset.bound) {
            h.dataset.bound = '1';
            h.addEventListener('change', event => {
                const select = event.target.closest('select[data-key]');
                if (select && !select.disabled) save(game, select.dataset.key, select.value);
            });
        }
        load(game);
    }
    document.addEventListener('click', event => {
        const item = event.target.closest && event.target.closest('.game-item[data-game]');
        if (item && supported(item.dataset.game) && host(item.dataset.game)) load(item.dataset.game);
    }, true);
    window.addEventListener('gameInstallationUpdated', () => Object.keys(state).forEach(load));
    window.addEventListener('ul-xml1-changed', () => Object.keys(state).forEach(game => {
        sync(game);
        if (!building(game)) load(game);
    }));
    window.RemasteredView = { supports: supported, render, reload: load };
})();
