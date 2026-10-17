"""End-to-end check of keyboard and controller navigation (focus-nav.js, gamepad-nav.js) against a
running Debug build (see launcher_cdp.py).

Walks Home -> Library -> a game's page -> Settings with real key presses only (CDP
Input.dispatchKeyEvent, as a keyboard - or Steam Input's desktop layout on a Steam Deck - sends them):
the arrow keys, Enter, Escape. On the way: the focus ring, a card's page and Back to the card, a popup
keeping the focus and giving it back, a toggle switched with Left / Right and switched back, a
<select> picked and put back with Escape, and LB / RB from a pretend pad read through the Gamepad API.
Saves a screenshot of each page with its focus ring. Every setting it touches is put back as it was;
no game is set up, launched or changed.

    tools\\run-test-debug.bat
    python tools\\dev\\focus_nav_cdp.py

It runs against the UI preview too (main.html opened in Chrome or Edge started with
--remote-debugging-port=12345), whose mock commands answer everything: a quick check without a build.
"""
import pathlib
import sys
import time

from launcher_cdp import Launcher

# key -> (key, code, Windows virtual key code, text)
KEYS = {
    "ArrowUp": ("ArrowUp", "ArrowUp", 38, ""),
    "ArrowDown": ("ArrowDown", "ArrowDown", 40, ""),
    "ArrowLeft": ("ArrowLeft", "ArrowLeft", 37, ""),
    "ArrowRight": ("ArrowRight", "ArrowRight", 39, ""),
    "Enter": ("Enter", "Enter", 13, "\r"),
    "Escape": ("Escape", "Escape", 27, ""),
    "Tab": ("Tab", "Tab", 9, ""),
}

# What has the focus, in one line: "page|element", the page being the visible .page-section's id, the
# sidebar, a popup, or the message box.
FOCUSED = """(() => {
    const e = document.activeElement;
    if (!e || e === document.body) return 'none';
    const where = e.closest('#message-box') ? 'message-box'
        : e.closest('.game-settings-backdrop, .component-selection-backdrop, .setup-flow-backdrop') ? 'popup'
        : e.closest('.sidebar') ? 'sidebar'
        : (e.closest('.page-section') || {}).id || 'other';
    const name = e.id ? '#' + e.id
        : e.dataset.game ? `${e.className.split(' ')[0]}[${e.dataset.game}]`
        : e.dataset.value !== undefined ? `${(e.closest('.toggle-group') || {}).id || 'toggle'}:${e.dataset.value}`
        : e.className ? '.' + e.className.split(' ')[0] : e.tagName.toLowerCase();
    return where + '|' + name;
})()"""


