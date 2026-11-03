// MUA 2006's prepared installation: graphics wrapper, input fix and OpenSpy.
// These settings are applied on the next game start; no live display-mode changes.
(function () {
    'use strict';
    const t = (key, vars) => window.LauncherI18n.t(key, vars);
    const esc = value => GameUtils.escapeHtml(String(value));
    const run = (name, payload) => window.executeCommand(name, payload || {});
    let data = null, busy = false, refreshing = false;
    const panel = () => document.getElementById('muac-options-panel');
    const row = (key, title, body, options) => {
        const current = data.values[key];
        const choices = options.slice();
        if (!choices.some(([value]) => value === current)) choices.push([current, t('muac.custom', { value: current })]);
        return `<div class="ul-display-row" data-row="${esc(key)}">
            <div class="ul-display-info"><label class="ul-display-label" for="muac-${esc(key)}">${esc(t(title))}</label>
                <span class="ul-display-description">${esc(t(body))}</span></div>
            <div class="ul-display-control"><select id="muac-${esc(key)}" class="setting-select" data-muac-setting="${esc(key)}"
                ${data.running || busy ? 'disabled' : ''}>${choices.map(([value, label]) =>
                    `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></div>
        </div>`;
    };
    const flags = () => [['0', t('display.off')], ['1', t('display.on')]];
    function status(text, failed = false) {
        const element = panel()?.querySelector('.ul-display-status');
        if (!element) return;
        element.textContent = text;
        element.hidden = !text;
        element.className = `ul-display-status is-${failed ? 'error' : 'info'}`;
    }
    function renderBody() {
        const host = panel(); if (!host) return;
        const body = host.querySelector('.ul-display-body');
        if (!data?.installed) {
            body.innerHTML = `<div class="ul-display-empty">${esc(t('muac.setUp'))}</div>`;
            return;
        }
        if (!data.runtimeReady) {
            body.innerHTML = `<div class="ul-display-empty">${esc(t('muac.missing', { files: (data.missing || []).join(', ') }))}</div>`;
            return;
        }
        body.innerHTML = [
            row('Mode', 'display.mode', 'muac.modeBody', [
                ['windowed', t('display.modeWindowed')], ['borderless', t('display.modeBorderless')], ['fullscreen', t('display.modeFullscreen')]]),
            row('Resolution', 'display.resolution', 'muac.resolutionBody', (data.modes || []).map(value => [value, value.replace('x', ' × ')])),
            row('FrameLimit', 'muac.frameLimit', 'muac.frameBody', [30, 60, 120, 144, 165, 240].map(fps => [String(fps), `${fps} FPS`]).concat([['0', t('display.frameRateUnlimited')]])),
            row('VSync', 'display.vsync', 'muac.vsyncBody', flags()),
            row('ControllerSupport', 'muac.controller', 'muac.controllerBody', flags()),
            row('CaptureMouse', 'muac.capture', 'muac.captureBody', flags()),
            row('OnlineService', 'muac.online', 'muac.onlineBody', [['openspy', 'OpenSpy'], ['off', t('display.off')]]),
            row('Watermark', 'muac.watermark', 'muac.watermarkBody', flags())
        ].join('');
        status(data.running ? t('muac.closeFirst') : t('muac.nextStart'));
    }
    async function load() {
        if (busy || refreshing || !panel()) return;
        refreshing = true;
        try { data = await run('get-muac-settings'); renderBody(); }
        catch (error) { status(error.message || String(error), true); }
        finally { refreshing = false; }
    }
    async function save(event) {
        const select = event.target.closest('[data-muac-setting]');
        if (!select || select.disabled || busy) return;
        const key = select.dataset.muacSetting, value = select.value;
        busy = true;
        panel().querySelectorAll('select').forEach(control => { control.disabled = true; });
        status(t('muac.saving'));
        try {
            const result = await run('set-muac-settings', { values: { [key]: value } });
            if (!result?.success) throw new Error(result?.error || t('display.saveFailed'));
            data = result;
            busy = false;
            renderBody();
            // The beta 3 dropdown upgrades new selects via its MutationObserver.
            setTimeout(() => panel()?.querySelector(`[data-muac-setting="${key}"]`)?.focus({ preventScroll: true }), 0);
        } catch (error) {
            busy = false;
            renderBody(); // Always release controls, even if a refresh is pending or fails.
            await load();
            status(error.message || String(error), true);
        }
    }
    function render() {
        const host = panel(); if (!host) return;
        host.innerHTML = `<div class="ul-display"><p class="ul-display-intro">${esc(t('muac.intro'))}</p>
            <div class="ul-display-status" hidden></div><div class="ul-display-body">${esc(t('display.loading'))}</div></div>`;
        host.addEventListener('change', save);
        load();
    }
    document.addEventListener('click', event => {
        if (event.target.closest?.('.game-item[data-game="muac"]')) load();
    }, true);
    window.addEventListener('gameInstallationUpdated', event => { if (event.detail?.game === 'muac') load(); });
    // Only refresh running status on the visible page, without rebuilding active controls.
    setInterval(async () => {
        if (!data?.installed || busy || refreshing || !panel()?.getClientRects().length) return;
        refreshing = true;
        try {
            const latest = await run('get-muac-settings');
            if (latest.running !== data.running || latest.runtimeReady !== data.runtimeReady) { data = latest; renderBody(); }
        } catch (_) { /* Keep the current controls when a background refresh fails. */ }
        finally { refreshing = false; }
    }, 3000);
    window.MuacView = { supports: game => game === 'muac', render, reload: load };
})();
