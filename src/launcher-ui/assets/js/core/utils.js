// Shared utility functions for Ultimate Legends

// Centralized property key constants
const PROPERTY_KEYS = {
    LAUNCHER: {
        CLOSE_ON_LAUNCH: 'launcher-close-on-launch',
        SKIP_CLIENT_UPDATE: 'launcher-skip-client-update',
        SKIP_REDIST_CHECK: 'launcher-skip-redist-check',
        LANGUAGE: 'launcher-language',
        THEME: 'launcher-theme',
        PINNED_GAMES: 'launcher-pinned-games',
        HIDDEN_GAMES: 'launcher-hidden-games',
        AUTO_SHORTCUTS: 'launcher-auto-shortcuts',
        OFFLINE_MODE: 'launcher-offline-mode',
        PORTABLE_MODE: 'launcher-portable-mode',
        REDUCE_MOTION: 'launcher-reduce-motion',
        GRAYSCALE_UNINSTALLED: 'launcher-grayscale-uninstalled'
    },
    GAME: {
        INSTALL: 'install',
        IS_INSTALLED: 'is-installed',
        LAUNCH_OPTIONS: 'launch-options',
        LAUNCH_ADMIN: 'launch-admin'
    }
};

class GameUtils {
    static GAME_ORDER = ['mua', 'mua2', 'xml2', 'muac', 'xml1'];

    // Friendly aliases accepted by the -launch CLI arg (alias -> UI ID).
    static LAUNCH_ARG_ALIASES = {
        'mua1': 'mua',
        'ultimatealliance': 'mua',
        'ultimatealliance2': 'mua2',
        'xmenlegends2': 'xml2',
        'xmenlegends': 'xml1'
    };

