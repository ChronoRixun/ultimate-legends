"""End-to-end check of the patch line on a game's page against a running Debug build (see launcher_cdp.py).

Points the MUA entry of the Debug launcher at a throwaway folder with a dummy Marvel.exe and serves
stand-ins for GitHub's "latest release" answer from a local server (mua-patch-release, Debug builds
only), then reads get-patch-status and the page's patch line for: no patch file yet, a patch DLL with
a version resource (Windows' own dinput8.dll, so its version is known), one without, a newer and an
older release, a release still being published (no ultimate-legends.json yet) and an unreachable
check. Clicking Update must start the same Verify as the page's Verify button (stubbed here, so
nothing is downloaded). Saves a screenshot of the page with an update available. Never touches a
real game install.

    tools\\run-test-debug.bat
    python tools\\dev\\patch_cdp.py
"""
import ctypes
import http.server
import json
import pathlib
import shutil
import sys
import tempfile
import threading
import time

from launcher_cdp import Launcher, wait_for

SYSTEM_DLL = pathlib.Path(r"C:\Windows\System32\dinput8.dll")


def file_version(path):
    """The DLL's FILEVERSION as patch_status formats it: a.b.c, or a.b.c.d when d isn't 0."""
    version = ctypes.windll.version
    size = version.GetFileVersionInfoSizeW(str(path), None)
    buffer = ctypes.create_string_buffer(size)
    version.GetFileVersionInfoW(str(path), 0, size, buffer)
    info = ctypes.c_void_p()
    length = ctypes.c_uint()
    version.VerQueryValueW(buffer, "\\", ctypes.byref(info), ctypes.byref(length))
    fixed = ctypes.cast(info, ctypes.POINTER(ctypes.c_uint32 * 13)).contents
    ms, ls = fixed[2], fixed[3]
    parts = [ms >> 16, ms & 0xFFFF, ls >> 16, ls & 0xFFFF]
    return ".".join(str(p) for p in (parts if parts[3] else parts[:3]))


