"""End-to-end check of the launcher's self-update (updater/launcher_update.cpp, app/launcher-update.js)
against a portable copy of the Debug build and a fake GitHub release on a local server.

    python tools\\dev\\launcher_update_cdp.py        # about 2 minutes; needs: pip install websocket-client

It needs the Debug build and the Release CEF runtime (tools\\stage-runtime.ps1's sources), and no other
Debug launcher running (CEF's debugging port 12345). It starts and stops its own launcher.

The test install is build\\update-test\\install: the Debug exe, ultimate-legends\\portable.marker, the CEF
runtime (hard links) and the UI, with properties that point the Debug-only dev-launcher-release at the
local server and claim version 0.1.0 (dev-launcher-version). The server publishes 0.1.2 the way the
release workflow does: ultimate-legends-0.1.2-win64-portable.zip (the same exe; a UI with a marker file)
and SHA256SUMS.txt, listed in a releases/latest JSON of GitHub's shape.

Covers: the check (update available, the bar), a download whose SHA-256 doesn't match (refused, nothing
changed, nothing left behind), the download, Restart now (the swap: the new UI is live; user\\, tools\\,
cache\\, mods\\, portable.marker and the settings untouched; updates\\ cleaned up; "updated" reported),
up to date, a file held open in data\\cef during the swap (retried, rolled back, said, then installed by
the next Restart now), a swap interrupted before and after the exe moved and with an empty journal, a new
version whose first start never got its window up (all rolled back from what is on the disk), and
development builds (no checks).
The ultimatelegends:// registration the test exe takes over is put back at the end. Screenshots go to
tools/dev/launcher-update-*.png (gitignored).
"""
import hashlib
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import winreg
import zipfile

from launcher_cdp import Launcher, wait_for, DEBUG_PORT

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
DEBUG_EXE = REPO / "build" / "bin" / "x64" / "Debug" / "ultimate-legends.exe"
CEF = REPO / "build" / "runtime" / "x64" / "Release" / "cef"
UI = REPO / "src" / "launcher-ui"
WORK = REPO / "build" / "update-test"
INSTALL = WORK / "install"
ROOT = INSTALL / "ultimate-legends"
UPDATES = ROOT / "updates"
NEW_VERSION = "0.1.2"
ZIP_NAME = f"ultimate-legends-{NEW_VERSION}-win64-portable.zip"
SCHEME_KEY = r"Software\Classes\ultimatelegends"


def link_tree(source, target):
    """Hard links (same drive) or copies of every file of `source` under `target`."""
    for path in source.rglob("*"):
        destination = target / path.relative_to(source)
        if path.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(path, destination)
        except OSError:
            shutil.copy2(path, destination)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def processes_under(folder):
    script = ("Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('"
              + str(folder).replace("'", "''") + "', 'OrdinalIgnoreCase') } | ForEach-Object { $_.ProcessId }")
    output = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True).stdout
    return [int(line) for line in output.split() if line.strip().isdigit()]


def stop_launcher():
    for pid in processes_under(WORK):
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True)
    wait_for(lambda: not processes_under(WORK), 20)


def debug_port_open():
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json", timeout=2)
        return True
    except OSError:
        return False


def start_launcher():
    subprocess.Popen([str(INSTALL / "ultimate-legends.exe"), "-no-assert-dialogs"], cwd=str(INSTALL),
                     creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS)
    return connect()


def connect(timeout=90):
    launcher = None

    def ready():
        nonlocal launcher
        try:
            launcher = Launcher()
            return launcher.evaluate("!!window.LauncherUpdate && !document.body.classList.contains('hidden')")
        except Exception:
            return False

    if not wait_for(ready, timeout):
        raise RuntimeError("the test launcher did not come up")
    return launcher


