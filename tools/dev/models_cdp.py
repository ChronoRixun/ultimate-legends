"""End-to-end click-through of the X-Men Legends page's Character models section against a running Debug
build (see launcher_cdp.py), with the character-model tool's test stand-in (fake_legends_models.py) in
throwaway folders: no game, no real pack, no download.

    tools\\run-test-debug.bat           (or a Debug launcher in Windows Sandbox: --remote-debugging-port=12345)
    python tools\\dev\\models_cdp.py     (needs: pip install websocket-client)

Points the xml1 entry at a fake port folder (Actors\\, a placeholder XMen2.exe that is never run, a mods\\
folder holding another mod), the Debug-only models-tool property at a .cmd that runs the stand-in with
this Python, and - for Upgraded - the mua entry at an empty folder. Then, through the page's own buttons
and dropdowns: the tool missing; the Community plan (the suggestion) with Upgraded greyed; a costume
picked from Wolverine's 19; Upgraded once MUA1 is set up; Apply with its progress, a hero that fails its
gate, downloads, credits; the folders, markers and load-order lines on disk (the other mod's line byte
for byte); Verify catching a changed file and Rebuild repairing it; Cancel mid-build (the previous
models kept) and the port build / Mods tab refused meanwhile; the mirror field; a download refusal in
plain words; Off removing everything the tool made and nothing else. Every setting it touches is put
back. Screenshots go to tools/dev/models-*.png, or to --shots DIR.
"""
import argparse
import json
import os
import pathlib
import shutil
import sys
import tempfile
import time

from launcher_cdp import Launcher, wait_for

