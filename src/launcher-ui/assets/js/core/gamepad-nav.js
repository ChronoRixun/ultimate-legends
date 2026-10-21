// A pad through the Gamepad API drives the launcher like the keyboard (focus-nav.js), so an Xbox-style
// controller works without Steam Input too: the D-pad and the left stick are the arrow keys, A is
// Enter, B is Escape, Y opens a card's menu, LB / RB go to the previous / next sidebar page. A held
// direction repeats (after 400 ms, every 120 ms). Nothing is read while the launcher isn't the window
// in front (a game running on the same pad), and a button already held when it comes back waits for
// its release.
(function () {
    'use strict';

    // The standard mapping's button indexes.
    const BUTTONS = [
        [0, 'Enter'],
        [1, 'Escape'],
        [3, 'ContextMenu'],
        [4, 'PrevSection'],
        [5, 'NextSection'],
        [12, 'ArrowUp'],
        [13, 'ArrowDown'],
        [14, 'ArrowLeft'],
        [15, 'ArrowRight']
    ];
    const REPEATING = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
    const DEADZONE = 0.5;
    const REPEAT_DELAY = 400;
    const REPEAT_EVERY = 120;

    const held = new Map(); // name -> { next: when it fires again (Infinity: not until released) }
    let looping = false;

    function pressed(button) {
        return !!button && (typeof button === 'object' ? button.pressed || button.value > 0.5 : button > 0.5);
    }

    // Every name held on any pad right now.
    function read(pads) {
        const names = new Set();
        for (const pad of pads || []) {
            if (!pad || pad.connected === false) continue;
            for (const [index, name] of BUTTONS) {
                if (pressed(pad.buttons && pad.buttons[index])) names.add(name);
            }
            const x = (pad.axes && pad.axes[0]) || 0;
            const y = (pad.axes && pad.axes[1]) || 0;
            // The stronger axis only, so a diagonal push moves one way.
            if (Math.max(Math.abs(x), Math.abs(y)) >= DEADZONE) {
                if (Math.abs(x) > Math.abs(y)) names.add(x > 0 ? 'ArrowRight' : 'ArrowLeft');
                else names.add(y > 0 ? 'ArrowDown' : 'ArrowUp');
            }
        }
        return names;
    }

    // The names to fire at `now` for these pads; `active` false (the launcher in the background) fires
    // nothing and holds back what is held until it is released.
    function step(pads, now, active = true) {
        const names = read(pads);
        for (const name of Array.from(held.keys())) {
            if (!names.has(name)) held.delete(name);
        }
        const fire = [];
        for (const name of names) {
            const state = held.get(name);
            if (!active) {
                held.set(name, { next: Infinity });
            } else if (!state) {
                held.set(name, { next: REPEATING.has(name) ? now + REPEAT_DELAY : Infinity });
                fire.push(name);
            } else if (now >= state.next) {
                state.next = now + REPEAT_EVERY;
                fire.push(name);
            }
        }
        return fire;
    }

    function pads() {
        if (!navigator.getGamepads) return [];
        return Array.from(navigator.getGamepads() || []).filter(Boolean);
    }

    function isActive() {
        const focused = typeof document.hasFocus !== 'function' || document.hasFocus();
        return focused && document.visibilityState !== 'hidden';
    }

    function send(name) {
        if (!window.FocusNav || window.FocusNav.isPadMuted()) return;
        if (name === 'PrevSection') window.FocusNav.section(-1);
        else if (name === 'NextSection') window.FocusNav.section(1);
        else window.FocusNav.press(name, 'pad');
    }

    function poll() {
        const connected = pads();
        if (!connected.length) {
            held.clear();
            looping = false;
            return;
        }
        step(connected, Date.now(), isActive()).forEach(send);
        requestAnimationFrame(poll);
    }

    function start() {
        if (looping) return;
        looping = true;
        requestAnimationFrame(poll);
    }

    window.addEventListener('gamepadconnected', start);
    // A pad seen before this script ran (a reload).
    if (pads().length) start();

    window.GamepadNav = { step, poll, start };
})();
