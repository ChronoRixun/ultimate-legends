// Managed retail-disc setup. Hiding this popup leaves the native job running.
(function () {
    'use strict';
    const t = key => window.LauncherI18n.t(`muac.${key}`);
    const esc = value => GameUtils.escapeHtml(String(value || ''));
    const run = (command, payload = {}) => window.executeCommand(command, payload);
    let host, timer, last = {}, source = '', output = '', starting = false, notified = false;
    let returnFocus;
    let formError = '';
    let updating = false, opening = false;
    function hide() {
        host?.remove(); host = null;
        if (!last.active) { clearTimeout(timer); timer = null; }
        const nextFocus = document.body.contains(returnFocus) ? returnFocus :
            Array.from(document.querySelectorAll('#muac-button-group button')).find(button => !button.disabled);
        nextFocus?.focus?.({ preventScroll: true });
    }
    function render() {
        if (!host) return;
        const focus = host.contains(document.activeElement) ? document.activeElement?.dataset?.act : null;
        const busy = starting || last.active;
        host.innerHTML = `<div class="component-selection-popup xml1-setup active" role="dialog" aria-modal="true" aria-labelledby="muac-setup-title">
            <div class="popup-header"><h3 id="muac-setup-title">${esc(t(updating ? 'updateTitle' : 'setupTitle'))}</h3><button class="popup-close" data-act="hide" type="button" aria-label="${esc(t('setupHide'))}">×</button></div>
            <div class="popup-content">
                <p>${esc(t(updating ? 'updateBody' : 'setupBody'))}</p>
                ${!updating && !busy && !last.success ? `<div class="xml1-setup-fields">
                    <label for="muac-source">${esc(t('setupSource'))}</label>
                    <input id="muac-source" class="xml1-input" value="${esc(source)}" autocomplete="off">
                    <div class="setup-actions"><button class="btn-cancel" type="button" data-act="iso">${esc(t('setupIso'))}</button>
                    <button class="btn-cancel" type="button" data-act="folder">${esc(t('setupDiscFolder'))}</button></div>
                    <label for="muac-output">${esc(t('setupOutput'))}</label>
                    <input id="muac-output" class="xml1-input" value="${esc(output)}" autocomplete="off">
                    <div class="setup-actions"><button class="btn-cancel" type="button" data-act="output">${esc(t('setupBrowse'))}</button></div>
                </div>` : ''}
                <p class="muac-setup-progress" role="status" aria-live="polite"></p>
                <p class="muac-setup-error" role="alert">${esc(formError || last.error)}</p>
                <div class="setup-actions">
                    ${busy ? `<button class="btn-cancel" type="button" data-act="cancel" ${last.cancelled ? 'disabled' : ''}>${esc(t(last.cancelled ? 'setupCancelling' : updating ? 'updateCancel' : 'setupCancel'))}</button>` :
                        last.success ? `<button class="btn-primary" type="button" data-act="done">${esc(t('setupDone'))}</button>` :
                        `${updating ? '' : `<button class="btn-cancel" type="button" data-act="existing">${esc(t('setupExisting'))}</button>`}<button class="btn-primary" type="button" data-act="start">${esc(t(updating ? 'updateStart' : 'setupStart'))}</button>`}
                    <button class="btn-cancel" type="button" data-act="hide">${esc(t('setupHide'))}</button>
                </div>
            </div></div>`;
        host.querySelector('#muac-source')?.addEventListener('input', event => { source = event.target.value; });
        host.querySelector('#muac-output')?.addEventListener('input', event => { output = event.target.value; });
        progress();
        const previous = focus ? host.querySelector(`[data-act="${focus}"]`) : null;
        const cancelButton = host.querySelector('[data-act="cancel"]');
        const next = previous && !previous.disabled ? previous :
            (cancelButton && !cancelButton.disabled ? cancelButton : null) || host.querySelector('[data-act="done"]') ||
            host.querySelector('[data-act="start"]') || host.querySelector('[data-act="hide"]');
        next?.focus({ preventScroll: true });
    }
    function progress() {
        const line = host?.querySelector('.muac-setup-progress');
        if (!line) return;
        line.textContent = last.success ? t(updating ? 'updateReady' : 'setupReady') : starting ? t('setupPreparing') :
            last.active && last.cleaning ? t('setupCleaning') :
            last.active ? `${last.message || last.phase || t('setupPreparing')}${last.percent > 0 ? ` — ${Math.floor(last.percent)}%` : ''}` : '';
    }
    async function poll() {
        clearTimeout(timer);
        try {
            const next = await run('get-muac-setup');
            const changed = next.active !== last.active || next.success !== last.success || next.error !== last.error || next.cancelled !== last.cancelled;
            last = next;
            if (changed) render(); else progress();
            if (last.success && !notified) {
                notified = true;
                window.dispatchEvent(new CustomEvent('gameInstallationUpdated', { detail: { game: 'muac' } }));
                window.MuacView?.reload();
            }
        } catch (error) {
            // A transient poll failure does not imply that native setup has stopped.
            if (host) host.querySelector('.muac-setup-error').textContent = error.message || String(error);
        }
        if (last.active || host) timer = setTimeout(poll, 750);
    }
    async function action(event) {
        const button = event.target.closest('[data-act]');
        if (!button || button.disabled) return;
        const act = button.dataset.act;
        try {
            if (act === 'hide' || act === 'done') { hide(); return; }
            if (act === 'cancel') { last = await run('cancel-muac-setup'); render(); return; }
            if (last.active || starting) return;
            if (act === 'existing') {
                hide(); new SetupFlowPopup().show('muac', 'Marvel: Ultimate Alliance (2006 PC)'); return;
            }
            if (act === 'iso' || act === 'folder' || act === 'output') {
                const path = act === 'iso' ? await run('browse-file', { title: t('setupSource'), filters: [{ name: 'DVD ISO', pattern: '*.iso' }] }) : await run('browse-folder');
                if (path) { if (act === 'output') output = path; else source = path; render(); }
                host?.querySelector(`[data-act="${act}"]`)?.focus();
                return;
            }
            if (act === 'start') {
                if (!updating && (!source.trim() || !output.trim())) throw new Error(t('setupPaths'));
                starting = true; last = {}; formError = ''; notified = false; render();
                const result = updating ? await run('start-muac-update') : await run('start-muac-setup', { source: source.trim(), output: output.trim() });
                if (!result?.success) throw new Error(result?.error || t('setupFailed'));
                last = await run('get-muac-setup');
            }
        } catch (error) { formError = error.message || String(error); }
        finally { starting = false; render(); }
    }
    async function show(update = false) {
        if (host || opening) return false;
        opening = true;
        try {
            returnFocus = document.activeElement;
            try { last = await run('get-muac-setup'); } catch (_) { last = {}; }
            updating = last.active ? !!last.updating : update;
            if (!last.active && (update || updating !== !!last.updating)) last = {};
            formError = ''; notified = false;
            host = document.createElement('div');
            host.className = 'component-selection-backdrop xml1-setup-backdrop active';
            host.addEventListener('click', action);
            host.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); hide(); } });
            document.body.appendChild(host); render();
            (host.querySelector('input') || host.querySelector('[data-act="done"]') || host.querySelector('[data-act="hide"]'))?.focus();
            poll();
            return true;
        } finally { opening = false; }
    }
    async function showUpdate() {
        if (await show(true) && !last.active && updating) {
            const start = host?.querySelector('[data-act="start"]');
            if (start) { start.focus(); await action({ target: start }); }
        }
    }
    window.MuacSetup = { show: () => show(false), showUpdate, hide };
})();