    // Every game runs from an install the player already has: the launcher never downloads
    // game files, only its patches. Accent colours match the game artwork.
    static GAME_CONFIGS = {
        'mua': {
            displayName: 'Marvel: Ultimate Alliance',
            shortName: 'MUA',
            uiId: 'mua',
            client: '2016 PC',
            provider: 'Your existing install',
            version: '2016 PC',
            steamAppId: '433300',
            description: "The 2016 PC release of the four-hero co-op action RPG. Ultimate Legends finds your install, adds native Xbox controller support, shows what you're playing on Discord and loads your mods, then launches you straight in.",
            patchName: 'MUA Controller Fix',
            credits: 'Controller support, Discord presence and mod loading by <a href="https://github.com/ChronoRixun/mua-controller-fix" target="_blank">MUA Controller Fix</a>.',
            accent: '#FF7A3D',
            assetBase: './assets/img/games/mua',
            iconPath: './assets/img/games/mua/icon.ico',
            capsulePath: './assets/img/games/mua/capsule.jpg',
            heroImagePath: './assets/img/games/mua/hero.jpg',
            logoPath: './assets/img/games/mua/logo.png',
            featured: true
        },
        'mua2': {
            displayName: 'Marvel: Ultimate Alliance 2',
            shortName: 'MUA2',
            uiId: 'mua2',
            client: '2016 PC',
            provider: 'Your existing install',
            version: '2016 PC',
            steamAppId: '433320',
            description: "The 2016 PC release of the sequel, with Fusion team-up powers. Ultimate Legends finds your install, adds native Xbox controller support, shows what you're playing on Discord and loads your mods, then launches you straight in.",
            patchName: 'MUA Controller Fix',
            credits: 'Controller support, Discord presence and mod loading by <a href="https://github.com/ChronoRixun/mua-controller-fix" target="_blank">MUA Controller Fix</a>.',
            accent: '#6B78FF',
            assetBase: './assets/img/games/mua2',
            iconPath: './assets/img/games/mua2/icon.ico',
            capsulePath: './assets/img/games/mua2/capsule.jpg',
            heroImagePath: './assets/img/games/mua2/hero.jpg',
            logoPath: './assets/img/games/mua2/logo.png'
        },
        'xml2': {
            displayName: 'X-Men Legends II: Rise of Apocalypse',
            shortName: 'XML2',
            uiId: 'xml2',
            client: '2005 PC',
            provider: 'Your existing install',
            version: '2005 PC',
            description: 'The 2005 PC release of the four-player co-op action RPG. Ultimate Legends finds your install, adds native controller support with the XML2 Fix and launches you straight in. Online play through OpenSpy is in progress.',
            patchName: 'XML2 Fix',
            credits: 'Controller support by <a href="https://github.com/ChronoRixun/xml2-fix" target="_blank">XML2 Fix</a>.',
            accent: '#AD6BFF',
            assetBase: './assets/img/games/xml2',
            iconPath: './assets/img/games/xml2/icon.ico',
            capsulePath: './assets/img/games/xml2/capsule.jpg',
            heroImagePath: './assets/img/games/xml2/hero.jpg',
            logoPath: './assets/img/games/xml2/logo.png'
        },
        'muac': {
            displayName: 'Marvel: Ultimate Alliance (2006 PC)',
            shortName: 'MUA 2006',
            uiId: 'muac',
            client: '2006 PC',
            provider: 'Your existing install',
            version: '2006 PC',
            comingSoon: true,
            description: 'The original 2006 PC release, the version most community mods are built on. Support is being added.',
            credits: '',
            accent: '#2FD4AE',
            assetBase: './assets/img/games/muac',
            iconPath: './assets/img/games/muac/icon.ico',
            capsulePath: './assets/img/games/muac/capsule.jpg',
            heroImagePath: './assets/img/games/muac/hero.jpg',
            logoPath: './assets/img/games/muac/logo.png'
        },
        // Built on the player's PC by the port's builder from their own Xbox disc image and their
        // XML2 install (app/xml1-*.js); it runs on the XML2 engine with the XML2 Fix.
        'xml1': {
            displayName: 'X-Men Legends',
            shortName: 'XML',
            uiId: 'xml1',
            client: 'Community port',
            provider: 'Built on your PC',
            version: 'PC port',
            built: true,
            description: 'The 2004 original never came to PC. This community port rebuilds it on X-Men Legends II’s PC engine, on your PC, from your own Xbox disc image and your X-Men Legends II install. Nothing from the games is downloaded.',
            patchName: 'XML2 Fix',
            credits: 'Runs on the <a href="https://github.com/ChronoRixun/xml2-fix" target="_blank">XML2 Fix</a>, built by the X-Men Legends port’s builder.',
            accent: '#FF4D63',
            assetBase: './assets/img/games/xml1',
            iconPath: './assets/img/games/xml1/icon.ico',
            capsulePath: './assets/img/games/xml1/capsule.jpg',
            heroImagePath: './assets/img/games/xml1/hero.jpg',
            logoPath: './assets/img/games/xml1/logo.png'
        }
    };

    /**
     * Get comprehensive game configuration
     * @param {string} game - The game identifier (backend ID like 'mua', 'xml2', etc.)
     * @returns {object} Complete game configuration object
     */
    static getGameConfig(game) {
        return this.GAME_CONFIGS[game] || null;
    }

    /**
     * Get game configuration by UI ID (mua, mua2, etc.)
     * @param {string} uiId - The UI game identifier
     * @returns {object} Complete game configuration object
     */
    static getGameConfigByUIId(uiId) {
        return this.getGameConfig(uiId);
    }

    static isComingSoon(uiId) {
        const config = this.getGameConfigByUIId(uiId);
        return !!(config && config.comingSoon);
    }

    /**
     * The id the backend knows the game by. The UI and the backend share ids (mua, mua2, xml2...),
     * so this and getUIIdFromBackendId only mark which side of that boundary a value belongs to.
     * @param {string} gameId - The UI game identifier
     * @returns {string} The backend game identifier
     */
    static getGameMapping(gameId) {
        return gameId;
    }

    /**
     * The UI id for a backend game id (the same value; see getGameMapping).
     * @param {string} backendId - The backend game identifier (mua, xml2, etc.)
     * @returns {string} The UI game identifier (mua, xml2, etc.)
     */
    static getUIIdFromBackendId(backendId) {
        return backendId;
    }

    /**
     * Get every game config in UI display order.
     * @returns {array} Ordered game configuration objects
     */
    static getAllGameConfigs() {
        return this.GAME_ORDER
            .map(uiId => this.getGameConfigByUIId(uiId))
            .filter(Boolean);
    }

