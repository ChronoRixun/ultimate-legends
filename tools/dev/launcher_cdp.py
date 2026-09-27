"""Drive a running Debug build of Ultimate Legends over the Chrome DevTools protocol.

Debug builds expose CEF's remote debugging on port 12345. This calls launcher commands
exactly as the UI does (window.executeCommand) and runs an end-to-end check of patch
installation for existing-install-only games.

    tools\\run-test-debug.bat              # start a Debug launcher
    python tools\\dev\\launcher_cdp.py      # run the checks (needs: pip install websocket-client)

The check uses a throwaway folder with a dummy Marvel.exe, never a real game install.
"""
import hashlib
import itertools
import json
import pathlib
import sys
import tempfile
import time
import urllib.request

import websocket

DEBUG_PORT = 12345
PATCH_MANIFEST = "https://github.com/ChronoRixun/mua-controller-fix/releases/latest/download/ultimate-legends.json"


class Launcher:
    def __init__(self, port=DEBUG_PORT):
        targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
        page = next(t for t in targets if t.get("type") == "page" and "ultimate-legends" in t.get("url", ""))
        # Chromium rejects DevTools websockets that send an Origin header unless it's allow-listed.
        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
        self.ids = itertools.count(1)

    def evaluate(self, expression):
        message_id = next(self.ids)
        self.ws.send(json.dumps({"id": message_id, "method": "Runtime.evaluate",
                                 "params": {"expression": expression, "awaitPromise": True, "returnByValue": True}}))
        while True:
            reply = json.loads(self.ws.recv())
            if reply.get("id") == message_id:
                result = reply["result"]
                if "exceptionDetails" in result:
                    raise RuntimeError(result["exceptionDetails"])
                return result["result"].get("value")

    def command(self, name, payload=None):
        return self.evaluate(f"window.executeCommand({json.dumps(name)}, {json.dumps(payload)})")

    def call(self, method, params=None):
        message_id = next(self.ids)
        self.ws.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
        while True:
            reply = json.loads(self.ws.recv())
            if reply.get("id") == message_id:
                return reply.get("result", {})

    def screenshot(self, path):
        """Saves a PNG of the launcher window's contents (not the desktop)."""
        import base64
        data = self.call("Page.captureScreenshot", {"format": "png"})["data"]
        pathlib.Path(path).write_bytes(base64.b64decode(data))


def wait_for(predicate, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.5)
    return False


def main():
    launcher = Launcher()
    failures = 0

    def check(ok, label):
        nonlocal failures
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}")
        failures += not ok

    def idle():
        progress = launcher.command("get-update-progress")
        return bool(progress) and not progress.get("active")

    manifest = json.load(urllib.request.urlopen(PATCH_MANIFEST))
    name, size, sha1, dest = manifest[0]
    print(f"published patch: {name} ({size} bytes, SHA-1 {sha1}, dest {dest})")

    with tempfile.TemporaryDirectory(prefix="ul-fake-mua-") as folder:
        folder = pathlib.Path(folder)
        game_exe = folder / "Marvel.exe"
        game_exe.write_bytes(b"placeholder - not a real game")
        patch = folder / name

        print("setup")
        check(launcher.command("find-game-install", {"game": "xml2"}) is None, "XML2 has no Steam app, so no detection")
        check(launcher.command("set-game-path", {"game": "mua", "path": str(folder)}) is True,
              "set-game-path accepts a folder containing Marvel.exe")
        check(launcher.command("set-game-path", {"game": "mua", "path": str(folder.parent)}) is False,
              "set-game-path rejects a folder without Marvel.exe")
        launcher.command("set-game-path", {"game": "mua", "path": str(folder)})

        print("finish setup installs the patch")
        launcher.command("verify-game", {"game": "mua"})
        check(wait_for(lambda: patch.exists() and patch.stat().st_size == size), f"{name} downloaded into the game folder")
        if patch.exists():
            check(hashlib.sha1(patch.read_bytes()).hexdigest().upper() == sha1, f"{name} matches the published SHA-1")
        check(game_exe.exists(), "the game's own files are untouched")
        # The worker marks the game installed after the file lands; let it finish before uninstalling,
        # or its late set_installed(true) would outlive the uninstall's reset.
        check(wait_for(idle), "patch install finished")
        check(launcher.command("get-game-property", {"game": "mua", "suffix": "is-installed"}) == "true",
              "MUA is marked installed")

        print("uninstall removes only the patch")
        launcher.command("delete-game", {"game": "mua"})
        check(wait_for(lambda: not patch.exists()), f"{name} removed")
        check(wait_for(idle), "uninstall finished")
        check(game_exe.exists() and game_exe.read_bytes() == b"placeholder - not a real game", "Marvel.exe still there, unchanged")
        check(not launcher.command("get-game-property", {"game": "mua", "suffix": "install"}),
              "MUA's install path is forgotten")
        check(launcher.command("get-game-property", {"game": "mua", "suffix": "is-installed"}) != "true",
              "MUA is no longer marked installed")

    print(f"\n{'PASSED' if not failures else 'FAILED'} ({failures} failure{'s' if failures != 1 else ''})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
