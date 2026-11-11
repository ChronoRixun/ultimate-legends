"""Issues #31/#32: synthetic installs against an isolated, offline Debug launcher.

Requires a fresh portable test profile (launcher-auto-shortcuts=false), -noupdate
and -offline. It never executes the synthetic Game.exe or helper, downloads files,
or writes the game's real registry key. --fix supplies a locally built MUA Classic
Fix DLL for its version resource only. Use a private desktop for the launcher.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import time
import uuid
import winreg
import zipfile

# Game.exe's own 14 sizes; without MUA Classic Fix 0.1.2 nothing else starts (#31).
RETAIL_MODES = {'640x480', '720x480', '800x600', '1024x768', '1280x720', '1280x768', '1280x960', '1280x1024',
                '1440x900', '1600x1200', '1680x1050', '1920x1080', '1920x1200', '2048x1536'}

from launcher_cdp import Launcher, wait_for


def run(launcher, profile, work, fix):
    profile, work, fix = profile.resolve(), work.resolve(), fix.resolve()
    assert (profile / 'portable.marker').is_file()
    properties = json.loads((profile / 'user/properties.json').read_text(encoding='utf-8'))
    assert properties.get('issues-31-32-test-profile') == 'true', 'Use an explicitly isolated profile'
    assert launcher.command('get-property', 'launcher-auto-shortcuts') == 'false'
    assert launcher.evaluate('window.IS_OFFLINE === true'), 'Start the test launcher with -offline'
    assert not work.exists(), 'Choose a new synthetic fixture folder'
    tool = profile / 'tools/muac-setup/0.2.1'
    manifest_file = profile / 'tool-manifests/muac-setup/0.2.1.json'
    assert not tool.exists() and not manifest_file.exists(), 'Use a fresh test profile'
    work.mkdir(parents=True)
    registry_token = uuid.uuid4().hex
    registry_key = 'Software\\UltimateLegendsTests\\MUAC\\' + registry_token
    original = {suffix: launcher.command('get-game-property', {'game': 'muac', 'suffix': suffix})
                for suffix in ['install', 'is-installed', 'test-registry-key']}
    cache_key = 'release-cache-stable-ChronoRixun/muac-fix'
    original_cache = launcher.command('get-property', cache_key)
    original_channel = launcher.command('get-property', 'launcher-update-channel')
    def check(ok, label):
        print(('PASS ' if ok else 'FAIL ') + label, flush=True)
        assert ok, label
    def prop(suffix, value):
        launcher.command('set-game-property', {'game': 'muac', 'suffix': suffix, 'value': value})
    def installed():
        return launcher.command('get-game-property', {'game': 'muac', 'suffix': 'is-installed'}) == 'true'
    def select(folder):
        return launcher.command('set-game-path', {'game': 'muac', 'path': str(folder)})
    def get():
        return launcher.command('get-muac-settings')
    def put(values):
        return launcher.command('set-muac-settings', {'values': values})
    def ready():
        return launcher.command('get-muac-setup')
    def finish():
        check(wait_for(lambda: not ready().get('active'), 30), 'runtime operation terminates')
        state = ready()
        check(state.get('success'), 'runtime operation succeeds: ' + json.dumps(state))
        check(installed(), 'existing install registered as complete')
    def fixture(name, mixed=False):
        folder = work / name
        for file in ['Game.exe', 'libIGCore.dll', 'libIGGfx.dll', 'data/herostat.engb', 'build.ini']:
            path = folder / (file.upper() if mixed else file)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'synthetic game marker')
        for name in ['mods/keep.txt', 'saves/keep.txt']:
            path = folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'player fixture retained')
        (folder / 'muac-fix.ini').write_text('; player comment\n[Input]\nControllerSupport=0\nCustom=keep\n', encoding='ascii')
        return folder
    try:
        prop('test-registry-key', registry_token)
        launcher.command('set-property', {'launcher-update-channel': 'stable', cache_key: json.dumps({
            'tag_name': 'v0.2.1', 'prerelease': False,
            'assets': [{'name': 'muac-setup.json', 'browser_download_url': 'https://example.invalid/unused', 'size': 1}]
        })})
        # All package bytes are pre-cached; the invalid helper is never executed.
        bundle = tool / 'runtime'; bundle.mkdir(parents=True)
        (tool / 'muac-setup.exe').write_bytes(b'synthetic helper - must never execute')
        payload = {'dinput8.dll': fix.read_bytes(), 'version.dll': b'synthetic compatibility DLL',
                   'version.json': b'{"logging":false}\n',
                   'muac-fix.ini': b'[Input]\nControllerSupport=1\n[Display]\nRunInBackground=1\n',
                   'dgVoodoo.conf': b'[General]\nFullScreenMode=false\n[DirectX]\nAppControlledScreenMode=false\n'}
        digest = lambda data: hashlib.sha256(data).hexdigest()
        graphics = b'synthetic graphics DLL - never loaded'
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as zip:
            zip.writestr('MS/x86/D3D9.dll', graphics)
        archive = archive.getvalue()
        files = []
        for target, data in payload.items():
            (bundle / target).write_bytes(data)
            files.append({'source': target, 'target': target, 'size': len(data), 'sha256': digest(data)})
        (bundle / 'package.json').write_text(json.dumps({'schema': 1, 'version': '0.2.1', 'files': files,
            'dgvoodoo': {'url': 'https://github.com/dege-diosg/dgVoodoo2/releases/download/fixture/unused.zip',
                        'member': 'MS/x86/D3D9.dll', 'size': len(archive), 'sha256': digest(archive),
                        'dll_size': len(graphics), 'dll_sha256': digest(graphics)}}), encoding='utf-8')
        cache = tool.parent / 'downloads'; cache.mkdir(exist_ok=True)
        graphics_cache = cache / (digest(archive) + '.zip'); graphics_cache.write_bytes(archive)
        manifest_file.parent.mkdir(parents=True, exist_ok=True)
        manifest_file.write_text(json.dumps({'version': '0.2.1', 'api': 1, 'min_launcher': '0.0.0',
            'zip': 'synthetic-unused.zip', 'size': 1, 'sha256': '0' * 64}), encoding='utf-8')

        game = fixture('existing MUA 2006')
        wrong = work / '2016'; wrong.mkdir(); (wrong / 'Marvel.exe').write_bytes(b'synthetic 2016 marker')
        check(not select(wrong), '2016 Marvel.exe refused as MUA 2006')
        check(not select(work) and not select(game / 'data'), 'parent and data folders refused')
        check(select(game), 'existing 2006 game root accepted without importer stamp')
        check(not installed() and not get()['runtimeReady'], 'missing runtime remains partial')
        info = launcher.command('get-game-install-info', {'game': 'muac'})
        check(info['valid'] and info['hasPatch'] and 'version.dll' in info['missingRuntime'], 'missing components explicitly reported')
        before = {str(p.relative_to(game)): p.read_bytes() for p in game.rglob('*') if p.is_file()}

        # Only bypass the UI online prompt; the native launcher remains -offline.
        launcher.evaluate('window.__issuesGuard = window.guardOnline; window.guardOnline = async () => true; true')
        launcher.evaluate("showManageInstall('muac', {finishSetup:true}); true")
        check(wait_for(lambda: launcher.evaluate("document.querySelector('.install-popup')?.parentElement.style.display === 'flex'"), 10), 'Finish Setup popup ready')
        check(wait_for(lambda: 'version.dll' in launcher.evaluate("document.querySelector('#install-popup-missing').textContent"), 10), 'Finish Setup shows missing runtime')
        launcher.evaluate("document.querySelector('.install-popup .btn-apply').click(); true")
        check(wait_for(lambda: ready().get('active') or ready().get('success') or ready().get('error'), 10), 'Finish Setup reaches runtime coordinator')
        finish()
        for name, data in before.items():
            actual = (game / name).read_bytes()
            check(data in actual if name == 'muac-fix.ini' else data == actual, 'keeps player file ' + name)
        check(not (game / '_muac/setup.json').exists(), 'no disc-import stamp required or fabricated')
        check(get()['runtimeReady'], 'installed runtime passes production readiness check')

        # A same-version repair must perform work and re-register a partial install.
        os.remove(str(game / 'version.dll')); prop('is-installed', 'false')
        answer = launcher.command('verify-game', {'game': 'muac'})
        check(answer.get('accepted') and answer.get('statusCommand') == 'get-muac-setup', 'Verify Files hands off to runtime repair')
        finish()
        check((game / 'version.dll').read_bytes() == payload['version.dll'], 'same-version repair restores missing component')

        prepared = fixture('nested/Prépâréd MUA', mixed=True)
        for name in ['dinput8.dll', 'version.dll', 'version.json', 'dgVoodoo.conf']:
            shutil.copy2(game / name, prepared / name)
        shutil.copy2(game / 'D3D9.dll', prepared / 'D3D9.dll')
        check(select(prepared) and installed(), 'mixed-case Unicode prepared game root is immediately ready')
        check(not select(prepared.parent), 'nested parent is not silently searched')
        # Exercise the working-install chooser without opening a native picker.
        launcher.evaluate('window.__issuesExecute = window.executeCommand; window.executeCommand = (name, data) => name === "browse-folder" ? Promise.resolve(' + json.dumps(str(prepared)) + ') : window.__issuesExecute(name, data); true')
        launcher.evaluate('(async()=>{ const popup = new SetupFlowPopup(); popup.show("muac", "MUA 2006"); await popup.handleExistingInstallation(); return true; })()')
        launcher.evaluate('window.executeCommand = window.__issuesExecute; true')
        check(installed(), 'working-install chooser keeps prepared installation ready')
        check(select(game), 'switch back to primary synthetic fixture')

        # Resolution writes are isolated under a Debug-only test registry key.
        check(put({'Resolution': '1280x720'})['success'], 'safe resolution writes isolated registry')
        snapshots = [(game / f).read_bytes() for f in ['muac-fix.ini', 'dgVoodoo.conf']]
        for mode in ['windowed', 'borderless', 'fullscreen']:
            result = put({'Mode': mode, 'Resolution': '3840x2160'})
            check(not result['success'] and '0.1.2' in result['error'], '4K refused clearly without the 0.1.2 guard in ' + mode)
        check(snapshots == [(game / f).read_bytes() for f in ['muac-fix.ini', 'dgVoodoo.conf']], 'refused batch changes no INI bytes')
        check(get()['values']['Resolution'] == '1280x720', 'refused 4K changes no registry value')
        check(not get()['resolutionGuard'] and all(v in RETAIL_MODES for v in get()['modes'] if v != '800x600'), "only the game's own sizes offered without the guard")
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, registry_key) as key:
            winreg.SetValueEx(key, 'Resolution', 0, winreg.REG_SZ, '3840x2160')
        check(not get()['resolutionSupported'] and get()['values']['Resolution'] == '3840x2160', 'old 4K value retained and flagged')
        launcher.evaluate('MuacSetup.hide(); document.querySelector(\'.game-item[data-game="muac"]\').click(); MuacView.reload(); true')
        check(wait_for(lambda: launcher.evaluate("!!document.querySelector('#muac-Resolution option[value=\"3840x2160\"][disabled]')"), 10), 'UI disables old 4K selection and offers recovery')
        result = launcher.command('launch-game', {'game': 'muac'})
        check(result.get('accepted') is False and result.get('reason') == 'muac_resolution', 'launch refused before synthetic Game.exe can execute')
        check(put({'Resolution': '1920x1080'})['success'] and get()['resolutionSupported'], 'an original size restores supported resolution state')
        print('PASS all issue #31/#32 CDP regressions; no game/helper execution or downloads', flush=True)
    finally:
        launcher.evaluate('window.executeCommand = window.__issuesExecute || window.executeCommand; window.guardOnline = window.__issuesGuard || window.guardOnline; window.MuacSetup?.hide(); true')
        for suffix, value in original.items(): prop(suffix, value or '')
        launcher.command('set-property', {cache_key: original_cache or '', 'launcher-update-channel': original_channel or ''})
        try: winreg.DeleteKey(winreg.HKEY_CURRENT_USER, registry_key)
        except FileNotFoundError: pass
        # Only our newly created synthetic fixtures/caches; keep logs outside them.
        for folder in [work, tool]:
            if folder.exists(): shutil.rmtree(str(folder))
        for file in [manifest_file, locals().get('graphics_cache')]:
            if file is not None and file.exists(): os.remove(str(file))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=12345)
    parser.add_argument('--profile', required=True, type=Path)
    parser.add_argument('--work-dir', required=True, type=Path)
    parser.add_argument('--fix', required=True, type=Path)
    args = parser.parse_args()
    launcher = Launcher(args.port)
    try:
        run(launcher, args.profile, args.work_dir, args.fix)
    finally:
        launcher.ws.close()
