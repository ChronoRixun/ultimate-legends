class GameSettingsPopup {
    constructor() {
        this.popup = null;
        this.backdrop = null;
        this.currentGame = null;
        this.gameConfig = null;
        this.createPopup();
    }

    createPopup() {
        this.backdrop = document.createElement('div');
        this.backdrop.className = 'game-settings-backdrop';
        this.backdrop.style.display = 'none';

        this.popup = document.createElement('div');
        this.popup.className = 'game-settings-popup';
        this.popup.innerHTML = `
            <div class="popup-header">
                <h3 id="settings-title">Game Settings</h3>
                <button class="popup-close">&times;</button>
            </div>
            <div class="popup-content">
                <div class="settings-section">
                    <h4>Installation Path</h4>
                    <div class="setting-item">
                        <label id="path-label">Game Installation Folder:</label>
                        <div class="input-group">
                            <input type="text" id="game-path" placeholder="Select installation folder..." readonly />
                            <button id="browse-btn" class="browse-button">Browse</button>
                        </div>
                    </div>
                </div>

                <div class="settings-section" id="game-options-section">
                    <h4>Game Options</h4>
                    <div class="setting-item inline-setting" id="launch-admin-row">
                        <label>Launch as Administrator</label>
                        <div class="toggle-group small" id="launch-admin-toggle">
                            <button class="toggle-btn" data-value="false">OFF</button>
                            <button class="toggle-btn" data-value="true">ON</button>
                        </div>
                    </div>
                </div>

                <div class="settings-section" id="launch-options-section">
                    <h4>Advanced</h4>
                    <div class="setting-item">
                        <label for="launch-options-input">Launch Options:</label>
                        <input type="text" id="launch-options-input" class="launch-options-input" />
                    </div>
                </div>

                <div class="popup-actions">
                    <button class="btn-reset">Reset Settings</button>
                    <div style="flex: 1;"></div>
                    <button class="btn-cancel">Cancel</button>
                    <button class="btn-save">Save Settings</button>
                </div>
            </div>
        `;

        this.backdrop.appendChild(this.popup);
        document.body.appendChild(this.backdrop);

        this.bindEvents();
    }

    bindEvents() {
        const closeBtn = this.popup.querySelector('.popup-close');
        const cancelBtn = this.popup.querySelector('.btn-cancel');
        const saveBtn = this.popup.querySelector('.btn-save');
        const resetBtn = this.popup.querySelector('.btn-reset');
        const browseBtn = this.popup.querySelector('#browse-btn');

        closeBtn.addEventListener('click', () => this.hide());
        cancelBtn.addEventListener('click', () => this.hide());
        saveBtn.addEventListener('click', () => this.handleSave());
        resetBtn.addEventListener('click', () => this.handleReset());
        browseBtn.addEventListener('click', () => this.handleBrowse());

        this.backdrop.addEventListener('click', (e) => {
            if (e.target === this.backdrop) {
                this.hide();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isVisible()) {
                this.hide();
            }
        });

        // Handle toggle button clicks
        this.popup.addEventListener('click', (e) => {
            if (e.target.classList.contains('toggle-btn')) {
                const toggleGroup = e.target.parentElement;
                const buttons = toggleGroup.querySelectorAll('.toggle-btn');

                // Remove active class from all buttons in this group
                buttons.forEach(btn => btn.classList.remove('active'));

                // Add active class to clicked button
                e.target.classList.add('active');
            }
        });
    }

    t(key, variables) {
        return window.LauncherI18n ? window.LauncherI18n.t(key, variables) : key;
    }

    refreshTexts() {
        this.popup.querySelector('.settings-section h4').textContent = this.t('popup.gameSettings.installationPath');
        this.popup.querySelector('#browse-btn').textContent = this.t('common.browse');
        this.popup.querySelector('#game-path').placeholder = this.t('popup.gameSettings.installationPlaceholder');
        this.popup.querySelector('#game-options-section h4').textContent = this.t('popup.gameSettings.gameOptions');
        this.popup.querySelector('#launch-admin-row label').textContent = this.t('popup.gameSettings.launchAdmin');
        this.popup.querySelector('#launch-options-section h4').textContent = this.t('popup.gameSettings.advanced');
        this.popup.querySelector('label[for="launch-options-input"]').textContent = this.t('popup.gameSettings.launchOptions');
        this.popup.querySelector('.btn-reset').textContent = this.t('common.resetSettings');
        this.popup.querySelector('.btn-cancel').textContent = this.t('common.cancel');
        this.popup.querySelector('.btn-save').textContent = this.t('common.saveSettings');
    }

    async show(game, gameConfig) {
        this.currentGame = game;
        this.gameConfig = gameConfig || GameUtils.getGameConfig(game);
        this.refreshTexts();

        // Update the UI with game-specific information
        this.popup.querySelector('#settings-title').textContent = this.t('popup.gameSettings.titleWithGame', {
            game: this.gameConfig.displayName
        });
        this.popup.querySelector('#path-label').textContent = this.t('popup.gameSettings.installationFolderWithGame', {
            game: this.gameConfig.displayName
        });

        // Load current settings
        await this.loadCurrentSettings();

        this.backdrop.style.display = 'flex';
    }

    hide() {
        this.backdrop.style.display = 'none';
    }

    isVisible() {
        return this.backdrop.style.display === 'flex';
    }

    async loadCurrentSettings() {
        if (typeof window.executeCommand === 'function') {
            try {
                // Load installation path
                const installPath = await window.executeCommand('get-game-property', {
                    game: this.currentGame,
                    suffix: PROPERTY_KEYS.GAME.INSTALL
                });
                this.popup.querySelector('#game-path').value = installPath || '';

                // Load launch options (available for all games)
                const launchOptions = await window.executeCommand('get-game-property', {
                    game: this.currentGame,
                    suffix: PROPERTY_KEYS.GAME.LAUNCH_OPTIONS
                });
                this.popup.querySelector('#launch-options-input').value = launchOptions || '';

                // Load launch-as-admin setting (all games); unset means the game's default
                const launchAdmin = await window.executeCommand('get-game-property', {
                    game: this.currentGame,
                    suffix: PROPERTY_KEYS.GAME.LAUNCH_ADMIN
                });
                const adminDefault = this.gameConfig.requiresElevation === true;
                const adminEnabled = (launchAdmin === 'true' || launchAdmin === 'false')
                    ? launchAdmin === 'true'
                    : adminDefault;
                const adminToggle = this.popup.querySelector('#launch-admin-toggle');
                adminToggle.querySelectorAll('.toggle-btn').forEach(btn => btn.classList.remove('active'));
                adminToggle.querySelector(`[data-value="${adminEnabled ? 'true' : 'false'}"]`).classList.add('active');
            } catch (error) {
                console.error('Failed to load current settings:', error);
            }
        }
    }

    async handleBrowse() {
        if (typeof window.executeCommand === 'function') {
            try {
                const folder = await window.executeCommand('browse-folder');
                if (folder) {
                    this.popup.querySelector('#game-path').value = folder;
                }
            } catch (error) {
                console.error('Failed to browse for folder:', error);
            }
        }
    }

    async handleSave() {
        const installPath = this.popup.querySelector('#game-path').value;

        if (typeof window.executeCommand === 'function') {
            try {
                // Validate and save installation path if provided
                if (installPath) {
                    const pathValid = await window.executeCommand('set-game-path', {
                        game: this.currentGame,
                        path: installPath,
                    });

                    if (!pathValid) {
                        // Path validation failed - show error message
                        if (typeof window.showMessageBox === 'function') {
                            window.showMessageBox(
                                this.t('popup.gameSettings.invalidGamePathTitle'),
                                this.t('popup.gameSettings.invalidGamePathBody', { game: this.gameConfig.displayName }),
                                [this.t('common.ok')]
                            );
                        } else {
                            alert(`The selected folder does not contain valid ${this.gameConfig.displayName} game files.`);
                        }
                        return; // Don't save anything if path is invalid
                    }
                }

                // Save launch-as-admin (all games); store only when it differs from the game's default
                const adminToggle = this.popup.querySelector('#launch-admin-toggle');
                const adminActive = adminToggle.querySelector('.toggle-btn.active');
                const adminEnabled = adminActive ? adminActive.dataset.value === 'true' : false;
                const adminDefault = this.gameConfig.requiresElevation === true;
                await window.executeCommand('set-game-property', {
                    game: this.currentGame,
                    suffix: PROPERTY_KEYS.GAME.LAUNCH_ADMIN,
                    value: adminEnabled === adminDefault ? '' : (adminEnabled ? 'true' : 'false')
                });

                // Save launch options (available for all games)
                const launchOptions = this.popup.querySelector('#launch-options-input').value.trim();
                await window.executeCommand('set-game-property', {
                    game: this.currentGame,
                    suffix: PROPERTY_KEYS.GAME.LAUNCH_OPTIONS,
                    value: launchOptions
                });

                this.hide();
            } catch (error) {
                console.error('Failed to save settings:', error);
                if (typeof window.showMessageBox === 'function') {
                    window.showMessageBox(
                        this.t('popup.gameSettings.saveFailedTitle'),
                        this.t('popup.gameSettings.saveFailedBody'),
                        [this.t('common.ok')]
                    );
                } else {
                    alert('Failed to save settings. Please try again.');
                }
            }
        }
    }

    async handleReset() {
        if (typeof window.showMessageBox === 'function') {
            const result = await window.showMessageBox(
                this.t('popup.gameSettings.resetTitle'),
                this.t('popup.gameSettings.resetBody', { game: this.gameConfig.displayName }),
                [this.t('common.cancel'), this.t('common.resetSettings')]
            );

            if (result === 1) {
                try {
                    // Reset all game settings using the reset-game-settings command
                    await window.executeCommand('reset-game-settings', {
                        game: this.currentGame
                    });

                    // Trigger UI refresh
                    window.dispatchEvent(new CustomEvent('gameInstallationUpdated', {
                        detail: { game: this.currentGame }
                    }));

                    this.hide();

                    if (typeof window.showMessageBox === 'function') {
                        window.showMessageBox(
                            this.t('popup.gameSettings.resetDoneTitle'),
                            this.t('popup.gameSettings.resetDoneBody', { game: this.gameConfig.displayName }),
                            [this.t('common.ok')]
                        );
                    }
                } catch (error) {
                    console.error('Failed to reset settings:', error);
                    if (typeof window.showMessageBox === 'function') {
                        window.showMessageBox(
                            this.t('popup.gameSettings.resetFailedTitle'),
                            this.t('popup.gameSettings.resetFailedBody'),
                            [this.t('common.ok')]
                        );
                    }
                }
            }
        }
    }

}

window.GameSettingsPopup = GameSettingsPopup;