    /**
     * Get the configured featured game, falling back to the first game.
     * @returns {object|null} Game configuration
     */
    static getFeaturedGame() {
        return this.getAllGameConfigs().find(config => config.featured) || this.getAllGameConfigs()[0] || null;
    }

    /**
     * Get all game images for preloading
     * @returns {object} Object with gameId as key and array of image paths as value
     */
    static getAllGameImages() {
        const images = {};

        // iconPath (.ico) is deliberately excluded: the sidebar <img> tags load those on their own.
        this.getAllGameConfigs().forEach(config => {
            images[config.uiId] = [
                config.capsulePath,
                config.heroImagePath,
                config.logoPath
            ].filter(Boolean);
        });

        // Add home page image
        images['home'] = ['./assets/img/brand/ul-mark.png'];

        return images;
    }

    /**
     * Get icon path for a UI game ID
     * @param {string} uiId - The UI game identifier
     * @returns {string} Icon path or null
     */
    static getIconPath(uiId) {
        const config = this.getGameConfigByUIId(uiId);
        return config ? config.iconPath : null;
    }

    /**
     * Get hero image path for a UI game ID
     * @param {string} uiId - The UI game identifier
     * @returns {string} Hero image path or null
     */
    static getHeroImagePath(uiId) {
        const config = this.getGameConfigByUIId(uiId);
        return config ? config.heroImagePath : null;
    }

    /**
     * Get all game UI IDs
     * @returns {array} Array of all game UI identifiers
     */
    static getAllGameIds() {
        return this.GAME_ORDER.slice();
    }

    /**
     * Get all game-specific active CSS classes
     * @returns {array} Array of active class names for all games
     */
    static getGameActiveClasses() {
        return this.getAllGameIds().map(id => `${id}-active`);
    }

