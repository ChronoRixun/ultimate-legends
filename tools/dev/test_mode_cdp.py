"""End-to-end check of the X-Men Legends page's Test mode section against a running Debug build (see
launcher_cdp.py).

Points the X-Men Legends (port) entry of the Debug launcher at a throwaway folder with a dummy
XMen2.exe and a dummy dinput.dll (the XML2 Fix), then reads and writes that folder's xml2-fix.ini
[TestMode] section through the same commands the page uses and through the page's own toggles and its
badge next to Play, and saves screenshots of both. The file holds what a real build leaves there
(the builder's [Game] / [Limits] / [Online], the player's [Display] / [Discord]): every byte outside
the one key written must stay. Never touches a real game install, and puts the entry's folder back
afterwards.

    tools\\run-test-debug.bat
    python tools\\dev\\test_mode_cdp.py

A Rebuild, Verify Files and Uninstall keeping (or, Uninstall, deleting) [TestMode] are checked by
xml1_cdp.py, which runs real builds.
"""
import pathlib
import sys
import tempfile
import time

from launcher_cdp import Launcher, wait_for

# What a build leaves in the port's ini, with comments, a non-ASCII comment and blank lines, none of
# which may move.
INI_TEMPLATE = (
    "; XML2 Fix settings (test copy) — café\r\n"
    "[Game]\r\n"
    "NewGameTeam=wolverine\r\n"
    "XPCurve=xml1\r\n"
    "\r\n"
    "[Limits]\r\n"
    "ActorSlots=127\r\n"
    "\r\n"
    "[Online]\r\n"
    "Domain=openspy.net\r\n"
    "\r\n"
    "[Display]\r\n"
    "; how the game is shown\r\n"
    "Mode=borderless\r\n"
    "RunInBackground=1\r\n"
    "\r\n"
    "[Discord]\r\n"
    "Enabled=0\r\n"
)

# A [TestMode] section written by hand, in the middle of the file, with inline comments and a key the
# launcher doesn't know.
FORGE_LINE = "ForgeEverywhere = 0   ; the Forge appears at every Xtraction point (default 0)"
HOTKEYS_LINE = "Hotkeys = 0           ; F8/F9/F10 test hotkeys (default 0)"
TESTMODE_TEMPLATE = INI_TEMPLATE.replace("[Discord]\r\n", (
    "[TestMode]\r\n"
    "; for testers\r\n"
    f"{FORGE_LINE}\r\n"
    f"{HOTKEYS_LINE}\r\n"
    "Verbose=1\r\n"
    "\r\n"
    "[Discord]\r\n"))

SAVE_WAIT = 0.8  # the page writes 250 ms after the last click


