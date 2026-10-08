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
up to date, a file held open in data\\cef during the swap (retried for a bounded time, rolled back, said,
logged in updates\\update.log), a file held in the download's launcher-ui (data\\cef swapped and rolled back
on each try), then installed by the next Restart now, a swap interrupted before and after the exe moved and
with an empty journal, a new version whose page never comes up (kept for two starts, then rolled back; all from what is on the disk), a
first start whose page fails after it is shown (kept), files held on three starts (the fourth doesn't
retry), and
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


def launch():
    subprocess.Popen([str(INSTALL / "ultimate-legends.exe"), "-no-assert-dialogs"], cwd=str(INSTALL),
                     creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS)


def start_launcher():
    launch()
    return connect()


def json_field(path, key):
    try:
        return json.loads(path.read_text()).get(key)
    except (OSError, ValueError):
        return None


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
        # Say what the launcher was doing: its log, its processes and what is in updates\.
        log = ROOT / "ultimate-legends.log"
        if log.exists():
            lines = [line for line in log.read_text(errors="replace").splitlines() if not line.startswith("Debug:")]
            print("    launcher log (last lines):", *lines[-25:], sep="\n      ")
        tasks = subprocess.run(["tasklist", "/FI", "IMAGENAME eq ultimate-legends.exe", "/FO", "CSV", "/NH"],
                               capture_output=True, text=True).stdout.strip()
        print("    launcher processes:", tasks or "none")
        if UPDATES.exists():
            print("    updates\\:", sorted(p.name for p in UPDATES.iterdir()))
        # The install path's own log spans the starts (ultimate-legends.log is the last start's only).
        update_log = UPDATES / "update.log"
        if update_log.exists():
            print("    updates\\update.log (last lines):", *update_log.read_text(errors="replace").splitlines()[-30:], sep="\n      ")
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


