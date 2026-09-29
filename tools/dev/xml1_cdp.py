"""End-to-end check of the X-Men Legends (community port) entry against a running Debug build
(see launcher_cdp.py), with the fake builder (fake_xml1_builder.py) in throwaway folders.

    tools\\run-test-debug.bat
    python tools\\dev\\xml1_cdp.py

A local HTTP server publishes the fake builder the way the real release will (xml1-builder.json +
zip + SHA-256) and a stand-in XML2 Fix (a dinput.dll with a version resource); Debug builds read
their URLs from the xml1-builder-manifest / xml1-patch-manifest properties. The XML2 entry is
pointed at a small fake install whose XMen2.exe is tools/dev/native/dummy_game.c (no window, it only
waits), so the Play and Stop checks run that, never a game. Every folder is under %TEMP%; the
launcher's own settings for XML2 and X-Men Legends are put back at the end.

Covers: the states (not set up, builder missing / unpublished, building, incomplete / resume,
needs the fix, ready, update available, damaged, failed), the wizard (requirements, disc errors
mapped to plain messages, disc check, options, progress, cancel, hide), the builder install
(SHA-256 checked, staging, update, pruning), the build (stamp, ini keys merged with the launcher's
Display defaults, fix installed), Play and Stop by path, Display / Discord / Mods on the port's
page, Verify / Repair, Free up, the cancel that ends in a kill, and uninstall. Screenshots of the
states go to tools/dev/xml1-*.png (they show profile paths: they are gitignored).
"""
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

import fake_xml1_builder as fake
import native
from launcher_cdp import Launcher, wait_for

HERE = pathlib.Path(__file__).resolve().parent
XML1_PROPS = ["install", "is-installed", "iso", "movies", "keep-cache", "link-base", "cache", "builder-version",
              "builder-content", "builder-manifest", "builder-exe", "patch-manifest"]
DEBUG_TOOLS = pathlib.Path(os.environ["LOCALAPPDATA"]) / "ultimate-legends_debug" / "tools" / "xml1-builder"


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class Test:
    def __init__(self):
        self.launcher = Launcher()
        self.failures = 0
        self.shots = []

    # ---- plumbing ----

    def check(self, ok, label):
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}")
        self.failures += not ok
        return ok

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

    def refresh_port(self):
        self.js("window.Xml1Port.refresh().then(() => window.Xml1Port.refreshInfo())")
        time.sleep(1.2)

    def shot(self, name, selector=None, block="start"):
        if selector:
            self.js(f"(() => {{ const e = document.querySelector({json.dumps(selector)}); if (e) e.scrollIntoView({{block: {json.dumps(block)}}}); }})()")
        time.sleep(0.6)  # popups fade in
        path = HERE / f"xml1-{name}.png"
        self.launcher.screenshot(path)
        self.shots.append(path.name)

    def job_done(self, job_id, timeout=60):
        wait_for(lambda: (self.cmd("get-xml1-job", {"id": job_id}) or {}).get("finished"), timeout)
        return self.cmd("get-xml1-job", {"id": job_id})

    def build_done(self, timeout=90):
        wait_for(lambda: (lambda job: job is not None and job["finished"])(self.cmd("get-xml1-build")), timeout)
        return self.cmd("get-xml1-build")

    def state(self):
        return self.js("window.Xml1Port.state()")


def publish_builder(www, version, content_version):
    return fake.make_package(www, version=version, content_version=content_version, shim=native.builder_shim())


def publish_fix(www, version):
    folder = www / "fix"
    folder.mkdir(exist_ok=True)
    dll = folder / "dinput.dll"
    shutil.copy2(native.fix_dll(version), dll)
    data = dll.read_bytes()
    (folder / "ultimate-legends.json").write_text(json.dumps([["dinput.dll", len(data), hashlib.sha1(data).hexdigest().upper(), "game"]]))