    /**
     * Format bytes into human-readable format
     * @param {number} bytes - Number of bytes
     * @returns {string} Formatted string (e.g., "1.5 GB")
     */
    static escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    static formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';

        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }

    static formatSpeed(bytesPerSec) {
        if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
        return GameUtils.formatBytes(bytesPerSec) + '/s';
    }

    static formatDuration(seconds) {
        if (!Number.isFinite(seconds) || seconds <= 0) return '';

        const total = Math.round(seconds);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;

        if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
        if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
        return `${s}s`;
    }

    /**
     * Track progress of a backend command with polling
     * @param {object} config - Configuration object
     * @param {string} config.gameId - UI game ID (for progress bar theming)
     * @param {string} config.command - Backend command name
     * @param {object} config.commandArgs - Arguments to pass to command
     * @param {string} config.initialMessage - Initial progress message
     * @param {string} config.completeMessage - Completion message
     * @param {function} config.onComplete - Optional callback when complete
     * @param {number} config.pollInterval - Poll interval in ms (default: 100)
     * @returns {Promise} Promise that resolves when operation completes
     */
    static inferQueueOp(command) {
        switch (command) {
            case 'verify-game': return 'verify';
            case 'delete-game': return 'uninstall';
            case 'launch-game': return 'launch';
            default: return command;
        }
    }

    static opBlocksGameButtons(op) {
        return op === 'verify' || op === 'install' || op === 'uninstall';
    }

    static async trackCommandProgress(config) {
        const {
            gameId,
            command,
            commandArgs = {},
            initialMessage = 'Processing...',
            completeMessage = 'Complete!',
            onComplete = null,
            pollInterval = 100,
            op,
            blocksGameButtons
        } = config;

        const resolvedOp = op || GameUtils.inferQueueOp(command);
        const resolvedBlocks = (blocksGameButtons !== undefined)
            ? !!blocksGameButtons
            : GameUtils.opBlocksGameButtons(resolvedOp);

        const runFn = (registerCancel) => new Promise((resolve, reject) => {
            let pollIntervalId;
            let cancelRequested = false;
            let lastBytes = 0, lastTime = 0, emaSpeed = 0; // bytes, ms, bytes/sec
            let startTime = 0, startBytes = 0;             // ms, bytes (download-start baseline)

            const cancelOperation = async () => {
                cancelRequested = true;
                if (pollIntervalId) {
                    clearInterval(pollIntervalId);
                    pollIntervalId = null;
                }
                window.ProgressManager.hide();
                try {
                    await window.executeCommand('cancel-update');
                } catch (error) {
                    console.error('Failed to send cancel command:', error);
                }
                // Poll until the worker actually unwinds before resolving so the
                // queue doesn't advance and reset() before cancellation lands.
                const start = Date.now();
                const cancelTimeoutMs = 5000;
                while (Date.now() - start < cancelTimeoutMs) {
                    try {
                        const status = await window.executeCommand('get-update-progress');
                        if (!status || !status.active) break;
                    } catch (_) { break; }
                    await new Promise(r => setTimeout(r, 100));
                }
                resolve();
            };

            registerCancel(cancelOperation);

            window.ProgressManager.show(gameId, initialMessage, cancelOperation);

            window.executeCommand(command, commandArgs)
                .then(() => {
                    console.log(`${command} command handler completed, starting polling`);
                    if (cancelRequested) return;

                    pollIntervalId = setInterval(async () => {
                        if (cancelRequested) {
                            clearInterval(pollIntervalId);
                            pollIntervalId = null;
                            return;
                        }
                        try {
                            const result = await window.executeCommand('get-update-progress');

                            if (!result) {
                                return;
                            }

                            if (!result.active) {
                                clearInterval(pollIntervalId);
                                pollIntervalId = null;
                                emaSpeed = 0;
                                window.ProgressManager.update(100, completeMessage);

                                if (onComplete) {
                                    try { onComplete(); } catch (cbErr) { console.error('onComplete error:', cbErr); }
                                }

                                setTimeout(() => {
                                    window.ProgressManager.hide();
                                    resolve();
                                }, 1000);
                                return;
                            }

                            // Paused: keep the bar alive at the current percent, just relabel.
                            // Reset the rate so a resumed download re-measures from scratch.
                            if (result.paused) {
                                emaSpeed = 0;
                                lastTime = 0;
                                startTime = 0;
                                const pausedMsg = window.LauncherI18n
                                    ? window.LauncherI18n.t('downloads.statusPausedAt', { percent: Number(result.progress || 0).toFixed(2) })
                                    : `Paused — ${Number(result.progress || 0).toFixed(2)}%`;
                                window.ProgressManager.update(result.progress, pausedMsg, null);
                                return;
                            }

                            // Speed/ETA from byte deltas — only while actually downloading. Verify/delete
                            // also report byte totals, but their "speed" is disk throughput, not a download.
                            let stats = null;
                            const downloaded = Number(result.downloadedBytes) || 0;
                            const total = Number(result.totalBytes) || 0;
                            if (total > 0 && result.mode === 'downloading') {
                                const now = Date.now();

                                // Live, smoothed speed for the MB/s readout.
                                if (lastTime === 0) {
                                    lastTime = now;
                                    lastBytes = downloaded;
                                } else {
                                    const dt = (now - lastTime) / 1000;
                                    if (dt >= 0.25 && downloaded >= lastBytes) {
                                        const inst = (downloaded - lastBytes) / dt;
                                        emaSpeed = emaSpeed ? emaSpeed * 0.7 + inst * 0.3 : inst;
                                        lastBytes = downloaded;
                                        lastTime = now;
                                    }
                                }

                                // Cumulative average (since start) for a smoothly counting-down ETA.
                                if (startTime === 0) {
                                    startTime = now;
                                    startBytes = downloaded;
                                }
                                const elapsed = (now - startTime) / 1000;
                                const avgSpeed = elapsed > 0 ? (downloaded - startBytes) / elapsed : 0;
                                const etaSeconds = avgSpeed > 0 ? (total - downloaded) / avgSpeed : null;

                                stats = { speed: emaSpeed, etaSeconds };
                            } else {
                                // Leaving the download phase (verify/retry) — re-baseline so the next
                                // download phase measures from scratch instead of a stale offset.
                                lastTime = 0;
                                startTime = 0;
                                emaSpeed = 0;
                            }

                            window.ProgressManager.update(result.progress, result.message, stats);
                        } catch (error) {
                            console.error('Error polling progress:', error);
                            clearInterval(pollIntervalId);
                            pollIntervalId = null;
                            window.ProgressManager.hide();
                            reject(error);
                        }
                    }, pollInterval);
                })
                .catch(error => {
                    console.error(`Failed to start ${command}:`, error);
                    window.ProgressManager.hide();
                    reject(error);
                });
        });

        const queue = window.DownloadQueueManager;
        if (!queue) {
            console.warn('DownloadQueueManager unavailable, running command directly');
            return runFn(() => {});
        }

        return queue.enqueue({
            gameId,
            op: resolvedOp,
            command,
            commandArgs,
            blocksGameButtons: resolvedBlocks,
            initialMessage,
            completeMessage,
            runFn
        });
    }

    static expandMissingToPackageIds(missingGroups) {
        const ids = [];
        for (const g of (missingGroups || [])) {
            const archs = (g.archs && g.archs.length) ? g.archs : [''];
            for (const arch of archs) {
                ids.push(arch ? `${g.group_id}_${arch}` : g.group_id);
            }
        }
        return ids;
    }

    static computeRedistAggregate(state, scopeIds) {
        const all = (state && state.packages) || [];
        const packages = (scopeIds && scopeIds.length) ? all.filter(p => scopeIds.includes(p.id)) : all;
        if (packages.length === 0) return { percent: 0, currentName: null };
        const done = packages.filter(p => p.status === 'completed' || p.status === 'installed').length;
        const current = packages.find(p => p.status === 'downloading' || p.status === 'installing');
        const currentPct = current ? (current.status === 'installing' ? 100 : (current.progress || 0)) : 0;
        const percent = Math.min(100, ((done * 100) + currentPct) / packages.length);
        return { percent, currentName: current ? current.name : null };
    }

    static async installRedistsWithProgressBar(missingGroups, uiGameId) {
        const t = (k, vars) => window.LauncherI18n ? window.LauncherI18n.t(k, vars) : k;

        if (!await window.guardOnline()) return false;

        const scopeIds = this.expandMissingToPackageIds(missingGroups);

        let initial;
        try { initial = await window.executeCommand('get-redist-progress'); }
        catch (e) { initial = null; }

        const alreadyRunning = !!(initial && initial.running);

        if (!alreadyRunning) {
            if (scopeIds.length === 0) return true;
            try { await window.executeCommand('install-redist', { ids: scopeIds }); }
            catch (e) { console.error('install-redist failed', e); return false; }
        }

        window.ProgressManager.show(uiGameId, t('installer.installingComponents'), null);

        return new Promise((resolve) => {
            const finish = (success) => {
                if (pollId) clearInterval(pollId);
                window.ProgressManager.hide();
                resolve(success);
            };

            const tick = async () => {
                let state;
                try { state = await window.executeCommand('get-redist-progress'); }
                catch (e) { console.error('get-redist-progress failed', e); finish(false); return; }
                if (!state) return;

                const { percent, currentName } = this.computeRedistAggregate(state, scopeIds);
                const msg = currentName ? t('installer.installingNamed', { name: currentName }) : t('installer.installingComponents');
                window.ProgressManager.update(percent, msg);

                if (state.running === false) {
                    const failed = (state.packages || []).some(p => p.status === 'failed');
                    finish(!failed);
                }
            };

            tick();
            const pollId = setInterval(tick, 500);
        });
    }

    /**
     * Launch a game, handling path validation, redistributables and progress
     * @param {string} backendGame - Backend game ID (mua, xml2, etc.)
     * @param {string} uiGameId - UI game ID (mua, xml2, etc.) for progress bar
     * @returns {Promise} Promise that resolves when launch completes
     */
    static async launchGame(backendGame, uiGameId) {
        const gameConfig = this.getGameConfig(backendGame);
        if (!gameConfig) {
            console.error(`No configuration found for game: ${backendGame}`);
            throw new Error('Game configuration not found');
        }

        // Guard against launching while another game is updating (singleton progress_tracker).
        const queue = window.DownloadQueueManager;
        if (queue && queue.isAnyBlockingActive() && !queue.isBusy(uiGameId)) {
            const i18n = window.LauncherI18n;
            const title = i18n ? i18n.t('errors.cannotLaunchTitle') : 'Cannot launch right now';
            const body = i18n ? i18n.t('errors.cannotLaunchBody') : 'Another game is currently updating. Please wait for it to finish or cancel it before launching a different game.';
            if (typeof window.showMessageBox === 'function') {
                window.showMessageBox(title, body, [i18n ? i18n.t('common.ok') : 'OK']);
            }
            throw new Error('Another game is updating');
        }

        // Check if game install path is configured
        const folder = await window.executeCommand('get-game-property', {
            game: backendGame,
            suffix: PROPERTY_KEYS.GAME.INSTALL
        });

        if (!folder) {
            const gameName = gameConfig.displayName;
            const i18n = window.LauncherI18n;
            if (typeof window.showMessageBox === 'function') {
                window.showMessageBox(
                    i18n ? i18n.t('errors.gameNotConfiguredTitle', { game: gameName }) : `${gameName} not configured`,
                    i18n ? i18n.t('errors.gameNotConfiguredBody', { game: gameName }) : `You have not configured your ${gameName} installation path.`,
                    [i18n ? i18n.t('common.ok') : 'OK']
                );
            } else {
                alert(`${gameName} installation path not configured.`);
            }
            throw new Error('Installation path not configured');
        }

        let skipRedistCheck = false;
        try {
            skipRedistCheck = (await window.executeCommand('get-property', PROPERTY_KEYS.LAUNCHER.SKIP_REDIST_CHECK)) === 'true';
        } catch (e) { /* treat as false */ }

        if (!skipRedistCheck) {
            let missingResp = null;
            try { missingResp = await window.executeCommand('get-missing-redists-for-game', { game: backendGame }); }
            catch (e) { console.error('get-missing-redists-for-game failed', e); }

            // Fails open, but say so: an empty list and a check that never ran look identical otherwise.
            if (!missingResp || missingResp.checked !== true) {
                console.error(`Redist check did not run for ${backendGame}, launching without it`, missingResp);
            }

            const missing = (missingResp && missingResp.missing) || [];
            if (missing.length > 0) {
                const result = window.LaunchRedistModal
                    ? await window.LaunchRedistModal.show(missing, gameConfig.displayName)
                    : { action: 'cancel' };
                if (!result || result.action === 'cancel') return;

                if (result.action === 'skip') {
                    if (result.dontAskAgain) {
                        try {
                            await window.executeCommand('set-property', {
                                [PROPERTY_KEYS.LAUNCHER.SKIP_REDIST_CHECK]: 'true'
                            });
                        } catch (e) { console.error('set-property skip-redist-check failed', e); }
                    }
                } else {
                    const ok = await GameUtils.installRedistsWithProgressBar(missing, uiGameId);
                    if (!ok) {
                        const i18n = window.LauncherI18n;
                        if (typeof window.showToast === 'function') {
                            window.showToast(i18n ? i18n.t('installer.redistInstallFailed') : 'Failed to install required components.', 'error', 6000);
                        }
                        return;
                    }
                }
            }
        }

        // Track launch progress
        const result = await this.trackCommandProgress({
            gameId: uiGameId,
            command: 'launch-game',
            commandArgs: { game: backendGame },
            initialMessage: window.LauncherI18n
                ? window.LauncherI18n.t('progress.launching', { game: gameConfig.displayName })
                : `Launching ${gameConfig.displayName}...`,
            completeMessage: window.LauncherI18n ? window.LauncherI18n.t('progress.launchComplete') : 'Launch complete!'
        });

        if (window.GameStateManager && typeof window.GameStateManager.markGameLaunched === 'function') {
            window.GameStateManager.markGameLaunched(uiGameId);
        }

        return result;
    }
}

// Make GameUtils available globally
window.GameUtils = GameUtils;

// Offline-mode guard for any network action (verify/download/update).
// Returns true if the action may proceed; false if blocked. If the user
// chooses to go online, relaunches the launcher without -offline.
window.guardOnline = async function guardOnline() {
    if (!window.IS_OFFLINE) return true;

    const t = (k) => window.LauncherI18n ? window.LauncherI18n.t(k) : k;
    if (typeof window.showMessageBox !== 'function') return false;

    const choice = await window.showMessageBox(
        t('offline.blockTitle'),
        t('offline.blockBody'),
        [t('offline.relaunchOnline'), t('common.cancel')]
    );

    if (choice === 0) {
        try { await window.executeCommand('relaunch-online'); } catch (_) {}
    }
    return false;
};