def replace_once(text, old, new):
    assert old in text, old
    return text.replace(old, new, 1)


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

        print("download (a just-unpacked file is held open for a moment, as a virus scanner does)")
        release.wrong_hash = False
        held_fresh = []

        def hold_fresh_file():
            # Open a file of the unpacked data\ as soon as it exists and keep it open until 3 s after the
            # unpacking is over (the zip is deleted then): data\ can't be renamed while it is open.
            # A CEF file: they are unpacked first, long before the folder is moved.
            unpacked_file = lambda: next(iter(UPDATES.glob(".staging-*/unpacked/*/ultimate-legends/data/cef/release/*.*")), None)
            deadline = time.time() + 280
            while unpacked_file() is None:
                if time.time() > deadline:
                    return
                time.sleep(0.05)
            with open(unpacked_file(), "rb"):  # no FILE_SHARE_DELETE
                held_fresh.append("opened")
                if wait_for(lambda: not list(UPDATES.glob(f".staging-*/{ZIP_NAME}")), 280):
                    time.sleep(3)
                    held_fresh.append("held past the unpacking")

        holder = threading.Thread(target=hold_fresh_file, daemon=True)
        holder.start()
        js("document.querySelector('#launcher-update-action').click()")  # Try again
        check(confirm() is not None, "Try again asks again")
        if not check(wait_for(lambda: status()["state"] == "ready", 300), "downloaded, verified and unpacked"):
            print("    status:", status())
            return 1
        holder.join(20)
        check(held_fresh == ["opened", "held past the unpacking"], f"the file was held past the unpacking: {held_fresh}")
        check("was held for a moment" in (ROOT / "ultimate-legends.log").read_text(errors="replace"),
              "the launcher waited for it (ultimate-legends.log)")
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
        # The page acts on its own copy of the status (refreshed every 500 ms while downloading): a click
        # before it has seen "ready" does nothing.
        check(wait_for(lambda: "ready" in (bar_text() or ""), 10), "the bar offers Restart now again")
        held = open(ROOT / "data" / "cef" / "release" / "icudtl.dat", "rb")  # no FILE_SHARE_DELETE: the folder can't be renamed
        try:
            started = time.time()
            js("document.querySelector('#launcher-update-action').click()")
            time.sleep(3)
            launcher = connect(180)
            js = launcher.evaluate
            took = time.time() - started
            check(25 < took < 120, f"the swap was retried for a while, and for a bounded time ({took:.0f} s)")
        finally:
            held.close()
        update_log = (UPDATES / "update.log").read_text(errors="replace")
        check("restarting to install " + NEW_VERSION in update_log and "started ultimate-legends.exe (pid" in update_log,
              "updates\\update.log: the restart and the new process's pid")
        check("swap try 1 failed" in update_log and "files still held after" in update_log,
              "updates\\update.log: each failed try, and that it gave up on held files")
        check("cef" in update_log.split("files still held after")[0].lower() and "failed:" in update_log,
              "updates\\update.log: the rename that failed (data\\cef) and why")
        check((ROOT / "data" / "launcher-ui" / "pre-swap.txt").exists(), "rolled back: the UI before the swap is live")
        s = status()
        check("could not be put in place" in s["installError"] and s["state"] == "ready",
              "the launcher says why, and offers Restart now again")
        check(wait_for(lambda: "could not be put in place" in (bar_text() or ""), 10), "on the bar")
        launcher.screenshot(HERE / "launcher-update-held.png")
        check((UPDATES / "ready" / "update.json").exists() and not (UPDATES / "applying.json").exists()
              and not (UPDATES / "previous").exists(), "the download kept, no journal, no previous\\")
        check(json_field(UPDATES / "ready" / "held.json", "count") == "1", "the held start is counted (held.json)")

        print("a file held in the download's launcher-ui: data\\cef is swapped, then rolled back each try")
        (ROOT / "data" / "cef" / "pre-swap.txt").write_text("the CEF folder before this swap")
        held = open(UPDATES / "ready" / "data" / "launcher-ui" / "main.html", "rb")  # ready\data\launcher-ui can't be renamed
        try:
            started = time.time()
            js("document.querySelector('#launcher-update-action').click()")
            time.sleep(3)
            launcher = connect(180)
            js = launcher.evaluate
            took = time.time() - started
            check(25 < took < 120, f"retried, rolled back, and back up in a bounded time ({took:.0f} s)")
        finally:
            held.close()
        check((ROOT / "data" / "cef" / "pre-swap.txt").exists() and (ROOT / "data" / "launcher-ui" / "pre-swap.txt").exists(),
              "rolled back: the CEF and the UI before the swap are live")
        check((UPDATES / "ready" / "data" / "cef").is_dir() and not (UPDATES / "ready" / "data" / "cef" / "pre-swap.txt").exists(),
              "the download's CEF went back to updates\\ready")
        update_log = (UPDATES / "update.log").read_text(errors="replace")
        check("launcher-ui" in update_log.split("files still held after")[-2].lower(), "updates\\update.log names the held folder")
        check(json_field(UPDATES / "ready" / "held.json", "count") == "2", "the held start is counted again (held.json)")
        (ROOT / "data" / "cef" / "pre-swap.txt").unlink()
        js("document.querySelector('#launcher-update-action').click()")  # Restart now, nothing held this time
        time.sleep(3)
        launcher = connect(120)
        js = launcher.evaluate
        check(not (ROOT / "data" / "launcher-ui" / "pre-swap.txt").exists() and marker.exists(), "the retry installs it")
        check(status()["updatedTo"] == NEW_VERSION and not status()["installError"], "and reports the update")
        check(wait_for(lambda: not (UPDATES / "previous").exists(), 45), "the previous version is deleted")

        new_exe = DEBUG_EXE.read_bytes() + b"\0UPDATE-TEST-NEW-EXE"  # a different exe that still runs (PE overlay)
        old_hash = sha256(INSTALL / "ultimate-legends.exe")

        print("a first start whose page fails after it is shown is kept")
        stop_launcher()
        page_js = ROOT / "data" / "launcher-ui" / "assets" / "js" / "app" / "main.js"
        original_js = page_js.read_text(encoding="utf-8")
        page_js.write_text(replace_once(original_js, "window.GameStateManager.startPolling();",
                                        "throw new Error('test: startup fails after the page is shown');"), encoding="utf-8")
        (UPDATES / "previous").mkdir(parents=True, exist_ok=True)
        shutil.copy2(INSTALL / "ultimate-legends.exe", UPDATES / "previous" / "ultimate-legends.exe")
        (UPDATES / "applied.json").write_text(json.dumps({"from": "0.1.0", "to": NEW_VERSION, "starts": "1"}))
        exe_before = sha256(INSTALL / "ultimate-legends.exe")
        launcher = start_launcher()
        js = launcher.evaluate
        check(js("window.LauncherUpdate.status === null"), "the page's startup failed before LauncherUpdate.init")
        check(wait_for(lambda: not (UPDATES / "applied.json").exists(), 10), "it still confirmed the start (applied.json gone)")
        check(wait_for(lambda: not (UPDATES / "previous").exists(), 30), "the previous version is deleted, not restored")
        check(sha256(INSTALL / "ultimate-legends.exe") == exe_before and marker.exists(), "the new version stays")
        stop_launcher()
        page_js.write_text(original_js, encoding="utf-8")

        print("files held on three starts: the fourth start doesn't try (and doesn't stall)")
        ready_dir = UPDATES / "ready"
        (ready_dir / "data" / "cef" / "release").mkdir(parents=True)
        (ready_dir / "data" / "launcher-ui").mkdir(parents=True)
        os.link(CEF / "libcef.dll", ready_dir / "data" / "cef" / "release" / "libcef.dll")
        shutil.copy2(UI / "main.html", ready_dir / "data" / "launcher-ui" / "main.html")
        shutil.copy2(DEBUG_EXE, ready_dir / "ultimate-legends.exe")
        (ready_dir / "update.json").write_text(json.dumps({"version": NEW_VERSION}))
        (ready_dir / "held.json").write_text(json.dumps({"count": "3"}))
        started = time.time()
        launcher = start_launcher()
        js = launcher.evaluate
        seconds = time.time() - started
        check(seconds < 25, f"the start took {seconds:.0f} s (no 30 s of retries)")
        s = status()
        check(s["state"] == "ready" and "press Restart now" in s["installError"], "it says why and offers Restart now")
        check(wait_for(lambda: "press Restart now" in (bar_text() or ""), 10), "on the bar")
        check((ready_dir / "update.json").exists() and marker.exists(), "the download kept, nothing installed")
        stop_launcher()
        shutil.rmtree(ready_dir)

        def half_swap(exe_moved, journal=None, applied=None, folders=("cef", "launcher-ui")):
            """The disk as a swap (or a first start) left it: data\\ folders moved out, fake new ones in."""
            stop_launcher()
            shutil.rmtree(UPDATES / "discarded", ignore_errors=True)
            (UPDATES / "ready" / "data").mkdir(parents=True, exist_ok=True)
            (UPDATES / "previous" / "data").mkdir(parents=True, exist_ok=True)
            for name in folders:
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

        print("a new version whose page never comes up: two starts, then the previous version is back")
        # The new exe with a UI folder that has no page: CEF starts, the page never shows.
        half_swap(True, applied={"from": "0.1.0", "to": "0.1.3"}, folders=("launcher-ui",))
        for count in ("1", "2"):
            launch()
            check(wait_for(lambda: json_field(UPDATES / "applied.json", "starts") == count, 30),
                  f"start {count} without the page is counted, nothing restored yet")
            time.sleep(3)
            check((ROOT / "data" / "launcher-ui" / "new.txt").exists(), f"start {count}: the new version still in place")
            stop_launcher()
        launcher = start_launcher()
        js = launcher.evaluate
        restored("third start", "did not start")
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
