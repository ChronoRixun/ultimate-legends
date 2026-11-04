// One per-player order for Library and sidebar. GAME_ORDER remains the upgrade/default list.
(function() {
    let order = GameUtils.GAME_ORDER.slice();
    let writes = Promise.resolve();
    let dragged = null;
    const t = key => window.LauncherI18n.t(key);
    function normalise(value) {
        const defaults = GameUtils.GAME_ORDER;
        const result = Array.isArray(value)
            ? [...new Set(value.filter(id => typeof id === 'string' && defaults.includes(id)))] : [];
        // Insert new/missing games at their default index, preserving the player's relative
        // order of games already present. Repeating this merge is idempotent.
        defaults.forEach((id, index) => {
            if (!result.includes(id)) result.splice(Math.min(index, result.length), 0, id);
        });
        return result;
    }
    function get() { return normalise(order); }
    function apply() {
        const focused = document.activeElement;
        for (const [parentSelector, itemSelector] of [
            ['#library-grid', '.library-card[data-game]'],
            ['.sidebar .game-list', '.game-item[data-game]']
        ]) {
            const parent = document.querySelector(parentSelector);
            if (!parent) continue;
            const items = Array.from(parent.querySelectorAll(itemSelector));
            get().forEach(id => {
                const item = items.find(node => node.dataset.game === id);
                if (item) parent.appendChild(item);
            });
        }
        // Moving a focused node can blur it in Chromium. Its listeners and state survive.
        if (focused && focused !== document.body && document.body.contains(focused) && focused.focus) focused.focus({ preventScroll: true });
    }
    async function load() {
        try {
            const raw = await window.executeCommand('get-property', PROPERTY_KEYS.LAUNCHER.GAME_ORDER);
            order = normalise(typeof raw === 'string' ? JSON.parse(raw) : null);
        } catch (_) { order = normalise(null); }
        apply();
        return get();
    }
    function update(change, force = false) {
        // Compute each move against the preceding saved move, including rapid pad presses.
        const result = writes.then(async () => {
            const next = normalise(change(get()));
            if (!force && JSON.stringify(next) === JSON.stringify(get())) return false;
            const text = JSON.stringify(next);
            await window.executeCommand('set-property', { [PROPERTY_KEYS.LAUNCHER.GAME_ORDER]: text });
            if (await window.executeCommand('get-property', PROPERTY_KEYS.LAUNCHER.GAME_ORDER) !== text) throw new Error('order not saved');
            order = next;
            apply();
            const status = document.getElementById('game-order-status');
            if (status) status.textContent = t('gameOrder.saved');
            return true;
        }).catch(() => {
            if (window.showToast) window.showToast(t('gameOrder.failed'), 'error');
            return false;
        });
        writes = result;
        return result;
    }
    function move(game, delta) {
        if (!GameUtils.GAME_ORDER.includes(game) || ![-1, 1].includes(delta)) return Promise.resolve(false);
        return update(ids => {
            const index = ids.indexOf(game), target = index + delta;
            if (target >= 0 && target < ids.length) [ids[index], ids[target]] = [ids[target], ids[index]];
            return ids;
        });
    }
    function place(game, target, after) {
        if (game === target || !GameUtils.GAME_ORDER.includes(game) || !GameUtils.GAME_ORDER.includes(target)) return Promise.resolve(false);
        return update(ids => {
            const rest = ids.filter(id => id !== game);
            rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, game);
            return rest;
        });
    }
    function reset() { return update(() => GameUtils.GAME_ORDER.slice(), true); }
    function menuItems(game) {
        const ids = get(), index = ids.indexOf(game), items = [];
        if (index > 0) items.push({ label: t('gameOrder.earlier'), action: () => move(game, -1) });
        if (index >= 0 && index < ids.length - 1) items.push({ label: t('gameOrder.later'), action: () => move(game, 1) });
        return items;
    }
    function clearIndicators() {
        document.querySelectorAll('.order-drop-before, .order-drop-after').forEach(item => {
            item.classList.remove('order-drop-before', 'order-drop-after');
        });
    }
    function finishDrag() {
        dragged = null;
        clearIndicators();
        document.querySelectorAll('.is-order-dragging').forEach(item => item.classList.remove('is-order-dragging'));
    }
    function bindDrag(item, vertical) {
        item.setAttribute('draggable', 'true');
        item.querySelectorAll('img').forEach(image => image.setAttribute('draggable', 'false'));
        if (item.dataset.orderDragBound) return;
        item.dataset.orderDragBound = 'true';
        let blocked = false;
        item.addEventListener('mousedown', event => {
            blocked = event.button !== 0 || !!event.target.closest('button, a, input, select, textarea');
        });
        item.addEventListener('dragstart', event => {
            if (blocked || !event.dataTransfer) { event.preventDefault(); return; }
            dragged = item.dataset.game;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-ultimate-legends-game', dragged);
            item.classList.add('is-order-dragging');
            item.dataset.orderSuppressClick = 'true';
        });
        const after = event => {
            const rect = item.getBoundingClientRect();
            return vertical ? event.clientY >= rect.top + rect.height / 2 : event.clientX >= rect.left + rect.width / 2;
        };
        item.addEventListener('dragover', event => {
            if (!dragged || dragged === item.dataset.game) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            clearIndicators();
            item.classList.add(after(event) ? 'order-drop-after' : 'order-drop-before');
        });
        item.addEventListener('dragleave', event => {
            if (!event.relatedTarget || !item.contains(event.relatedTarget)) clearIndicators();
        });
        item.addEventListener('drop', event => {
            if (!dragged) return; // Never accept an external file, URL or forged game payload.
            event.preventDefault();
            const source = dragged, target = item.dataset.game, later = after(event);
            finishDrag();
            void place(source, target, later);
        });
        item.addEventListener('dragend', finishDrag);
        // Native HTML dragging starts only after the browser's movement threshold. Suppress
        // the trailing click after a drag, while ordinary clicks keep navigating as before.
        item.addEventListener('click', event => {
            if (item.dataset.orderSuppressClick === 'true') {
                item.removeAttribute('data-order-suppress-click');
                event.preventDefault(); event.stopImmediatePropagation();
            }
        }, true);
        item.addEventListener('dragend', () => {
            setTimeout(() => { item.removeAttribute('data-order-suppress-click'); }, 0);
        });
    }
    function bindSettings() {
        const button = document.getElementById('reset-game-order-btn');
        if (button) button.onclick = reset;
    }
    document.addEventListener('DOMContentLoaded', bindSettings);
    window.GameOrder = { get, normalise, load, move, place, reset, menuItems, bindDrag, apply };
})();
