"""End-to-end check of the Discord section against a running Debug build (see launcher_cdp.py).

Points the XML2 entry of the Debug launcher at a throwaway folder with a dummy XMen2.exe and a
dummy dinput.dll (the XML2 Fix), then reads and writes that folder's xml2-fix.ini [Discord] section
through the same commands the page uses and through the page's own toggles, and saves a screenshot
of the section. Never touches a real game install.

    tools\\run-test-debug.bat
    python tools\\dev\\presence_cdp.py
"""
import pathlib
import sys
import tempfile
import time

from launcher_cdp import Launcher

# Other sections, comments, a non-ASCII comment and a blank line, none of which may move.
INI_TEMPLATE = (
    "; XML2 Fix settings (test copy) — café\r\n"
    "[Online]\r\n"
    "Domain=openspy.net\r\n"
    "\r\n"
    "[Display]\r\n"
    "; how the game is shown\r\n"
    "Mode=borderless\r\n"
    "InGameOptions=1\r\n"
)

# A [Discord] section the launcher didn't write: a comment and a key it doesn't know.
DISCORD_TEMPLATE = INI_TEMPLATE + (
    "\r\n"
    "[Discord]\r\n"
    "; rich presence\r\n"
    "AppId=123456789\r\n"
    "Enabled=0\r\n"
    "ShowParty=0\r\n"
    "\r\n"
    "[Debug]\r\n"
    "LogNetwork=0\r\n"
)

# Inline comments, read as the fix reads them: the value is the text after '=' up to a ';' or '#',
# trimmed. The first line is the XML2 Fix README's own example: OFF in the game, so OFF here too.
README_ENABLED = "Enabled=0        ; no presence at all (0, false, no or off; anything else, or no key: on)"
COMMENTED_TEMPLATE = INI_TEMPLATE + (
    "\r\n"
    "[Discord]\r\n"
    f"{README_ENABLED}\r\n"
    "ShowZone=   ; not decided yet\r\n"
    "ShowParty=OFF # later\r\n"
)

SAVE_WAIT = 0.8  # the page writes 250 ms after the last click