def read_scheme():
    """The ultimatelegends:// registration, to put back after the test exe took it over."""
    values = {}
    for sub in ("", r"\DefaultIcon", r"\shell\open\command"):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, SCHEME_KEY + sub) as key:
                values[sub] = winreg.QueryValueEx(key, "")[0]
        except OSError:
            pass
    return values


def restore_scheme(values):
    if not values:
        for sub in (r"\shell\open\command", r"\shell\open", r"\shell", r"\DefaultIcon", ""):
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, SCHEME_KEY + sub)
            except OSError:
                pass
        return
    for sub, value in values.items():
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, SCHEME_KEY + sub) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, value)


class Release:
    """A fake GitHub: /releases/latest (the API's JSON) and /download/<asset>."""

    def __init__(self, folder):
        self.folder = folder
        self.wrong_hash = False
        release = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path.startswith("/releases/latest"):
                    body = json.dumps(release.latest()).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                name = self.path.rsplit("/", 1)[-1]
                if name == "SHA256SUMS.txt":
                    digest = "0" * 64 if release.wrong_hash else sha256(release.folder / ZIP_NAME)
                    body = f"{digest}  {ZIP_NAME}\n".encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                path = release.folder / name
                if name != ZIP_NAME or not path.exists():
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Length", str(path.stat().st_size))
                self.end_headers()
                with open(path, "rb") as stream:
                    shutil.copyfileobj(stream, self.wfile, 1 << 20)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def url(self, path):
        return f"http://127.0.0.1:{self.port}/{path}"

    def latest(self):
        return {
            "tag_name": f"v{NEW_VERSION}",
            "html_url": f"https://github.com/ChronoRixun/ultimate-legends/releases/tag/v{NEW_VERSION}",
            "assets": [
                {"name": ZIP_NAME, "size": (self.folder / ZIP_NAME).stat().st_size,
                 "browser_download_url": self.url(f"download/{ZIP_NAME}")},
                {"name": "SHA256SUMS.txt", "size": 100, "browser_download_url": self.url("download/SHA256SUMS.txt")},
            ],
        }


def make_release_zip(path):
    """The release zip's layout (tools/package-portable.ps1), stored (CEF doesn't compress much)."""
    top = f"ultimate-legends-{NEW_VERSION}-win64-portable"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as archive:
        archive.write(DEBUG_EXE, f"{top}/ultimate-legends.exe")
        archive.writestr(f"{top}/ultimate-legends/portable.marker", "from the zip")
        for file in CEF.rglob("*"):
            if file.is_file():
                archive.write(file, f"{top}/ultimate-legends/data/cef/release/{file.relative_to(CEF).as_posix()}")
        for file in UI.rglob("*"):
            if file.is_file():
                archive.write(file, f"{top}/ultimate-legends/data/launcher-ui/{file.relative_to(UI).as_posix()}")
        archive.writestr(f"{top}/ultimate-legends/data/launcher-ui/update-test.txt", NEW_VERSION)


def make_install(release):
    INSTALL.mkdir(parents=True)
    shutil.copy2(DEBUG_EXE, INSTALL / "ultimate-legends.exe")
    (ROOT / "portable.marker").parent.mkdir(parents=True)
    (ROOT / "portable.marker").write_text("")
    link_tree(CEF, ROOT / "data" / "cef" / "release")
    shutil.copytree(UI, ROOT / "data" / "launcher-ui")
    for folder in ("user", "tools", "cache", "mods"):
        (ROOT / folder).mkdir(parents=True, exist_ok=True)
        (ROOT / folder / "sentinel.txt").write_text(f"{folder} must survive the update")
    (ROOT / "user" / "properties.json").write_text(json.dumps({
        "dev-launcher-release": release.url("releases/latest"),
        "dev-launcher-version": "0.1.0",
        "launcher-auto-shortcuts": "false",  # no Desktop / Start Menu shortcut to this throwaway exe
    }, indent=2))


