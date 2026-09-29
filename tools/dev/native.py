"""Small native test fixtures for the launcher's CDP tests, compiled on demand with MSVC.

    dummy_game()        an XMen2.exe stand-in that opens no window and just waits (up to 10 min)
    fix_dll(version)    a dinput.dll stand-in (never loaded) with a VERSIONINFO of `version`
    builder_shim()      xml1-builder.exe for the fake builder (tools/dev/fake_xml1_builder.py)

Sources are in tools/dev/native/; outputs go to build/dev-tools/ (gitignored) and are rebuilt when
their source changes. Needs the Visual Studio C++ tools (found with vswhere), as the launcher's own
build does.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
SOURCES = HERE / "native"
OUT = HERE.parents[1] / "build" / "dev-tools"
VSWHERE = pathlib.Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Microsoft Visual Studio" / "Installer" / "vswhere.exe"

_env = None


def msvc_env():
    """The environment of an x64 Developer Command Prompt (vcvars64.bat), cached per process."""
    global _env
    if _env is None:
        install = subprocess.run([str(VSWHERE), "-latest", "-products", "*", "-requires",
                                  "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
                                 capture_output=True, text=True, check=True).stdout.strip().splitlines()
        if not install:
            raise RuntimeError("Visual Studio C++ tools not found (vswhere)")
        vcvars = pathlib.Path(install[0]) / "VC" / "Auxiliary" / "Build" / "vcvars64.bat"
        output = subprocess.run(f'cmd /s /c ""{vcvars}" >nul && set"', capture_output=True, text=True, shell=True, check=True).stdout
        _env = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    return _env


def _tool(name):
    """The full path of an MSVC tool: CreateProcess searches the caller's PATH, not the child's."""
    path = next((value for key, value in msvc_env().items() if key.upper() == "PATH"), "")
    found = shutil.which(name, path=path)
    if not found:
        raise RuntimeError(f"{name} not found in the Visual Studio environment")
    return found


def _build(name, sources, *, dll=False, windows=False, rc_text=None, extra_key=""):
    """Compiles `sources` (files in tools/dev/native) into build/dev-tools/<name> unless it is current."""
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / name
    digest = hashlib.sha1()
    for source in sources:
        digest.update((SOURCES / source).read_bytes())
    digest.update((rc_text or "").encode() + extra_key.encode() + repr((dll, windows)).encode())
    stamp = target.with_suffix(target.suffix + ".sha1")
    if target.exists() and stamp.exists() and stamp.read_text() == digest.hexdigest():
        return target

    with tempfile.TemporaryDirectory(prefix="ul-native-") as work:
        work = pathlib.Path(work)
        inputs = [str(SOURCES / source) for source in sources]
        if rc_text:
            (work / "version.rc").write_text(rc_text, encoding="utf-8")
            subprocess.run([_tool("rc"), "/nologo", "/fo", str(work / "version.res"), str(work / "version.rc")],
                           cwd=work, env=msvc_env(), check=True, capture_output=True)
            inputs.append(str(work / "version.res"))
        command = [_tool("cl"), "/nologo", "/O1", "/W4", "/MT", *inputs, f"/Fe:{work / name}"]
        if dll:
            command.insert(1, "/LD")
        command += ["/link", "/SUBSYSTEM:WINDOWS" if windows else "/SUBSYSTEM:CONSOLE"]
        if windows and not dll:
            command.append("/ENTRY:wWinMainCRTStartup")
        result = subprocess.run(command, cwd=work, env=msvc_env(), capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"cl failed for {name}:\n{result.stdout}\n{result.stderr}")
        shutil.copy2(work / name, target)
    stamp.write_text(digest.hexdigest())
    return target


def dummy_game():
    return _build("dummy_game.exe", ["dummy_game.c"], windows=True)


def fix_dll(version="1.2.0"):
    """A dinput.dll stand-in whose file version is `version` (e.g. "1.2.0")."""
    parts = [int(p) for p in version.split(".")] + [0, 0, 0, 0]
    numbers = ",".join(str(p) for p in parts[:4])
    dotted = ".".join(str(p) for p in parts[:4])
    rc = f"""#include <winver.h>
VS_VERSION_INFO VERSIONINFO
FILEVERSION {numbers}
PRODUCTVERSION {numbers}
FILEOS VOS__WINDOWS32
FILETYPE VFT_DLL
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "FileDescription", "Test stand-in for the XML2 Fix"
      VALUE "FileVersion", "{dotted}"
      VALUE "ProductName", "Ultimate Legends test fixture"
      VALUE "ProductVersion", "{dotted}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"""
    built = _build(f"dummy_fix-{version}.dll", ["dummy_fix.c"], dll=True, windows=True, rc_text=rc, extra_key=version)
    return built


def builder_shim():
    return _build("xml1-builder.exe", ["builder_shim.c"])


if __name__ == "__main__":
    for path in (dummy_game(), fix_dll("1.2.0"), builder_shim()):
        print(path)
    print(json.dumps({"ok": True}))
