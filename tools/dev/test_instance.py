"""A Release (or Debug) launcher as an isolated TEST INSTANCE, for agent and CDP checks on a PC where the player's
own launcher may be running (common/utils/test_instance.hpp):

    python tools\\dev\\test_instance.py prepare <folder>            # portable copy of build\\bin\\x64\\Release
    python tools\\dev\\test_instance.py start <folder> [--name N] [--port 12399] [--props props.json]
    python tools\\dev\\test_instance.py stop <folder>

`-portable -test-instance <name>`: its own data folder (<folder>\\ultimate-legends), its own single-instance lock and
deep-link pipe (never hands its start to the player's launcher, never takes the player's ultimatelegends:// links),
no ultimatelegends:// registration, no shortcuts and no other HKCU writes, a window that is shown without ever being
activated, and the Debug-only dev properties (xml1-builder-manifest, <game>-patch-manifest / -patch-release,
dev-release-api, xml1-models-manifest, builder-exe, ...) honoured, so the CDP suites' local fixture servers work
with a Release build. Seed those properties BEFORE start (--props, merged into user\\properties.json): without
dev-release-api the launcher asks api.github.com as usual. --force-device-scale-factor=1 makes the window's pixels
the page's CSS pixels on a scaled display. Drive it with launcher_cdp.Launcher(port).
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]


def prepare(folder, config):
    folder = pathlib.Path(folder)
    if folder.exists():
        sys.exit(f"{folder} exists: prepare makes a fresh copy")
    root = folder / "ultimate-legends"
    (root / "user").mkdir(parents=True)
    shutil.copyfile(REPO / "build" / "bin" / "x64" / config / "ultimate-legends.exe", folder / "ultimate-legends.exe")
    (root / "portable.marker").write_bytes(b"")
    shutil.copytree(REPO / "build" / "runtime" / "x64" / config / "cef", root / "data" / "cef" / config.lower())
    shutil.copytree(REPO / "src" / "launcher-ui", root / "data" / "launcher-ui")
    write_props(folder, {"launcher-auto-shortcuts": "false"})
    print(f"prepared {folder}")


def write_props(folder, props):
    path = pathlib.Path(folder) / "ultimate-legends" / "user" / "properties.json"
    current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    current.update(props)
    path.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8", newline="\n")


def start(folder, name, port, props):
    folder = pathlib.Path(folder)
    if props:
        write_props(folder, json.loads(pathlib.Path(props).read_text(encoding="utf-8")))
    info = subprocess.STARTUPINFO()
    info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    info.wShowWindow = 4  # SW_SHOWNOACTIVATE
    process = subprocess.Popen([str(folder / "ultimate-legends.exe"), "-portable", "-test-instance", name,
                                f"--remote-debugging-port={port}", "--force-device-scale-factor=1"],
                               cwd=str(folder), startupinfo=info, creationflags=0x00000200 | 0x00000040,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (folder / "test-instance.pid").write_text(str(process.pid))
    print(f"started pid {process.pid}, CDP on 127.0.0.1:{port}")


def stop(folder):
    pid_file = pathlib.Path(folder) / "test-instance.pid"
    if pid_file.exists():
        subprocess.run(["taskkill", "/T", "/F", "/PID", pid_file.read_text().strip()], capture_output=True)
        pid_file.unlink()
        print("stopped")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["prepare", "start", "stop"])
    parser.add_argument("folder")
    parser.add_argument("--config", default="Release", choices=["Release", "Debug"])
    parser.add_argument("--name", default="agent")
    parser.add_argument("--port", type=int, default=12399)
    parser.add_argument("--props", help="a JSON object merged into user\\properties.json before start")
    args = parser.parse_args()
    if args.action == "prepare":
        prepare(args.folder, args.config)
    elif args.action == "start":
        start(args.folder, args.name, args.port, args.props)
    else:
        stop(args.folder)


if __name__ == "__main__":
    main()