def main():
    for needed in (DEBUG_EXE, CEF, UI):
        if not needed.exists():
            print(f"missing {needed}: build Debug and Release first")
            return 2
    if debug_port_open():
        print(f"a Debug launcher is running (port {DEBUG_PORT}); close it first")
        return 2

    failures = 0

    def check(ok, label):
        nonlocal failures
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}")
        failures += not ok
        return ok

    scheme = read_scheme()
    stop_launcher()
    if WORK.exists():
        shutil.rmtree(WORK)
    www = WORK / "www"
    www.mkdir(parents=True)
    print("packing the fake release")
    make_release_zip(www / ZIP_NAME)
    release = Release(www)
    make_install(release)
    exe_hash = sha256(INSTALL / "ultimate-legends.exe")
    marker = ROOT / "data" / "launcher-ui" / "update-test.txt"

    launcher = None
    try:
        launcher = start_launcher()
        js = launcher.evaluate

        def status():
            return launcher.command("get-launcher-update")

        def bar_text():
            return js("(() => { const b = document.querySelector('#launcher-update-bar'); "
                      "return b && !b.hidden ? document.querySelector('#launcher-update-text').innerText : null; })()")

        def confirm():
            if not wait_for(lambda: js("document.querySelector('#message-box').classList.contains('visible')"), 10):
                return None
            text = js("document.querySelector('#message-box .mb-content').innerText")
            js("document.querySelectorAll('#message-box .mb-buttons button')[0].click()")
            return text

        print("check")
        s = status()
        check(s["enabled"] and s["canInstall"] and s["current"] == "0.1.0", "a portable install with a release version updates itself")
        check(wait_for(lambda: status()["state"] == "available", 30), "the check finds the newer release")
        check(status()["latest"] == NEW_VERSION, f"latest is {NEW_VERSION}")
        check(wait_for(lambda: (bar_text() or "").startswith("Update available"), 10), "the bar says: Update available")
        launcher.screenshot(HERE / "launcher-update-available.png")

        print("a download that doesn't match SHA256SUMS.txt")
        release.wrong_hash = True
        js("document.querySelector('#launcher-update-action').click()")
        text = confirm()
        check(text is not None and NEW_VERSION in text and "SHA-256" in text, "Update asks first, naming the version")
        check(wait_for(lambda: status()["state"] == "failed", 120), "the download fails")
        check("SHA-256" in status()["error"], "because of the SHA-256")
        check(wait_for(lambda: "SHA-256" in (bar_text() or ""), 10), "the bar says why")
        launcher.screenshot(HERE / "launcher-update-failed.png")
        check(wait_for(lambda: not [p for p in UPDATES.iterdir()] if UPDATES.exists() else True, 10),
              "nothing left in updates\\ (no staging, no ready)")
        check(sha256(INSTALL / "ultimate-legends.exe") == exe_hash and not marker.exists(), "the launcher is unchanged")

        print("download")
        release.wrong_hash = False
        js("document.querySelector('#launcher-update-action').click()")  # Try again
        check(confirm() is not None, "Try again asks again")
        check(wait_for(lambda: status()["state"] == "ready", 180), "downloaded, verified and unpacked")
        ready = json.loads((UPDATES / "ready" / "update.json").read_text())
        check(ready.get("version") == NEW_VERSION and ready.get("sha256") == sha256(www / ZIP_NAME),
              "updates\\ready\\update.json names the version and the zip's SHA-256")
        check(not marker.exists(), "nothing live changed yet")
        check(wait_for(lambda: "ready" in (bar_text() or ""), 10), "the bar offers Restart now")
        launcher.screenshot(HERE / "launcher-update-ready.png")

        print("restart now")
        js("document.querySelector('#launcher-update-action').click()")
        time.sleep(3)
        launcher = connect(120)
        js = launcher.evaluate
        check(marker.exists() and marker.read_text() == NEW_VERSION, "the new UI is live")
        check(sha256(ROOT / "data" / "cef" / "release" / "libcef.dll") == sha256(CEF / "libcef.dll"), "the new CEF is live")
        check(all((ROOT / f / "sentinel.txt").exists() for f in ("user", "tools", "cache", "mods")),
              "user\\, tools\\, cache\\ and mods\\ untouched")
        properties = json.loads((ROOT / "user" / "properties.json").read_text())
        check(properties.get("dev-launcher-version") == "0.1.0", "the settings untouched")
        check((ROOT / "portable.marker").read_text() == "", "portable.marker untouched")
        check(status()["updatedTo"] == NEW_VERSION, "the new start reports the update")
        check(wait_for(lambda: not (UPDATES / "previous").exists(), 45), "the previous version is deleted")
        check(not (UPDATES / "ready").exists() and not (UPDATES / "applying.json").exists(), "no ready\\ or journal left")
        check(not list(WORK.glob("install/ultimate-legends/updates/.staging-*")), "no staging left")

        print("up to date")
        launcher.command("set-property", {"dev-launcher-version": NEW_VERSION})
        launcher.command("check-launcher-update")
        check(wait_for(lambda: status()["state"] == "up-to-date", 30), "the same version is up to date")
        js("window.LauncherUpdate.refresh()")
        check(wait_for(lambda: bar_text() is None, 10), "no bar")
        launcher.command("set-property", {"dev-launcher-version": "0.1.0"})

        print("a file held open in data\\cef during the swap")
        (ROOT / "data" / "launcher-ui" / "pre-swap.txt").write_text("the UI before this swap")
        launcher.command("check-launcher-update")
        check(wait_for(lambda: status()["state"] == "available", 30), "0.1.0 again: the update is offered")
        js("window.LauncherUpdate.refresh()")
        js("document.querySelector('#launcher-update-action').click()")
        check(confirm() is not None and wait_for(lambda: status()["state"] == "ready", 180), "downloaded again")
        held = open(ROOT / "data" / "cef" / "release" / "icudtl.dat", "rb")  # no FILE_SHARE_DELETE: the folder can't be renamed
        try:
            started = time.time()
            js("document.querySelector('#launcher-update-action').click()")
            time.sleep(3)
            launcher = connect(180)
            js = launcher.evaluate
            check(time.time() - started > 25, f"the swap was retried for a while ({time.time() - started:.0f} s)")
        finally:
            held.close()
        check((ROOT / "data" / "launcher-ui" / "pre-swap.txt").exists(), "rolled back: the UI before the swap is live")
        s = status()
        check("could not be put in place" in s["installError"] and s["state"] == "ready",
              "the launcher says why, and offers Restart now again")
        check(wait_for(lambda: "could not be put in place" in (bar_text() or ""), 10), "on the bar")
        launcher.screenshot(HERE / "launcher-update-held.png")
        check((UPDATES / "ready" / "update.json").exists() and not (UPDATES / "applying.json").exists()
              and not (UPDATES / "previous").exists(), "the download kept, no journal, no previous\\")
        js("document.querySelector('#launcher-update-action').click()")  # Restart now, nothing held this time
        time.sleep(3)
        launcher = connect(120)
        js = launcher.evaluate
        check(not (ROOT / "data" / "launcher-ui" / "pre-swap.txt").exists() and marker.exists(), "the retry installs it")
        check(status()["updatedTo"] == NEW_VERSION and not status()["installError"], "and reports the update")
        check(wait_for(lambda: not (UPDATES / "previous").exists(), 45), "the previous version is deleted")

        new_exe = DEBUG_EXE.read_bytes() + b"\0UPDATE-TEST-NEW-EXE"  # a different exe that still runs (PE overlay)
        old_hash = sha256(INSTALL / "ultimate-legends.exe")

        def half_swap(exe_moved, journal=None, applied=None):
            """The disk as a swap (or a first start) left it: data\\ folders moved out, fake new ones in."""
            stop_launcher()
            shutil.rmtree(UPDATES / "discarded", ignore_errors=True)
            (UPDATES / "ready" / "data").mkdir(parents=True, exist_ok=True)
            (UPDATES / "previous" / "data").mkdir(parents=True, exist_ok=True)
            for name in ("cef", "launcher-ui"):
                for attempt in range(20):
                    try:
                        os.rename(ROOT / "data" / name, UPDATES / "previous" / "data" / name)
                        break
                    except OSError:
                        time.sleep(1)
                (ROOT / "data" / name).mkdir()
                (ROOT / "data" / name / "new.txt").write_text("half-installed")
            if exe_moved:
                os.rename(INSTALL / "ultimate-legends.exe", UPDATES / "previous" / "ultimate-legends.exe")
                (INSTALL / "ultimate-legends.exe").write_bytes(new_exe)
            else:
                (UPDATES / "ready" / "ultimate-legends.exe").write_bytes(new_exe)
            if journal is not None:
                (UPDATES / "applying.json").write_text(journal)
            if applied is not None:
                (UPDATES / "applied.json").write_text(json.dumps(applied))

        def restored(label, words):
            check(sha256(INSTALL / "ultimate-legends.exe") == old_hash, f"{label}: the previous exe is back")
            check((ROOT / "data" / "cef" / "release" / "libcef.dll").exists() and marker.exists()
                  and not (ROOT / "data" / "launcher-ui" / "new.txt").exists(), f"{label}: the previous CEF and UI are back")
            check(not (UPDATES / "applying.json").exists() and not (UPDATES / "applied.json").exists()
                  and not (UPDATES / "ready").exists(), f"{label}: no journal, applied.json or ready\\ left")
            check(sha256(UPDATES / "discarded" / "ultimate-legends.exe") == hashlib.sha256(new_exe).hexdigest(),
                  f"{label}: the new version set aside in updates\\discarded")
            check(wait_for(lambda: not (UPDATES / "previous").exists(), 30), f"{label}: previous\\ cleared")
            check(words in status()["installError"], f"{label}: the launcher says: {words}")
            check(wait_for(lambda: words in (bar_text() or ""), 10), f"{label}: on the bar")

        print("an interrupted swap is rolled back: folders moved, the exe not yet")
        half_swap(False, json.dumps({"version": "0.1.3", "items": ["data/cef", "data/launcher-ui", "exe"]}))
        launcher = start_launcher()
        js = launcher.evaluate
        restored("journal", "interrupted")

        print("an interrupted swap with an empty journal (a power cut while writing it)")
        half_swap(False, "")
        launcher = start_launcher()
        js = launcher.evaluate
        restored("empty journal", "interrupted")

        print("an interrupted swap after the exe moved: the new exe restores the old one and starts it")
        half_swap(True, json.dumps({"version": "0.1.3", "items": ["data/cef", "data/launcher-ui", "exe"]}))
        launcher = start_launcher()
        js = launcher.evaluate
        restored("exe moved", "interrupted")

        print("a new version whose first start never got its window up")
        half_swap(True, applied={"from": "0.1.0", "to": "0.1.3", "started": "true"})
        launcher = start_launcher()
        js = launcher.evaluate
        restored("failed first start", "did not start")
        launcher.screenshot(HERE / "launcher-update-restored.png")

        print("development builds")
        launcher.command("set-property", {"dev-launcher-version": ""})
        s = status()
        check(not s["enabled"], "no version: updates are off")
        js("window.LauncherUpdate.refresh()")
        line = js("document.querySelector('#launcher-update-status').innerText")
        check(line == "Updates are off in development builds.", "Settings says so")
        check(wait_for(lambda: bar_text() is None, 10), "no bar")
    finally:
        stop_launcher()
        release.server.shutdown()
        restore_scheme(scheme)
        shutil.rmtree(WORK, ignore_errors=True)

    print(f"\n{'PASSED' if not failures else 'FAILED'} ({failures} failure{'s' if failures != 1 else ''})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
