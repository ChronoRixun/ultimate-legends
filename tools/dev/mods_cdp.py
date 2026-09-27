"""End-to-end check of the Mods section against a running Debug build (see launcher_cdp.py).

Points the XML2 entry of the Debug launcher at a throwaway folder with a dummy XMen2.exe,
then installs, reorders, toggles and removes mods through the same commands the page uses,
and saves a screenshot of the XML2 page. Never touches a real game install.

    tools\\run-test-debug.bat
    python tools\\dev\\mods_cdp.py
"""
import json
import pathlib
import sys
import tempfile
import time
import zipfile

from launcher_cdp import Launcher, wait_for


def main():
    launcher = Launcher()
    failures = 0

    def check(ok, label):
        nonlocal failures
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}")
        failures += not ok

    with tempfile.TemporaryDirectory(prefix="ul-fake-xml2-") as folder:
        game = pathlib.Path(folder)
        (game / "XMen2.exe").write_bytes(b"placeholder - not a real game")
        (game / "data").mkdir()

        original = launcher.command("get-game-property", {"game": "xml2", "suffix": "install"})
        try:
            check(launcher.command("set-game-path", {"game": "xml2", "path": str(game), "existing_install": True}) is True,
                  "XML2 pointed at the fake game folder")

            print("empty")
            state = launcher.command("get-mods", {"game": "xml2"})
            check(state["installed"] and state["mods"] == [], "no mods yet")

            print("install from a zip")
            archive = game.parent / f"{game.name}-Hero Pack.zip"
            with zipfile.ZipFile(archive, "w") as z:
                z.writestr("Hero Pack/readme.txt", "hello")
                z.writestr("Hero Pack/data/herostat.engb", "stats")
                z.writestr("Hero Pack/mod.json", json.dumps({"name": "Hero Pack", "version": "1.2", "author": "Test"}))
            started = launcher.command("import-mod", {"game": "xml2", "path": str(archive), "kind": "zip"})
            check(started.get("success") is True, "import started")
            done = wait_for(lambda: not launcher.command("get-mod-import", {"game": "xml2"})["active"], 30)
            job = launcher.command("get-mod-import", {"game": "xml2"})
            check(done and job["error"] == "" and job["name"] == "Hero Pack", f"installed as {job['name']!r} {job['error']}")
            check((game / "mods" / "Hero Pack" / "data" / "herostat.engb").exists(), "files are in mods\\Hero Pack")
            archive.unlink()

            print("install from a folder")
            source = pathlib.Path(tempfile.mkdtemp(prefix="ul-mod-src-")) / "Skins"
            (source / "actors").mkdir(parents=True)
            (source / "actors" / "0101.igb").write_bytes(b"skin")
            launcher.command("import-mod", {"game": "xml2", "path": str(source), "kind": "folder"})
            wait_for(lambda: not launcher.command("get-mod-import", {"game": "xml2"})["active"], 30)
            job = launcher.command("get-mod-import", {"game": "xml2"})
            check(job["error"] == "" and job["name"] == "Skins", f"installed as {job['name']!r} {job['error']}")
            state = launcher.command("get-mods", {"game": "xml2"})
            names = [m["name"] for m in state["mods"]]
            check(names == ["Hero Pack", "Skins"], f"load order {names}")
            hero = state["mods"][0]
            check(hero["title"] == "Hero Pack" and hero["version"] == "1.2" and hero["author"] == "Test", "mod.json details shown")

            print("reorder and toggle")
            check(launcher.command("set-mod-order", {"game": "xml2", "names": ["Skins", "Hero Pack"]})["success"], "reordered")
            check(launcher.command("set-mod-enabled", {"game": "xml2", "name": "Skins", "enabled": False})["success"], "disabled Skins")
            order = (game / "mods" / "load-order.txt").read_text()
            check("-Skins\r\n+Hero Pack\r\n" in order.replace("\n", "\r\n").replace("\r\r", "\r"), "load-order.txt written for the game")

            print("page")
            launcher.evaluate("document.querySelector('.game-item[data-game=\"xml2\"]').click()")
            time.sleep(1.5)
            rows = launcher.evaluate("document.querySelectorAll('#xml2-mods-panel .ul-mod').length")
            check(rows == 2, f"Mods section lists {rows} mods")
            launcher.evaluate("document.getElementById('xml2-mods-panel').scrollIntoView()")
            time.sleep(0.5)
            shot = pathlib.Path(__file__).with_name("mods-section.png")
            launcher.screenshot(shot)
            print(f"  screenshot: {shot}")

            print("uninstall")
            check(launcher.command("uninstall-mod", {"game": "xml2", "name": "Hero Pack"})["success"], "removed Hero Pack")
            check(not (game / "mods" / "Hero Pack").exists(), "its folder is gone")
            check(launcher.command("uninstall-mod", {"game": "xml2", "name": "..\\data"})["success"] is False, "refuses paths outside mods")
            check((game / "data").exists(), "game folder untouched")
        finally:
            if original:
                launcher.command("set-game-path", {"game": "xml2", "path": original, "existing_install": True})

    print(f"\n{'PASSED' if not failures else 'FAILED'} ({failures} failure{'s' if failures != 1 else ''})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