class Releases(http.server.BaseHTTPRequestHandler):
    """/release/<tag>: a published release; /draft/<tag>: one without the patch manifest yet; /broken: HTTP 500."""

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/release/") or path.startswith("/draft/"):
            tag = path.rsplit("/", 1)[1]
            assets = [{"name": "dinput8.dll"}] + ([{"name": "ultimate-legends.json"}] if path.startswith("/release/") else [])
            body = json.dumps({"tag_name": tag, "html_url": f"https://github.com/ChronoRixun/mua-controller-fix/releases/tag/{tag}",
                               "assets": assets}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(500)
            self.end_headers()

    def log_message(self, *args):
        pass


def main():
    launcher = Launcher()
    failures = 0

    def check(ok, label):
        nonlocal failures
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}")
        failures += not ok

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Releases)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    scenario = iter(range(1, 1000))

    def point_at(path):
        # A fresh URL per scenario: the launcher keeps a successful check for an hour per URL.
        launcher.command("set-game-property", {"game": "mua", "suffix": "patch-release", "value": f"{base}{path}?s={next(scenario)}"})

    def status():
        """get-patch-status once the background check is done."""
        wait_for(lambda: not launcher.command("get-patch-status", {"game": "mua"})["checking"], 20)
        return launcher.command("get-patch-status", {"game": "mua"})

    def page_line():
        launcher.evaluate("document.querySelector('.game-item[data-game=\"mua\"]').click()")
        wait_for(lambda: launcher.evaluate(
            "(() => { const p = document.getElementById('mua-patch'); return !!p && !p.hidden && !!p.querySelector('.detail-patch-installed'); })()"), 10)
        time.sleep(0.3)
        return launcher.evaluate("""(() => {
            const p = document.getElementById('mua-patch');
            const label = p.querySelector('.detail-patch-update-label');
            return { name: p.querySelector('.detail-patch-stat span').textContent.trim(),
                     installed: p.querySelector('.detail-patch-installed').textContent.trim(),
                     update: label ? label.textContent.trim() : null,
                     link: label && label.querySelector('a') ? label.querySelector('a').getAttribute('href') : null,
                     button: !!p.querySelector('.detail-patch-update-action') };
        })()""")

    with tempfile.TemporaryDirectory(prefix="ul-fake-mua-patch-") as folder:
        game = pathlib.Path(folder)
        (game / "Marvel.exe").write_bytes(b"placeholder - not a real game")
        patch = game / "dinput8.dll"

        original = launcher.command("get-game-property", {"game": "mua", "suffix": "install"})
        try:
            check(launcher.command("set-game-path", {"game": "mua", "path": str(game), "existing_install": True}) is True,
                  "MUA pointed at the fake game folder")

            print("no patch file yet")
            point_at("/release/v1.2.0")
            s = status()
            check(s["installed"] is None and s["latest"] == "1.2.0" and not s["updateAvailable"], f"not installed, nothing to update: {s}")
            line = page_line()
            check(line["name"] == "MUA Controller Fix" and line["installed"] == "Not installed yet" and line["update"] is None,
                  f"page: {line}")

            print("a patch with a version resource")
            shutil.copyfile(SYSTEM_DLL, patch)
            installed = file_version(patch)
            major = int(installed.split(".")[0])
            point_at(f"/release/v{major + 1}.0.0")
            s = status()
            check(s["installed"] == installed and s["latest"] == f"{major + 1}.0.0" and s["updateAvailable"],
                  f"{installed} installed, {major + 1}.0.0 newer: update available")
            check(s["page"].endswith(f"/tag/v{major + 1}.0.0"), "release page passed on")
            line = page_line()
            check(line["installed"] == installed and line["update"] == f"Update available: {major + 1}.0.0" and line["button"],
                  f"page: {line}")
            check(line["link"] == s["page"], "the notice links the release page")
            launcher.evaluate("document.getElementById('mua-patch').scrollIntoView()")
            time.sleep(0.5)
            shot = pathlib.Path(__file__).with_name("patch-update-available.png")
            launcher.screenshot(shot)
            print(f"  screenshot: {shot}")

            print("Update runs Verify")
            clicked = launcher.evaluate("""(() => {
                const real = window.verifyGame;
                let called = null;
                window.verifyGame = gameId => { called = gameId; };
                try { document.querySelector('#mua-patch .detail-patch-update-action').click(); }
                finally { window.verifyGame = real; }
                return called;
            })()""")
            check(clicked == "mua", f"verifyGame('mua') called: {clicked!r}")

            print("an older release")
            point_at(f"/release/v{max(major - 1, 0)}.9.0")
            s = status()
            check(s["installed"] == installed and not s["updateAvailable"], "nothing newer: no update")
            check(page_line()["update"] is None, "no notice on the page")

            print("a release still being published")
            point_at(f"/draft/v{major + 2}.0.0")
            s = status()
            check(s["latest"] is None and not s["updateAvailable"], "no ultimate-legends.json yet: not offered")

            print("the check fails")
            point_at("/broken")
            s = status()
            check(not s["checking"] and s["latest"] is None and not s["updateAvailable"], "HTTP 500: no update, no error on the page")
            check(page_line()["installed"] == installed, "the installed release is still shown")

            print("a patch file without a version resource")
            patch.write_bytes(b"MZ - not a real DLL")
            point_at("/release/v1.2.0")
            s = status()
            check(s["installed"] == "" and s["updateAvailable"], "unknown version: the release is offered")
            check(page_line()["installed"] == "Installed", "page: Installed")

            print("XML2 and XML1 answer too, MUA2 shares MUA's check")
            check(launcher.command("get-patch-status", {"game": "mua2"}) is not None, "mua2")
            check(launcher.command("get-patch-status", {"game": "xml2"}) is not None, "xml2")
        finally:
            launcher.command("set-game-property", {"game": "mua", "suffix": "patch-release", "value": ""})
            if original:
                launcher.command("set-game-path", {"game": "mua", "path": original, "existing_install": True})
            server.shutdown()

    print(f"\n{'PASSED' if not failures else 'FAILED'} ({failures} failure{'s' if failures != 1 else ''})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
