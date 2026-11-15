// The optional Vulkan renderer (DXVK) of the XML2-engine games (offered on X-Men Legends only for now), in Display & options. Off by default and
// nothing is downloaded until the player turns it on and confirms: then the launcher (dxvk_commands.cpp)
// downloads the one pinned official release (DXVK 3.1.1 from github.com/doitsujin/dxvk), checks its
// SHA-256 and the SHA-256 of the two files it uses, and puts the 32-bit d3d8.dll and d3d9.dll next to the
// game. Turning it off removes exactly those files. A d3d8.dll / d3d9.dll that isn't the pinned one is
// never replaced or removed. Under Proton the game already runs through Proton's own DXVK, so the switch
// is off there (only Remove remains when the files are present).
(function () {
    'use strict';

    // Only X-Men Legends (Legends Classic) for now; add 'xml2' (and "xml2" in dxvk::offered_for, display/dxvk.cpp)
    // to offer it on X-Men Legends II too, once tested there.
    const SUPPORTED = new Set(['xml1']);
    const POLL_MS = 500;
    const state = {};

    const t = (key, values) => (window.LauncherI18n ? window.LauncherI18n.t(`dxvk.${key}`, values) : key);
    const esc = value => GameUtils.escapeHtml(value);
    const backendId = game => (GameUtils.getGameMapping && GameUtils.getGameMapping(game)) || game;
    const host = game => document.getElementById(`${game}-dxvk-panel`);
    const get = game => state[game] || (state[game] = { data: null, epoch: 0, timer: null, asking: false });
    const building = game => game === 'xml1' && window.Xml1Port && (window.Xml1Port.starting || window.Xml1Port.isBuilding());

    function percent(data) {
        return data && data.total > 0 ? Math.max(0, Math.min(100, Math.floor(100 * data.done / data.total))) : 0;
    }

    function phaseText(data) {
        const version = data.version || '';
        switch (data.phase) {
            case 'download': return t('downloading', { version, percent: percent(data) });
            case 'verify': return t('verifying');
            case 'install': return t('installing');
            case 'remove': return t('removing');
            default: return t('working');
        }
    }

    // What the row says under the switch, and how it looks.
    function status(game, data) {
        const version = data.version || '';
        if (data.busy) return { text: phaseText(data), kind: 'info' };
        if (data.error) return { text: data.error, kind: 'error' };
        if (data.wine) return { text: data.files === 'none' ? t('proton') : t('protonInstalled', { version }), kind: 'info' };
        if (data.files === 'foreign') return { text: t('foreign', { version }), kind: 'warn' };
        if (data.files === 'partial') return { text: t('partial', { version }), kind: 'warn' };
        if (data.files === 'ours') return { text: building(game) ? t('building') : data.running ? t('running') : t('on', { version }), kind: 'ok' };
        if (data.wanted) return { text: t('missing'), kind: 'warn' };
        if (building(game)) return { text: t('building'), kind: 'info' };
        if (data.offline && !data.cached) return { text: t('offline'), kind: 'info' };
        return { text: t('off'), kind: 'info' };
    }

    function render(game) {
        const h = host(game);
        if (!h || !SUPPORTED.has(game)) return;
        if (!h.dataset.bound) {
            h.dataset.bound = 'true';
            h.addEventListener('click', event => onClick(game, event));
        }
        load(game);
    }

    function draw(game) {
        const h = host(game);
        const s = get(game);
        const data = s.data;
        if (!h || !data) return;
        if (!data.installed) {
            h.innerHTML = `<div class="ul-display ul-dxvk"><div class="ul-display-empty">${esc(t('setUp'))}</div></div>`;
            return;
        }
        const on = data.files === 'ours' || data.files === 'partial';
        const locked = data.busy || s.asking || building(game) || data.running;
        // Turning on: not under Proton, not over someone else's d3d8/d3d9, not offline without the saved download.
        const canOn = !on && !locked && !data.wine && data.files !== 'foreign' && !(data.offline && !data.cached);
        const canOff = on && !locked;
        const note = status(game, data);
        const focused = h.contains(document.activeElement) ? document.activeElement.dataset.value || document.activeElement.dataset.op || '' : '';
        h.innerHTML = `
            <div class="ul-display ul-dxvk" data-files="${esc(data.files)}">
                <p class="ul-display-intro">${esc(t('intro'))}</p>
                <div class="ul-display-row" data-row="dxvk">
                    <div class="ul-display-info">
                        <span class="ul-display-label">${esc(t('label'))}</span>
                        <span class="ul-display-description">${esc(t('body', { version: data.version }))}</span>
                        <span class="ul-dxvk-status is-${esc(note.kind)}" role="status" aria-live="polite">${esc(note.text)}</span>
                        ${data.busy && data.phase === 'download' ? `<div class="xml1-progress-bar ul-dxvk-bar"><div class="xml1-progress-fill" style="width:${percent(data)}%"></div></div>` : ''}
                    </div>
                    <div class="ul-display-control">
                        ${data.busy ? `<button type="button" class="secondary-action xml1-small" data-op="cancel">${esc(t('cancel'))}</button>` : `
                        <div class="toggle-group small ul-dxvk-toggle">
                            <button class="toggle-btn${on ? '' : ' active'}" data-value="0"${canOff ? '' : ' disabled'}>${esc(t('switchOff'))}</button>
                            <button class="toggle-btn${on ? ' active' : ''}" data-value="1"${canOn ? '' : ' disabled'}>${esc(t('switchOn'))}</button>
                        </div>`}
                    </div>
                </div>
                <p class="ul-display-footer">${esc(t('source', { version: data.version }))}</p>
            </div>`;
        if (focused) {
            const candidates = [h.querySelector(`[data-value="${focused}"]`), h.querySelector(`[data-op="${focused}"]`),
                ...h.querySelectorAll('.ul-dxvk-toggle .toggle-btn, [data-op]')];
            const again = candidates.find(element => element && !element.disabled);
            if (again) again.focus();
        }
    }

    async function load(game) {
        const s = get(game);
        const epoch = ++s.epoch;
        clearTimeout(s.timer);
        let data;
        try {
            data = await window.executeCommand('get-dxvk-state', { game: backendId(game) });
        } catch (error) {
            if (epoch === s.epoch) window.showToast(String((error && error.message) || error), 'error');
            return;
        }
        if (epoch !== s.epoch || !data) return;
        s.data = data;
        draw(game);
        if (data.busy) s.timer = setTimeout(() => load(game), POLL_MS);
        else if (shouldRestore(game, data)) restore(game);
    }

    // A rebuild or repair of the port sweeps every file it didn't make, DXVK's too (Legends Classic's
    // sweep_stale keeps only the XML2 Fix's). The player chose it and the checked download is kept: put it
    // back once, without asking again; if that fails, the row says so and offers On.
    function shouldRestore(game, data) {
        const s = get(game);
        return !s.restored && data.installed && data.wanted && data.cached && data.files === 'none' && !data.error &&
            !data.wine && !data.running && !building(game) && !s.asking;
    }

    async function restore(game) {
        const s = get(game);
        s.restored = true;
        try {
            await window.executeCommand('set-dxvk', { game: backendId(game), enabled: true });
        } catch (_) {
            // The next load shows what happened.
        }
        await load(game);
    }

    async function turnOn(game) {
        const s = get(game);
        const data = s.data;
        if (!data || s.asking) return;
        s.asking = true;
        draw(game);
        try {
            // The player agrees to this one download, with its source and size in front of them.
            if (!data.cached) {
                const size = GameUtils.formatBytes ? GameUtils.formatBytes(Number(data.size) || 0) : `${data.size} bytes`;
                const choice = await window.showMessageBox(t('confirmTitle', { version: data.version }),
                    esc(t('confirmBody', { version: data.version, size })), [window.LauncherI18n ? window.LauncherI18n.t('common.cancel') : 'Cancel', t('confirm')]);
                if (choice !== 1) return;
            }
            const result = await window.executeCommand('set-dxvk', { game: backendId(game), enabled: true });
            if (!result || !result.success) window.showToast((result && result.error) || t('failed'), 'error', 8000);
        } catch (error) {
            window.showToast(String((error && error.message) || error), 'error');
        } finally {
            s.asking = false;
            await load(game);
        }
    }

    async function turnOff(game) {
        const s = get(game);
        if (!s.data || s.asking) return;
        s.asking = true;
        draw(game);
        try {
            const result = await window.executeCommand('set-dxvk', { game: backendId(game), enabled: false });
            if (!result || !result.success) window.showToast((result && result.error) || t('failed'), 'error', 8000);
        } catch (error) {
            window.showToast(String((error && error.message) || error), 'error');
        } finally {
            s.asking = false;
            await load(game);
        }
    }

    async function cancel(game) {
        try {
            await window.executeCommand('cancel-dxvk', { game: backendId(game) });
        } catch (_) {
            // The next poll shows where it stands.
        }
        load(game);
    }

    function onClick(game, event) {
        const target = event.target && event.target.closest ? event.target : null;
        if (!target) return;
        const toggle = target.closest('.ul-dxvk-toggle .toggle-btn');
        if (toggle && !toggle.disabled && !toggle.classList.contains('active')) {
            if (toggle.dataset.value === '1') turnOn(game);
            else turnOff(game);
            return;
        }
        const op = target.closest('[data-op="cancel"]');
        if (op && !op.disabled) cancel(game);
    }

    // Opening the game's page, a build starting or ending, the game starting or stopping: look again.
    document.addEventListener('click', event => {
        const item = event.target && event.target.closest ? event.target.closest('.game-item[data-game]') : null;
        if (item && SUPPORTED.has(item.dataset.game) && host(item.dataset.game)) load(item.dataset.game);
    }, true);
    window.addEventListener('gameInstallationUpdated', () => Object.keys(state).forEach(load));
    window.addEventListener('ul-xml1-changed', () => {
        if (state.xml1 && state.xml1.data) draw('xml1');
        if (state.xml1 && !building('xml1')) load('xml1');
    });

    window.DxvkView = {
        supports: game => SUPPORTED.has(game),
        render,
        reload: load,
        get state() { return state; }
    };
})();
