"""End-to-end check of the Display section against a running Debug build (see launcher_cdp.py).

Points the XML2 entry of the Debug launcher at a throwaway folder with a dummy XMen2.exe and a
dummy dinput.dll (the XML2 Fix), then reads and writes that folder's xml2-fix.ini through the same
commands the page uses and through the page's own controls, and saves a screenshot of the XML2
page. Never touches a real game install.

    tools\\run-test-debug.bat
    python tools\\dev\\display_cdp.py
"""
import pathlib
import sys
import tempfile
import time

from launcher_cdp import Launcher

INI_TEMPLATE = (
    "; XML2 Fix settings (test copy)\r\n"
    "[Online]\r\n"
    "Domain=openspy.net\r\n"
    "\r\n"
    "[Display]\r\n"
    "; how the game is shown\r\n"
    "Mode=fullscreen\r\n"
)


def main():
    launcher = Launcher()
    failures = 0

    def check(ok, label):
        nonlocal failures
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}")
        failures += not ok

    def get():
        return launcher.command("get-display-settings", {"game": "xml2"})

    def put(values):
        return launcher.command("set-display-settings", {"game": "xml2", "values": values})

    def ui(expression):
        return launcher.evaluate(f"(() => {{ const panel = document.getElementById('xml2-display-panel'); {expression} }})()")

    def set_select(key, value):
        return ui(f"const s = panel.querySelector('select[data-key=\"{key}\"]'); s.value = {value!r}; "
                  "s.dispatchEvent(new Event('change', { bubbles: true })); return s.value;")

    with tempfile.TemporaryDirectory(prefix="ul-fake-xml2-") as folder:
        game = pathlib.Path(folder)
        (game / "XMen2.exe").write_bytes(b"placeholder - not a real game")
        ini = game / "xml2-fix.ini"
        fix = game / "dinput.dll"

        def ini_text():
            return ini.read_text(encoding="utf-8", errors="replace") if ini.exists() else ""

        original = launcher.command("get-game-property", {"game": "xml2", "suffix": "install"})
        try:
            check(launcher.command("set-game-path", {"game": "xml2", "path": str(game), "existing_install": True}) is True,
                  "XML2 pointed at the fake game folder")

            print("without the fix")
            state = get()
            check(state["supported"] and state["installed"] and not state["fixInstalled"], "game set up, fix not installed")
            check(put({"Mode": "borderless"}).get("success") is False, "refuses to write without the fix")
            check(not ini.exists(), "no ini created")
            check(launcher.command("get-display-settings", {"game": "mua"})["supported"] is False, "MUA has no display settings")

            print("read")
            fix.write_bytes(b"placeholder - not the real fix")
            ini.write_text(INI_TEMPLATE, encoding="ascii")
            state = get()
            check(state["fixInstalled"] and state["ini"].lower() == str(ini).lower(), f"fix seen, ini at {state.get('ini')}")
            values = state["values"]
            check(values["Mode"] == "fullscreen" and values["Width"] is None and values["FrameRate"] is None and values["VSync"] is None,
                  f"values read {values}")
            check(state["modes"] and all(m["width"] >= 640 and m["height"] >= 480 for m in state["modes"]), f"{len(state['modes'])} display modes")
            check(state["desktop"]["width"] > 0 and state["desktop"]["height"] > 0, f"desktop {state['desktop']}")
            check(state["modes"] == sorted(state["modes"], key=lambda m: (m["width"], m["height"])), "modes sorted, smallest first")
            check(len({(m["width"], m["height"]) for m in state["modes"]}) == len(state["modes"]), "each size once")

            print("write")
            result = put({"Mode": "Borderless", "FrameRate": "refresh", "VSync": True, "RunInBackground": False, "Width": 2560, "Height": 1440})
            check(result.get("success") is True, f"wrote six keys {result.get('error', '')}")
            values = result.get("values", {})
            check(values.get("Mode") == "borderless" and values.get("FrameRate") == "refresh" and values.get("VSync") is True
                  and values.get("RunInBackground") is False and values.get("Width") == 2560 and values.get("Height") == 1440,
                  f"answer carries the new values {values}")
            text = ini_text()
            for line in ("Mode=borderless", "FrameRate=refresh", "VSync=1", "RunInBackground=0", "Width=2560", "Height=1440"):
                check(line in text, f"ini has {line}")
            for kept in ("; XML2 Fix settings (test copy)", "[Online]", "Domain=openspy.net", "; how the game is shown"):
                check(kept in text, f"ini keeps {kept!r}")
            check(text.count("[Display]") == 1, "one [Display] section")

            print("game default removes the key")
            result = put({"Mode": None, "VSync": None, "Width": None, "Height": None})
            check(result.get("success") is True, "removed four keys")
            text = ini_text()
            check("Mode=" not in text and "VSync=" not in text and "Width=" not in text and "Height=" not in text, "keys gone")
            check("FrameRate=refresh" in text and "RunInBackground=0" in text and "; how the game is shown" in text, "the rest stays")
            check(get()["values"]["Mode"] is None, "Mode reads as game default")

            print("bad values are refused before anything is written")
            before = ini_text()
            check(put({"Mode": "weird"}).get("success") is False, "unknown Mode")
            check(put({"FrameRate": "fast"}).get("success") is False, "FrameRate word")
            check(put({"Width": -1}).get("success") is False, "negative Width")
            check(put({"VSync": 2}).get("success") is False, "VSync=2")
            check(put({"Bogus": 1}).get("success") is False, "unknown key")
            check(put({}).get("success") is False, "nothing to change")
            check(put({"Mode": "windowed", "FrameRate": "fast"}).get("success") is False, "one bad value fails the batch")
            check(ini_text() == before, "ini untouched by refused writes")

            print("numbers and a fresh file")
            check(put({"FrameRate": 180}).get("values", {}).get("FrameRate") == "180", "FrameRate 180 written as text")
            check(put({"FrameRate": 0}).get("values", {}).get("FrameRate") == "0", "FrameRate 0 = unlimited")
            ini.unlink()
            check(put({"Mode": "windowed"}).get("success") is True and "Mode=windowed" in ini_text(), "ini created when missing")
            ini.write_text(INI_TEMPLATE.replace("Mode=fullscreen", "FrameRate=180"), encoding="ascii")

            print("page")
            launcher.evaluate("document.querySelector('.game-item[data-game=\"xml2\"]').click()")
            time.sleep(1.5)
            rows = ui("return panel.querySelectorAll('.ul-display-row').length;")
            check(rows == 6, f"Display section shows {rows} rows")
            check(ui("return panel.querySelector('select[data-key=\"Mode\"]').value;") == "", "Mode shows game default")
            check(ui("return panel.querySelector('select[data-key=\"FrameRate\"]').value;") == "180", "FrameRate shows the file's 180")
            check("180" in ui("const s = panel.querySelector('select[data-key=\"FrameRate\"]'); return s.options[s.selectedIndex].text;"),
                  "and lists it as an option")
            check(ui("return panel.querySelector('select[data-key=\"Resolution\"]').disabled;") is True, "Resolution disabled in game default")
            check(ui("return panel.querySelectorAll('.ul-display-note').length;") == 3, "restart note on Mode, Resolution and VSync")
            check(ui("return panel.querySelector('.ul-display-toggle[data-key=\"RunInBackground\"] .toggle-btn.active').dataset.value;") == "1",
                  "Run in background defaults to ON")

            set_select("Mode", "windowed")
            check(ui("return panel.querySelector('select[data-key=\"Resolution\"]').disabled;") is False, "Resolution enabled for windowed")
            time.sleep(0.8)
            check("Mode=windowed" in ini_text(), "Mode saved from the page")

            desktop = get()["desktop"]
            set_select("Resolution", f"{desktop['width']}x{desktop['height']}")
            set_select("VSync", "1")
            ui("panel.querySelector('.ul-display-toggle[data-key=\"Topmost\"] .toggle-btn[data-value=\"1\"]').click();")
            time.sleep(0.8)
            text = ini_text()
            check(f"Width={desktop['width']}" in text and f"Height={desktop['height']}" in text, "desktop resolution saved (one debounced write)")
            check("VSync=1" in text and "Topmost=1" in text, "VSync and Topmost saved")
            check("; how the game is shown" in text and "[Online]" in text, "comments and other sections kept")

            launcher.evaluate("document.getElementById('xml2-display-panel').scrollIntoView()")
            time.sleep(0.5)
            shot = pathlib.Path(__file__).with_name("display-section.png")
            launcher.screenshot(shot)
            print(f"  screenshot: {shot}")

            set_select("Mode", "")
            time.sleep(0.8)
            check(ui("return panel.querySelector('select[data-key=\"Resolution\"]').disabled;") is True, "Resolution disabled again")
            check("Mode=" not in ini_text() and f"Width={desktop['width']}" in ini_text(), "Mode removed, resolution kept for later")

            print("fix removed")
            fix.unlink()
            check(get()["fixInstalled"] is False, "fix no longer seen")
            launcher.evaluate("window.DisplayView.reload('xml2')")
            time.sleep(0.8)
            check(ui("return panel.querySelectorAll('.ul-display-row').length;") == 0
                  and ui("return !!panel.querySelector('.ul-display-empty');"), "page shows the install hint instead")
            check((game / "XMen2.exe").exists(), "game folder untouched")
        finally:
            if original:
                launcher.command("set-game-path", {"game": "xml2", "path": original, "existing_install": True})

    print(f"\n{'PASSED' if not failures else 'FAILED'} ({failures} failure{'s' if failures != 1 else ''})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