def main():
    test = Test()
    check, cmd, js = test.check, test.cmd, test.js

    root = pathlib.Path(tempfile.mkdtemp(prefix="ul-xml1-"))
    www = root / "www"
    www.mkdir()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(www)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    xml2 = fake.make_fake_xml2(root / "X-Men Legends II", native.dummy_game())
    out = root / "X-Men Legends (Port)"
    cache = root / "cache"
    isos = root / "discs"
    isos.mkdir()
    # Small space needs, so the checks don't depend on this PC's free space.
    small = {"need_bytes": 50_000_000, "cache_need_bytes": 20_000_000}
    good = fake.make_fake_iso(isos / "X-Men Legends (World).iso", fake=small)
    slow = fake.make_fake_iso(isos / "slow.iso", fake=dict(small, speed=6))
    stubborn = fake.make_fake_iso(isos / "stubborn.iso", fake=dict(small, speed=12, ignore_cancel=True))
    failing = fake.make_fake_iso(isos / "failing.iso", fake=dict(small, fail_stage="content"))

    saved_xml2 = test.prop("install", game="xml2")
    saved = {suffix: test.prop(suffix) for suffix in XML1_PROPS}
    dummies = []
    try:
        # A clean slate for X-Men Legends in the Debug profile.
        shutil.rmtree(DEBUG_TOOLS, ignore_errors=True)
        for suffix in XML1_PROPS:
            test.prop(suffix, "")
        publish_builder(www, "1.0.0", 3)
        publish_fix(www, "1.2.0")
        test.prop("builder-manifest", f"{base}/missing/xml1-builder.json")
        test.prop("patch-manifest", f"{base}/fix/ultimate-legends.json")
        test.prop("cache", str(cache))
        cmd("set-game-property", {"game": "xml2", "suffix": "install", "value": ""})
        # A fresh page, as a player would open the launcher with these settings.
        test.launcher.call("Page.reload", {"ignoreCache": True})
        wait_for(lambda: js("!!(window.Xml1Port && window.Xml1Port.status)"), 20)
        time.sleep(1)

        print("not set up")
        status = test.status()
        check(status["state"] == "not-setup" and not status["builder"]["installed"], f"state {status['state']}, no builder")
        check(not status["xml2"]["setUp"] and status["defaultOut"] == "", "no XML2 yet, so no default folder")
        test.page()
        check("NOT SET UP" in (test.text("#xml1-build-panel") or "").upper(), "the Build section says Not set up")
        check(test.text("#xml1-button-group .setup-button") is not None, "the page offers Set up")
        test.shot("not-set-up", "#xml1-page .detail-build")

        print("wizard: requirements")
        js("window.Xml1Setup.show()")
        wait_for(lambda: test.exists(".xml1-setup [data-req='xml2']"), 5)
        check(test.exists(".xml1-setup .xml1-req.is-missing[data-req='xml2']"), "X-Men Legends II missing")
        check(test.exists(".xml1-setup [data-act='setup-xml2']"), "offers to set up X-Men Legends II")
        check(js("document.querySelector('.xml1-setup [data-act=\"check\"]').disabled"), "Check disc disabled")
        js("window.Xml1Setup.hide()")

        check(cmd("set-game-path", {"game": "xml2", "path": str(xml2)}) is True, "XML2 pointed at the fake install")
        status = test.status()
        check(status["xml2"]["setUp"] and pathlib.Path(status["defaultOut"]) == out, f"default folder next to XML2: {status['defaultOut']}")
        js("window.Xml1Setup.show()")
        wait_for(lambda: test.exists(".xml1-setup .xml1-req.is-ok[data-req='xml2']"), 5)
        check(js("document.querySelector('.xml1-setup [data-field=\"out\"]').value") == str(out), "destination prefilled")
        check(wait_for(lambda: "free on this drive" in (test.text(".xml1-setup .xml1-free") or ""), 5), "free space shown")

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

        print("wizard: disc check installs the builder, then maps disc errors to plain messages")
        test.prop("builder-manifest", f"{base}/xml1-builder.json")
        js("window.Xml1Setup.show()")
        check(wait_for(lambda: "downloaded when you continue" in (test.text(".xml1-setup [data-req='builder']") or ""), 20),
              "the builder row: downloaded when you continue")
        test.set_input(".xml1-setup [data-field='iso']", str(fake.make_fake_iso(isos / "ps2.iso", kind="ps2")))
        check(not js("document.querySelector('.xml1-setup [data-act=\"check\"]').disabled"), "Check disc enabled")
        test.shot("wizard-requirements")
        test.click(".xml1-setup [data-act='check']")
        wait_for(lambda: test.exists(".xml1-setup .xml1-error") or test.exists(".xml1-setup [data-act='build']"), 40)
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
                                 (isos / "gone.iso", "E_ISO_NOT_FOUND", "was not found")):
            test.set_input(".xml1-setup [data-field='iso']", str(iso))
            test.click(".xml1-setup [data-act='check']")
            wait_for(lambda: test.exists(".xml1-setup .xml1-error") or test.exists(".xml1-setup [data-act='build']"), 20)
            shown = test.text(".xml1-setup .xml1-error") or ""
            check(js("(document.querySelector('.xml1-setup .xml1-error') || {dataset: {}}).dataset.code") == code and words in shown,
                  f"{iso.name}: {code}")
            test.click(".xml1-setup [data-act='back']")

        print("wizard: a good disc image")
        test.set_input(".xml1-setup [data-field='iso']", str(slow))
        test.click(".xml1-setup [data-act='check']")
        wait_for(lambda: test.exists(".xml1-setup [data-act='build']") or test.exists(".xml1-setup .xml1-error"), 20)
        shown = test.text(".xml1-setup") or ""
        check("recognised disc image" in shown, "recognised dump")
        check("Free space" in shown and "minutes" in shown, "space and a time estimate")
        check(not js("document.querySelector('.xml1-setup [data-act=\"build\"]').disabled"), "Build enabled")
        js("document.querySelector('.xml1-setup .xml1-advanced').open = true")
        test.shot("wizard-check")

        print("building, with progress; hide; cancel")
        test.click(".xml1-setup [data-act='build']")
        check(wait_for(lambda: test.exists(".xml1-setup .xml1-stage.is-running"), 15), "stage list from the plan event")
        check(wait_for(lambda: (cmd("get-xml1-build") or {}).get("overall", 0) > 25, 40), "progress moves")
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
        job = test.build_done(40)
        check(job["exitCode"] == 5 and not job["killed"], f"cancelled by the builder (exit {job['exitCode']})")
        check(wait_for(lambda: test.status()["state"] == "incomplete", 5), "state incomplete (building.json kept)")
        check(wait_for(lambda: not js("window.ProgressManager.isActive"), 5), "progress bar released")
        test.refresh_port()
        check("RESUME" in (test.text("#xml1-button-group .setup-button") or "").upper(), "the page offers Resume build")
        test.shot("incomplete", "#xml1-page .hero-section")

        print("resume: the finished steps are cached; then the XML2 Fix goes in")
        test.click("#xml1-button-group .setup-button")
        check(wait_for(lambda: (cmd("get-xml1-build") or {}).get("active"), 10), "resumed")
        wait_for(lambda: (cmd("get-xml1-build") or {}).get("stages"), 10)
        plan = (cmd("get-xml1-build") or {}).get("stages", [])
        cached = [stage["id"] for stage in plan if stage["cached"]]
        check(len(cached) >= 1, f"cached stages skipped: {cached}")
        job = test.build_done(90)
        check(job["exitCode"] == 0 and job["result"]["ok"], f"build finished (exit {job['exitCode']}, {job['warnings']} warnings)")
        check(wait_for(lambda: (out / "dinput.dll").exists() and test.status()["isInstalled"], 30), "XML2 Fix installed into the port folder")
        status = test.status()
        check(status["state"] == "ready" and status["fix"]["ok"] and status["fix"]["version"].startswith("1.2.0"),
              f"ready, fix {status['fix']['version']} meets {status['fix']['required']}")
        stamp = json.loads((out / "_build" / "stamp.json").read_text())
        check(stamp["builder"]["content_version"] == 3 and stamp["profile"]["movies"] is True, "stamp written")
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

        print("verify and repair")
        registry = json.loads((out / "_build" / "registry.json").read_text())
        (out / registry["files"][0]["path"]).unlink()
        test.refresh_port()
        test.click("#xml1-build-panel [data-act='verify']")
        check(wait_for(lambda: test.state() == "damaged", 20), "Verify build finds the missing file")
        test.shot("damaged", "#xml1-page .detail-build")
        test.click("#xml1-build-panel [data-act='rebuild']")
        test.message_box(1)
        job = test.build_done(90)
        check(job["exitCode"] == 0 and (out / registry["files"][0]["path"]).exists(), "Repair rebuilds it")
        check(wait_for(lambda: test.state() == "ready", 30), "ready")

        print("a failed build")
        test.prop("iso", str(failing))
        test.refresh_port()
        test.click("#xml1-build-panel [data-act='rebuild']")
        test.message_box(1)
        job = test.build_done(60)
        check(job["exitCode"] == 1 and job["errors"][0]["code"] == "E_PIPELINE", "exit 1, E_PIPELINE")
        check(wait_for(lambda: test.exists("#xml1-build-panel .xml1-error[data-code='E_PIPELINE']"), 10), "the page shows the error")
        check("A step of the build failed" in (test.text("#xml1-build-panel .xml1-error") or ""), "in plain words, with Copy details / Open log / Report")
        details = js("window.Xml1Port.details(window.Xml1Port.build)")
        profile = os.environ.get("USERPROFILE", "C:\\Users\\")
        check("E_PIPELINE" in details and profile not in details and "Last log lines" in details, "Copy details: code, log tail, no profile path")
        test.shot("failed", "#xml1-page .detail-build")
        check(test.status()["state"] == "incomplete", "state incomplete: Resume")
        cmd("launch-game", {"game": "xml1"})
        refused = test.message_box(0) or ""
        check("has not finished building" in refused and cmd("is-game-running", {"game": "xml1"}) is False,
              "Play refused on an unfinished build")

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
        time.sleep(1)
        leftover = subprocess.run(["tasklist", "/FI", "IMAGENAME eq xml1-builder.exe"], capture_output=True, text=True).stdout
        check("xml1-builder.exe" not in leftover, "no builder process left")

        print("finish the build, free up the cache")
        test.prop("iso", str(good))
        test.refresh_port()
        test.click("#xml1-button-group .setup-button")
        job = test.build_done(90)
        check(job["exitCode"] == 0 and wait_for(lambda: test.status()["state"] == "ready", 30), "built again")
        test.refresh_port()
        check(wait_for(lambda: js("!!(window.Xml1Port.info && window.Xml1Port.info.cache && window.Xml1Port.info.cache.bytes > 0)"), 10), "cache size shown")
        test.click("#xml1-build-panel [data-act='free-cache']")
        test.message_box(1)
        check(wait_for(lambda: not any(p.is_dir() for p in cache.iterdir() if (p / "disc.json").exists()), 20), "build cache deleted")
        check(test.status()["state"] == "ready", "the game stays")

        print("uninstall: the builder deletes its build; mods can stay; saves are never touched")
        (out / "mods" / "My Mod").mkdir(parents=True)
        (out / "mods" / "My Mod" / "readme.txt").write_text("mine")
        js("(uninstallGameDirect('xml1'), true)")  # (the dialog's promise resolves when it closes)
        check(wait_for(lambda: test.exists(".xml1-uninstall"), 5), "uninstall asks what to delete")
        check("MB" in (test.text(".xml1-uninstall") or "") or "KB" in (test.text(".xml1-uninstall") or ""), "sizes shown")
        check(js("document.querySelector('.xml1-uninstall [data-choice=\"deleteGame\"]').checked") and
              not js("document.querySelector('.xml1-uninstall [data-choice=\"mods\"]').checked"), "defaults: game yes, mods no")
        test.shot("uninstall")
        test.click(".xml1-uninstall [data-act='uninstall']")
        check(wait_for(lambda: not test.status()["install"], 30), "the folder is forgotten")
        check(wait_for(lambda: sorted(p.relative_to(out).as_posix() for p in out.rglob("*")) == ["mods", "mods/My Mod", "mods/My Mod/readme.txt"], 10),
              f"only the mods are left: {sorted(p.name for p in out.iterdir()) if out.exists() else None}")
        status = test.status()
        check(status["state"] == "not-setup" and not status["isInstalled"], "not set up again")
        check(xml2.exists() and (xml2 / "XMen2.exe").exists(), "X-Men Legends II untouched")
    finally:
        for process in dummies:
            if process.poll() is None:
                process.kill()
        js("window.Xml1Setup && window.Xml1Setup.hide()")
        for suffix, value in saved.items():
            test.prop(suffix, value or "")
        cmd("set-game-property", {"game": "xml2", "suffix": "install", "value": saved_xml2 or ""})
        shutil.rmtree(DEBUG_TOOLS, ignore_errors=True)
        server.shutdown()
        js("window.Xml1Port.refresh()")
        shutil.rmtree(root, ignore_errors=True)

    print(f"\nscreenshots: {', '.join(test.shots)}")
    print(f"\n{'PASSED' if not test.failures else 'FAILED'} ({test.failures} failure{'s' if test.failures != 1 else ''})")
    return 1 if test.failures else 0


if __name__ == "__main__":
    sys.exit(main())
