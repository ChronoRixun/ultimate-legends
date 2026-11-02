// Native <select> popups are separate windows in CEF and can disappear under Proton.
// Keep the select as the value/event source for existing settings code, but render its UI
// entirely in the page. A single body-level list avoids clipping by scrolling game panels.
(function () {
    'use strict';

    const controls = new WeakMap();
    const triggers = new WeakMap();
    let sequence = 0;
    let active = null;
    let menu = null;
    let search = '';
    let searchTime = 0;

    function setAttribute(element, name, value) {
        if (element.getAttribute(name) !== String(value)) element.setAttribute(name, value);
    }

    function options(control) {
        return Array.from(control.select.options);
    }

    function available(option) {
        return !option.disabled && !option.hidden && !(option.parentElement.tagName === 'OPTGROUP' && option.parentElement.disabled);
    }

    function close() {
        if (!active) return;
        setAttribute(active.button, 'aria-expanded', 'false');
        active.button.removeAttribute('aria-activedescendant');
        active.select.classList.remove('is-picking');
        active = null;
        menu.hidden = true;
        menu.replaceChildren();
        search = '';
        searchTime = 0;
    }

    function sync(control, selectionChanged = false) {
        const { select, button } = control;
        const selected = select.options[select.selectedIndex];
        const label = selected ? selected.label : '';
        if (button.textContent !== label) button.textContent = label;
        button.disabled = select.disabled;
        button.hidden = select.hidden;
        if (active === control) {
            if (button.disabled || !button.isConnected || !button.getClientRects().length) close();
            else if (selectionChanged) {
                control.index = select.selectedIndex;
                renderOptions();
            }
        }
    }

    function highlight(index) {
        if (!active) return;
        active.index = index;
        Array.from(menu.children).forEach((item, i) => item.classList.toggle('is-active', i === index));
        const item = menu.children[index];
        if (!item) { active.button.removeAttribute('aria-activedescendant'); return; }
        setAttribute(active.button, 'aria-activedescendant', item.id);
        // Do not scroll the page/panel when moving through a long resolution list.
        if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop;
        else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) {
            menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
        }
    }

    function position() {
        const rect = active.button.getBoundingClientRect();
        const viewport = window.visualViewport;
        const left = (viewport && viewport.offsetLeft) || 0;
        const top = (viewport && viewport.offsetTop) || 0;
        const width = viewport ? viewport.width : window.innerWidth;
        const height = viewport ? viewport.height : window.innerHeight;
        const margin = 8;
        const gap = 4;
        menu.style.width = `${Math.min(Math.max(rect.width, 200), Math.max(0, width - margin * 2))}px`;
        menu.style.left = `${Math.max(left + margin, Math.min(rect.left, left + width - menu.offsetWidth - margin))}px`;
        const below = Math.max(0, top + height - rect.bottom - margin - gap);
        const above = Math.max(0, rect.top - top - margin - gap);
        const wanted = Math.min(menu.scrollHeight, 320);
        const flip = below < wanted && above > below;
        menu.style.maxHeight = `${Math.min(320, flip ? above : below)}px`;
        menu.style.top = `${flip ? Math.max(top + margin, rect.top - gap - menu.offsetHeight) : rect.bottom + gap}px`;
    }

    function renderOptions() {
        const control = active;
        const entries = options(control);
        if (!entries[control.index] || !available(entries[control.index])) {
            control.index = entries.findIndex((option, index) => index === control.select.selectedIndex && available(option));
            if (control.index < 0) control.index = entries.findIndex(available);
        }
        menu.replaceChildren();
        entries.forEach((option, index) => {
            const item = document.createElement('div');
            item.id = `${control.button.id}-option-${index}`;
            item.className = 'launcher-dropdown-option';
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', String(index === control.select.selectedIndex));
            item.setAttribute('aria-disabled', String(!available(option)));
            item.hidden = option.hidden;
            item.dataset.index = index;
            item.textContent = option.label;
            menu.appendChild(item);
        });
        position();
        highlight(control.index);
    }

    function ensureMenu() {
        if (menu) return;
        menu = document.createElement('div');
        menu.id = 'launcher-dropdown-list';
        menu.className = 'launcher-dropdown-list';
        menu.setAttribute('role', 'listbox');
        menu.hidden = true;
        document.body.appendChild(menu);
        // Options use aria-activedescendant; the trigger keeps the one tab stop.
        menu.addEventListener('mousedown', event => event.preventDefault());
        menu.addEventListener('pointermove', event => {
            if (event.pointerType !== 'mouse') return;
            const item = event.target.closest('[data-index]');
            if (item && active && available(active.select.options[Number(item.dataset.index)])) highlight(Number(item.dataset.index));
        });
        menu.addEventListener('click', event => {
            const item = event.target.closest('[data-index]');
            if (item) commit(Number(item.dataset.index));
        });
    }

    function open(control) {
        if (control.select.disabled || !control.button.getClientRects().length) return;
        close();
        ensureMenu();
        active = control;
        control.select.classList.add('is-picking');
        const entries = options(control);
        control.index = entries.findIndex((option, index) => index === control.select.selectedIndex && available(option));
        if (control.index < 0) control.index = entries.findIndex(available);
        menu.hidden = false;
        setAttribute(control.button, 'aria-expanded', 'true');
        if (control.button.hasAttribute('aria-labelledby')) {
            menu.setAttribute('aria-labelledby', control.button.getAttribute('aria-labelledby'));
            menu.removeAttribute('aria-label');
        } else {
            menu.setAttribute('aria-label', control.button.getAttribute('aria-label'));
            menu.removeAttribute('aria-labelledby');
        }
        renderOptions();
    }

    function commit(index) {
        if (!active) return;
        const { select, button } = active;
        const option = select.options[index];
        if (!option || !available(option) || select.disabled) return;
        const changed = select.selectedIndex !== index;
        select.selectedIndex = index;
        close();
        button.focus({ preventScroll: true });
        if (changed) {
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function onKey(control, event) {
        if (control.select.disabled || event.altKey || event.ctrlKey || event.metaKey) return;
        const key = event.key === 'Backspace' && active === control ? 'Escape' : event.key;
        if (key === 'Tab') { close(); return; }
        if (key === 'Escape') {
            if (active === control) { event.preventDefault(); event.stopPropagation(); close(); }
            return;
        }
        const navigation = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
        const printable = key.length === 1 && key !== ' ';
        if (!navigation.includes(key) && key !== 'Enter' && key !== ' ' && !printable) return;
        event.preventDefault();
        event.stopPropagation();
        if (key === 'Enter' || key === ' ') {
            if (active === control) commit(control.index);
            else open(control);
            return;
        }
        const wasOpen = active === control;
        if (!wasOpen) open(control);
        if (active !== control) return;
        const entries = options(control);
        if (printable) {
            const now = Date.now();
            const letter = key.toLocaleLowerCase();
            search = now - searchTime < 700 ? search + letter : letter;
            searchTime = now;
            // Repeated letters cycle through matches (e.g. multiple resolutions starting 1).
            const repeated = Array.from(search).every(char => char === letter);
            const prefix = repeated ? letter : search;
            const start = search.length > 1 && !repeated ? control.index : control.index + 1;
            for (let step = 0; step < entries.length; step++) {
                const index = (start + step + entries.length) % entries.length;
                if (available(entries[index]) && entries[index].label.trim().toLocaleLowerCase().startsWith(prefix)) {
                    highlight(index);
                    break;
                }
            }
        } else if (key === 'Home' || key === 'End') {
            const indices = entries.map((option, index) => available(option) ? index : -1).filter(index => index >= 0);
            highlight(key === 'Home' ? indices[0] ?? -1 : indices[indices.length - 1] ?? -1);
        } else if (wasOpen) {
            const delta = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
            for (let index = control.index + delta; index >= 0 && index < entries.length; index += delta) {
                if (available(entries[index])) { highlight(index); break; }
            }
        }
    }

    function enhance(root = document) {
        const selects = root.matches && root.matches('select') ? [root] : Array.from(root.querySelectorAll('select'));
        if (selects.length) ensureMenu();
        selects.forEach(select => {
            if (controls.has(select) || select.multiple || select.size > 1) return;
            const hadFocus = document.activeElement === select;
            const button = document.createElement('button');
            button.type = 'button';
            const key = select.dataset.focus || select.dataset.key;
            const parent = select.closest('[id]');
            const identity = key && parent ? `${parent.id}-${encodeURIComponent(key)}` : `launcher-dropdown-${++sequence}`;
            button.id = `${select.id || identity}-button`;
            button.className = `${select.className} launcher-dropdown-trigger`;
            if (select.dataset.focus) button.dataset.focus = select.dataset.focus;
            button.setAttribute('role', 'combobox');
            button.setAttribute('aria-haspopup', 'listbox');
            button.setAttribute('aria-expanded', 'false');
            button.setAttribute('aria-controls', 'launcher-dropdown-list');
            const row = select.closest('.setting-item, .ul-display-row');
            const label = select.labels[0] || (row && row.querySelector('label, .ul-display-label'));
            if (select.hasAttribute('aria-label')) button.setAttribute('aria-label', select.getAttribute('aria-label'));
            else if (select.hasAttribute('aria-labelledby')) button.setAttribute('aria-labelledby', select.getAttribute('aria-labelledby'));
            else if (label) {
                if (!label.id) label.id = `${button.id}-label`;
                button.setAttribute('aria-labelledby', label.id);
            } else button.setAttribute('aria-label', select.name || select.dataset.key || 'Options');
            if (label && label.tagName === 'LABEL') label.htmlFor = button.id;
            if (select.title) button.title = select.title;
            select.insertAdjacentElement('afterend', button);
            select.classList.add('launcher-dropdown-source');
            select.tabIndex = -1;
            select.setAttribute('aria-hidden', 'true');
            const control = { select, button, index: -1 };
            controls.set(select, control);
            triggers.set(button, control);
            // Existing callers (Online's Open Update channel and Models' focus restoration)
            // still address the select. Forward those operations to its visible control.
            select.focus = options => button.focus(options);
            select.scrollIntoView = options => button.scrollIntoView(options);
            // Settings are loaded/reset using .value without firing change. Preserve that
            // contract and update the visible label immediately, without polling.
            ['value', 'selectedIndex'].forEach(property => {
                const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, property);
                Object.defineProperty(select, property, {
                    configurable: true,
                    get() { return descriptor.get.call(this); },
                    set(value) { descriptor.set.call(this, value); sync(control, true); }
                });
            });
            select.addEventListener('change', () => sync(control, true));
            button.addEventListener('click', () => { if (active === control) close(); else open(control); });
            button.addEventListener('keydown', event => onKey(control, event));
            button.addEventListener('blur', () => { if (active === control) close(); });
            sync(control);
            if (hadFocus) button.focus({ preventScroll: true });
        });
    }

    const observer = new MutationObserver(records => {
        const changed = new Set();
        records.forEach(record => {
            if (record.type === 'childList') record.addedNodes.forEach(node => {
                if (node.nodeType === 1 && node !== menu && !node.closest('.launcher-dropdown-list')) enhance(node);
            });
            const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            const select = target && target.closest('select');
            if (select && controls.has(select)) changed.add(controls.get(select));
        });
        changed.forEach(control => {
            sync(control);
            if (active === control) renderOptions();
        });
        if (active && (!active.button.isConnected || !active.button.getClientRects().length)) close();
    });
    observer.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['disabled', 'selected', 'label', 'hidden', 'class', 'style']
    });
    function outside(event) {
        if (active && !active.button.contains(event.target) && !menu.contains(event.target)) close();
    }
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('click', outside, true);
    document.addEventListener('scroll', event => { if (active && event.target !== menu) close(); }, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', close);
        window.visualViewport.addEventListener('scroll', close);
    }
    document.addEventListener('DOMContentLoaded', () => enhance());
    // FocusNav captures keys before the trigger sees them. Keep its echo suppression and
    // spatial arrows between closed controls, then hand an open picker its own navigation.
    function handleKey(button, event) {
        const control = triggers.get(button);
        if (!control) return false;
        if (active !== control && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return false;
        onKey(control, event);
        return event.defaultPrevented;
    }
    window.LauncherDropdowns = { enhance, close, handleKey };
})();
