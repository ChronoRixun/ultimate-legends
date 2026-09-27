// Finish setup / Manage install. The player's own install is never downloaded or changed; this
// popup shows the folder the launcher uses and installs, updates or removes the game's patch.
class InstallPopup {
    constructor() {
        this.popup = null;
        this.backdrop = null;
        this.currentGame = null;
        this.gameConfig = null;
        this.options = {};
        this.createPopup();
    }

    createPopup() {
        this.backdrop = document.createElement('div');
        this.backdrop.className = 'component-selection-backdrop';
        this.backdrop.style.display = 'none';

        this.popup = document.createElement('div');
        this.popup.className = 'component-selection-popup install-popup';
        this.popup.innerHTML = `
            <div class="popup-header">
                <h3 id="install-popup-title"></h3>
                <button class="popup-close">&times;</button>
            </div>
            <div class="popup-content">
                <p class="install-note install-popup-note" id="install-popup-note"></p>
                <div class="install-info-section">
                    <div class="install-info-row">
                        <span class="install-info-label" id="install-popup-folder-label"></span>
                        <span class="install-info-value install-popup-path" id="install-popup-folder"></span>
                    </div>
                    <div class="install-info-row">
                        <span class="install-info-label" id="install-popup-patch-label"></span>
                        <span class="install-info-value" id="install-popup-patch"></span>
                    </div>
                </div>
                <p class="install-note install-popup-warning" id="install-popup-missing" hidden></p>
                <div class="popup-actions">
                    <button class="btn-uninstall"></button>
                    <div class="popup-actions-right">
                        <button class="btn-cancel"></button>
                        <button class="btn-apply"></button>
                    </div>
                </div>
            </div>
        `;

        this.backdrop.appendChild(this.popup);
        document.body.appendChild(this.backdrop);

        this.bindEvents();
    }

    t(key, variables) {
        return window.LauncherI18n ? window.LauncherI18n.t(key, variables) : key;
    }

    isFinishSetup() {
        return this.options?.finishSetup === true;
    }

    refreshTexts() {
        const finishSetup = this.isFinishSetup();
        const displayName = this.gameConfig?.displayName || '';

        this.popup.querySelector('#install-popup-title').textContent = this.t(finishSetup
            ? 'popup.manageInstall.setupTitleWithGame'
            : 'popup.manageInstall.titleWithGame', { game: displayName });
        this.popup.querySelector('#install-popup-note').textContent = this.t(finishSetup
            ? 'popup.manageInstall.setupNote'
            : 'popup.manageInstall.manageNote');
        this.popup.querySelector('#install-popup-folder-label').textContent = this.t('popup.manageInstall.folder');
        this.popup.querySelector('#install-popup-patch-label').textContent = this.t('popup.manageInstall.patch');
        this.popup.querySelector('#install-popup-missing').textContent = this.t('popup.manageInstall.folderMissing', { game: displayName });
        this.popup.querySelector('.btn-uninstall').textContent = this.t('popup.manageInstall.uninstall');
        this.popup.querySelector('.btn-cancel').textContent = this.t('common.cancel');
        this.popup.querySelector('.btn-apply').textContent = this.t(finishSetup
            ? 'common.finishSetup'
            : 'popup.manageInstall.updatePatch');
    }

    bindEvents() {
        this.popup.querySelector('.popup-close').addEventListener('click', () => this.hide());
        this.popup.querySelector('.btn-cancel').addEventListener('click', () => this.hide());
        this.popup.querySelector('.btn-apply').addEventListener('click', () => this.apply());
        this.popup.querySelector('.btn-uninstall').addEventListener('click', () => this.uninstallGame());

        this.backdrop.addEventListener('click', (e) => {
            if (e.target === this.backdrop) {
                this.hide();
            }
        });
    }

    async show(game, gameConfig, options = {}) {
        this.currentGame = game;
        this.gameConfig = gameConfig;
        this.options = { finishSetup: false, ...options };
        this.refreshTexts();

        // Finish setup is the end of the setup pipeline; there is nothing to uninstall yet.
        const uninstallBtn = this.popup.querySelector('.btn-uninstall');
        uninstallBtn.hidden = this.isFinishSetup();
        this.popup.querySelector('.popup-actions').style.justifyContent = this.isFinishSetup() ? 'flex-end' : '';

        try {
            await this.loadInstallInfo();
        } catch (error) {
            console.error('Failed to load install info:', error);
            this.showError(this.t('popup.manageInstall.loadError'));
            return;
        }

        this.backdrop.style.display = 'flex';
        setTimeout(() => {
            this.backdrop.classList.add('active');
            this.popup.classList.add('active');
        }, 10);
    }

    hide() {
        this.backdrop.classList.remove('active');
        this.popup.classList.remove('active');

        setTimeout(() => {
            this.backdrop.style.display = 'none';
        }, 300);
    }

    async loadInstallInfo() {
        const info = await window.executeCommand('get-game-install-info', { game: this.currentGame });
        if (!info) {
            throw new Error('No install information returned');
        }

        // The path is right-aligned and clipped from the left (direction: rtl) so its end stays
        // visible; the LRM marks keep it reading left to right, trailing brackets included.
        const folderEl = this.popup.querySelector('#install-popup-folder');
        folderEl.textContent = info.path ? `\u200E${info.path}\u200E` : this.t('popup.manageInstall.notSet');
        folderEl.title = info.path || '';
        folderEl.classList.toggle('error', !info.valid);

        this.popup.querySelector('#install-popup-patch').textContent = info.hasPatch
            ? (this.gameConfig?.patchName || this.t('popup.manageInstall.patchDefault'))
            : this.t('popup.manageInstall.noPatch');

        // A folder that no longer holds the game can't take the patch; point at Game Settings instead.
        this.popup.querySelector('#install-popup-missing').hidden = !!info.valid;
        this.popup.querySelector('.btn-apply').disabled = !info.valid;
    }

    async apply() {
        // Installing or updating the patch needs the network.
        if (!await window.guardOnline()) return;

        this.hide();

        // Install (finish setup) or update the patch; the game's own files are never touched.
        const gameId = GameUtils.getUIIdFromBackendId(this.currentGame);
        if (gameId) {
            verifyGame(gameId, this.isFinishSetup() ? 'install' : 'verify');
        }
    }

    async uninstallGame() {
        const uiId = GameUtils.getUIIdFromBackendId(this.currentGame);
        const proceeded = await window.uninstallGameDirect(uiId);
        if (proceeded) this.hide();
    }

    showError(message) {
        if (typeof window.showMessageBox === 'function') {
            window.showMessageBox(this.t('popup.manageInstall.errorTitle'), message, [this.t('common.ok')]);
        } else {
            alert(message);
        }
    }
}
