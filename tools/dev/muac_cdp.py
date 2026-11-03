"""MUAC settings integration tests against the isolated Debug launcher (CDP).

Uses synthetic game files and a local build of muac-fix's DLL for its version
resource only. Does not load a real game. Restores the game's Resolution registry
value and launcher properties afterwards. --fix is a built x86 muac-fix DLL.
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import tempfile
import time
import winreg

import native
from launcher_cdp import Launcher, wait_for

KEY = r'Software\Activision\Marvel Ultimate Alliance\Settings\Display'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fix', type=pathlib.Path, required=True)
    args = parser.parse_args()
    launcher = Launcher()
    failures = []
    def check(condition, label):
        print(('PASS ' if condition else 'FAIL ') + label, flush=True)
        if not condition: failures.append(label)
    def get(): return launcher.command('get-muac-settings')
    def put(values): return launcher.command('set-muac-settings', {'values': values})
    original = {suffix: launcher.command('get-game-property', {'game': 'muac', 'suffix': suffix})
                for suffix in ['install', 'is-installed']}
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, KEY) as key:
            old_resolution = winreg.QueryValueEx(key, 'Resolution')
    except FileNotFoundError:
        old_resolution = None
    process = None
    try:
        with tempfile.TemporaryDirectory(prefix='ul-muac-') as tmp:
            game = pathlib.Path(tmp)
            (game / 'Game.exe').write_bytes(b'synthetic')
            check(launcher.command('set-game-path', {'game': 'muac', 'path': str(game)}) is False,
                  'rejects a Game.exe-only folder')
            for name in ['libIGCore.dll', 'libIGGfx.dll', 'data/herostat.engb', 'build.ini']:
                file = game / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b'synthetic fixture')
            check(launcher.command('set-game-path', {'game': 'muac', 'path': str(game)}) is True,
                  'accepts a folder with the installation markers')
            check(get()['installed'] and not get()['runtimeReady'], 'reports missing runtime components')
            check(put({'CaptureMouse': False})['success'] is False, 'refuses writes without the runtime')
            check(not (game / 'muac-fix.ini').exists(), 'failed admission created no configuration')
            shutil.copy2(args.fix, game / 'dinput8.dll')
            (game / 'version.dll').write_bytes(b'synthetic fixture')
            (game / 'D3D9.dll').write_bytes(b'synthetic fixture')
            graphics = game / 'dgVoodoo.conf'
            inputs = game / 'muac-fix.ini'
            graphics.write_text('; retain me\n[General]\nFullScreenMode=true\nCaptureMouse=true\n'
                                '[DirectX]\nAppControlledScreenMode=true\n[Other]\nKeep=yes\n', encoding='ascii')
            inputs.write_text('[Input]\nCaptureMouse=1 ; user comment\n[Other]\nKeep=yes\n', encoding='ascii')
            check(get()['runtimeReady'], 'recognizes the MUA Classic Fix version resource')
            defaults = get()['values']
            check(defaults['Watermark'] == '1' and defaults['FrameLimit'] == '0', 'missing graphics keys use the wrapper defaults')
            check(put({'Mode': 'windowed', 'CaptureMouse': False, 'Watermark': False})['success'], 'writes windowed defaults')
            text = graphics.read_text().lower().replace(' ', '')
            check('fullscreenmode=false' in text and 'appcontrolledscreenmode=false' in text,
                  'both fullscreen overrides are disabled')
            check('capturemouse=false' in text and get()['values']['CaptureMouse'] == '0', 'capture toggle updates both files')
            check('retain me' in graphics.read_text() and 'user comment' in inputs.read_text() and 'Keep=yes' in inputs.read_text(),
                  'preserves comments and unrelated settings')
            before = (graphics.read_bytes(), inputs.read_bytes())
            check(not put({'Mode': 'fullscreen', 'FrameLimit': 'broken'})['success'], 'rejects a partly invalid batch')
            check((graphics.read_bytes(), inputs.read_bytes()) == before, 'invalid batch writes nothing')
            for values in [{'Watermark': []}, {'CaptureMouse': None}, {'Resolution': '../x'},
                           {'Resolution': '1x1'}, {'FrameLimit': 10}, {'Unknown': True}, {'Mode': 'windowed\x00bad'}]:
                check(not put(values)['success'], f'rejects invalid values {values!r}')
            check(put({'Mode': 'borderless', 'FrameLimit': 120, 'VSync': True, 'ControllerSupport': False,
                       'Resolution': '1280x720'})['success'], 'writes display and input settings')
            values = get()['values']
            check(all(values[k] == v for k, v in {'Mode': 'borderless', 'FrameLimit': '120', 'VSync': '1',
                      'ControllerSupport': '0', 'Resolution': '1280x720'}.items()), 'reads back saved values')
            with inputs.open('a') as stream: stream.write('\n[Online]\nDomain=off\nServer=127.0.0.1\n')
            check(get()['values']['OnlineService'] == 'custom', 'custom server takes precedence over Domain=off')
            check(put({'OnlineService': 'off'})['success'] and get()['values']['OnlineService'] == 'off', 'Off clears the server override')
            check(put({'OnlineService': 'openspy'})['success'] and get()['values']['OnlineService'] == 'openspy', 'enables OpenSpy')
            check(put({'Mode': 'fullscreen'})['success'] and get()['values']['Mode'] == 'fullscreen', 'fullscreen round trip')
            check(put({'Mode': 'windowed', 'ControllerSupport': True, 'FrameLimit': 60})['success'], 'returns to windowed defaults')
            launcher.evaluate("document.querySelector('.game-item[data-game=\"muac\"]').click(); true")
            launcher.evaluate('MuacView.reload()')
            check(launcher.evaluate("document.querySelectorAll('#muac-options-panel select').length") == 8, 'all eight controls are rendered')
            launcher.evaluate("(()=>{const s=document.querySelector('#muac-Watermark');s.value='1';s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()")
            check(wait_for(lambda: get()['values']['Watermark'] == '1', 10), 'UI change reaches the native backend')
            # An ordinary test process at the registered Game.exe path exercises the live guard.
            shutil.copy2(native.dummy_game(), game / 'Game.exe')
            process = subprocess.Popen([str(game / 'Game.exe')], creationflags=subprocess.CREATE_NO_WINDOW)
            check(wait_for(lambda: get()['running'], 10), 'detects the registered game process')
            before = (graphics.read_bytes(), inputs.read_bytes())
            check(not put({'Mode': 'fullscreen'})['success'], 'refuses settings changes while running')
            check((graphics.read_bytes(), inputs.read_bytes()) == before, 'running refusal writes nothing')
            process.terminate(); process.wait(timeout=10); process = None
            check(wait_for(lambda: not get()['running'], 10), 'detects exit')
            launcher.evaluate('MuacView.reload()')
            check(launcher.evaluate("Array.from(document.querySelectorAll('#muac-options-panel select')).every(s=>!s.disabled)"),
                  'options become editable after exit')
    finally:
        if process is not None: process.terminate(); process.wait(timeout=10)
        for suffix, value in original.items():
            launcher.command('set-game-property', {'game': 'muac', 'suffix': suffix, 'value': value or ''})
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, KEY) as key:
            if old_resolution is None:
                try: winreg.DeleteValue(key, 'Resolution')
                except FileNotFoundError: pass
            else: winreg.SetValueEx(key, 'Resolution', 0, old_resolution[1], old_resolution[0])
    print(json.dumps({'failures': failures}))
    return bool(failures)


if __name__ == '__main__':
    raise SystemExit(main())