def main():
    launcher = Launcher()
    failures = 0
    shots = pathlib.Path(__file__).parent

    def check(ok, label):
        nonlocal failures
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}")
        failures += not ok

    def press(name, times=1):
        key, code, vk, text = KEYS[name]
        for _ in range(times):
            base = {"key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}
            launcher.call("Input.dispatchKeyEvent", dict(base, type="keyDown", **({"text": text} if text else {})))
            launcher.call("Input.dispatchKeyEvent", dict(base, type="keyUp"))
            time.sleep(0.15)

    def focused():
        return launcher.evaluate(FOCUSED)

    def js(expression):
        return launcher.evaluate(expression)

    def seek(key, predicate, limit=25):
        """Presses `key` until the focus satisfies `predicate` (given focused()); False if it never does."""
        for _ in range(limit):
            if predicate(focused()):
                return True
            press(key)
        return predicate(focused())

    def seek_vertical(predicate, limit=15):
        """Up, then Down, until the focus satisfies `predicate`."""
        return seek("ArrowUp", predicate, limit) or seek("ArrowDown", predicate, limit)

    def is_settings_action(_):
        return js("document.activeElement.classList.contains('detail-settings-action')")

    def page():
        return js("(() => { const p = [...document.querySelectorAll('.page-section')].find(p => p.offsetParent !== null); return p ? p.id : null; })()")

    def ring():
        time.sleep(0.5)  # buttons and cards ease in (transition: all 0.35s), the outline with them
        return js("(() => { const e = document.activeElement; if (!e || e === document.body) return false; "
                  "const s = getComputedStyle(e); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2; })()")

    def shot(name):
        path = shots / f"focus-nav-{name}.png"
        launcher.screenshot(path)
        print(f"  screenshot: {path}")

    # A window in the background has no focus: the Gamepad API part needs the page to think it has.
    launcher.call("Emulation.setFocusEmulationEnabled", {"enabled": True})
    js("window.AppViews.navigateTo('home'); document.activeElement && document.activeElement.blur(); true")
    time.sleep(1)

    print("Home")
    check(page() == "home-page", "on Home")
    press("ArrowDown")
    check(focused().startswith("home-page|"), f"the first arrow focuses the page ({focused()})")
    check(js("document.documentElement.dataset.nav === 'keys'") and ring(), "with a focus ring")
    shot("home")

    print("Home -> Library, from the sidebar")
    check(seek("ArrowLeft", lambda f: f.startswith("sidebar|"), 10), f"Left reaches the sidebar ({focused()})")
    check(seek("ArrowUp", lambda f: f == "sidebar|#home", 10), "Up to Home")
    press("ArrowDown")
    check(focused() == "sidebar|#library", f"Down: Library ({focused()})")
    press("Enter")
    time.sleep(0.8)
    check(page() == "library-page" and focused() == "sidebar|#library", "Enter: the Library, the focus stays in the sidebar")

    print("Library -> a game's page")
    press("ArrowRight")
    check(focused().startswith("library-page|"), f"Right: into the Library ({focused()})")
    check(seek("ArrowDown", lambda f: f.startswith("library-page|library-card["), 10), f"Down to a card ({focused()})")
    card = focused()
    game = card.split("[", 1)[1].rstrip("]")
    check(ring(), "the card shows the ring")
    shot("library")
    press("Enter")
    time.sleep(1.2)
    check(page() == f"{game}-page", f"Enter: {game}'s page")
    check(js("document.activeElement.hasAttribute('data-autofocus')") and focused().startswith(f"{game}-page|"),
          f"the focus followed into it, onto Play / Set up ({focused()})")
    seen = {focused()}
    for _ in range(6):
        press("ArrowDown")
        seen.add(focused())
    check(len(seen) >= 3 and all(f.split("|")[0] in (f"{game}-page", "sidebar") for f in seen),
          f"Down walks the page's controls ({len(seen)} of them)")
    shot("game")

    # The setup popup for a game not set up (its main button is Setup); Client settings for one that is
    # (its Play is never pressed). Either closes with Escape having changed nothing.
    print("a popup")
    seek("ArrowUp", lambda f: js("document.activeElement.hasAttribute('data-autofocus')"), 12)
    main = js("document.activeElement.id")
    if main.endswith("-setup-button"):
        opener = f"{game}-page|#{main}"
        reached = focused() == opener
    else:
        seek("ArrowRight", lambda f: js("!!document.activeElement.closest('.detail-actions-panel')"), 4)
        reached = seek_vertical(is_settings_action, 8)
        opener = focused()
    check(reached, f"on the control that opens it ({focused()})")
    if reached:
        press("Enter")
        time.sleep(1)
        check(focused().startswith("popup|"), f"Enter opens it, with the focus inside ({focused()})")
        inside = True
        for _ in range(8):
            press("Tab")
            inside = inside and focused().startswith("popup|")
        check(inside, "Tab goes round inside it")
        press("ArrowDown", 4)
        press("ArrowRight", 2)
        check(focused().startswith("popup|"), "so do the arrows")
        shot("popup")
        press("Escape")
        time.sleep(0.6)
        check(js("![...document.querySelectorAll('.setup-flow-backdrop, .game-settings-backdrop')].some(e => getComputedStyle(e).display !== 'none')"),
              "Escape closes it")
        check(focused() == opener, f"the focus is back on its button ({focused()})")

    print("Back")
    press("Escape")
    time.sleep(0.8)
    check(page() == "library-page", "Escape: back to the Library")
    check(focused() == card, f"on the card it was opened from ({focused()})")

    print("Library -> Settings")
    check(seek("ArrowLeft", lambda f: f.startswith("sidebar|"), 10), "Left to the sidebar")
    check(seek("ArrowDown", lambda f: f == "sidebar|#settings", 15), f"Down to Settings ({focused()})")
    press("Enter")
    time.sleep(1)
    check(page() == "settings-page", "Enter: Settings")

    print("a toggle: Left / Right")
    press("ArrowRight")
    check(focused().startswith("settings-page|"), f"Right: into Settings ({focused()})")
    check(seek_vertical(lambda f: f.startswith("settings-page|reduce-motion-toggle:"), 20), f"Up / Down to Reduce motion ({focused()})")
    before = js("document.querySelector('#reduce-motion-toggle .toggle-btn.active').dataset.value")
    there, back = ("ArrowRight", "ArrowLeft") if before == "false" else ("ArrowLeft", "ArrowRight")
    press(there)
    after = js("document.querySelector('#reduce-motion-toggle .toggle-btn.active').dataset.value")
    check(after != before and focused().endswith(f":{after}"), f"{there}: {before} -> {after}, the focus with it")
    press(there)
    check(focused().endswith(f":{after}"), "again: stays at the end")
    shot("settings")
    press(back)
    time.sleep(0.5)
    check(js("document.querySelector('#reduce-motion-toggle .toggle-btn.active').dataset.value") == before, f"{back}: back to {before}")

    print("a select: picked, then put back")
    check(seek("ArrowUp", lambda f: f == "settings-page|#theme-select", 10), f"Up to Theme ({focused()})")
    theme = js("document.getElementById('theme-select').value")
    applied = js("[document.documentElement.getAttribute('data-theme'), document.documentElement.getAttribute('data-accent')].join()")
    press("ArrowDown")
    check(focused() != "settings-page|#theme-select" and js("document.getElementById('theme-select').value") == theme,
          "not picking: Down moves on and the theme stays")
    press("ArrowUp")
    press("Enter")
    check(js("document.getElementById('theme-select').classList.contains('is-picking')"), "Enter: picking")
    press("ArrowDown")
    check(js("document.getElementById('theme-select').value") != theme, "Down: the next theme shows in the box")
    press("Escape")
    time.sleep(0.3)
    check(js("document.getElementById('theme-select').value") == theme and
          js("[document.documentElement.getAttribute('data-theme'), document.documentElement.getAttribute('data-accent')].join()") == applied
          and page() == "settings-page",
          "Escape: the old theme back, never applied, still on Settings")

    print("a pad through the Gamepad API (pretend)")
    js("""(() => {
        const pad = { connected: true, mapping: 'standard', axes: [0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
        window.__pad = pad;
        navigator.getGamepads = () => [pad];
        window.__press = index => { pad.buttons[index].pressed = true; window.GamepadNav.poll(); pad.buttons[index].pressed = false; window.GamepadNav.poll(); };
        return true;
    })()""")
    js("window.__press(5)")
    time.sleep(0.6)
    check(page() == "home-page" and focused() == "sidebar|#home", f"RB from Settings wraps to Home ({focused()})")
    js("window.__press(4)")
    time.sleep(0.6)
    check(page() == "settings-page" and focused() == "sidebar|#settings", "LB: back to Settings")
    js("window.__press(15)")
    check(focused().startswith("settings-page|"), f"D-pad right: into Settings ({focused()})")
    js("window.__press(1)")
    time.sleep(0.6)
    check(page() == "home-page", "B: back to the page before (Home)")
    js("delete navigator.getGamepads; true")
    launcher.call("Emulation.setFocusEmulationEnabled", {"enabled": False})

    print(f"\n{'PASSED' if not failures else 'FAILED'} ({failures} failure{'s' if failures != 1 else ''})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
