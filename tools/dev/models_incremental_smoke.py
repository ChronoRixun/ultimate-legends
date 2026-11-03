"""Offline disk/protocol smoke test using fake_legends_models.py; never starts a game or UI.

    python tools/dev/models_incremental_smoke.py --work-folder <absolute scratch folder>

All fixture writes live under that folder. No installed tool, game assets, network, packages or
clipboard access. This tests the stand-in's preservation contract; real-tool release checks are
listed in docs/testing/models-incremental.md.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import shutil
import uuid


def digest_tree(folder):
    return {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in folder.rglob('*') if p.is_file()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-folder', type=Path, required=True)
    args = parser.parse_args()
    work = args.work_folder
    if not work.is_absolute():
        parser.error('--work-folder must be absolute')
    work.mkdir(parents=True, exist_ok=True)
    tool = Path(__file__).resolve().with_name('fake_legends_models.py')
    # Python 3.14's TemporaryDirectory creates mode 0700 on Windows, which can exclude the
    # restricted launcher test token. Use ordinary inherited workspace permissions instead.
    root = (work.resolve() / ('incremental-' + uuid.uuid4().hex)).resolve()
    root.mkdir()
    try:
        port = root / 'port'
        (port / 'Actors').mkdir(parents=True)
        # Placeholders only: no executable, no game content.
        for skin in ('14501', '14301'):
            (port / 'Actors' / f'{skin}.IGB').write_text('not a model', encoding='utf-8')
        mods = port / 'mods'
        (mods / 'Other Mod').mkdir(parents=True)
        (mods / 'Other Mod' / 'settings.txt').write_text('keep me', encoding='utf-8')
        original_order = b'; player comment\r\n+Other Mod\r\n'
        (mods / 'load-order.txt').write_bytes(original_order)
        base = [sys.executable, str(tool), 'build', '--json', '--port', str(port), '--work', str(root / 'cache'), '--mode', 'community']
        env = dict(os.environ, FAKE_LM_DELAY='0', FAKE_LM_DOWNLOAD_DELAY='0', FAKE_LM_FAIL='',
                   FAKE_LM_BUILD_EXIT='', FAKE_LM_LOG=str(root / 'commands.log'))

        def build(*flags):
            answer = subprocess.run(base + list(flags), env=env, capture_output=True, text=True, timeout=20, check=False)
            assert answer.returncode == 0, (answer.returncode, answer.stdout, answer.stderr)
            events = [json.loads(line) for line in answer.stdout.splitlines()]
            return events, events[-1]

        _, first = build('--hero', 'beast')
        assert set(first['characters']) == {'beast'}
        beast = digest_tree(mods / 'Community-Beast')
        other = digest_tree(mods / 'Other Mod')
        events, added = build('--hero', 'wolverine')
        assert set(added['characters']) == {'wolverine'}
        assert {e['hero'] for e in events if e['event'] == 'stage' and e.get('stage') == 'convert'} == {'wolverine'}
        assert digest_tree(mods / 'Community-Beast') == beast
        assert digest_tree(mods / 'Other Mod') == other
        assert (mods / 'load-order.txt').read_bytes().startswith(original_order)
        assert '+Community-Beast' in (mods / 'load-order.txt').read_text()
        print('ok new hero only; installed Beast and unrelated mod hashes unchanged; player load-order bytes kept')

        _, changed = build('--hero', 'wolverine', '--costume', 'wolverine=community:Ultimate XML1')
        assert changed['characters']['wolverine']['source'] == 'Ultimate XML1'
        assert digest_tree(mods / 'Community-Beast') == beast
        print('ok changed costume only; unchanged hero retained')

        before_cancel = digest_tree(mods)
        slow_env = dict(env, FAKE_LM_DELAY='30')
        process = subprocess.Popen(base + ['--hero', 'wolverine'], env=slow_env, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            # The fake converter announces itself before sleeping; cancel while no publication has begun.
            for line in process.stdout:
                event = json.loads(line)
                if event['event'] == 'engine':
                    process.kill()
                    break
            process.communicate(timeout=10)
            assert process.returncode != 0
            assert digest_tree(mods) == before_cancel
            print('ok cancellation during conversion leaves the complete mods tree byte-identical')
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=10)
    finally:
        assert root.is_relative_to(work.resolve()) and root.name.startswith('incremental-')
        shutil.rmtree(str(root))
    print('3 smoke checks passed; scratch fixtures cleaned')


if __name__ == '__main__':
    main()
