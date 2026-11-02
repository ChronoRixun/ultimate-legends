"""Offline DOM tests in an already installed headless Chromium (no launcher/backend).

Run: python tools/dev/dropdown_ui_test.py [--browser PATH]
Uses only the Python standard library; all scratch files stay inside this checkout.
"""
import argparse
import html
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import uuid


REPO = Path(__file__).resolve().parents[2]
UI = REPO / "src/launcher-ui"


def browser_path():
    cache = Path(os.environ.get("LOCALAPPDATA", "")) / "ms-playwright"
    candidates = sorted(cache.glob("chromium_headless_shell-*/chrome-headless-shell-win64/chrome-headless-shell.exe"))
    return candidates[-1] if candidates else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", type=Path, default=browser_path())
    args = parser.parse_args()
    if not args.browser or not args.browser.is_file():
        parser.error("pass --browser pointing to an installed headless Chromium executable")
    scratch = (REPO / f".dropdown-test-{uuid.uuid4().hex}").resolve()
    scratch.mkdir()  # Inherit workspace ACLs (Python 3.14 mkdtemp uses a private Windows ACL).
    try:
        # Use the real settings markup/styles, but load only the modules under test. Do not
        # initialize the launcher: its CEF commands, polling and external services are absent.
        page = re.sub(r"<script\b[^>]*>.*?</script>", "", (UI / "main.html").read_text(encoding="utf-8"), flags=re.S)
        page = page.replace("<head>", f'<head><base href="{UI.as_uri()}/">', 1)
        scripts = ["core/utils.js", "core/i18n.js", "ui/dropdown.js", "app/display-view.js",
                   "app/models-view.js", "app/update-channel.js", "app/main.js"]
        tests = (REPO / "tools/dev/dropdown_ui_test.js").read_text(encoding="utf-8")
        tags = "".join(f'<script src="assets/js/{name}"></script>' for name in scripts)
        page = page.replace("</body>", tags + "<script>window.removeEventListener('load', initialize);</script>"
                            + f"<script>{tests}</script></body>")
        fixture = scratch / "test.html"
        fixture.write_text(page, encoding="utf-8", newline="\n")
        command = [str(args.browser), "--headless", "--no-sandbox",
                   "--disable-gpu", "--disable-background-networking", "--disable-breakpad",
                   "--disable-crash-reporter", "--disable-crashpad-for-testing",
                   "--disable-component-update", "--disable-sync", "--no-first-run", "--no-default-browser-check",
                   "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND", "--allow-file-access-from-files",
                   f"--user-data-dir={scratch / 'profile'}", "--window-size=1280,800",
                   "--dump-dom", "--virtual-time-budget=12000", fixture.as_uri()]
        flags = subprocess.IDLE_PRIORITY_CLASS | subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        browser = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8", errors="replace", creationflags=flags)
        try:
            stdout, stderr = browser.communicate(timeout=45)
        except subprocess.TimeoutExpired:
            # Stop only this browser and its children, including if tests hang before output.
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(browser.pid), "/T", "/F"], capture_output=True,
                               creationflags=subprocess.CREATE_NO_WINDOW)
            else:
                browser.kill()
            browser.communicate()
            print("FAIL: headless browser timed out")
            return 1
        match = re.search(r'<pre id="dropdown-test-results">(.*?)</pre>', stdout, re.S)
        if not match:
            print("FAIL: headless tests did not finish", stderr[-3000:], stdout[-1000:])
            return 1
        results = json.loads(html.unescape(match[1]))
        for test in results:
            print(f"{'PASS' if test['ok'] else 'FAIL'} {test['name']}" + (f": {test['error']}" if not test['ok'] else ""))
        passed = sum(test["ok"] for test in results)
        print(f"{passed}/{len(results)} passed (1280x800, offline headless Chromium)")
        return int(passed != len(results) or browser.returncode != 0)
    finally:
        # Absolute path, confined to the directory created above.
        shutil.rmtree(scratch)


if __name__ == "__main__":
    raise SystemExit(main())
