// Display section of the X-Men Legends II page (and of the X-Men Legends port's, which runs on the
// same fix): the [Display] section of xml2-fix.ini next to the game, which the XML2 Fix
// (dinput.dll) reads when the game starts and its in-game Advanced
// options write too. Every change is saved on its own (debounced) through the same
// WritePrivateProfileString semantics, so the rest of the file and its comments stay as they are;
// "Game default" removes the key.
(function () {
    'use strict';

    // Games whose fix has a [Display] section.
    const SUPPORTED = new Set(['xml2', 'xml1']);
    const FRAME_RATES = [30, 60, 120, 144, 165, 240];
    // Rows whose change the fix only picks up when the game starts.
    const RESTART_ROWS = new Set(['Mode', 'Resolution', 'VSync']);
    const SAVE_DELAY = 250;

    const state = {};
    const escapeHtml = value => GameUtils.escapeHtml(value);

    function t(key, variables) {
        return window.LauncherI18n ? window.LauncherI18n.t(key, variables) : key;
    }

    function backendId(gameId) {
        return (GameUtils.getGameMapping && GameUtils.getGameMapping(gameId)) || gameId;
    }

    function run(command, payload) {
        return window.executeCommand(command, payload);
    }

    function panel(gameId) {
        return document.getElementById(`${gameId}-display-panel`);
    }

    function getState(gameId) {
        if (!state[gameId]) {
            state[gameId] = { data: null, pending: {}, timer: null };
        }
        return state[gameId];
    }

    function reportError(error) {
        console.error(error);
        window.showToast(String((error && error.message) || error), 'error');
    }

    // ---- values <-> controls ----

    // Width/Height as one "WxH" value; '' when either is absent or 0 (the game's setting).
    function resolutionValue(values) {
        const width = Number(values.Width);
        const height = Number(values.Height);
        return width > 0 && height > 0 ? `${width}x${height}` : '';
    }

    // A 0/1 key as a select value ('' = absent); unreadable values are shown as they are.
    function flagValue(value) {
        if (value === null || value === undefined) return '';
        if (value === true) return '1';
        if (value === false) return '0';
        return String(value);
    }

    function flagOn(value, fallback) {
        return value === true || value === false ? value : fallback;
    }

    function modeOptions() {
        return [
            { value: '', label: t('display.modeDefault') },
            { value: 'fullscreen', label: t('display.modeFullscreen') },
            { value: 'borderless', label: t('display.modeBorderless') },
            { value: 'windowed', label: t('display.modeWindowed') }
        ];
    }

    function resolutionOptions(data) {
        const desktop = data.desktop || {};
        const desktopValue = desktop.width > 0 && desktop.height > 0 ? `${desktop.width}x${desktop.height}` : '';
        const options = [{ value: '', label: t('display.resolutionGame') }];
        if (desktopValue) {
            options.push({ value: desktopValue, label: t('display.resolutionDesktop', { width: desktop.width, height: desktop.height }) });
        }
        (data.modes || []).forEach(mode => {
            const value = `${mode.width}x${mode.height}`;
            if (value !== desktopValue) {
                options.push({ value, label: t('display.resolutionMode', { width: mode.width, height: mode.height }) });
            }
        });
        return options;
    }

    function frameRateOptions(data) {
        const refresh = data.desktop && data.desktop.refresh > 0 ? data.desktop.refresh : 0;
        const options = [{ value: '', label: t('display.frameRateDefault') }];
        FRAME_RATES.forEach(fps => options.push({ value: String(fps), label: t('display.frameRateFps', { fps }) }));
        options.push({ value: 'refresh', label: refresh ? t('display.frameRateRefresh', { hz: refresh }) : t('display.frameRateRefreshUnknown') });
        options.push({ value: '0', label: t('display.frameRateUnlimited') });
        return options;
    }

    function vsyncOptions() {
        return [
            { value: '', label: t('display.vsyncDefault') },
            { value: '0', label: t('display.off') },
            { value: '1', label: t('display.on') }
        ];
    }

    // ---- markup ----

    // The label for a value the file holds that the list doesn't offer (say FrameRate=180).
    function customLabel(key, value) {
        if (key === 'FrameRate' && /^\d+$/.test(value)) return t('display.frameRateCustom', { fps: value });
        if (key === 'Resolution') {
            const [width, height] = value.split('x');
            return t('display.resolutionCustom', { width, height });
        }
        return t('display.customValue', { value });
    }

    function selectHTML(key, options, current) {
        // A value the file holds that isn't offered is listed too, so the row shows what the game
        // will do instead of silently picking something else.
        if (current && !options.some(option => option.value === current)) {
            options.push({ value: current, label: customLabel(key, current) });
        }
        return `<select class="setting-select ul-display-select" data-key="${escapeHtml(key)}">${options
            .map(option => `<option value="${escapeHtml(option.value)}"${option.value === current ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
            .join('')}</select>`;
    }

    function toggleHTML(key, on) {
        return `
            <div class="toggle-group small ul-display-toggle" data-key="${escapeHtml(key)}">
                <button class="toggle-btn${on ? '' : ' active'}" data-value="0">${escapeHtml(t('display.off'))}</button>
                <button class="toggle-btn${on ? ' active' : ''}" data-value="1">${escapeHtml(t('display.on'))}</button>
            </div>`;
    }

    function rowHTML(row, labelKey, control, description) {
        return `
            <div class="ul-display-row" data-row="${escapeHtml(row)}">
                <div class="ul-display-info">
                    <span class="ul-display-label">${escapeHtml(t(labelKey))}</span>
                    <span class="ul-display-description">${escapeHtml(description)}</span>
                    ${RESTART_ROWS.has(row) ? `<span class="ul-display-note">${escapeHtml(t('display.restart'))}</span>` : ''}
                </div>
                <div class="ul-display-control">${control}</div>
            </div>`;
    }

    function emptyHTML(text) {
        return `<div class="ul-display-empty">${escapeHtml(text)}</div>`;
    }

    function render(gameId) {
        const host = panel(gameId);
        if (!host) return;

        host.innerHTML = `
            <div class="ul-display">
                <p class="ul-display-intro">${escapeHtml(t('display.intro'))}</p>
                <div class="ul-display-status" hidden></div>
                <div class="ul-display-body">${emptyHTML(t('display.loading'))}</div>
            </div>`;

        host.querySelector('.ul-display-body').addEventListener('change', event => onChange(gameId, event));
        host.querySelector('.ul-display-body').addEventListener('click', event => onClick(gameId, event));
        load(gameId);
    }

    function showStatus(gameId, text, kind) {
        const status = panel(gameId) && panel(gameId).querySelector('.ul-display-status');
        if (!status) return;
        status.hidden = !text;
        status.textContent = text || '';
        status.className = `ul-display-status${kind ? ` is-${kind}` : ''}`;
    }

    async function load(gameId) {
        const s = getState(gameId);
        try {
            s.data = await run('get-display-settings', { game: backendId(gameId) });
        } catch (error) {
            reportError(error);
            return;
        }
        renderBody(gameId);
    }

    function renderBody(gameId) {
        const host = panel(gameId);
        if (!host) return;
        const body = host.querySelector('.ul-display-body');
        const data = getState(gameId).data;

        if (!data || !data.installed) {
            body.innerHTML = emptyHTML(t('display.setUpFirst'));
            showStatus(gameId, '');
            return;
        }
        if (!data.fixInstalled) {
            body.innerHTML = emptyHTML(t('display.installFix'));
            showStatus(gameId, '');
            return;
        }

        const values = data.values || {};
        body.innerHTML = `
            ${rowHTML('Mode', 'display.mode', selectHTML('Mode', modeOptions(), values.Mode || ''), t('display.modeBody'))}
            ${rowHTML('Resolution', 'display.resolution', selectHTML('Resolution', resolutionOptions(data), resolutionValue(values)), t('display.resolutionBody'))}
            ${rowHTML('FrameRate', 'display.frameRate', selectHTML('FrameRate', frameRateOptions(data), values.FrameRate === null || values.FrameRate === undefined ? '' : String(values.FrameRate)), t('display.frameRateBody'))}
            ${rowHTML('VSync', 'display.vsync', selectHTML('VSync', vsyncOptions(), flagValue(values.VSync)), t('display.vsyncBody'))}
            ${rowHTML('RunInBackground', 'display.runInBackground', toggleHTML('RunInBackground', flagOn(values.RunInBackground, true)), t('display.runInBackgroundBody'))}
            ${rowHTML('Topmost', 'display.topmost', toggleHTML('Topmost', flagOn(values.Topmost, false)), t('display.topmostBody'))}
            <p class="ul-display-footer">${escapeHtml(t('display.storedIn', { file: data.ini || 'xml2-fix.ini' }))}</p>`;
        syncRows(gameId);
        showStatus(gameId, data.running ? t('display.appliesNextLaunch') : '', 'info');
    }

    // Rows that depend on other rows: the resolution only counts for borderless and windowed.
    function syncRows(gameId) {
        const host = panel(gameId);
        const s = getState(gameId);
        if (!host || !s.data || !s.data.values) return;

        const mode = s.data.values.Mode || '';
        const windowed = mode === 'borderless' || mode === 'windowed';
        const row = host.querySelector('.ul-display-row[data-row="Resolution"]');
        if (!row) return;
        row.classList.toggle('is-disabled', !windowed);
        const select = row.querySelector('select');
        if (select) select.disabled = !windowed;
        const description = row.querySelector('.ul-display-description');
        if (description) description.textContent = windowed ? t('display.resolutionBody') : t('display.resolutionHint');
    }

    // ---- saving ----

    function onChange(gameId, event) {
        const select = event.target.closest('.ul-display-select');
        if (!select) return;
        const key = select.dataset.key;
        const value = select.value;
        if (key === 'Resolution') {
            const [width, height] = value ? value.split('x').map(Number) : [null, null];
            queue(gameId, { Width: value ? width : null, Height: value ? height : null });
            return;
        }
        queue(gameId, { [key]: value === '' ? null : value });
    }

    function onClick(gameId, event) {
        const button = event.target.closest('.ul-display-toggle .toggle-btn');
        if (!button) return;
        const group = button.closest('.ul-display-toggle');
        group.querySelectorAll('.toggle-btn').forEach(b => b.classList.toggle('active', b === button));
        queue(gameId, { [group.dataset.key]: button.dataset.value === '1' });
    }

    // Collects changes for a moment and writes them in one go; the rows follow right away.
    function queue(gameId, changes) {
        const s = getState(gameId);
        Object.assign(s.pending, changes);
        if (s.data && s.data.values) Object.assign(s.data.values, changes);
        syncRows(gameId);
        clearTimeout(s.timer);
        s.timer = setTimeout(() => flush(gameId), SAVE_DELAY);
    }

    async function flush(gameId) {
        const s = getState(gameId);
        const changes = s.pending;
        s.pending = {};
        s.timer = null;
        if (!Object.keys(changes).length) return;

        try {
            const result = await run('set-display-settings', { game: backendId(gameId), values: changes });
            if (!result || !result.success) throw new Error((result && result.error) || t('display.saveFailed'));
            // What the file holds now, unless newer edits are already waiting.
            if (s.data && result.values && !Object.keys(s.pending).length) {
                s.data.values = result.values;
                syncRows(gameId);
            }
        } catch (error) {
            reportError(error);
            load(gameId); // back to what the file says
        }
    }

    // Refresh when the game's page is opened: the fix may have been installed, or the in-game
    // options may have changed the file, since the last look.
    document.addEventListener('click', event => {
        const item = event.target.closest && event.target.closest('.game-item[data-game]');
        if (item && SUPPORTED.has(backendId(item.dataset.game)) && panel(item.dataset.game)) {
            setTimeout(() => load(item.dataset.game), 0);
        }
    }, true);

    window.DisplayView = {
        supports: gameId => SUPPORTED.has(backendId(gameId)),
        render,
        reload: load
    };
})();