def main():
    launcher = Launcher()
    failures = 0

    def check(ok, label):
        nonlocal failures
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}")
        failures += not ok

    def get(game="xml2"):
        return launcher.command("get-presence-settings", {"game": game})

    def put(values):
        return launcher.command("set-presence-settings", {"game": "xml2", "values": values})

    def ui(expression):
        return launcher.evaluate(f"(() => {{ const panel = document.getElementById('xml2-presence-panel'); {expression} }})()")

    def click(key, value):
        return ui(f"const b = panel.querySelector('.ul-presence-toggle[data-key=\"{key}\"] .toggle-btn[data-value=\"{value}\"]'); "
                  "if (!b) return 'missing'; b.click(); return b.disabled ? 'disabled' : 'clicked';")

    def shown(key):
        return ui(f"const b = panel.querySelector('.ul-presence-toggle[data-key=\"{key}\"] .toggle-btn.active'); return b ? b.dataset.value : null;")

    def disabled(key):
        return ui(f"return [...panel.querySelectorAll('.ul-presence-toggle[data-key=\"{key}\"] .toggle-btn')].every(b => b.disabled);")

    def open_page():
        launcher.evaluate("document.querySelector('.game-item[data-game=\"xml2\"]').click()")
        time.sleep(1.5)

    with tempfile.TemporaryDirectory(prefix="ul-fake-xml2-") as folder:
        game = pathlib.Path(folder)
        (game / "XMen2.exe").write_bytes(b"placeholder - not a real game")
        ini = game / "xml2-fix.ini"
        fix = game / "dinput.dll"

        def raw():
            return ini.read_bytes() if ini.exists() else b""

        def text():
            return raw().decode("utf-8", errors="replace")

        original = launcher.command("get-game-property", {"game": "xml2", "suffix": "install"})
        try:
            check(launcher.command("set-game-path", {"game": "xml2", "path": str(game), "existing_install": True}) is True,
                  "XML2 pointed at the fake game folder")

            print("without the fix")
            state = get()
            check(state["supported"] and state["installed"] and not state["fixInstalled"], "game set up, fix not installed")
            check(state.get("fix") == "XML2 Fix" and state.get("file") == "xml2-fix.ini", f"fix named {state.get('fix')!r}, file {state.get('file')!r}")
            check(put({"Enabled": False}).get("success") is False, "refuses to write without the fix")
            check(not ini.exists(), "no ini created")
            check(get("mua")["supported"] is False, "MUA has no Discord settings (yet)")
            check(get("nope")["supported"] is False, "unknown game: not supported")

            print("read: absent means on")
            fix.write_bytes(b"placeholder - not the real fix")
            ini.write_bytes(INI_TEMPLATE.encode("utf-8"))
            state = get()
            check(state["fixInstalled"] and state["ini"].lower() == str(ini).lower(), f"fix seen, ini at {state.get('ini')}")
            check(state["values"] == {"Enabled": None, "ShowZone": None, "ShowParty": None}, f"no [Discord] yet: {state['values']}")
            check(state["defaults"] == {"Enabled": True, "ShowZone": True, "ShowParty": True}, "every key defaults to on")

            print("write into a file without [Discord]")
            before = raw()
            result = put({"Enabled": False})
            check(result.get("success") is True and result["values"]["Enabled"] is False, f"Enabled off {result.get('error', '')}")
            after = raw()
            check(after.startswith(before), "everything before the new section is byte-for-byte the same")
            check("[Discord]\r\nEnabled=0\r\n" in text(), "[Discord] Enabled=0 appended")
            check("[]" not in text() and text().count("[Discord]") == 1, "one [Discord], no stray section")

            result = put({"Enabled": True, "ShowZone": False})
            check(result.get("success") is True, "Enabled on, ShowZone off")
            check("Enabled=1" in text() and "ShowZone=0" in text(), "Enabled=1 written explicitly, ShowZone=0")
            check(result["values"] == {"Enabled": True, "ShowZone": False, "ShowParty": None}, f"answer {result['values']}")

            result = put({"ShowZone": None})
            check(result.get("success") is True and "ShowZone=" not in text(), "null removes a key (back to on)")
            check(get()["values"]["ShowZone"] is None, "ShowZone reads as default again")

            print("values the command takes")
            check(put({"ShowParty": "0"}).get("values", {}).get("ShowParty") is False, "\"0\"")
            check(put({"ShowParty": 1}).get("values", {}).get("ShowParty") is True, "1")
            check(put({"ShowParty": "off"}).get("values", {}).get("ShowParty") is False and "ShowParty=0" in text(), "\"off\" written as 0")

            print("bad values are refused before anything is written")
            before = raw()
            check(put({"Enabled": "maybe"}).get("success") is False, "Enabled=maybe")
            check(put({"Enabled": 2}).get("success") is False, "Enabled=2")
            check(put({"Enabled": 0.5}).get("success") is False, "Enabled=0.5")
            check(put({"AppId": 1}).get("success") is False, "unknown key")
            check(put({"Bogus": None}).get("success") is False, "unknown key, even to remove")
            check(put({}).get("success") is False, "nothing to change")
            check(put({"ShowZone": False, "Enabled": "maybe"}).get("success") is False, "one bad value fails the batch")
            check(raw() == before, "ini untouched by refused writes")

            print("a [Discord] section written by hand")
            ini.write_bytes(DISCORD_TEMPLATE.encode("utf-8"))
            state = get()
            check(state["values"] == {"Enabled": False, "ShowZone": None, "ShowParty": False}, f"read {state['values']}")
            result = put({"Enabled": True, "ShowZone": False})
            check(result.get("success") is True, "written")
            expected = DISCORD_TEMPLATE.replace("Enabled=0", "Enabled=1").replace("ShowParty=0\r\n", "ShowParty=0\r\nShowZone=0\r\n")
            check(text() == expected, "changed in place: the comment, AppId, [Debug] and the order all kept")
            if text() != expected:
                print(text())

            ini.write_bytes(DISCORD_TEMPLATE.replace("Enabled=0", "Enabled=maybe").encode("utf-8"))
            check(get()["values"]["Enabled"] == "maybe", "an unreadable value comes back as written")

            print("inline comments, read as the fix reads them")
            ini.write_bytes(COMMENTED_TEMPLATE.encode("utf-8"))
            state = get()
            check(state["values"] == {"Enabled": False, "ShowZone": None, "ShowParty": False},
                  f"README line is OFF, empty-with-comment is the default, 'OFF # later' is OFF: {state['values']}")

            def reads(line, key="Enabled"):
                ini.write_bytes((INI_TEMPLATE + f"\r\n[Discord]\r\n{line}\r\n").encode("utf-8"))
                return get()["values"][key]

            check(reads("Enabled=1;tight") is True, "1;tight (no space before the ';')")
            check(reads("Enabled=no\t; after a tab") is False, "no<tab>; comment")
            check(reads("Enabled = False   # hash comment") is False, "spaces round '=', False # comment")
            check(reads("Enabled=Yes ; comment") is True, "Yes ; comment")
            check(reads("Enabled=on#x") is True, "on#x")
            check(reads("Enabled=0 ; 1") is False, "a 1 in the comment doesn't count")
            check(reads("Enabled=;") is None, "only a comment: the default")
            check(reads("Enabled=maybe ; comment") == "maybe", "unreadable with a comment: the value alone comes back")

            print("rewriting keeps the inline comment")
            ini.write_bytes(COMMENTED_TEMPLATE.encode("utf-8"))
            result = put({"Enabled": True, "ShowZone": False, "ShowParty": True})
            check(result.get("success") is True and result["values"] == {"Enabled": True, "ShowZone": False, "ShowParty": True},
                  f"three keys flipped {result.get('values')}")
            expected = (COMMENTED_TEMPLATE.replace(README_ENABLED, README_ENABLED.replace("Enabled=0", "Enabled=1"))
                        .replace("ShowZone=   ; not decided yet", "ShowZone=0 ; not decided yet")
                        .replace("ShowParty=OFF # later", "ShowParty=1 # later"))
            check(text() == expected, "each line's comment kept after its new value, spacing and all")
            if text() != expected:
                print(text())
            check(put({"Enabled": False}).get("values", {}).get("Enabled") is False
                  and f"{README_ENABLED}\r\n" in text(), "and back to the README's line exactly")

            ini.write_bytes((INI_TEMPLATE + "\r\n[Discord]\r\nEnabled=1;tight\r\n").encode("utf-8"))
            put({"Enabled": False})
            check("Enabled=0;tight\r\n" in text(), "a tight comment stays tight")

            long_comment = "; " + "long comment " * 60
            ini.write_bytes((INI_TEMPLATE + f"\r\n[Discord]\r\nShowZone=1 {long_comment.strip()}\r\n").encode("utf-8"))
            check(get()["values"]["ShowZone"] is True, f"read past a {len(long_comment.strip())}-character comment")
            put({"ShowZone": False})
            check(f"ShowZone=0 {long_comment.strip()}\r\n" in text(), "and the comment kept whole on a rewrite")

            ini.write_bytes(COMMENTED_TEMPLATE.encode("utf-8"))
            check(put({"Enabled": None}).get("success") is True and "Enabled" not in text()
                  and "no presence at all" not in text(), "removing a key removes its line, comment and all")
            check(text() == COMMENTED_TEMPLATE.replace(f"{README_ENABLED}\r\n", ""), "nothing else touched")

            print("a fresh file")
            ini.unlink()
            check(put({"ShowParty": False}).get("success") is True and text() == "[Discord]\r\nShowParty=0\r\n", "ini created when missing")

            print("page")
            ini.write_bytes(INI_TEMPLATE.encode("utf-8"))
            open_page()
            check(launcher.evaluate("(() => { const s = document.querySelector('#xml2-page .detail-display'); "
                                    "return !!s && !!s.nextElementSibling && s.nextElementSibling.classList.contains('detail-presence'); })()"),
                  "the Discord section follows the Display section")
            check(launcher.evaluate("document.querySelector('#xml2-page .detail-presence-title').textContent") == "Discord", "titled Discord")
            rows = ui("return panel.querySelectorAll('.ul-presence-row').length;")
            check(rows == 3, f"{rows} rows")
            check(ui("return panel.querySelector('.ul-presence-row[data-row=\"Enabled\"] .ul-display-label').textContent;")
                  == "Show what I’m playing on Discord", "main toggle label")
            check(ui("return panel.querySelector('.ul-presence-row[data-row=\"Enabled\"] .ul-display-description').textContent;")
                  == "Friends see the game, your zone and your party. No names or addresses.", "main toggle note")
            check([shown(k) for k in ("Enabled", "ShowZone", "ShowParty")] == ["1", "1", "1"], "all ON with no [Discord] section")
            check(not disabled("ShowZone") and not disabled("ShowParty"), "sub-options usable")
            check(ui("return panel.querySelectorAll('.ul-presence-row.is-sub').length;") == 2, "two sub-options")

            check(click("Enabled", "0") == "clicked", "click OFF")
            check(disabled("ShowZone") and disabled("ShowParty"), "sub-options disabled at once")
            time.sleep(SAVE_WAIT)
            check("[Discord]\r\nEnabled=0\r\n" in text(), "Enabled=0 saved from the page")
            check(click("ShowZone", "0") == "disabled" and "ShowZone" not in text(), "a disabled sub-option can't be changed")

            check(click("Enabled", "1") == "clicked", "click ON")
            check(click("ShowParty", "0") == "clicked", "ShowParty OFF")
            time.sleep(SAVE_WAIT)
            check("Enabled=1" in text() and "ShowParty=0" in text(), "Enabled=1 and ShowParty=0 saved (one debounced write)")
            check(text().startswith(INI_TEMPLATE), "the rest of the file kept")
            check(shown("ShowParty") == "0" and shown("Enabled") == "1", "toggles show the file")

            print("page follows the file")
            ini.write_bytes(DISCORD_TEMPLATE.encode("utf-8"))
            open_page()
            check([shown(k) for k in ("Enabled", "ShowZone", "ShowParty")] == ["0", "1", "0"], "hand-edited file shown on opening the page")
            check(disabled("ShowParty"), "sub-options disabled while presence is off")
            ini.write_bytes(DISCORD_TEMPLATE.replace("Enabled=0", "Enabled=maybe").encode("utf-8"))
            launcher.evaluate("window.PresenceView.reload('xml2')")
            time.sleep(0.8)
            check(shown("Enabled") == "1", "an unreadable value shows the default, ON")

            ini.write_bytes(COMMENTED_TEMPLATE.encode("utf-8"))
            launcher.evaluate("window.PresenceView.reload('xml2')")
            time.sleep(0.8)
            check([shown(k) for k in ("Enabled", "ShowZone", "ShowParty")] == ["0", "1", "0"],
                  "the README's 'Enabled=0 ; comment' shows OFF, as the game treats it")
            check(disabled("ShowZone") and disabled("ShowParty"), "sub-options disabled by it")
            check(click("Enabled", "1") == "clicked", "click ON")
            time.sleep(SAVE_WAIT)
            check(f"{README_ENABLED.replace('Enabled=0', 'Enabled=1')}\r\n" in text(), "saved from the page with the comment kept")

            # A tidy state for the screenshot: on, zone on, party off.
            ini.write_bytes(INI_TEMPLATE.encode("utf-8"))
            launcher.evaluate("window.PresenceView.reload('xml2')")
            time.sleep(0.8)
            click("ShowParty", "0")
            time.sleep(SAVE_WAIT)
            launcher.evaluate("document.querySelector('#xml2-page .detail-presence').scrollIntoView({ block: 'center' })")
            time.sleep(0.5)
            shot = pathlib.Path(__file__).with_name("presence-section.png")
            launcher.screenshot(shot)
            print(f"  screenshot: {shot}")

            print("fix removed")
            fix.unlink()
            check(get()["fixInstalled"] is False, "fix no longer seen")
            check(put({"Enabled": True}).get("success") is False, "writes refused")
            launcher.evaluate("window.PresenceView.reload('xml2')")
            time.sleep(0.8)
            check(ui("return panel.querySelectorAll('.ul-presence-row').length;") == 0
                  and "XML2 Fix" in ui("const e = panel.querySelector('.ul-display-empty'); return e ? e.textContent : '';"),
                  "page shows the install hint instead, naming the fix")
            check((game / "XMen2.exe").exists(), "game folder untouched")
        finally:
            if original:
                launcher.command("set-game-path", {"game": "xml2", "path": original, "existing_install": True})

    print(f"\n{'PASSED' if not failures else 'FAILED'} ({failures} failure{'s' if failures != 1 else ''})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
