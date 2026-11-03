"""Headless save-import host checks. Uses installed MSVC/Node; never downloads.

python tools/dev/save_import_host_checks.py --work-folder O:/.../scratch
    [--deps <already populated local deps folder>] [--syntax]
Builds/runs serially at Idle. No launcher/game windows or desktop operations.
"""
from __future__ import annotations
import argparse
import ctypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-folder', required=True, type=Path)
    parser.add_argument('--deps', type=Path, default=ROOT / 'deps')
    parser.add_argument('--syntax', action='store_true')
    parser.add_argument('--skip-host', action='store_true', help='Reuse an already passed host suite; run only transport and optional syntax checks')
    args = parser.parse_args()
    if os.name != 'nt':
        parser.error('The production hidden process transport needs Windows.')
    scratch = args.work_folder.resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, TEMP=str(scratch), TMP=str(scratch), VSCMD_SKIP_SENDTELEMETRY='1')
    ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x40)
    if not shutil.which('cl', path=env.get('PATH')):
        vswhere = Path(env.get('ProgramFiles(x86)', r'C:/Program Files (x86)')) / 'Microsoft Visual Studio/Installer/vswhere.exe'
        env['PATH'] = str(vswhere.parent) + os.pathsep + env.get('PATH', '')
        install = subprocess.check_output([str(vswhere), '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], env=env, text=True, creationflags=0x40).strip()
        if not install:
            parser.error('Use an installed MSVC developer shell.')
        batch = scratch / 'msvc-env.cmd'
        batch.write_text('@echo off\ncall "' + install + '\\Common7\\Tools\\VsDevCmd.bat" -no_logo -arch=x64 -host_arch=x64\nif errorlevel 1 exit /b 1\nset\n', encoding='utf-8')
        output = subprocess.check_output(['cmd', '/d', '/c', str(batch)], env=env, text=True, creationflags=0x40)
        # Keep the environment in memory. Never print credentials or its values.
        env.update(line.split('=', 1) for line in output.splitlines() if '=' in line and not line.startswith('='))
    cxx = shutil.which('cl', path=env.get('PATH'))
    node = shutil.which('node', path=env.get('PATH'))
    rapidjson = args.deps.resolve() / 'rapidjson/include'
    if not cxx or not node or not (rapidjson / 'rapidjson/document.h').is_file():
        parser.error('MSVC, Node and local RapidJSON headers are required. No installation was attempted.')

    def call(command):
        result = subprocess.run([str(item) for item in command], cwd=scratch, env=env, creationflags=0x40)
        if result.returncode:
            raise SystemExit(result.returncode)

    common = [cxx, '/nologo', '/std:c++20', '/EHsc', '/W4', '/utf-8', '/DRAPIDJSON_HAS_STDSTRING', '/external:W0', '/external:I' + str(rapidjson)]
    host_dir = scratch / 'host'; host_dir.mkdir(exist_ok=True)
    premake = (ROOT / 'premake5.lua').read_text(encoding='utf-8').split('project "ultimate-legends-tests"')[1]
    sources = sorted((ROOT / 'src/tests').glob('*.cpp')) + [ROOT / path for path in re.findall(r'"(\./src/launcher/[^\"]+\.cpp)"', premake)]
    host_exe = host_dir / 'ultimate-legends-tests.exe'
    if not args.skip_host:
        call(common + ['/I' + str(ROOT / 'src/tests'), '/I' + str(ROOT / 'src/launcher'), '/Fo' + str(host_dir) + '\\', '/Fe' + str(host_exe), *sources])
        call([host_exe])

    transport_dir = scratch / 'transport'; transport_dir.mkdir(exist_ok=True)
    transport_exe = transport_dir / 'save-import-transport.exe'
    call(common + ['/I' + str(ROOT / 'tools/dev/save_import_headless'), '/I' + str(ROOT / 'src/common'), '/I' + str(ROOT / 'src/launcher/xml1'),
                   '/Fo' + str(transport_dir) + '\\', '/Fe' + str(transport_exe),
                   ROOT / 'src/launcher/xml1/builder_process.cpp', ROOT / 'src/launcher/xml1/save_import_args.cpp',
                   ROOT / 'tools/dev/save_import_headless/transport_support.cpp', ROOT / 'tools/dev/save_import_host_smoke.cpp'])
    call([transport_exe, node, ROOT / 'src/tests/ui/fake_save_import_cli.js'])
    if args.syntax:
        # The native launcher itself is not linked or run. Use the already
        # populated local dependency tree and its generated version header.
        headers = [ROOT / 'src/launcher', ROOT / 'src/common', args.deps.resolve() / 'cef', args.deps.resolve() / 'curl/include',
                   args.deps.resolve() / 'libtomcrypt/src/headers', args.deps.resolve() / 'libtommath', args.deps.resolve() / 'miniz']
        generated = args.deps.resolve().parent / 'build/src'
        # Match libtomcrypt.import() in the production premake project, including
        # its allocator-prototype setting; otherwise MSVC reports C4565 here.
        call(common + ['/Zs', '/WX', '/DLTC_NO_PROTOTYPES', '/DLTC_NO_FAST', '/DLTC_NO_RSA_BLINDING', '/DLTC_NO_FILE', '/DARGTYPE=4',
                       '/I' + str(generated), *['/I' + str(path) for path in headers],
                       ROOT / 'src/launcher/commands/xml1_commands.cpp', ROOT / 'src/launcher/xml1/xml1_port.cpp', ROOT / 'src/launcher/xml1/builder_process.cpp',
                       ROOT / 'src/launcher/models/models_tool.cpp'])
    print('Headless native checks passed; no launcher or game was started.', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
