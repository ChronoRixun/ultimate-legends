// Local artwork only. URLs are opaque launcher-owned resources, never the selected source path.
(function() {
    const records = {};
    let busy = false;
    const t = key => window.LauncherI18n.t(key);
    const escape = text => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
    const valid = (game, kind, url) => typeof url === 'string' &&
        new RegExp(`^/custom-art/${game}/${kind}/[0-9a-f]{1,32}\\.(png|jpg|webp)$`).test(url);

    async function decodePreview(url, convert) {
        const image = new Image();
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
            image.src = url;
        });
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 16_000_000) throw new Error('artwork');
        if (!convert) return {};
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        const png = canvas.toDataURL('image/png').split(',')[1];
        if (!png || png.length > (20 * 1024 * 1024 * 4 / 3 + 4)) throw new Error('artwork');
        return { png };
    }

    function apply(game, previous) {
        const config = GameUtils.getGameConfig(game);
        if (!config) return;
        document.querySelectorAll('img').forEach(img => {
            if (img.getAttribute('src') === previous.capsulePath) img.setAttribute('src', config.capsulePath);
        });
        document.querySelectorAll(`.library-card[data-game="${game}"], .client-card[data-game="${game}"]`)
            .forEach(card => card.classList.toggle('has-custom-art', !!records[game]?.capsule));
        document.getElementById(`${game}-page`)?.classList.toggle('has-custom-banner', !!records[game]?.hero);
        const heroes = [document.querySelector(`#${game}-page .hero-section`)];
        const home = document.getElementById('hub-hero');
        if (home && home.dataset.game === game) heroes.push(home);
        heroes.filter(Boolean).forEach(hero => {
            hero.style.setProperty('--hero-image', `url("${config.heroImagePath}")`);
            if (hero === home) hero.classList.toggle('has-custom-banner', !!records[game]?.hero);
        });
    }
    async function broken(game, kind, url) {
        if (!records[game] || records[game][kind] !== url) return;
        const previous = GameUtils.getGameConfig(game);
        delete records[game][kind];
        apply(game, previous);
        try { await window.executeCommand('reset-artwork', { game, kind, record: url.split('/').pop() }); } catch (_) {}
    }
    async function load(game, update = false) {
        if (!GameUtils.GAME_ORDER.includes(game)) return;
        const previous = GameUtils.getGameConfig(game);
        let result;
        try { result = await window.executeCommand('get-artwork', { game }); } catch (_) { return; }
        records[game] = {};
        for (const kind of ['capsule', 'hero']) {
            const url = result && result[kind];
            if (!valid(game, kind, url)) continue;
            records[game][kind] = url;
            // Background images have no error event. Probe both kinds with the CEF decoder,
            // and keep the handler alive to catch a missing or damaged managed copy.
            const probe = new Image();
            probe.onerror = () => broken(game, kind, url);
            probe.src = url;
        }
        if (update) apply(game, previous);
    }
    async function change(game, kind) {
        if (busy || !GameUtils.GAME_ORDER.includes(game) || !['capsule', 'hero'].includes(kind)) return;
        busy = true;
        let picked;
        let committed = false;
        try {
            picked = await window.executeCommand('pick-artwork', { game, kind, title: t(kind === 'hero' ? 'artwork.changeBanner' : 'artwork.change') });
            if (!picked || (!picked.error && !picked.preview)) return;
            if (picked.error || !valid(game, kind, picked.preview)) throw new Error('artwork');
            const converted = await decodePreview(picked.preview, picked.convert);
            const crop = kind === 'hero' ? 'hero' : 'capsule';
            const message = `<p>${escape(t('artwork.previewBody'))}</p><img class="artwork-preview artwork-preview-${crop}" src="${escape(picked.preview)}" alt="${escape(t('artwork.preview'))}">`;
            const choice = await window.showMessageBox(escape(t('artwork.preview')), message,
                [t('artwork.use'), { label: t('common.cancel'), cancel: true }]);
            if (choice !== 0) return;
            committed = await window.executeCommand('confirm-artwork', { game, kind, record: picked.record, ...converted });
            if (!committed) throw new Error('artwork');
            await load(game, true);
        } catch (_) {
            window.showToast(t('artwork.failed'), 'error');
        } finally {
            if (picked && picked.record && !committed) {
                try { await window.executeCommand('confirm-artwork', { game, kind, record: picked.record, cancel: true }); } catch (_) {}
            }
            busy = false;
        }
    }
    async function reset(game) {
        if (busy) return;
        busy = true;
        try {
            const cleared = await window.executeCommand('reset-artwork', { game });
            await load(game, true);
            if (!cleared) throw new Error('artwork');
        } catch (_) { window.showToast(t('artwork.failed'), 'error'); }
        finally { busy = false; }
    }
    function menuItems(game) {
        const items = [
            { label: t('artwork.change'), action: () => change(game, 'capsule') },
            { label: t('artwork.changeBanner'), action: () => change(game, 'hero') }
        ];
        if (records[game] && (records[game].capsule || records[game].hero)) {
            items.push({ label: t('artwork.reset'), action: () => reset(game) });
        }
        return items;
    }
    // Detect a managed card deleted after startup. Banner probes run on each load/change.
    document.addEventListener('error', event => {
        const src = event.target && event.target.getAttribute && event.target.getAttribute('src');
        for (const game of GameUtils.GAME_ORDER) for (const kind of ['capsule', 'hero']) {
            if (valid(game, kind, src)) broken(game, kind, src);
        }
    }, true);
    window.Artwork = { records, load, change, reset, menuItems,
        loadAll: () => Promise.all(GameUtils.GAME_ORDER.map(game => load(game))) };
})();
