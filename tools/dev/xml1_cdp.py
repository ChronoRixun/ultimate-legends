"""End-to-end check of the X-Men Legends (community port) entry against a running Debug build
(see launcher_cdp.py), with the fake builder (fake_xml1_builder.py) - or the real one - in
throwaway folders.

    tools\\run-test-debug.bat
    python tools\\dev\\xml1_cdp.py            # the fake builder, tiny test inputs (about 5 minutes)
    python tools\\dev\\xml1_cdp.py --real     # the real builder from source (about 20 minutes)

Fake mode: a local HTTP server publishes the fake builder the way the real release will
(xml1-builder.json + zip + SHA-256) and a stand-in XML2 Fix (a dinput.dll with a version resource);
Debug builds read their URLs from the xml1-builder-manifest / xml1-patch-manifest properties. The XML2
entry is pointed at a small fake install whose XMen2.exe is tools/dev/native/dummy_game.c (no window,
it only waits), so the Play and Stop checks run that, never a game. The disc images are real, tiny
Xbox / PS2 / GameCube / CSO images (the fake reads them by the real builder's rules).

Real mode (--real): the Debug-only builder-exe property points at tools/dev/xml1-builder-src.cmd, which
runs the real builder (xml1builder) from the port's source tree. Its inputs are the real ones, read
only: your X-Men Legends disc image (--iso), your X-Men Legends II install (--xml2, through a junction
next to the test's game folder, so the setup's default folder is the test's), and a warm build cache
(--cache) that the test hard-links into a throwaway copy on the same drive (never written, never
deleted). The game is built into %TEMP%. Afterwards the test asserts that nothing in the XML2 install,
the disc image or the cache changed. It never launches a game: Play / Stop are skipped. The fake
builder's own knobs (a failing step, a builder that ignores cancel) have no real equivalent: the
failing step and the ignored cancel are skipped. The builder install / update / pruning checks are the
fake's (the real builder runs from source, not a release).

Held files, both modes: a stray file another program holds open survives a repair, which succeeds and
names it (W_EXTRA_FILES, detail.not_removed, cause "held"); a file the build must replace held open
fails the build with E_IO (exit 6, detail.cause "held"), which the page says in plain words.

Covers: the states (not set up, builder missing / unpublished, building, incomplete / resume, needs
the fix, ready, update available, damaged, failed), the wizard (requirements, disc errors mapped to
plain messages, disc check, options, progress, cancel, hide), the builder install (SHA-256 checked,
staging, update, pruning), a builder zip the player already has (checked like a download: refused when
damaged, incomplete or older; installed from it with no download; found in tools\\xml1-builder; a damaged one
there skipped for the download), the build (stamp, ini keys merged with the launcher's Display defaults, fix
installed), Play and Stop by path, Display / Discord / Mods on the port's page, Verify (the groups and
counts) / Repair, warnings after a build (their counts from detail.count), E_IO per cause in plain
words, Report a problem (the saved report, paths masked), a rebuild without the disc image, Free up,
the cancel that ends in a kill, uninstall, and a folder holding only the launcher's files as a
destination (the builder's info: absent). Screenshots of the states go to tools/dev/xml1-*.png
(xml1-real-*.png with --real; they show profile paths: they are gitignored).
"""
import argparse
import ctypes
import functools
import hashlib
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from ctypes import wintypes

import fake_xml1_builder as fake
import native
from launcher_cdp import Launcher, wait_for

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
XML1_PROPS = ["install", "is-installed", "iso", "movies", "keep-cache", "link-base", "cache", "builder-version",
              "builder-content", "builder-manifest", "builder-exe", "patch-manifest"]
DEBUG_TOOLS = pathlib.Path(os.environ["LOCALAPPDATA"]) / "ultimate-legends_debug" / "tools" / "xml1-builder"
DEV_BUILDER = HERE / "xml1-builder-src.cmd"
# Real mode's inputs (read only): your own disc image, your XML2 install and a warm prepare cache, from the
# environment (XML1_REAL_ISO, XML1_REAL_XML2, XML1_REAL_CACHE) or the --iso / --xml2 / --cache options.
REAL_ISO = os.environ.get("XML1_REAL_ISO", "")
REAL_XML2 = os.environ.get("XML1_REAL_XML2", "")
REAL_CACHE = os.environ.get("XML1_REAL_CACHE", "")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class Test:
    def __init__(self, real):
        self.launcher = Launcher()
        self.real = real
        self.failures = 0
        self.shots = []

    # ---- plumbing ----

    def check(self, ok, label):
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}")
        self.failures += not ok
        return ok

    def skip(self, label):
        print(f"  skip  {label}")

    def cmd(self, name, payload=None):
        return self.launcher.command(name, payload)

    def js(self, expression):
        return self.launcher.evaluate(expression)

    def prop(self, suffix, value=None, game="xml1"):
        if value is None:
            return self.cmd("get-game-property", {"game": game, "suffix": suffix})
        self.cmd("set-game-property", {"game": game, "suffix": suffix, "value": value})

    def status(self):
        return self.cmd("get-xml1-status")

    def click(self, selector):
        return self.js(f"(() => {{ const e = document.querySelector({json.dumps(selector)}); if (!e || e.disabled) return false; e.click(); return true; }})()")

    def text(self, selector):
        return self.js(f"(() => {{ const e = document.querySelector({json.dumps(selector)}); return e ? e.innerText : null; }})()")

    def exists(self, selector):
        return self.js(f"!!document.querySelector({json.dumps(selector)})")

    def set_input(self, selector, value):
        self.js(f"""(() => {{ const e = document.querySelector({json.dumps(selector)}); e.value = {json.dumps(value)};
                  e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); }})()""")

    def message_box(self, index, timeout=10):
        """Clicks button `index` of the launcher's message box once it shows; returns its text."""
        if not wait_for(lambda: self.js("document.querySelector('#message-box').classList.contains('visible')"), timeout):
            return None
        text = self.text("#message-box .mb-content")
        self.js(f"document.querySelectorAll('#message-box .mb-buttons button')[{index}].click()")
        return text

    def page(self):
        self.js("window.AppViews.navigateTo('xml1')")
        time.sleep(1.2)

    def refresh_port(self, timeout=30):
        """The page's status and the builder's `info` about the build (the real one takes seconds)."""
        self.js("window.Xml1Port.info = null")
        self.js("window.Xml1Port.refresh().then(() => window.Xml1Port.refreshInfo())")
        if not wait_for(lambda: self.js("!!window.Xml1Port.info || !window.Xml1Port.status.install"), timeout):
            print("  (info did not come back)")
        time.sleep(0.5)

    def shot(self, name, selector=None, block="start"):
        if selector:
            self.js(f"(() => {{ const e = document.querySelector({json.dumps(selector)}); if (e) e.scrollIntoView({{block: {json.dumps(block)}}}); }})()")
        time.sleep(0.6)  # popups fade in
        path = HERE / f"xml1-{'real-' if self.real else ''}{name}.png"
        self.launcher.screenshot(path)
        self.shots.append(path.name)

    def job_done(self, job_id, timeout=60):
        wait_for(lambda: (self.cmd("get-xml1-job", {"id": job_id}) or {}).get("finished"), timeout)
        return self.cmd("get-xml1-job", {"id": job_id})

    def build_done(self, timeout=90):
        """Waits for the build started since the last call to finish. The page checks the builder's
        release before every build (and installs a newer one), so a build starts a moment after its
        click: first wait for a job that is not the one already seen, then for it to finish."""
        if self.real:
            timeout = max(timeout, 1500)
        seen = getattr(self, "_seen_job", None)
        wait_for(lambda: (lambda job: job is not None and job.get("id") != seen)(self.cmd("get-xml1-build")), 20)
        wait_for(lambda: (lambda job: job is not None and job["finished"])(self.cmd("get-xml1-build")), timeout)
        job = self.cmd("get-xml1-build")
        self._seen_job = job.get("id") if job else None
        return job

    def state(self):
        return self.js("window.Xml1Port.state()")


