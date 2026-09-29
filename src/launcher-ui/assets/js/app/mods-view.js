// Mods tab of a game's page: the game's <install>\mods folders, in load order, for the mod
// loaders in the XML2 Fix and MUA Controller Fix. Lower rows load later, so they win when two
// mods change the same file.
(function () {
    'use strict';

    // Games whose patch DLL includes the mod loader.
    const SUPPORTED = new Set(['mua', 'mua2', 'xml2', 'xml1']);

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
        return document.getElementById(`${gameId}-mods-panel`);
    }

    function getState(gameId) {
        if (!state[gameId]) {
            state[gameId] = { data: null, busy: false, importing: null };
        }
        return state[gameId];
    }

    function formatSize(bytes) {
        if (!bytes) return '0 KB';
        const units = ['B', 'KB', 'MB', 'GB'];
        let value = bytes;
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit++;
        }
        return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
    }

    function reportError(error) {
        console.error(error);
        window.showToast(String((error && error.message) || error), 'error');
    }

    function rowHTML(mod, index, count) {
        const title = mod.title || mod.name;
        const details = [
            mod.version ? t('mods.version', { version: mod.version }) : '',
            mod.author ? t('mods.by', { author: mod.author }) : '',
            t(mod.files === 1 ? 'mods.fileCountOne' : 'mods.fileCount', { count: mod.files, size: formatSize(mod.size) })
        ].filter(Boolean).join(' · ');

        return `
            <li class="ul-mod${mod.enabled ? '' : ' is-disabled'}" data-name="${escapeHtml(mod.name)}">
                <label class="ul-mod-toggle" title="${escapeHtml(t(mod.enabled ? 'mods.disable' : 'mods.enable'))}">
                    <input type="checkbox" class="ul-mod-enabled"${mod.enabled ? ' checked' : ''}>
                    <span class="ul-mod-switch"></span>
                </label>
                <div class="ul-mod-info">
                    <div class="ul-mod-title">${escapeHtml(title)}${mod.title && mod.title !== mod.name ? ` <span class="ul-mod-folder">${escapeHtml(mod.name)}</span>` : ''}</div>
                    <div class="ul-mod-details">${escapeHtml(details)}</div>
                    ${mod.description ? `<div class="ul-mod-description">${escapeHtml(mod.description)}</div>` : ''}
                </div>
                <div class="ul-mod-order">
                    <button class="ul-mod-icon-button ul-mod-up" title="${escapeHtml(t('mods.moveUp'))}"${index === 0 ? ' disabled' : ''}>&#9650;</button>
                    <button class="ul-mod-icon-button ul-mod-down" title="${escapeHtml(t('mods.moveDown'))}"${index === count - 1 ? ' disabled' : ''}>&#9660;</button>
                </div>
                <div class="ul-mod-actions">
                    <button class="secondary-action ul-mod-open" title="${escapeHtml(t('mods.openModFolder'))}"><span class="secondary-action-icon folder-icon"></span></button>
                    <button class="secondary-action ul-mod-remove" title="${escapeHtml(t('mods.remove'))}">${escapeHtml(t('mods.remove'))}</button>
                </div>
            </li>`;
    }

    function render(gameId) {
        const host = panel(gameId);
        if (!host) return;
        const s = getState(gameId);

        host.innerHTML = `
            <div class="ul-mods">
                <div class="ul-mods-toolbar">
                    <div class="ul-mods-add">
                        <button class="secondary-action ul-mods-add-zip">${escapeHtml(t('mods.addZip'))}</button>
                        <button class="secondary-action ul-mods-add-folder">${escapeHtml(t('mods.addFolder'))}</button>
                    </div>
                    <div class="ul-mods-tools">
                        <button class="secondary-action ul-mods-open"><span class="secondary-action-icon folder-icon"></span>${escapeHtml(t('mods.openFolder'))}</button>
                        <button class="secondary-action ul-mods-refresh" title="${escapeHtml(t('mods.refreshHint'))}">${escapeHtml(t('mods.refresh'))}</button>
                    </div>
                </div>
                <p class="ul-mods-hint">${escapeHtml(t('mods.orderHint'))}</p>
                <div class="ul-mods-status" hidden></div>
                <div class="ul-mods-body"><div class="ul-mods-empty">${escapeHtml(t('mods.loading'))}</div></div>
            </div>`;

        host.querySelector('.ul-mods-add-zip').addEventListener('click', () => addMod(gameId, 'zip'));
        host.querySelector('.ul-mods-add-folder').addEventListener('click', () => addMod(gameId, 'folder'));
        host.querySelector('.ul-mods-open').addEventListener('click', () => openFolder(gameId));
        host.querySelector('.ul-mods-refresh').addEventListener('click', () => load(gameId));
        host.querySelector('.ul-mods-body').addEventListener('click', event => onListClick(gameId, event));
        host.querySelector('.ul-mods-body').addEventListener('change', event => onListChange(gameId, event));

        if (s.importing) {
            showStatus(gameId, t('mods.installing', { name: s.importing }));
        }
        load(gameId);
    }

    function showStatus(gameId, text, kind) {
        const status = panel(gameId) && panel(gameId).querySelector('.ul-mods-status');
        if (!status) return;
        status.hidden = !text;
        status.textContent = text || '';
        status.className = `ul-mods-status${kind ? ` is-${kind}` : ''}`;
    }

    async function load(gameId) {
        const s = getState(gameId);
        try {
            s.data = await run('get-mods', { game: backendId(gameId) });
        } catch (error) {
            reportError(error);
            return;
        }
        renderList(gameId);
    }

    function renderList(gameId) {
        const host = panel(gameId);
        if (!host) return;
        const body = host.querySelector('.ul-mods-body');
        const data = getState(gameId).data;

        if (!data || !data.installed) {
            body.innerHTML = `<div class="ul-mods-empty">${escapeHtml(t('mods.setUpFirst'))}</div>`;
            host.querySelectorAll('.ul-mods-add button, .ul-mods-open').forEach(b => { b.disabled = true; });
            return;
        }
        host.querySelectorAll('.ul-mods-add button, .ul-mods-open').forEach(b => { b.disabled = false; });

        if (data.running) {
            showStatus(gameId, t('mods.appliesNextLaunch'), 'info');
        }

        const mods = data.mods || [];
        if (!mods.length) {
            body.innerHTML = `<div class="ul-mods-empty">${escapeHtml(t('mods.empty'))}</div>`;
            return;
        }
        body.innerHTML = `<ol class="ul-mods-list">${mods.map((mod, i) => rowHTML(mod, i, mods.length)).join('')}</ol>`;
    }

    async function onListChange(gameId, event) {
        const checkbox = event.target.closest('.ul-mod-enabled');
        if (!checkbox) return;
        const name = checkbox.closest('.ul-mod').dataset.name;
        try {
            const result = await run('set-mod-enabled', { game: backendId(gameId), name, enabled: checkbox.checked });
            if (!result || !result.success) throw new Error((result && result.error) || t('mods.saveFailed'));
        } catch (error) {
            reportError(error);
        }
        load(gameId);
    }

    async function onListClick(gameId, event) {
        const row = event.target.closest('.ul-mod');
        if (!row) return;
        const name = row.dataset.name;

        if (event.target.closest('.ul-mod-up')) return move(gameId, name, -1);
        if (event.target.closest('.ul-mod-down')) return move(gameId, name, 1);
        if (event.target.closest('.ul-mod-open')) {
            const data = getState(gameId).data;
            return run('open-folder', { path: `${data.folder}\\${name}` }).catch(reportError);
        }
        if (event.target.closest('.ul-mod-remove')) return remove(gameId, name);
    }

    async function move(gameId, name, delta) {
        const data = getState(gameId).data;
        const names = (data.mods || []).map(mod => mod.name);
        const from = names.indexOf(name);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= names.length) return;
        names.splice(to, 0, names.splice(from, 1)[0]);
        try {
            const result = await run('set-mod-order', { game: backendId(gameId), names });
            if (!result || !result.success) throw new Error((result && result.error) || t('mods.saveFailed'));
        } catch (error) {
            reportError(error);
        }
        load(gameId);
    }

    async function remove(gameId, name) {
        const choice = await window.showMessageBox(t('mods.removeTitle'), t('mods.removeBody', { name }), [t('common.cancel'), t('mods.remove')]);
        if (choice !== 1) return;
        try {
            const result = await run('uninstall-mod', { game: backendId(gameId), name });
            if (!result || !result.success) throw new Error((result && result.error) || t('mods.removeFailed'));
            window.showToast(t('mods.removed', { name }), 'success');
        } catch (error) {
            reportError(error);
        }
        load(gameId);
    }

    async function openFolder(gameId) {
        const data = getState(gameId).data;
        if (!data || !data.folder) return;
        try {
            await run('open-folder', { path: data.folder, create: true });
        } catch (error) {
            reportError(error);
        }
    }

    async function addMod(gameId, kind) {
        const s = getState(gameId);
        if (s.importing) return;

        let source = null;
        try {
            source = kind === 'zip'
                ? await run('browse-file', { title: t('mods.pickZip'), filters: [{ name: t('mods.zipFilter'), pattern: '*.zip' }] })
                : await run('browse-folder', {});
        } catch (error) {
            reportError(error);
            return;
        }
        if (!source) return;

        const label = source.split(/[\\/]/).pop();
        try {
            const started = await run('import-mod', { game: backendId(gameId), path: source, kind });
            if (!started || !started.success) throw new Error((started && started.error) || t('mods.installFailed'));
        } catch (error) {
            reportError(error);
            return;
        }

        s.importing = label;
        showStatus(gameId, t('mods.installing', { name: label }));
        pollImport(gameId);
    }

    async function pollImport(gameId) {
        const s = getState(gameId);
        let job = null;
        try {
            job = await run('get-mod-import', { game: backendId(gameId) });
        } catch (error) {
            job = { active: false, finished: true, error: String(error.message || error) };
        }

        if (job && job.active) {
            setTimeout(() => pollImport(gameId), 300);
            return;
        }

        s.importing = null;
        if (job && job.error) {
            showStatus(gameId, job.error, 'error');
        } else {
            showStatus(gameId, '');
            window.showToast(t('mods.installed', { name: (job && job.name) || '' }), 'success');
        }
        load(gameId);
    }

    // Refresh when the game's page is opened, so mods added outside the launcher show up.
    document.addEventListener('click', event => {
        const item = event.target.closest && event.target.closest('.game-item[data-game]');
        if (item && SUPPORTED.has(backendId(item.dataset.game)) && panel(item.dataset.game)) {
            setTimeout(() => load(item.dataset.game), 0);
        }
    }, true);

    window.ModsView = {
        supports: gameId => SUPPORTED.has(backendId(gameId)),
        render
    };
})();
