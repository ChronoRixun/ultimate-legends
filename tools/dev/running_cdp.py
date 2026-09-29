"""The running check and Stop act on a game's own exe, by full path (BUILDER_DESIGN F5).

X-Men Legends II and the X-Men Legends port both run an XMen2.exe, from different folders. This
starts two copies of a dummy XMen2.exe (tools/dev/native/dummy_game.c: no window, it only waits)
from two throwaway folders and checks, against a running Debug build (see launcher_cdp.py), that
each library entry sees and stops only the copy in its own folder. Never touches a real install
and never starts a game.

    tools\\run-test-debug.bat
    python tools\\dev\\running_cdp.py
"""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

import native
from launcher_cdp import Launcher, wait_for


def short_path(path):
    """The 8.3 form of `path` (the same text when the volume has no 8.3 names)."""
    import ctypes
    buffer = ctypes.create_unicode_buffer(1024)
    length = ctypes.windll.kernel32.GetShortPathNameW(str(path), buffer, len(buffer))
    return buffer.value if 0 < length < len(buffer) else str(path)


def main():
    launcher = Launcher()
    failures = 0

    def check(ok, label):
        nonlocal failures
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}")
        failures += not ok

    def running(game):
        return launcher.command("is-game-running", {"game": game}) is True

    dummy = native.dummy_game()
    has_xml1 = launcher.command("get-game-install-info", {"game": "xml1"}) is not None
    saved = {game: launcher.command("get-game-property", {"game": game, "suffix": "install"}) for game in ("xml2", "xml1")}
    processes = []

    def start(exe):
        process = subprocess.Popen([str(exe)])
        processes.append(process)
        time.sleep(0.3)
        return process

    with tempfile.TemporaryDirectory(prefix="ul-run-a-") as first, tempfile.TemporaryDirectory(prefix="ul-run-b-") as second:
        a = pathlib.Path(first)
        b = pathlib.Path(second)
        exe_a = a / "XMen2.exe"
        exe_b = b / "XMen2.exe"
        shutil.copy2(dummy, exe_a)
        shutil.copy2(dummy, exe_b)
        try:
            check(launcher.command("set-game-path", {"game": "xml2", "path": str(a)}) is True, "XML2 pointed at folder A")

            print("an XMen2.exe from another folder is not XML2")
            other = start(exe_b)
            check(not running("xml2"), "XML2 not running while only B's XMen2.exe runs")
            check(launcher.command("stop-game", {"game": "xml2"}) is False, "Stop for XML2 finds nothing to stop")
            check(other.poll() is None, "B's XMen2.exe untouched")

            print("XML2's own XMen2.exe")
            own = start(exe_a)
            check(wait_for(lambda: running("xml2"), 5), "XML2 running once A's XMen2.exe runs")
            check(launcher.command("stop-game", {"game": "xml2"}) is True, "Stop for XML2")
            check(wait_for(lambda: own.poll() is not None, 5), "A's XMen2.exe stopped")
            check(other.poll() is None, "B's XMen2.exe still running")
            check(wait_for(lambda: not running("xml2"), 5), "XML2 no longer running")

            print("the same folder written differently")
            for label, variant in (("upper case", str(a).upper()), ("8.3 short name", short_path(a)), ("with ..", str(a / "sub" / ".."))):
                launcher.command("set-game-property", {"game": "xml2", "suffix": "install", "value": variant})
                own = start(exe_a)
                check(wait_for(lambda: running("xml2"), 5), f"XML2 running, folder stored as {label}")
                check(launcher.command("stop-game", {"game": "xml2"}) is True and wait_for(lambda: own.poll() is not None, 5)
                      and other.poll() is None, f"Stop stops only A's ({label})")
            launcher.command("set-game-path", {"game": "xml2", "path": str(a)})

            if has_xml1:
                print("XML2 and the X-Men Legends port side by side")
                (b / "_build").mkdir()
                (b / "_build" / "stamp.json").write_text(json.dumps({"format": 1}), encoding="utf-8")
                check(launcher.command("set-game-path", {"game": "xml1", "path": str(b)}) is True, "X-Men Legends pointed at folder B")
                check(running("xml1") and not running("xml2"), "only X-Men Legends running (B)")
                own = start(exe_a)
                check(wait_for(lambda: running("xml2"), 5) and running("xml1"), "both running")
                check(launcher.command("stop-game", {"game": "xml1"}) is True, "Stop for X-Men Legends")
                check(wait_for(lambda: other.poll() is not None, 5), "B's XMen2.exe stopped")
                check(own.poll() is None, "XML2's XMen2.exe still running")
                check(wait_for(lambda: not running("xml1"), 5) and running("xml2"), "X-Men Legends stopped, XML2 still running")
                check(launcher.command("stop-game", {"game": "xml2"}) is True and wait_for(lambda: own.poll() is not None, 5),
                      "Stop for XML2 stops A's")
            else:
                print("(this build has no X-Men Legends entry: side-by-side checks skipped)")
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            for game, value in saved.items():
                if game == "xml1" and not has_xml1:
                    continue
                launcher.command("set-game-property", {"game": game, "suffix": "install", "value": value or ""})

    print(f"\n{'PASSED' if not failures else 'FAILED'} ({failures} failure{'s' if failures != 1 else ''})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
