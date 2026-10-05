// The patch line in a game page's side panel: which release of the game's patch (the MUA Controller
// Fix, the XML2 Fix) is in its folder, and, when GitHub has a newer one, an "Update available" line
// whose button runs the same Verify that installs it (launching the game from the launcher installs
// it too). The backend (updater/patch_status.cpp) reads the installed DLL's version and checks the
// latest release in the background, so the page asks again while that check is running.
(function () {
    'use strict';

    // Games with a patch release (game_config.cpp's patch_file / patch_release_url).
    const SUPPORTED = new Set(['mua', 'mua2', 'xml2', 'xml1']);
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

    function installedText(status) {
        if (status.installed === null || status.installed === undefined) return t('detail.patchNotInstalled');
        return status.installed || t('detail.patchUnknownVersion');
    }

    function html(gameId, status) {
        const stat = `
            <div class="detail-stat detail-patch-stat">
                <span>${escapeHtml(patchName(gameId))}</span>
                <strong class="detail-patch-installed">${escapeHtml(installedText(status))}</strong>
            </div>`;
        if (!status.updateAvailable) return stat;

        const label = escapeHtml(t('detail.patchUpdateAvailable', { version: status.latest }));
        const notice = status.page ? `<a href="${escapeHtml(status.page)}" target="_blank">${label}</a>` : label;
        return `${stat}
            <div class="detail-patch-update">
                <span class="detail-patch-update-label">${notice}</span>
                <button type="button" class="secondary-action detail-patch-update-action" data-game="${escapeHtml(gameId)}"
                        title="${escapeHtml(t('detail.patchUpdateHint', { version: status.latest }))}">
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
                if (typeof verifyGame === 'function') verifyGame(gameId);
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