HERE = pathlib.Path(__file__).resolve().parent
FAKE = HERE / "fake_legends_models.py"
XML1_PROPS = ["install", "is-installed", "models-tool", "models-mode", "models-mirror", "models-costumes"]
OTHER_ORDER = b"+Some Other Mod\r\n-Old Skin\r\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shots", type=pathlib.Path, default=HERE)
    args = parser.parse_args()
    args.shots.mkdir(parents=True, exist_ok=True)

    launcher = Launcher()
    failures = 0
    offline = False

    def check(ok, label):
        nonlocal failures
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}", flush=True)
        failures += not ok
        return ok

    def js(expression):
        return launcher.evaluate(expression)

    def q(selector, expression="!!el"):
        return js(f"(() => {{ const el = document.querySelector({json.dumps('#xml1-models-panel ' + selector)}); return {expression}; }})()")

    def text(selector):
        return q(selector, "el ? el.textContent.replace(/\\s+/g, ' ').trim() : null")

    def click(selector, timeout=60):
        # the page may still be finishing what the last step started: wait for the control to be enabled
        wait_for(lambda: q(selector, "!!el && !el.disabled"), timeout)
        return q(selector, "el && !el.disabled ? (el.click(), true) : false")

    def state():
        return js("(() => { const s = window.ModelsView._state('xml1'); return { loading: s.loading, refreshing: !!s.refreshing, "
                  "active: !!(s.job && s.job.active) || s.runs > 0 || s.acting > 0, command: s.job && s.job.command, plan: s.plan && s.plan.mode, "
                  "rows: s.plan ? s.plan.rows.length : 0 }; })()")

    def idle(timeout=60):
        return wait_for(lambda: (lambda s: not s["loading"] and not s["refreshing"] and not s["active"])(state()), timeout)

    def open_page():
        js("document.querySelector('.game-item[data-game=\"xml1\"]').click()")
        time.sleep(0.3)
        js("window.ModelsView.refresh('xml1')")
        idle()

    def shot(name):
        js("document.getElementById('xml1-models-panel').closest('section').scrollIntoView({block: 'start'})")
        time.sleep(0.4)
        path = args.shots / f"models-{name}.png"
        launcher.screenshot(path)
        print(f"  screenshot: {path}", flush=True)

    def scroll_to(selector):
        q(selector, "el ? (el.scrollIntoView({block: 'center'}), true) : false")
        time.sleep(0.3)

    def status_of(hero):
        return q(f'.ul-models-row[data-hero="{hero}"] .ul-models-status', "el ? el.className.replace(/.*is-/, '') : null")

    root = pathlib.Path(tempfile.mkdtemp(prefix="ul-models-cdp-"))
    port = root / "port"
    (port / "Actors").mkdir(parents=True)
    (port / "XMen2.exe").write_bytes(b"placeholder - not a game, never run")
    (port / "libIGSg.dll").write_bytes(b"placeholder")
    (port / "_build").mkdir()
    (port / "_build" / "stamp.json").write_text("{}")
    mods = port / "mods"
    for other in ("Some Other Mod", "Old Skin"):
        (mods / other).mkdir(parents=True)
        (mods / other / "readme.txt").write_text("another mod")
    (mods / "load-order.txt").write_bytes(OTHER_ORDER)
    mua1 = root / "mua1"
    mua1.mkdir()
    wrapper = root / "run-fake.cmd"
    wrapper.write_text(f'@echo off\r\nset "PYTHONDONTWRITEBYTECODE=1"\r\n"{sys.executable}" -u "{FAKE}" %*\r\nexit /b %ERRORLEVEL%\r\n')

    originals = {suffix: launcher.command("get-game-property", {"game": "xml1", "suffix": suffix}) for suffix in XML1_PROPS}
    original_mua = launcher.command("get-game-property", {"game": "mua", "suffix": "install"})
    knobs_file = None

    def knobs(**values):
        knobs_file.write_text(json.dumps(values))

    try:
        for suffix, value in (("install", str(port)), ("is-installed", "true"), ("models-tool", ""), ("models-mode", ""),
                              ("models-mirror", ""), ("models-costumes", "")):
            launcher.command("set-game-property", {"game": "xml1", "suffix": suffix, "value": value})
        launcher.command("set-game-property", {"game": "mua", "suffix": "install", "value": ""})

        # The launcher may run with -offline (the sandbox does): the page's offline rule is checked on its
        # own below; the rest runs as online.
        offline = js("!!window.IS_OFFLINE")
        js("window.IS_OFFLINE = false; true")

        print("the tool not installed")
        open_page()
        status = launcher.command("get-models-status")
        check(status["tool"]["found"] is False, "get-models-status: no tool")
        check(status["port"]["built"] is True, "the fake port counts as built")
        check(q(".ul-models-missing"), "the page says the tool is not installed")
        check(not q(".ul-models-table") and not q('[data-act="apply"]'), "no table, no Apply")
        shot("tool-missing")
        knobs_file = pathlib.Path(status["workFolder"]) / "fake-knobs.json"
        knobs_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(knobs_file.parent / "community-cache", ignore_errors=True)  # a clean run: nothing downloaded yet
        knobs(DELAY=0.05)

        print("the Community pack, suggested")
        launcher.command("set-game-property", {"game": "xml1", "suffix": "models-tool", "value": str(wrapper)})
        open_page()
        st = state()
        check(st["plan"] == "community" and st["rows"] == 15, f"planned community for 15 heroes ({st})")
        check(q('.ul-models-mode[data-mode="community"]', "el.className.includes('active')"), "Community pack chosen")
        check("Suggested" in (text('.ul-models-mode[data-mode="community"]') or ""), "marked Suggested")
        check(q('.ul-models-mode[data-mode="upgraded"]', "el.disabled"), "Upgraded greyed (no MUA1 / MUA2)")
        check("set one of them up" in (text(".ul-models-upgraded-note") or ""), "with the reason")
        check(status_of("profxastral") == "stock", "Professor X (astral): original (no community skin)")
        options = q('.ul-models-row[data-hero="wolverine"] select', "el ? el.options.length : 0")
        check(options == 19, f"Wolverine's costume chooser has {options} costumes")
        check("by BaconWizard17" in (text('.ul-models-row[data-hero="wolverine"] .ul-models-credit') or ""), "the author shown")
        check("once the pack is built" in (text(".ul-models-credits") or ""), "credits panel before the build")
        shot("community-plan")

        print("keyboard / controller")
        keys = {"Tab": ("Tab", "Tab", 9, None), "ArrowDown": ("ArrowDown", "ArrowDown", 40, None), "Enter": ("Enter", "Enter", 13, "\r")}

        def press(name):
            key, code, vk, typed = keys[name]
            base = {"key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}
            launcher.call("Input.dispatchKeyEvent", dict(base, type="keyDown", **({"text": typed} if typed else {})))
            launcher.call("Input.dispatchKeyEvent", dict(base, type="keyUp"))
            time.sleep(0.15)

        def focus_key():
            return js("(() => { const el = document.activeElement; return el && el.closest('#xml1-models-panel') ? (el.dataset.focus || el.tagName) : null; })()")

        q('.ul-models-mode[data-mode="community"]', "(el.focus(), true)")
        reached = set()
        for _ in range(12):
            press("Tab")
            reached.add(focus_key())
        check("apply" in reached, f"Tab reaches Apply ({sorted(map(str, reached))})")
        seen = set()
        q('.ul-models-mode[data-mode="community"]', "(el.focus(), true)")
        for _ in range(8):
            press("ArrowDown")
            seen.add(focus_key())
        check("apply" in seen or any(str(k).startswith("costume-") for k in seen), f"Down (a pad) walks into the section ({sorted(map(str, seen))})")
        q('.ul-models-mode[data-mode="off"]', "(el.focus(), true)")
        press("Enter")
        time.sleep(0.5)
        idle()
        check(q('.ul-models-mode[data-mode="off"]', "el.className.includes('active')"), "Enter on Off picks it")
        check(focus_key() == "mode-off", f"the focus stays on it after the redraw ({focus_key()})")
        click('.ul-models-mode[data-mode="community"]')
        time.sleep(0.3)
        idle()

        print("offline mode")
        js("window.IS_OFFLINE = true; window.ModelsView.refresh('xml1'); true")
        idle()
        check(q(".ul-models-offline") and "not downloaded yet" in (text(".ul-models-offline") or ""), "offline: the note")
        check(q('[data-act="apply"]', "el.disabled"), "offline: Apply waits for the downloads")
        js("window.IS_OFFLINE = false; window.ModelsView.refresh('xml1'); true")
        idle()
        check(not q(".ul-models-offline"), "online again: no note")

        print("a costume")
        q('.ul-models-row[data-hero="wolverine"] select', "(el.value = 'Variant 07', el.dispatchEvent(new Event('change', {bubbles: true})), true)")
        time.sleep(0.5)
        idle()
        stored = json.loads(launcher.command("get-game-property", {"game": "xml1", "suffix": "models-costumes"}) or "{}")
        check(stored.get("wolverine") == "community:Variant 07", f"stored {stored}")
        check(q('.ul-models-row[data-hero="wolverine"] select', "el.value") == "Variant 07", "the plan follows the choice")
        scroll_to('.ul-models-row[data-hero="wolverine"]')
        launcher.screenshot(args.shots / "models-costume.png")

        print("Upgraded once MUA1 is set up")
        launcher.command("set-game-property", {"game": "mua", "suffix": "install", "value": str(mua1)})
        open_page()
        check(not q('.ul-models-mode[data-mode="upgraded"]', "el.disabled"), "Upgraded enabled")
        click('.ul-models-mode[data-mode="upgraded"]')
        time.sleep(0.3)
        idle()
        check(state()["plan"] == "upgraded", "planned upgraded")
        check("MUA1" in (text('.ul-models-row[data-hero="storm"] .ul-models-tier') or ""), "Storm from MUA1")
        check("Community" in (text('.ul-models-row[data-hero="beast"] .ul-models-tier') or ""), "Beast falls back to Community")
        count = q('.ul-models-row[data-hero="wolverine"] select', "el ? el.options.length : 0")
        if not check(count == 3, f"Wolverine: MUA1's three costumes ({count})"):
            print("    (diagnostics)", state(), q('.ul-models-row[data-hero="wolverine"]', r"el ? el.textContent.replace(/\s+/g, ' ') : null"))
        shot("upgraded-plan")
        click('.ul-models-mode[data-mode="community"]')
        time.sleep(0.3)
        idle()

        print("Apply")
        knobs(DELAY=0.5, FAIL="cyclops")
        click('[data-act="apply"]')
        check(wait_for(lambda: q(".ul-models-progress") and "of 14 heroes" in (text(".ul-models-progress") or ""), 30), "progress bar with heroes")
        check(wait_for(lambda: q('.ul-models-downloads'), 20), "downloads listed")
        time.sleep(1.5)
        check(q('[data-act="cancel"]') and not q('[data-act="apply"]'), "Cancel instead of Apply while it runs")
        check(q('.ul-models-row[data-hero="wolverine"] select', "el.disabled"), "costumes locked while it runs")
        dl = text(".ul-models-downloads") or ""
        check("SHA-256" in dl and "MB" in dl and "author" in dl, f"download file / size / source / hash: {dl[:120]}")
        shot("building")
        check(idle(120), "the build finished")
        outcome = text(".ul-models-outcome") or ""
        check("13 heroes have their new models; 2 kept the original" in outcome, f"outcome: {outcome}")
        check(status_of("beast") == "built", "Beast built")
        check(status_of("cyclops") == "failed", "Cyclops failed")
        check("seam opens" in (text('.ul-models-row[data-hero="cyclops"]') or ""), "with the gate's reason")
        check("BaconWizard17" in (text(".ul-models-credits-text") or ""), "credits from the built pack")
        check(launcher.command("get-game-property", {"game": "xml1", "suffix": "models-mode"}) == "community", "mode stored")
        folders = sorted(p.name for p in mods.iterdir() if p.is_dir())
        check("Community-Beast" in folders and "Community-Cyclops" not in folders and "Some Other Mod" in folders, f"folders {folders}")
        order = (mods / "load-order.txt").read_bytes()
        check(order.startswith(OTHER_ORDER), "the other mods' lines kept byte for byte")
        check(b"+Community-Beast\r\n" in order and b"Community-Cyclops" not in order, "+Community-Beast, nothing for Cyclops")
        wolverine = json.loads((mods / "Community-Wolverine" / "legends-models.json").read_text())
        check(wolverine["characters"]["wolverine"]["source"] == "Variant 07", "the chosen costume was built")
        shot("built")
        scroll_to(".ul-models-credits")
        launcher.screenshot(args.shots / "models-credits.png")

        print("Verify")
        (mods / "Community-Beast" / "Actors" / "14501.IGB").write_bytes(b"changed")
        click('[data-act="verify"]')
        time.sleep(0.3)
        idle()
        check("missing or changed" in (text(".ul-models-verify") or ""), "Verify reports the changed file")
        check("Community-Beast/Actors/14501.IGB" in (text(".ul-models-verify") or ""), "and names it")
        shot("verify-damaged")
        knobs(DELAY=0.02, FAIL="cyclops")
        check((text('[data-act="apply"]') or "") == "Rebuild", "Apply reads Rebuild for the installed appearance")
        click('[data-act="apply"]')
        time.sleep(0.5)
        idle(120)
        check(not q(".ul-models-verify"), "Rebuild repaired it (verified after the build)")

        print("Cancel mid-build")
        knobs(DELAY=3)
        js("window.__realMessageBox = window.showMessageBox; window.showMessageBox = async () => 1; true")
        click('[data-act="apply"]')
        check(wait_for(lambda: state()["active"] and state()["command"] == "build", 20), "a build runs")
        time.sleep(1.0)
        refused = launcher.command("set-mod-enabled", {"game": "xml1", "name": "Some Other Mod", "enabled": False})
        check(refused and refused.get("success") is False, f"the Mods tab waits: {refused}")
        build = launcher.command("xml1-build-start", {"iso": str(root / "x.iso"), "out": str(port)})
        check(build and build.get("code") == "L_MODELS_RUNNING", f"a port build waits: {build}")
        second = launcher.command("models-run", {"command": "scan"})
        check(second and second.get("code") == "L_BUSY", "one run at a time")
        click('[data-act="cancel"]')
        check(idle(30), "the run ended")
        check("Cancelled" in (text(".ul-models-outcome") or ""), "the page says Cancelled")
        build_id = js("window.ModelsView._state('xml1').job.id")
        job = launcher.command("get-models-job", {"id": build_id, "from": 0})
        check(job and job["exitCode"] == 130 and job["exitName"] == "cancelled", f"the build's exit is 130 ({job and job['exitCode']})")
        js("window.showMessageBox = window.__realMessageBox; true")
        verify = launcher.command("models-run", {"command": "verify", "pack": "Models-Community"})
        wait_for(lambda: launcher.command("get-models-job", {"id": verify["id"], "from": 0})["finished"], 20)
        result = json.loads(launcher.command("get-models-job", {"id": verify["id"], "from": 0})["lines"][-1])
        check(result.get("ok") is True, "the previous models are intact after the cancel")
        check(launcher.command("set-mod-enabled", {"game": "xml1", "name": "Old Skin", "enabled": False})["success"], "the Mods tab writes again")
        # (the Mods tab writes its own header lines; from here on the tool must keep those byte for byte too)
        baseline = (mods / "load-order.txt").read_bytes()

        print("mirror")
        js("document.querySelector('#xml1-models-panel .ul-models-mirror').open = true; true")
        q(".ul-models-mirror-input", "(el.value = 'http://example.com/', true)")
        click('[data-act="save-mirror"]')
        time.sleep(0.4)
        check(launcher.command("get-game-property", {"game": "xml1", "suffix": "models-mirror"}) in ("", None), "http refused")
        bad = launcher.command("set-models-settings", {"mirror": "https://x.example/\" --strict"})
        check(bad["success"] is False, "the backend refuses a mirror with a quote")
        js("document.querySelector('#xml1-models-panel .ul-models-mirror').open = true; true")
        q(".ul-models-mirror-input", "(el.value = 'https://mirror.example/legends-models/', true)")
        click('[data-act="save-mirror"]')
        time.sleep(0.4)
        check(launcher.command("get-game-property", {"game": "xml1", "suffix": "models-mirror"}) == "https://mirror.example/legends-models/", "https saved")
        knobs(DELAY=0.02, LOG="")
        shutil.rmtree(knobs_file.parent / "community-cache", ignore_errors=True)  # downloaded again, from the mirror
        click('[data-act="apply"]')
        time.sleep(0.5)
        idle(60)
        check("from the mirror" in (text(".ul-models-downloads") or ""), "downloads come from the mirror")
        js("document.querySelector('#xml1-models-panel .ul-models-mirror').open = true; true")
        js("document.querySelector('#xml1-models-panel .ul-models-mirror').scrollIntoView({block: 'center'})")
        time.sleep(0.3)
        launcher.screenshot(args.shots / "models-mirror.png")

        print("a download refusal")
        knobs(BUILD_EXIT=20)
        clicked = click('[data-act="apply"]')
        time.sleep(0.5)
        idle(120)
        wait_for(lambda: q(".ul-models-outcome"), 60)
        outcome = text(".ul-models-outcome") or ""
        if not outcome:
            print("    (diagnostics)", clicked, state(), text('[data-act="apply"]'),
                  js("JSON.stringify((s => ({outcome: s.outcome, job: s.job && {c: s.job.command, e: s.job.exitCode, err: s.job.errors, se: s.job.startError}}))(window.ModelsView._state('xml1')))"))
        check("could not be downloaded or did not match its checksum" in outcome, f"plain words: {outcome[:100]}")
        check(q(".ul-models-outcome", "el.className.includes('is-error')"), "shown as an error")
        shot("download-failed")
        knobs(DELAY=0.02)

        print("offline mode, skins already downloaded")
        js("window.IS_OFFLINE = true; window.ModelsView.refresh('xml1'); true")
        idle()
        check(not q(".ul-models-offline") and not q('[data-act="apply"]', "el.disabled"), "nothing to download: Apply works offline")
        js(f"window.IS_OFFLINE = {'true' if offline else 'false'}; window.ModelsView.refresh('xml1'); true")
        idle()

        print("Off")
        click('.ul-models-mode[data-mode="off"]')
        time.sleep(0.3)
        idle()
        check(not q(".ul-models-table"), "no table for Off")
        check((text('[data-act="apply"]') or "") == "Turn off", "Apply reads Turn off")
        click('[data-act="apply"]')
        time.sleep(0.5)
        idle(60)
        folders = sorted(p.name for p in mods.iterdir() if p.is_dir() and not p.name.startswith("."))
        check(folders == ["Old Skin", "Some Other Mod"], f"only the other mods left: {folders}")
        order = (mods / "load-order.txt").read_bytes()
        expected = b"".join(line for line in baseline.splitlines(keepends=True) if b"Community-" not in line)
        check(order == expected, f"load order back to the other mods' lines, byte for byte: {order!r}")
        check("none" in (text(".ul-models-installed") or ""), "Installed: none")
        check(launcher.command("get-game-property", {"game": "xml1", "suffix": "models-mode"}) == "off", "mode off stored")
        shot("off")
    finally:
        js(f"window.IS_OFFLINE = {'true' if offline else 'false'}; true")
        for suffix, value in originals.items():
            launcher.command("set-game-property", {"game": "xml1", "suffix": suffix, "value": value or ""})
        launcher.command("set-game-property", {"game": "mua", "suffix": "install", "value": original_mua or ""})
        if knobs_file and knobs_file.exists():
            knobs_file.unlink()
            shutil.rmtree(knobs_file.parent / "community-cache", ignore_errors=True)
            shutil.rmtree(knobs_file.parent / "ports", ignore_errors=True)
        shutil.rmtree(root, ignore_errors=True)

    print(f"\n{'PASSED' if not failures else 'FAILED'} ({failures} failure{'s' if failures != 1 else ''})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