def main():
    launcher = Launcher()
    failures = 0

    def check(ok, label):
        nonlocal failures
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}")
        failures += not ok

    def get(game="xml1"):
        return launcher.command("get-test-mode-settings", {"game": game})

    def put(values, game="xml1"):
        return launcher.command("set-test-mode-settings", {"game": game, "values": values})

    def ui(expression):
        return launcher.evaluate(f"(() => {{ const panel = document.getElementById('xml1-testmode-panel'); "
                                 f"const badge = document.getElementById('xml1-testmode-badge'); {expression} }})()")

    def click(key, value):
        return ui(f"const b = panel.querySelector('.ul-testmode-toggle[data-key=\"{key}\"] .toggle-btn[data-value=\"{value}\"]'); "
                  "if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked';")

    def shown(key):
        return ui(f"const b = panel.querySelector('.ul-testmode-toggle[data-key=\"{key}\"] .toggle-btn.active'); return b ? b.dataset.value : null;")

    def badge_shown():
        return ui("return !badge.hidden && !!badge.querySelector('.ul-testmode-badge') && badge.offsetParent !== null;")

    keys = {"Tab": ("Tab", 9, ""), "Enter": ("Enter", 13, "\r"), "Space": (" ", 32, " ")}

    def press(name, shift=False):
        """A real key press (CDP Input.dispatchKeyEvent), as a keyboard - or a controller mapped to one - sends it."""
        key, code, text = keys[name]
        base = {"key": key, "code": "Space" if name == "Space" else name, "windowsVirtualKeyCode": code, "modifiers": 8 if shift else 0}
        launcher.call("Input.dispatchKeyEvent", dict(base, type="keyDown", **({"text": text} if text else {})))
        launcher.call("Input.dispatchKeyEvent", dict(base, type="keyUp"))
        time.sleep(0.1)

    def focused():
        """Which test mode control has the focus: "Key:value", "badge:off", or the focused element's tag."""
        return launcher.evaluate("""(() => { const e = document.activeElement; if (!e) return null;
            if (e.classList.contains('ul-testmode-off')) return 'badge:off';
            const group = e.closest('.ul-testmode-toggle'); if (group) return `${group.dataset.key}:${e.dataset.value}`;
            return e.tagName; })()""")

    def reload():
        launcher.evaluate("window.TestModeView.reload('xml1')")
        time.sleep(0.8)

    def open_page():
        launcher.evaluate("window.AppViews.navigateTo('xml1')")
        time.sleep(1.2)
        reload()

    with tempfile.TemporaryDirectory(prefix="ul-fake-xml1-") as folder:
        game = pathlib.Path(folder)
        (game / "XMen2.exe").write_bytes(b"placeholder - not a real game")
        ini = game / "xml2-fix.ini"
        fix = game / "dinput.dll"

        def raw():
            return ini.read_bytes() if ini.exists() else b""

        def text():
            return raw().decode("utf-8", errors="replace")

        original = launcher.command("get-game-property", {"game": "xml1", "suffix": "install"})
        try:
            launcher.command("set-game-property", {"game": "xml1", "suffix": "install", "value": str(game)})
            check(launcher.command("get-game-property", {"game": "xml1", "suffix": "install"}) == str(game),
                  "X-Men Legends pointed at the fake folder")

            print("which games have it")
            check(get("xml2")["supported"] is False and put({"Hotkeys": True}, "xml2").get("success") is False,
                  "X-Men Legends II: no test mode (the port's page only)")
            check(get("mua")["supported"] is False, "MUA: none")

            print("without the fix")
            state = get()
            check(state["supported"] and state["installed"] and not state["fixInstalled"], "folder set, fix not installed")
            check(state.get("keys") == ["ForgeEverywhere", "Hotkeys"], f"switches {state.get('keys')}")
            check(put({"Hotkeys": True}).get("success") is False and not ini.exists(), "refuses to write; no ini created")

            print("read: absent means off")
            fix.write_bytes(b"placeholder - not the real fix")
            ini.write_bytes(INI_TEMPLATE.encode("utf-8"))
            state = get()
            check(state["fixInstalled"] and state["ini"].lower() == str(ini).lower(), f"fix seen, ini at {state.get('ini')}")
            check(state["values"] == {"ForgeEverywhere": None, "Hotkeys": None}, f"no [TestMode] yet: {state['values']}")
            check(state["defaults"] == {"ForgeEverywhere": False, "Hotkeys": False}, "every key defaults to off")
            check(raw() == INI_TEMPLATE.encode("utf-8"), "reading wrote nothing")

            print("one key into a file without [TestMode]: everything else byte for byte")
            before = raw()
            result = put({"Hotkeys": True})
            check(result.get("success") is True and result["values"] == {"ForgeEverywhere": None, "Hotkeys": True},
                  f"Hotkeys on {result.get('values')} {result.get('error', '')}")
            after = raw()
            check(after.startswith(before), "every byte before the new section is the same: [Game], [Online], [Display], [Discord]")
            check(after[len(before):].lstrip(b"\r\n") == b"[TestMode]\r\nHotkeys=1\r\n", f"only [TestMode] Hotkeys=1 appended: {after[len(before):]!r}")
            check("ForgeEverywhere" not in text(), "ForgeEverywhere not written")

            print("one key in a hand-written [TestMode]: only its value changes")
            ini.write_bytes(TESTMODE_TEMPLATE.encode("utf-8"))
            check(get()["values"] == {"ForgeEverywhere": False, "Hotkeys": False}, "'0   ; comment' reads as off")
            result = put({"ForgeEverywhere": True})
            # (WritePrivateProfileString writes the line as "Key=value": the spaces round that one '=' go.)
            expected = TESTMODE_TEMPLATE.replace(FORGE_LINE, "ForgeEverywhere=1   ; the Forge appears at every Xtraction point (default 0)")
            check(result.get("success") is True and result["values"] == {"ForgeEverywhere": True, "Hotkeys": False}, f"answer {result.get('values')}")
            check(raw() == expected.encode("utf-8"), "the file is the template with that one value changed, comment and all")
            if raw() != expected.encode("utf-8"):
                print(text())
            put({"ForgeEverywhere": False})
            check("ForgeEverywhere=0   ; the Forge appears at every Xtraction point (default 0)\r\n" in text()
                  and f"{HOTKEYS_LINE}\r\n" in text() and "Verbose=1\r\n" in text(), "and back; Hotkeys' line and Verbose untouched")

            print("values the command takes; anything else is refused before a write")
            check(put({"Hotkeys": "1"}).get("values", {}).get("Hotkeys") is True, "\"1\"")
            check(put({"Hotkeys": 0}).get("values", {}).get("Hotkeys") is False, "0")
            check(put({"Hotkeys": "on"}).get("values", {}).get("Hotkeys") is True and "Hotkeys=1" in text(), "\"on\" written as 1")
            before = raw()
            check(put({"Hotkeys": "maybe"}).get("success") is False, "Hotkeys=maybe")
            check(put({"Hotkeys": 2}).get("success") is False, "Hotkeys=2")
            check(put({"Verbose": 1}).get("success") is False, "a [TestMode] key the launcher doesn't know")
            check(put({"Mode": "windowed"}).get("success") is False, "a [Display] key")
            check(put({"Enabled": False}).get("success") is False, "a [Discord] key")
            check(put({"Bogus": None}).get("success") is False, "unknown key, even to remove")
            check(put({}).get("success") is False, "nothing to change")
            check(put({"ForgeEverywhere": True, "Hotkeys": "maybe"}).get("success") is False, "one bad value fails the batch")
            check(raw() == before, "ini untouched by refused writes")
            check(put({"Hotkeys": None}).get("success") is True and "Hotkeys" not in text()
                  and "Verbose=1\r\n" in text(), "null removes the key (back to off), nothing else")

            print("a fresh file")
            ini.unlink()
            check(put({"ForgeEverywhere": True}).get("success") is True and text() == "[TestMode]\r\nForgeEverywhere=1\r\n", "ini created when missing")

            print("page: the toggles follow the file")
            ini.write_bytes(TESTMODE_TEMPLATE.replace(HOTKEYS_LINE, HOTKEYS_LINE.replace("= 0", "= 1")).encode("utf-8"))
            open_page()
            check(launcher.evaluate("(() => { const s = document.querySelector('#xml1-page .detail-testmode'); "
                                    "return !!s && s.querySelector('.detail-display-title').textContent; })()") == "Test mode", "a Test mode section")
            check(ui("return panel.querySelectorAll('.ul-testmode-row').length;") == 2, "two rows")
            check("turns online play off" in (ui("const e = panel.querySelector('.ul-testmode-online'); return e ? e.textContent : '';") or ""),
                  "the online-play note")
            check([shown("ForgeEverywhere"), shown("Hotkeys")] == ["0", "1"], "Forge OFF, hotkeys ON, as the file says")
            check(badge_shown(), "the badge is on the page while Hotkeys is on")
            check(launcher.evaluate("(() => { const b = document.getElementById('xml1-testmode-badge'); "
                                    "const g = document.getElementById('xml1-button-group'); return !!b && !!g && g.nextElementSibling === b; })()"),
                  "right under Play's button group")
            launcher.evaluate("document.getElementById('xml1-page').scrollIntoView({ block: 'start' })")
            time.sleep(0.5)
            shot = pathlib.Path(__file__).with_name("test-mode-badge.png")
            launcher.screenshot(shot)
            print(f"  screenshot: {shot}")

            print("page: a toggle writes its own key, the rest stays byte for byte")
            before = text()
            check(click("ForgeEverywhere", "1") == "clicked", "click Forge ON")
            time.sleep(SAVE_WAIT)
            check(text() == before.replace(FORGE_LINE, "ForgeEverywhere=1   ; the Forge appears at every Xtraction point (default 0)"),
                  "only the ForgeEverywhere line changed")

            print("page: the badge goes with the last switch off, comes back with the first on")
            check(click("ForgeEverywhere", "0") == "clicked" and click("Hotkeys", "0") == "clicked", "both OFF")
            check(not badge_shown(), "badge gone at once")
            time.sleep(SAVE_WAIT)
            check(get()["values"] == {"ForgeEverywhere": False, "Hotkeys": False}, "both saved off")
            check(click("ForgeEverywhere", "1") == "clicked" and badge_shown(), "Forge ON: the badge is back")
            time.sleep(SAVE_WAIT)

            print("page: Turn test mode off")
            check(click("Hotkeys", "1") == "clicked", "Hotkeys ON too")
            time.sleep(SAVE_WAIT)
            before = text()
            check(ui("const b = badge.querySelector('.ul-testmode-off'); if (!b || b.disabled) return false; b.focus(); b.click(); return true;"),
                  "click Turn test mode off")
            check(wait_for(lambda: get()["values"] == {"ForgeEverywhere": False, "Hotkeys": False}, 5), "both written off")
            check(text() == before.replace("ForgeEverywhere=1", "ForgeEverywhere=0").replace("Hotkeys=1", "Hotkeys=0"),
                  "those two values and nothing else")
            check(not badge_shown(), "badge gone")
            check(launcher.evaluate("document.activeElement && document.activeElement.closest('#xml1-button-group') !== null"),
                  "the focus is on the button group (Play / Set up), not lost")

            print("page: the keyboard reaches and switches everything (Tab, Shift+Tab, Enter, Space)")
            check(ui("return [...panel.querySelectorAll('.toggle-btn')].every(b => b.tagName === 'BUTTON' && b.tabIndex === 0 && !b.disabled);"),
                  "every toggle is a focusable button")
            check(click("ForgeEverywhere", "1") == "clicked", "Forge ON: the badge is up")
            time.sleep(SAVE_WAIT)
            launcher.evaluate("document.querySelector('#xml1-button-group button').focus()")
            press("Tab")
            check(focused() == "badge:off", f"one Tab from Play: Turn test mode off ({focused()})")
            for _ in range(80):
                if focused() == "ForgeEverywhere:0":
                    break
                press("Tab")
            check(focused() == "ForgeEverywhere:0", "Tab on through the page reaches the first toggle")
            check(ui("const b = document.activeElement; return getComputedStyle(b).outlineStyle !== 'none';"), "with a focus ring")
            press("Tab")
            press("Tab")
            check(focused() == "Hotkeys:0", "two more Tabs: the hotkeys' OFF")
            press("Tab")
            press("Enter")
            check(focused() == "Hotkeys:1" and shown("Hotkeys") == "1", "Tab, Enter: hotkeys ON")
            press("Tab", shift=True)
            press("Space")
            check(focused() == "Hotkeys:0" and shown("Hotkeys") == "0", "Shift+Tab, Space: hotkeys OFF")
            time.sleep(SAVE_WAIT)
            check(get()["values"]["Hotkeys"] is False, "saved")
            launcher.evaluate("document.activeElement.blur()")

            print("the file edited outside the launcher")
            ini.write_bytes(TESTMODE_TEMPLATE.replace(FORGE_LINE, "ForgeEverywhere=yes").encode("utf-8"))
            reload()
            check(shown("ForgeEverywhere") == "1" and badge_shown(), "'yes' shows ON and the badge")
            ini.write_bytes(TESTMODE_TEMPLATE.replace(FORGE_LINE, "ForgeEverywhere=maybe").encode("utf-8"))
            reload()
            check(shown("ForgeEverywhere") == "0" and not badge_shown(), "an unreadable value shows the default, OFF")

            # A tidy state for the screenshot: Forge on.
            ini.write_bytes(INI_TEMPLATE.encode("utf-8"))
            reload()
            click("ForgeEverywhere", "1")
            time.sleep(SAVE_WAIT)
            launcher.evaluate("document.querySelector('#xml1-page .detail-testmode').scrollIntoView({ block: 'center' })")
            time.sleep(0.5)
            shot = pathlib.Path(__file__).with_name("test-mode-section.png")
            launcher.screenshot(shot)
            print(f"  screenshot: {shot}")

            print("fix removed")
            fix.unlink()
            check(get()["fixInstalled"] is False and put({"Hotkeys": True}).get("success") is False, "writes refused")
            reload()
            check(ui("return panel.querySelectorAll('.ul-testmode-row').length;") == 0 and not badge_shown(),
                  "no toggles, no badge: the install hint instead")
            check((game / "XMen2.exe").exists(), "game folder untouched")
        finally:
            launcher.command("set-game-property", {"game": "xml1", "suffix": "install", "value": original or ""})

    print(f"\n{'PASSED' if not failures else 'FAILED'} ({failures} failure{'s' if failures != 1 else ''})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
