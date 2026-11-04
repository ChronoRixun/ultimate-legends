// Shared installed-version and update line. Most patches update through Verify;
// MUA Classic Fix uses its own runtime-only update job. The backend preserves full
// prerelease versions and checks the selected channel in the background.
(function () {
    'use strict';

    // Games with a patch release (game_config.cpp's patch_file / patch_release_url).
    const SUPPORTED = new Set(['mua', 'mua2', 'xml2', 'xml1', 'muac']);
    const RECHECK_MS = 1500;
    const MAX_RECHECKS = 20;

    const escapeHtml = value => GameUtils.escapeHtml(value);
    const rechecks = {};

    function t(key, variables) {
        return window.LauncherI18n ? window.LauncherI18n.t(key, variables) : key;
    }

    function backendId(gameId) {
        return (GameUtils.getGameMapping && GameUtils.getGameMapping(gameId)) || gameId;
    }

    function slot(gameId) {
        return document.getElementById(`${gameId}-patch`);
    }

    function patchName(gameId) {
        const config = GameUtils.getGameConfig ? GameUtils.getGameConfig(gameId) : null;
        return (config && config.patchName) || t('popup.manageInstall.patchDefault');
    }

    function installedText(status, gameId) {
        if (status.installed === null || status.installed === undefined) return t('detail.patchNotInstalled');
        return status.installed || t(backendId(gameId) === 'muac' ? 'muac.versionUnknown' : 'detail.patchUnknownVersion');
    }

    function html(gameId, status) {
        // A pre-release (the update channel's Beta, update-channel.js): its whole version and a Beta badge.
        const badge = status.prerelease ? ` <span class="beta-badge">${escapeHtml(t('updateChannel.badge'))}</span>` : '';
        const stat = `
            <div class="detail-stat detail-patch-stat">
                <span>${escapeHtml(patchName(gameId))}</span>
                <strong class="detail-patch-installed">${escapeHtml(installedText(status, gameId))}${badge}</strong>
            </div>`;
        const error = backendId(gameId) === 'muac' && status.error
            ? `<p class="detail-patch-check-error" role="status">${escapeHtml(status.error)}</p>` : '';
        if (!status.updateAvailable) return stat + error;

        const label = escapeHtml(t(backendId(gameId) === 'muac' && status.wineMigration ? 'muac.protonMigrationUpdate' : 'detail.patchUpdateAvailable', { version: status.latest }));
        const notice = status.page ? `<a href="${escapeHtml(status.page)}" target="_blank">${label}</a>` : label;
        return `${stat}${error}
            <div class="detail-patch-update">
                <span class="detail-patch-update-label">${notice}</span>
                <button type="button" class="secondary-action detail-patch-update-action" data-game="${escapeHtml(gameId)}"
                        title="${escapeHtml(t(backendId(gameId) === 'muac' ? 'muac.updateBody' : 'detail.patchUpdateHint', { version: status.latest }))}">
                    <span class="secondary-action-icon verify-icon"></span>
                    ${escapeHtml(t('detail.patchUpdate'))}
                </button>
            </div>`;
    }

    async function render(gameId) {
        const target = slot(gameId);
        if (!target || typeof window.executeCommand !== 'function') return;

        let status = null;
        try {
            status = await window.executeCommand('get-patch-status', { game: backendId(gameId) });
        } catch (error) {
            console.error(`Patch status for ${gameId}:`, error);
        }
        if (!status) {
            target.hidden = true;
            return;
        }

        target.innerHTML = html(gameId, status);
        target.hidden = false;

        const button = target.querySelector('.detail-patch-update-action');
        if (button) {
            button.addEventListener('click', () => {
                if (backendId(gameId) === 'muac') window.MuacSetup?.showUpdate();
                else if (typeof verifyGame === 'function') verifyGame(gameId);
            });
        }

        // The latest release is still being checked: ask again shortly, a limited number of times.
        clearTimeout((rechecks[gameId] || {}).timer);
        if (status.checking) {
            const count = ((rechecks[gameId] || {}).count || 0) + 1;
            if (count <= MAX_RECHECKS) {
                rechecks[gameId] = { count, timer: setTimeout(() => render(gameId), RECHECK_MS) };
            }
        } else {
            rechecks[gameId] = { count: 0, timer: null };
        }
    }

    // After a Verify (or a patch install) the installed release may have changed.
    window.addEventListener('gameInstallationUpdated', event => {
        const game = event.detail && event.detail.game;
        GameUtils.getAllGameConfigs()
            .filter(config => SUPPORTED.has(backendId(config.uiId)) && (!game || backendId(config.uiId) === game))
            .forEach(config => render(config.uiId));
    });

    // Refresh when the game's page is opened: a launch from the launcher may have installed a release.
    document.addEventListener('click', event => {
        const item = event.target.closest && event.target.closest('.game-item[data-game]');
        if (item && SUPPORTED.has(backendId(item.dataset.game)) && slot(item.dataset.game)) {
            setTimeout(() => render(item.dataset.game), 0);
        }
    }, true);

    window.PatchView = {
        supports: gameId => SUPPORTED.has(backendId(gameId)),
        render
    };
})();