# ---- fixtures ----

def publish_builder(www, version, content_version):
    return fake.make_package(www, version=version, content_version=content_version, shim=native.builder_shim())


def publish_fix(www, version):
    folder = www / "fix"
    folder.mkdir(exist_ok=True)
    dll = folder / "dinput.dll"
    shutil.copy2(native.fix_dll(version), dll)
    data = dll.read_bytes()
    (folder / "ultimate-legends.json").write_text(json.dumps([["dinput.dll", len(data), hashlib.sha1(data).hexdigest().upper(), "game"]]))


def snapshot(folder):
    """{relative path: (size, mtime_ns, file id)} of every file under folder."""
    found = {}
    for dirpath, _, filenames in os.walk(folder):
        for name in filenames:
            path = os.path.join(dirpath, name)
            try:
                stat = os.stat(path)
            except OSError:
                continue
            found[os.path.relpath(path, folder)] = (stat.st_size, stat.st_mtime_ns, stat.st_ino)
    return found


def link_copy(source, target):
    """A copy of the build cache made of hard links (same drive): the builder can add, rename and
    delete in it freely; the original files are only read. The lock and the logs are left out."""
    source, target = pathlib.Path(source), pathlib.Path(target)
    count = 0
    for dirpath, dirnames, filenames in os.walk(source):
        rel = pathlib.Path(dirpath).relative_to(source)
        if rel == pathlib.Path("."):
            dirnames[:] = [d for d in dirnames if d.lower() != "logs"]
            filenames = [f for f in filenames if f.lower() != "lock"]
        (target / rel).mkdir(parents=True, exist_ok=True)
        for name in filenames:
            os.link(pathlib.Path(dirpath) / name, target / rel / name)
            count += 1
    return count


def make_junction(link, target):
    subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], check=True, capture_output=True)


def builder_processes(marker):
    """Command lines of builder processes (the fake's shim and Python, or cmd / Python running the
    real one) whose command line holds `marker` (the test's own folder)."""
    script = ("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*xml1builder*' -or "
              "$_.CommandLine -like '*xml1-builder*' } | ForEach-Object { $_.CommandLine }")
    output = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True).stdout
    return [line for line in output.splitlines() if marker.lower() in line.lower() and "Get-CimInstance" not in line]


_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD,
                                  wintypes.DWORD, wintypes.HANDLE]
_kernel32.CreateFileW.restype = wintypes.HANDLE
_kernel32.CloseHandle.argtypes = [wintypes.HANDLE]


def hold_file(path):
    """Opens a file with no sharing at all, as another program holding it would: nothing else can
    open, replace or delete it until release_file()."""
    handle = _kernel32.CreateFileW(str(path), 0x80000000, 0, None, 3, 0x80, None)  # GENERIC_READ, no sharing, OPEN_EXISTING
    if handle in (None, wintypes.HANDLE(-1).value):
        raise ctypes.WinError(ctypes.get_last_error())
    return handle


def release_file(handle):
    _kernel32.CloseHandle(handle)


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--real", action="store_true", help="run the real builder from source (tools/dev/xml1-builder-src.cmd)")
    parser.add_argument("--iso", default=REAL_ISO, help="--real: your X-Men Legends disc image (read only; env XML1_REAL_ISO)")
    parser.add_argument("--xml2", default=REAL_XML2, help="--real: your X-Men Legends II install (read only; env XML1_REAL_XML2)")
    parser.add_argument("--cache", default=REAL_CACHE, help="--real: a warm build cache to reuse (read only; env XML1_REAL_CACHE)")
    return parser.parse_args()


def main():
    sys.stdout.reconfigure(line_buffering=True)  # progress shows as it happens, also into a file
    args = parse_args()
    real = args.real
    test = Test(real)
    check, cmd, js = test.check, test.cmd, test.js

    root = pathlib.Path(tempfile.mkdtemp(prefix="ul-xml1-real-" if real else "ul-xml1-"))
    www = root / "www"
    www.mkdir()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(www)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    out = root / "X-Men Legends (Port)"
    isos = root / "discs"
    isos.mkdir()
    xml2 = root / "X-Men Legends II"
    cache = None
    before = {}
    if real:
        for path in (args.iso, args.xml2, args.cache, DEV_BUILDER):
            if not pathlib.Path(path).exists():
                sys.exit(f"--real needs {path}")
        print("real mode: taking stock of the inputs (read only)")
        before = {"xml2": snapshot(args.xml2), "cache": snapshot(args.cache), "iso": os.stat(args.iso)}
        make_junction(xml2, args.xml2)
        drive = os.path.splitdrive(os.path.abspath(args.cache))[0].lower()
        link_parent = REPO / "build" if os.path.splitdrive(str(REPO))[0].lower() == drive else pathlib.Path(args.cache).parent
        link_parent.mkdir(parents=True, exist_ok=True)
        cache = pathlib.Path(tempfile.mkdtemp(prefix="ul-xml1-test-cache-", dir=link_parent))
        print(f"  {link_copy(args.cache, cache)} cache files hard-linked into a throwaway copy")
        good = slow = pathlib.Path(args.iso)
    else:
        fake.make_fake_xml2(xml2, native.dummy_game())
        cache = root / "cache"
        # Small space needs, so the checks don't depend on this PC's free space.
        small = {"need_bytes": 50_000_000, "cache_need_bytes": 20_000_000}
        good = fake.make_fake_iso(isos / "X-Men Legends (World).iso", fake=small)
        slow = fake.make_fake_iso(isos / "slow.iso", fake=dict(small, speed=6))
        stubborn = fake.make_fake_iso(isos / "stubborn.iso", fake=dict(small, speed=12, ignore_cancel=True))
        failing = fake.make_fake_iso(isos / "failing.iso", fake=dict(small, fail_stage="content"))

    saved_xml2 = test.prop("install", game="xml2")
    saved_props = {suffix: test.prop(suffix) for suffix in XML1_PROPS}
    dummies = []
    held = None
    try:
        # A clean slate for X-Men Legends in the Debug profile.
        shutil.rmtree(DEBUG_TOOLS, ignore_errors=True)
        for suffix in XML1_PROPS:
            test.prop(suffix, "")
        publish_fix(www, "1.2.0")
        test.prop("builder-manifest", f"{base}/missing/xml1-builder.json")
        test.prop("patch-manifest", f"{base}/fix/ultimate-legends.json")
        test.prop("cache", str(cache))
        if real:
            test.prop("builder-exe", str(DEV_BUILDER))
        else:
            publish_builder(www, "1.0.0", 3)
        cmd("set-game-property", {"game": "xml2", "suffix": "install", "value": ""})
        # A fresh page, as a player would open the launcher with these settings.
        test.launcher.call("Page.reload", {"ignoreCache": True})
        wait_for(lambda: js("!!(window.Xml1Port && window.Xml1Port.status)"), 20)
        time.sleep(1)

        print("not set up")
        status = test.status()
        if real:
            check(status["state"] == "not-setup" and status["builder"]["installed"] and status["builder"]["dev"],
                  "state not-setup; the builder: the real one from source (builder-exe)")
        else:
            check(status["state"] == "not-setup" and not status["builder"]["installed"], f"state {status['state']}, no builder")
        check(not status["xml2"]["setUp"] and status["defaultOut"] == "", "no XML2 yet, so no default folder")
        test.page()
        check("NOT SET UP" in (test.text("#xml1-build-panel") or "").upper(), "the Build section says Not set up")
        check(test.text("#xml1-button-group .setup-button") is not None, "the page offers Set up")
        test.shot("not-set-up", "#xml1-page .detail-build")

        print("malformed input never stops the launcher (no assert dialog, no crash)")
        for name, payload in (("set-game-property", {"game": "xml1", "suffix": "iso", "value": 5}),
                              ("set-game-property", {"game": None, "suffix": [], "value": None}),
                              ("get-game-property", {"game": 7, "suffix": {}}),
                              ("reset-game-settings", {"game": 3}),
                              ("xml1-build-start", {"iso": 5, "out": None, "movies": "yes"}),
                              ("xml1-info", {"iso": [1], "out": {}}),
                              ("xml1-folder", {"path": 3}),
                              ("get-xml1-job", {"id": "x"}),
                              ("xml1-clean", "not an object")):
            try:
                cmd(name, payload)
            except Exception as error:  # noqa: BLE001 - a JS-side rejection is fine, a dead launcher is not
                print(f"  ({name}: {error})")
        for body in ('{"command": "get-xml1-status"}', 'not json', '[]', '{"command": 5, "data": 1}', ''):
            js(f"fetch('/command', {{method: 'POST', body: {json.dumps(body)}}}).then(r => r.status).catch(() => -1)")
        odd = root / "odd build"
        (odd / "_build").mkdir(parents=True)
        (odd / "XMen2.exe").write_bytes(b"MZ")
        (odd / "_build" / "stamp.json").write_text(json.dumps({"builder": {"content_version": "3", "version": 5}, "finished": 5, "profile": [],
                                                              "requires": {"xml2fix": 1.2}, "outputs": {"bytes": -1},
                                                              "inputs": {"disc": {"disc_id": "../../escape"}}}))
        (odd / "_build" / "building.json").write_text('{"inputs": {"disc": {"disc_id": 12}}}')
        test.prop("install", str(odd))
        status = test.status()
        check(status["state"] == "incomplete" and status["discId"] == "" and not status["cacheHasDisc"],
              f"a stamp of odd types reads as an unfinished build, no disc id taken from it ({status['state']})")
        test.prop("install", "")
        check(test.status()["state"] == "not-setup" and test.prop("iso") == "", "still answering; the bad values were not stored")

        print("E_IO in plain words per cause (detail.cause); warning counts from detail.count")
        described = js("""(() => {
            const port = window.Xml1Port;
            const io = (detail) => port.describe({ code: 'E_IO', msg: 'builder text', hint: 'builder hint', detail });
            const out = {};
            for (const cause of ['held', 'read_only', 'denied', 'disk_full', 'drive_read_only', 'disk_error', 'drive_gone', 'too_long', 'other']) {
                out[cause] = io({ path: 'Actors/14001.IGB', where: 'out', cause, errno: 13, winerror: 5 });
            }
            out.cache = io({ path: 'abc/prepared/stage.json', where: 'cache', cause: 'held' });
            out.xml2 = io({ path: 'Data/herostat.engb', where: 'xml2', cause: 'disk_error' });
            out.nofile = io({ path: null, where: null, cause: 'held' });
            out.nocause = io({ path: 'Actors/14001.IGB' });
            out.odd = io({ path: 5, where: [], cause: {} });
            const notices = (...list) => port.noticesOf({ notices: list }).map(n => n.text);
            out.count = notices({ code: 'W_EXTRA_FILES', msg: 'files the build did not make', count: 1, detail: { count: 7, files: ['Data/a.txt'] } });
            out.parsed = notices({ code: 'W_XML2_MODIFIED', msg: '3 file(s) of X-Men Legends II differ', count: 1, detail: { files: ['Data/x'] } });
            out.kept = notices({ code: 'W_EXTRA_FILES', msg: '2 file(s)', count: 1,
                                 detail: { count: 2, files: ['Data/a.txt', 'Data/b.txt'], not_removed: ['Data/b.txt'], cause: 'held' } });
            return out;
        })()""") or {}
        generic = "A file could not be read or written."
        words = {"held": "Another program has Actors/14001.IGB open.", "read_only": "Actors/14001.IGB is read-only.",
                 "denied": "Windows denied access to Actors/14001.IGB.", "disk_full": "The drive is full.",
                 "drive_read_only": "The drive is write-protected.", "disk_error": "The drive reported an error with Actors/14001.IGB.",
                 "drive_gone": "The drive is not available.", "too_long": "The path of Actors/14001.IGB is too long."}
        wrong = {cause: described.get(cause, {}).get("title") for cause, title in words.items() if (described.get(cause) or {}).get("title") != title}
        check(not wrong, "a plain title per cause" + (f" (wrong: {wrong})" if wrong else ""))
        check(all((described.get(cause) or {}).get("hint") and described[cause]["hint"] != "builder hint" for cause in words), "a hint per cause")
        check("Close it" in (described.get("held") or {}).get("hint", ""), f"held: {described.get('held', {}).get('hint')!r}")
        named = [cause for cause in words if "Actors/14001.IGB" in words[cause]]
        check(all(not described[cause]["facts"] for cause in named) and
              all(described[cause]["facts"] == ["File: Actors/14001.IGB"] for cause in words if cause not in named),
              "the file named once: in the title, or as File: when the title doesn't say it")
        check((described.get("cache") or {}).get("title") == "Another program has abc/prepared/stage.json (in the build cache) open." and
              (described.get("xml2") or {}).get("title") == "The drive reported an error with Data/herostat.engb (in X-Men Legends II’s folder).",
              f"where: the build cache / X-Men Legends II's folder ({(described.get('cache') or {}).get('title')!r})")
        check((described.get("nofile") or {}).get("title") == "Another program has a file of the build open.", f"no file: {(described.get('nofile') or {}).get('title')!r}")
        check(all((described.get(k) or {}).get("title") == generic for k in ("other", "nocause", "odd")) and
              described["nocause"]["facts"] == ["File: Actors/14001.IGB"] and described["other"]["facts"] == ["File: Actors/14001.IGB"],
              "an unknown cause (or none): the general text and the file")
        check(": 7 (first: Data/a.txt)" in " ".join(described.get("count") or []), f"W_EXTRA_FILES counts detail.count: {described.get('count')}")
        check("files: 3;" in " ".join(described.get("parsed") or []), f"no detail.count: the number of the message: {described.get('parsed')}")
        check(any("Another program has them open" in text and "first: Data/b.txt" in text for text in described.get("kept") or []),
              f"not_removed with cause held: said so, first the kept file: {described.get('kept')}")

        print("wizard: requirements")
        js("window.Xml1Setup.show()")
        wait_for(lambda: test.exists(".xml1-setup [data-req='xml2']"), 5)
        check(test.exists(".xml1-setup .xml1-req.is-missing[data-req='xml2']"), "X-Men Legends II missing")
        check(test.exists(".xml1-setup [data-act='setup-xml2']"), "offers to set up X-Men Legends II")
        check(js("document.querySelector('.xml1-setup [data-act=\"check\"]').disabled"), "Check disc disabled")
        js("window.Xml1Setup.hide()")

        check(cmd("set-game-path", {"game": "xml2", "path": str(xml2)}) is True,
              "XML2 pointed at " + ("the real install (a junction next to the test folder)" if real else "the fake install"))
        status = test.status()
        check(status["xml2"]["setUp"] and pathlib.Path(status["defaultOut"]) == out, f"default folder next to XML2: {status['defaultOut']}")
        js("window.Xml1Setup.show()")
        wait_for(lambda: test.exists(".xml1-setup .xml1-req.is-ok[data-req='xml2']"), 5)
        check(js("document.querySelector('.xml1-setup [data-field=\"out\"]').value") == str(out), "destination prefilled")
        check(wait_for(lambda: "free on this drive" in (test.text(".xml1-setup .xml1-free") or ""), 5), "free space shown")

        if real:
            test.skip("builder not released / SHA-256 / install from the release: the fake's (the real builder runs from source)")
            check("dev" in (test.text(".xml1-setup [data-req='builder']") or ""), "the builder row: the source build (dev)")
            js("window.Xml1Setup.hide()")
        else:
            print("builder not released yet: said up front")
            check(wait_for(lambda: test.exists(".xml1-setup .xml1-req.is-missing[data-req='builder']"), 20), "the builder row says so")
            check("not been released yet" in (test.text(".xml1-setup [data-req='builder']") or ""), "in plain words")
            test.set_input(".xml1-setup [data-field='iso']", str(good))
            check(js("document.querySelector('.xml1-setup [data-act=\"check\"]').disabled"), "Check disc stays disabled")
            test.shot("builder-unpublished")
            js("window.Xml1Setup.hide()")

            print("builder: a download that doesn't match its SHA-256 is not installed")
            manifest = json.loads((www / "xml1-builder.json").read_text())
            bad = dict(manifest, sha256="0" * 64)
            (www / "bad").mkdir()
            (www / "bad" / "xml1-builder.json").write_text(json.dumps(dict(bad, url=f"{base}/{manifest['zip']}")))
            test.prop("builder-manifest", f"{base}/bad/xml1-builder.json")
            cmd("xml1-builder-check", {"install": True})
            wait_for(lambda: not test.status()["builder"]["checking"] and not test.status()["builder"]["installing"], 20)
            builder = test.status()["builder"]
            check(builder["code"] == "L_BUILDER_HASH" and not builder["installed"], f"refused: {builder['code']}")
            check(not DEBUG_TOOLS.exists() or not [p for p in DEBUG_TOOLS.iterdir()], "nothing left in the tools folder")
            test.prop("builder-manifest", f"{base}/xml1-builder.json")

            print("builder: a zip the player already has is checked like a download")

            def builder_settled(timeout=30):
                wait_for(lambda: not test.status()["builder"]["checking"] and not test.status()["builder"]["installing"], timeout)
                return test.status()["builder"]

            def install_zip(path):
                check(cmd("xml1-builder-install-zip", {"path": str(path)}) is True, f"{path.name}: taken")
                return builder_settled()

            def forget_builder():
                shutil.rmtree(DEBUG_TOOLS, ignore_errors=True)
                test.prop("builder-version", "")
                test.prop("builder-content", "")

            release_zip = www / manifest["zip"]
            hand = root / "by-hand"
            (hand / "good").mkdir(parents=True)
            damaged_bytes = bytearray(release_zip.read_bytes())
            damaged_bytes[len(damaged_bytes) // 2] ^= 0xFF
            damaged = hand / manifest["zip"]
            damaged.write_bytes(bytes(damaged_bytes))
            builder = install_zip(damaged)
            check(builder["code"] == "L_BUILDER_ZIP_MISMATCH" and "SHA-256" in builder["error"] and not builder["installed"],
                  f"the release's size, other bytes: refused ({builder['code']}: {builder['error'][:80]!r})")
            damaged.write_bytes(bytes(damaged_bytes[:1000]))
            builder = install_zip(damaged)
            check(builder["code"] == "L_BUILDER_ZIP_MISMATCH" and "1000 bytes" in builder["error"] and not builder["installed"],
                  f"an incomplete zip: refused, with both sizes ({builder['error'][:80]!r})")
            older, _ = fake.make_package(hand / "old", version="0.9.0", content_version=2, shim=native.builder_shim())
            builder = install_zip(older)
            check(builder["code"] == "L_BUILDER_ZIP_OLD" and "0.9.0" in builder["error"] and "1.0.0" in builder["error"]
                  and not builder["installed"], f"an older builder's zip: refused, naming both versions ({builder['error'][:80]!r})")
            check(not DEBUG_TOOLS.exists() or not [p for p in DEBUG_TOOLS.iterdir() if p.is_dir()], "nothing installed from them")

            good = hand / "good" / manifest["zip"]
            shutil.copy2(release_zip, good)
            release_zip.rename(release_zip.with_name("away.zip"))  # a download would fail now
            try:
                builder = install_zip(good)
                check(builder["installed"] and builder["version"] == "1.0.0" and builder["source"] == "zip" and not builder["code"],
                      f"the release's zip: installed from it, nothing downloaded ({builder['source']!r})")
                check((DEBUG_TOOLS / "1.0.0" / "xml1-builder.exe").exists() and good.read_bytes() == (www / "away.zip").read_bytes(),
                      "into tools/xml1-builder/1.0.0; the player's zip left as it was")
                check(not [p for p in DEBUG_TOOLS.iterdir() if p.name.startswith(".staging")], "no staging folder left")

                forget_builder()
                DEBUG_TOOLS.mkdir(parents=True)
                shutil.copy2(good, DEBUG_TOOLS / manifest["zip"])
                cmd("xml1-builder-check", {"install": True})
                builder = builder_settled()
                check(builder["installed"] and builder["source"] == "zip", "the release's zip put in tools/xml1-builder is found and used")
            finally:
                (www / "away.zip").rename(release_zip)

            forget_builder()
            DEBUG_TOOLS.mkdir(parents=True)
            (DEBUG_TOOLS / manifest["zip"]).write_bytes(bytes(damaged_bytes))
            cmd("xml1-builder-check", {"install": True})
            builder = builder_settled()
            check(builder["installed"] and builder["source"] == "download", "a damaged one there is not used: the release is downloaded")
            forget_builder()

            js("window.Xml1Setup.show()")
            check(wait_for(lambda: test.exists(".xml1-setup [data-act='builder-zip']"), 20), "the wizard offers a zip you already have")
            js("window.Xml1Setup.hide()")

        print("wizard: the disc check" + ("" if real else " installs the builder, then") + " maps disc errors to plain messages")
        js("window.Xml1Setup.show()")
        if not real:
            check(wait_for(lambda: "downloaded when you continue" in (test.text(".xml1-setup [data-req='builder']") or ""), 20),
                  "the builder row: downloaded when you continue")
        test.set_input(".xml1-setup [data-field='iso']", str(fake.make_fake_iso(isos / "ps2.iso", kind="ps2")))
        check(not js("document.querySelector('.xml1-setup [data-act=\"check\"]').disabled"), "Check disc enabled")
        test.shot("wizard-requirements")
        test.click(".xml1-setup [data-act='check']")
        wait_for(lambda: test.exists(".xml1-setup .xml1-error") or test.exists(".xml1-setup [data-act='build']"), 120 if real else 40)
        if not real:
            builder = test.status()["builder"]
            check(builder["installed"] and builder["version"] == "1.0.0", f"builder {builder['version']} installed from the release")
            check((DEBUG_TOOLS / "1.0.0" / "xml1-builder.exe").exists(), "into tools/xml1-builder/1.0.0")
            check(not [p for p in DEBUG_TOOLS.iterdir() if p.name.startswith(".staging")], "no staging folder left")
        check(js("document.querySelector('.xml1-setup .xml1-error').dataset.code") == "E_ISO_NOT_XBOX", "PS2 image: E_ISO_NOT_XBOX")
        check("not a disc image of the Xbox version" in (test.text(".xml1-setup .xml1-error-title") or ""), "shown as a plain message")
        test.shot("wizard-wrong-disc")
        test.click(".xml1-setup [data-act='back']")
        for iso, code, words in ((fake.make_fake_iso(isos / "other.iso", title_id="0x41560017", title="Some Other Game"), "E_ISO_WRONG_GAME", "Found: Some Other Game"),
                                 (fake.make_fake_iso(isos / "packed.cso", kind="cso"), "E_ISO_COMPRESSED", "compressed"),
                                 (fake.make_fake_iso(isos / "gamecube.iso", kind="gamecube"), "E_ISO_NOT_XBOX", "not a disc image of the Xbox version"),
                                 (fake.make_fake_iso(isos / "truncated.iso", truncated=True), "E_ISO_READ", "could not be read to the end"),
                                 (fake.make_fake_iso(isos / "demo.iso", incomplete=True), "E_ISO_INCOMPLETE", "Missing: z/assetsfb.zip"),
                                 (isos / "gone.iso", "E_ISO_NOT_FOUND", "was not found")):
            test.set_input(".xml1-setup [data-field='iso']", str(iso))
            test.click(".xml1-setup [data-act='check']")
            wait_for(lambda: test.exists(".xml1-setup .xml1-error") or test.exists(".xml1-setup [data-act='build']"), 120 if real else 20)
            shown = test.text(".xml1-setup .xml1-error") or ""
            found = js("(document.querySelector('.xml1-setup .xml1-error') || {dataset: {}}).dataset.code")
            check(found == code and words in shown, f"{iso.name}: {code}" + ("" if found == code and words in shown else f" (got {found}: {shown!r})"))
            test.click(".xml1-setup [data-act='back']")

        if not real:
            print("builder output of unexpected shapes (nulls, numbers, arrays, lines that aren't events)")
            odd_iso = fake.make_fake_iso(isos / "odd.iso", fake={"odd_events": True})
            started = cmd("xml1-info", {"iso": str(odd_iso), "out": str(out)})
            job = test.job_done(started["id"], 30) if started.get("success") else {}
            check(job.get("finished") and job.get("exitCode") == 0 and (job.get("result") or {}).get("info", {}).get("iso"),
                  "the run is read to its end: its result and info")
            check(test.status()["state"] == "not-setup", "the launcher keeps answering")

            print("wizard: an X-Men Legends II with a file added (a mod installed into it) is named, not refused")
            (xml2 / "Data" / "mod_override.txt").write_text("a mod", encoding="utf-8")
            test.set_input(".xml1-setup [data-field='iso']", str(slow))
            test.click(".xml1-setup [data-act='check']")
            wait_for(lambda: test.exists(".xml1-setup [data-act='build']") or test.exists(".xml1-setup .xml1-error"), 20)
            note = test.text(".xml1-setup .xml1-check-notice") or ""
            check("differs from a retail install" in note and "mod_override.txt" in note, f"the check says so: {note[:90]!r}")
            check(not js("document.querySelector('.xml1-setup [data-act=\"build\"]').disabled"), "Build still enabled")
            test.click(".xml1-setup [data-act='back']")
            (xml2 / "Data" / "mod_override.txt").unlink()

        print("wizard: a good disc image")
        test.set_input(".xml1-setup [data-field='iso']", str(slow))
        test.click(".xml1-setup [data-act='check']")
        wait_for(lambda: test.exists(".xml1-setup [data-act='build']") or test.exists(".xml1-setup .xml1-error"), 120 if real else 20)
        shown = test.text(".xml1-setup") or ""
        check("recognised disc image" in shown, "recognised dump")
        check("Free space" in shown and "minutes" in shown, "space and a time estimate")
        check(not test.exists(".xml1-setup .xml1-check-notice"), "no warnings for a retail X-Men Legends II")
        check(not js("document.querySelector('.xml1-setup [data-act=\"build\"]').disabled"), "Build enabled")
        js("document.querySelector('.xml1-setup .xml1-advanced').open = true")
        test.shot("wizard-check")

        print("building, with progress; hide; cancel")
        test.click(".xml1-setup [data-act='build']")
        check(wait_for(lambda: test.exists(".xml1-setup .xml1-stage.is-running"), 60 if real else 15), "stage list from the plan event")
        check(wait_for(lambda: (cmd("get-xml1-build") or {}).get("overall", 0) > 25, 600 if real else 40), "progress moves")
        time.sleep(0.7)
        test.shot("wizard-building")
        status = test.status()
        check(status["state"] == "building" and pathlib.Path(status["install"]) == out, "state building, folder remembered")
        again = cmd("xml1-build-start", {"iso": str(good), "out": str(out)})
        check(again["success"] is False and again["code"] == "L_BUILD_RUNNING", "one build at a time")
        test.click(".xml1-setup [data-act='close']")
        check(wait_for(lambda: js("window.ProgressManager.isActive && window.ProgressManager.currentGame === 'xml1'"), 5),
              "hidden: the global progress bar shows the build")
        check("Building X-Men Legends" in (test.text("#progress-info") or ""), f"bar: {test.text('#progress-info')}")
        check("BUILDING" in (test.text("#xml1-button-group .setup-button") or "").upper(), "the page button shows Building n%")
        test.shot("building-page", "#xml1-page .hero-section")
        test.click("#xml1-build-panel [data-act='cancel-build']")
        body = test.message_box(1)
        check(body is not None and "safe point" in body, "cancel asks first")
        began = time.time()
        job = test.build_done(40)
        check(job["exitCode"] == 5 and not job["killed"], f"cancelled by the builder (exit {job['exitCode']}, {time.time() - began:.1f} s)")
        check(wait_for(lambda: test.status()["state"] == "incomplete", 5), "state incomplete (building.json kept)")
        check(wait_for(lambda: not js("window.ProgressManager.isActive"), 5), "progress bar released")
        check(wait_for(lambda: not builder_processes(str(root)), 10), "no builder process left")
        test.refresh_port()
        check("RESUME" in (test.text("#xml1-button-group .setup-button") or "").upper(), "the page offers Resume build")
        test.shot("incomplete", "#xml1-page .hero-section")

        print("resume: the finished steps are cached; then the XML2 Fix goes in")
        test.click("#xml1-button-group .setup-button")
        check(wait_for(lambda: (cmd("get-xml1-build") or {}).get("active"), 10), "resumed")
        wait_for(lambda: (cmd("get-xml1-build") or {}).get("stages"), 60)
        plan = (cmd("get-xml1-build") or {}).get("stages", [])
        cached = [stage["id"] for stage in plan if stage["cached"]]
        check(len(cached) >= 1, f"cached stages skipped: {cached}")
        job = test.build_done(90)
        content_version = job.get("contentVersion") if real else 3
        check(job["exitCode"] == 0 and job["result"]["ok"], f"build finished (exit {job['exitCode']}, {job['warnings']} warnings, {job['seconds']:.0f} s)")
        check(wait_for(lambda: (out / "dinput.dll").exists() and test.status()["isInstalled"], 30), "XML2 Fix installed into the port folder")
        status = test.status()
        check(status["state"] == "ready" and status["fix"]["ok"] and status["fix"]["version"].startswith("1.2.0"),
              f"ready, fix {status['fix']['version']} meets {status['fix']['required']}")
        stamp = json.loads((out / "_build" / "stamp.json").read_text())
        check(stamp["builder"]["content_version"] == content_version and stamp["profile"]["movies"] is True, f"stamp written (content {content_version})")
        check((out / "_build" / "manifest.json").exists() and (out / "_build" / "verify-report.json").exists(), "manifest.json and verify-report.json")
        ini = (out / "xml2-fix.ini").read_text()
        check("NewGameTeam=wolverine" in ini and "ActorSlots=127" in ini, "the builder's [Game] and [Limits] keys")
        check("Mode=borderless" in ini and "RunInBackground=1" in ini, "the launcher's first-setup [Display] defaults")
        test.refresh_port()
        test.page()
        check(test.exists("#xml1-button-group .play-button"), "Play on the page")
        check("UP TO DATE" in (test.text("#xml1-build-panel .xml1-state") or "").upper(), "Build section: up to date")
        test.shot("ready", "#xml1-page .hero-section")
        test.shot("ready-build-section", "#xml1-page .detail-build")
        js("window.AppViews.navigateTo('library')")
        time.sleep(1)
        test.shot("library")
        test.page()

        print("Display, Discord and Mods on the port's page (its own xml2-fix.ini)")
        display = cmd("get-display-settings", {"game": "xml1"})
        check(display["fixInstalled"] and display["values"]["Mode"] == "borderless", "Display reads the port's ini")
        check(cmd("set-presence-settings", {"game": "xml1", "values": {"Enabled": False}})["success"], "Discord switch written")
        ini = (out / "xml2-fix.ini").read_text()
        check("[Discord]" in ini and "Enabled=0" in ini and "NewGameTeam=wolverine" in ini, "next to the builder's keys")
        check(cmd("get-mods", {"game": "xml1"})["installed"], "Mods section works on the port folder")
        check(test.exists("#xml1-display-panel .ul-display-row") and test.exists("#xml1-presence-panel .ul-display-row"),
              "Display and Discord sections on the page")
        test.shot("display-section", "#xml1-page .detail-display:not(.detail-build)")

        if real:
            test.skip("Play / Stop: the real build's XMen2.exe is the game (never launched by the tests)")
        else:
            print("Play starts the port's XMen2.exe; XML2's is a different game (F5)")
            assert pathlib.Path(test.prop("install")).resolve() == out.resolve()  # never anything but the test folder
            other = subprocess.Popen([str(xml2 / "XMen2.exe")])
            dummies.append(other)
            time.sleep(0.5)
            check(cmd("is-game-running", {"game": "xml2"}) is True and cmd("is-game-running", {"game": "xml1"}) is False,
                  "XML2's XMen2.exe running: X-Men Legends is not")
            js("launchGame('xml1')")
            check(wait_for(lambda: cmd("is-game-running", {"game": "xml1"}) is True, 20), "Play: the port's XMen2.exe runs")
            check(cmd("stop-game", {"game": "xml1"}) is True, "Stop")
            check(wait_for(lambda: cmd("is-game-running", {"game": "xml1"}) is False, 10) and other.poll() is None,
                  "only the port stopped; XML2's XMen2.exe still running")
            check(cmd("stop-game", {"game": "xml2"}) is True and wait_for(lambda: other.poll() is not None, 10), "then XML2's stopped")
            time.sleep(2.5)  # the exit watchdog releases the launch barrier

        if real:
            print("update available: the stamp of an older content version (the real builder says stale)")
            stamp = json.loads((out / "_build" / "stamp.json").read_text())
            stamp["builder"]["content_version"] = 0
            (out / "_build" / "stamp.json").write_text(json.dumps(stamp, indent=1))
            test.refresh_port()
            test.page()
            check(wait_for(lambda: "UPDATE AVAILABLE" in (test.text("#xml1-build-panel .xml1-state") or "").upper(), 30),
                  "Build section: update available (from the builder's info: content 0 < " f"{content_version})")
            test.shot("update-available", "#xml1-page .detail-build")
            test.click("#xml1-build-panel [data-act='rebuild']")
            test.message_box(1)
            job = test.build_done()
            check(job["exitCode"] == 0, f"rebuilt (exit {job['exitCode']}, {job['seconds']:.0f} s)")
            check(wait_for(lambda: test.status()["state"] == "ready", 30), "up to date again")
            check(json.loads((out / "_build" / "stamp.json").read_text())["builder"]["content_version"] == content_version, "the stamp's content version")
        else:
            print("update available: a newer builder with new content")
            publish_builder(www, "1.1.0", 4)
            cmd("xml1-builder-check", {"install": True})
            wait_for(lambda: not test.status()["builder"]["checking"] and not test.status()["builder"]["installing"], 30)
            status = test.status()
            check(status["builder"]["version"] == "1.1.0", "builder 1.1.0 installed silently")
            check(status["state"] == "stale", "content 3 < 4: update available (never an automatic rebuild)")
            check(sorted(p.name for p in DEBUG_TOOLS.iterdir()) == ["1.0.0", "1.1.0"], "1.0.0 kept until a build with 1.1.0 works")
            test.refresh_port()
            test.page()
            check("UPDATE AVAILABLE" in (test.text("#xml1-build-panel .xml1-state") or "").upper(), "Build section: update available")
            test.shot("update-available", "#xml1-page .detail-build")
            test.click("#xml1-build-panel [data-act='rebuild']")
            test.message_box(1)
            job = test.build_done(90)
            check(job["exitCode"] == 0 and job["version"] == "1.1.0", "rebuilt with 1.1.0")
            check(wait_for(lambda: test.status()["state"] == "ready", 30), "up to date again")
            check(sorted(p.name for p in DEBUG_TOOLS.iterdir()) == ["1.1.0"], "old builder pruned after the good build")

        print("verify: groups and counts; report a problem; repair")
        manifest = json.loads((out / "_build" / "manifest.json").read_text())
        built = sorted(rel for rel, entry in manifest["files"].items() if entry["kind"] == "built")
        gone, changed = built[0], built[1]
        (out / gone).unlink()
        data = bytearray((out / changed).read_bytes())
        data[len(data) // 2] ^= 0xFF
        (out / changed).write_bytes(bytes(data))
        stray = out / "Data" / "stray-test-file.txt"
        stray.parent.mkdir(parents=True, exist_ok=True)
        stray.write_text("not the build's", encoding="utf-8")
        test.refresh_port()
        test.page()
        test.click("#xml1-build-panel [data-act='verify']")
        check(wait_for(lambda: test.state() == "damaged", 120 if real else 20), "Verify build finds the damage")
        verify = js("window.Xml1Port.verify") or {}
        counts = verify.get("counts") or {}
        check(counts.get("missing") == 1 and counts.get("changed") == 1 and counts.get("extra") == 1,
              f"counts from the builder: {counts}")
        check("(2)" in (test.text("#xml1-build-panel .xml1-state") or ""), "the state counts the damaged files (missing + changed)")
        group_text = test.text("#xml1-build-panel .xml1-verify") or ""
        check(test.exists("#xml1-build-panel .xml1-verify-group[data-code='missing'][data-count='1']") and
              test.exists("#xml1-build-panel .xml1-verify-group[data-code='changed'][data-count='1']") and
              test.exists("#xml1-build-panel .xml1-verify-group[data-code='extra'][data-count='1']"), "a group per finding, with its count")
        check(gone in group_text and changed.split("/")[-1] in group_text and "stray-test-file.txt" in group_text, "the first files of each group")
        check("antivirus" in group_text and "another program or a mod" in group_text, "the builder's cause hints")
        check(test.exists("#xml1-build-panel [data-act='report']"), "Report a problem offered")
        test.shot("damaged", "#xml1-page .detail-build")
        written = js("window.Xml1Port.saveReport(window.Xml1Port.build, false)") or {}
        report = pathlib.Path(written.get("path") or "nowhere")
        check(written.get("success") and report.is_file(), f"report saved: {report.name}")
        text = report.read_text(encoding="utf-8") if report.is_file() else ""
        profile = os.environ.get("USERPROFILE", "C:\\Users\\")
        check("verify-report.json" in text and '"missing"' in text and gone in text, "it holds verify-report.json (the groups, relative paths)")
        check("build log, last" in text, "and the end of the build log")
        check(profile not in text and profile.replace("\\", "\\\\") not in text and "%USERPROFILE%" in text, "profile paths masked")
        report.unlink(missing_ok=True)  # (a report of the test's own made-up damage)
        # A second stray file that another program holds open: the repair can't delete it, so it stays and
        # the build succeeds, naming it (W_EXTRA_FILES: detail.not_removed, cause held).
        kept = out / "Data" / "stray-held-open.txt"
        kept.write_text("held by another program", encoding="utf-8")
        held = hold_file(kept)
        test.click("#xml1-build-panel [data-act='rebuild']")
        test.message_box(1)
        job = test.build_done(90)
        check(job["exitCode"] == 0 and (out / gone).exists(), f"Repair rebuilds it (exit {job['exitCode']})")
        check(wait_for(lambda: test.state() == "ready", 30), "ready")
        check(not stray.exists(), "the rebuild removed the file it did not make")
        notice = next((n for n in job.get("notices", []) if n.get("code") == "W_EXTRA_FILES"), None)
        detail = (notice or {}).get("detail") or {}
        check(notice is not None and "data/stray-held-open.txt" in [str(p).lower() for p in detail.get("not_removed") or []]
              and detail.get("cause") == "held" and isinstance(detail.get("count"), int) and detail["count"] >= 1,
              f"the one it could not remove (held open) is named: {[n.get('code') for n in job.get('notices', [])]}, {detail}")
        check(wait_for(lambda: (lambda shown: "stray-held-open.txt" in shown and "Another program has them open" in shown)(
                           test.text("#xml1-build-panel .xml1-notice[data-code='W_EXTRA_FILES']") or ""), 10),
              "the page shows that warning: the file, and why it stayed")
        test.shot("repaired-warning", "#xml1-page .detail-build")
        release_file(held)
        held = None
        kept.unlink()
        test.click("#xml1-build-panel [data-act='verify']")
        check(wait_for(lambda: (js("window.Xml1Port.verify") or {}).get("state") == "current", 120 if real else 20) and test.state() == "ready",
              "Verify: current, nothing missing or changed")

        print("a failed build: another program holds a file the build replaces (E_IO, exit 6)")
        registry = json.loads((out / "_build" / "registry.json").read_text())
        victim = next(entry["rel"] for entry in sorted(registry["entries"].values(), key=lambda e: e["rel"]) if entry.get("sha1"))
        held = hold_file(out / victim)
        print(f"  (holding {victim} open, as another program would)")
        test.refresh_port()
        test.click("#xml1-build-panel [data-act='rebuild']")
        test.message_box(1)
        job = test.build_done(60)
        error = job["errors"][0] if job["errors"] else {}
        code, detail = error.get("code", "-"), error.get("detail") or {}
        check(job["exitCode"] == 6 and code == "E_IO", f"exit {job['exitCode']}, {code}")
        check(detail.get("cause") == "held" and str(detail.get("path")).lower() == victim.lower() and detail.get("where") == "out",
              f"detail: cause held, the file relative to the game folder ({ {k: detail.get(k) for k in ('path', 'where', 'cause', 'winerror')} })")
        check(wait_for(lambda: test.exists("#xml1-build-panel .xml1-error[data-code='E_IO']"), 10), "the page shows the error")
        shown = test.text("#xml1-build-panel .xml1-error") or ""
        check(f"another program has {victim.lower()} open" in shown.lower() and "Close it" in shown,
              f"in plain words: who has which file, and what to do ({shown.splitlines()[0] if shown else ''!r})")
        check(test.exists("#xml1-build-panel .xml1-error [data-act='copy-details']") and test.exists("#xml1-build-panel .xml1-error [data-act='report']"),
              "with Copy details / Open log / Report")
        details = js("window.Xml1Port.details(window.Xml1Port.build)")
        check(code in details and profile not in details and "Last log lines" in details and '"cause":"held"' in details,
              "Copy details: code, detail (the cause), log tail, no profile path")
        test.shot("failed", "#xml1-page .detail-build")
        written = js("window.Xml1Port.saveReport(window.Xml1Port.build, false)") or {}
        text = pathlib.Path(written["path"]).read_text(encoding="utf-8") if written.get("success") else ""
        if written.get("success"):
            pathlib.Path(written["path"]).unlink(missing_ok=True)
        check(code in text and profile not in text and "build log, last" in text, "the saved report: the error, the log, no profile path")
        check(test.status()["state"] == "incomplete", "state incomplete: Resume")
        release_file(held)
        held = None

        if real:
            test.skip("a failing step (E_PIPELINE): the fake's knob (the real pipeline has no bug to show on demand)")
        else:
            print("a failed build: a step of the build fails (E_PIPELINE)")
            test.prop("iso", str(failing))
            test.refresh_port()
            test.click("#xml1-build-panel [data-act='resume']")
            job = test.build_done(60)
            code = job["errors"][0]["code"] if job["errors"] else "-"
            check(job["exitCode"] == 1 and code == "E_PIPELINE", f"exit {job['exitCode']}, {code}")
            check(wait_for(lambda: "A step of the build failed" in (test.text("#xml1-build-panel .xml1-error[data-code='E_PIPELINE']") or ""), 10),
                  "the page says so in plain words")
            check(test.status()["state"] == "incomplete", "state incomplete: Resume")
        if real:
            test.skip("Play refused on an unfinished build: never launches in real mode")
        else:
            cmd("launch-game", {"game": "xml1"})
            refused = test.message_box(0) or ""
            check("has not finished building" in refused and cmd("is-game-running", {"game": "xml1"}) is False,
                  "Play refused on an unfinished build")

        if real:
            test.skip("a builder that ignores cancel: the fake's knob (the real one exits within seconds, checked above)")
        else:
            print("a builder that ignores cancel is ended with its job")
            test.prop("iso", str(stubborn))
            started = cmd("xml1-build-start", {"iso": str(stubborn), "out": str(out), "movies": True, "keepCache": True})
            check(started["success"], "started")
            wait_for(lambda: (cmd("get-xml1-build") or {}).get("overall", 0) > 5, 30)
            cmd("xml1-build-cancel")
            began = time.time()
            job = test.build_done(40)
            waited = time.time() - began
            check(job["killed"] and job["errors"][0]["code"] == "L_BUILDER_KILLED" and 14 <= waited <= 30,
                  f"killed after {waited:.0f} s ({job['errors'][0]['code'] if job['errors'] else '-'})")
            check(wait_for(lambda: not builder_processes(str(root)), 10), "no builder process left")

        print("the disc image is gone: the build cache has the disc, so the build resumes without it")
        test.prop("iso", str(root / "moved away.iso"))
        test.refresh_port()
        test.page()
        status = test.status()
        check(not status["isoExists"] and status["cacheHasDisc"] and status["discId"], f"no disc image; the cache has disc {status['discId']}")
        check("the build cache has the disc" in (test.text("#xml1-build-panel") or ""), "the disc row says so")
        check("RESUME" in (test.text("#xml1-button-group .setup-button") or "").upper(), "Resume build offered")
        test.click("#xml1-button-group .setup-button")
        check(wait_for(lambda: (cmd("get-xml1-build") or {}).get("active"), 10), "resumed without a disc image")
        job = test.build_done(90)
        log = (out / "_build" / "builder.log").read_text(encoding="utf-8", errors="replace") if (out / "_build" / "builder.log").exists() else ""
        check(job["exitCode"] == 0 and "(no --iso)" in log, f"built from the cache's disc (exit {job['exitCode']}; the log says no --iso)")
        check(wait_for(lambda: test.status()["state"] == "ready", 30), "ready")
        test.prop("iso", str(good))

        print("free up the build cache")
        test.refresh_port()
        test.page()
        check(wait_for(lambda: js("!!(window.Xml1Port.info && window.Xml1Port.info.cache && window.Xml1Port.info.cache.bytes > 0)"), 30), "cache size shown")
        test.click("#xml1-build-panel [data-act='free-cache']")
        test.message_box(1)
        check(wait_for(lambda: not any(p.is_dir() for p in cache.iterdir() if (p / "disc").is_dir() or (p / "disc.json").exists()), 60),
              "build cache deleted" + (" (the throwaway copy)" if real else ""))
        check(test.status()["state"] == "ready", "the game stays")

        print("uninstall: the builder deletes its build; mods can stay; saves are never touched")
        (out / "mods" / "My Mod").mkdir(parents=True)
        (out / "mods" / "My Mod" / "readme.txt").write_text("mine")
        js("(uninstallGameDirect('xml1'), true)")  # (the dialog's promise resolves when it closes)
        check(wait_for(lambda: test.exists(".xml1-uninstall"), 5), "uninstall asks what to delete")
        check(any(unit in (test.text(".xml1-uninstall") or "") for unit in ("KB", "MB", "GB")), "sizes shown")
        check(js("document.querySelector('.xml1-uninstall [data-choice=\"deleteGame\"]').checked") and
              not js("document.querySelector('.xml1-uninstall [data-choice=\"mods\"]').checked"), "defaults: game yes, mods no")
        test.shot("uninstall")
        test.click(".xml1-uninstall [data-act='uninstall']")
        check(wait_for(lambda: not test.status()["install"], 120 if real else 30), "the folder is forgotten")
        check(wait_for(lambda: sorted(p.relative_to(out).as_posix() for p in out.rglob("*")) == ["mods", "mods/My Mod", "mods/My Mod/readme.txt"], 30),
              f"only the mods are left: {sorted(p.name for p in out.iterdir()) if out.exists() else None}")
        status = test.status()
        check(status["state"] == "not-setup" and not status["isInstalled"], "not set up again")
        check(xml2.exists() and (xml2 / "XMen2.exe").exists(), "X-Men Legends II untouched")

        print("a folder holding only the launcher's files (the XML2 Fix, its settings, mods) is a valid destination")
        (out / "dinput.dll").write_bytes(b"stand-in")
        (out / "xml2-fix.ini").write_text("[Display]\nMode=borderless\n", encoding="utf-8")
        test.prop("install", str(out))
        status = test.status()
        check(status["state"] == "absent" and status["launcherOnly"], f"state absent, not a broken build ({status['state']})")
        folder = cmd("xml1-folder", {"path": str(out)})
        check(folder["launcherOnly"] and not folder["builder"], "xml1-folder: launcher files only")
        started = cmd("xml1-info", {"out": str(out)})
        job = test.job_done(started["id"], 120 if real else 30) if started.get("success") else {}
        said = (((job.get("result") or {}).get("info") or {}).get("out") or {}).get("state")
        check(job.get("exitCode") == 0 and said == "absent", f"the builder's info calls it absent, the rule its build uses ({said})")
        test.prop("install", "")
        js("window.Xml1Setup.show()")
        wait_for(lambda: test.exists(".xml1-setup [data-field='iso']"), 5)
        test.set_input(".xml1-setup [data-field='iso']", str(good))
        test.set_input(".xml1-setup [data-field='out']", str(out))
        test.click(".xml1-setup [data-act='check']")
        wait_for(lambda: test.exists(".xml1-setup [data-act='build']") or test.exists(".xml1-setup .xml1-error"), 120 if real else 20)
        shown = test.text(".xml1-setup") or ""
        check("they are kept" in shown and "already has other files" not in shown, "the check takes it and says the files are kept")
        check(not js("document.querySelector('.xml1-setup [data-act=\"build\"]').disabled"), "Build enabled")
        test.shot("wizard-launcher-files")
        if real:
            test.skip("building into it: the cache was deleted by the uninstall (a first build takes minutes); the fake builds it")
            js("window.Xml1Setup.hide()")
        else:
            test.click(".xml1-setup [data-act='build']")
            job = test.build_done(90)
            check(job["exitCode"] == 0, f"built next to them (exit {job['exitCode']})")
            check((out / "mods" / "My Mod" / "readme.txt").exists() and (out / "xml2-fix.ini").read_text().startswith("[Display]"),
                  "the mods and the ini kept")
            js("window.Xml1Setup.hide()")
    finally:
        if held:
            release_file(held)
        for process in dummies:
            if process.poll() is None:
                process.kill()
        js("window.Xml1Setup && window.Xml1Setup.hide()")
        for suffix, value in saved_props.items():
            test.prop(suffix, value or "")
        cmd("set-game-property", {"game": "xml2", "suffix": "install", "value": saved_xml2 or ""})
        shutil.rmtree(DEBUG_TOOLS, ignore_errors=True)
        server.shutdown()
        js("window.Xml1Port.refresh()")
        if real and os.path.isjunction(xml2):
            os.rmdir(xml2)  # the junction itself, never the install behind it
        if real and cache and cache.exists():
            shutil.rmtree(cache, ignore_errors=True)  # hard links: only the copy's names go
        shutil.rmtree(root, ignore_errors=True)

    if real:
        print("real mode: the inputs are as they were")
        after = snapshot(args.xml2)
        changed = sorted(rel for rel in set(before["xml2"]) | set(after) if before["xml2"].get(rel) != after.get(rel))
        check(not changed, f"X-Men Legends II: no file written, added or removed ({len(after)} files)" + (f"; changed: {changed[:5]}" if changed else ""))
        iso_now = os.stat(args.iso)
        check((iso_now.st_size, iso_now.st_mtime_ns) == (before["iso"].st_size, before["iso"].st_mtime_ns), "the disc image unchanged")
        after = snapshot(args.cache)
        # The test only reads the original cache (its copy is hard links): a file changed in place (the same
        # file id, other size / time) would be a write through a link. Files replaced, added or removed at the
        # original paths are another user of the cache (the port's own builds share it); they are listed.
        written = sorted(rel for rel, value in before["cache"].items() if rel in after and after[rel] != value and after[rel][2] == value[2])
        check(not written, f"the reused cache: none of its {len(before['cache'])} files written through the test's links" + (f"; {written[:5]}" if written else ""))
        others = sorted(rel for rel in set(before["cache"]) | set(after) if before["cache"].get(rel) != after.get(rel) and rel not in written)
        if others:
            print(f"  note  changed at the cache's own paths meanwhile (another user of it): {others[:5]}")

    print(f"\nscreenshots: {', '.join(test.shots)}")
    print(f"\n{'PASSED' if not test.failures else 'FAILED'} ({test.failures} failure{'s' if test.failures != 1 else ''})")
    return 1 if test.failures else 0


if __name__ == "__main__":
    sys.exit(main())
