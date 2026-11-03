"""Exercise the real managed-setup coordinator in an isolated Debug launcher.

An explicit --source and new --output opt into importing the owner's local disc.
No game is launched. Launcher properties are restored; the new output is retained.
"""
import argparse
import functools
import http.server
import json
import pathlib
import threading
import time

from launcher_cdp import Launcher


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--package-dir', required=True, type=pathlib.Path)
    parser.add_argument('--source', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    parser.add_argument('--screenshot', type=pathlib.Path)
    parser.add_argument('--cancel', action='store_true')
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError('Integration test requires a new output path')
    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_):
            pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(args.package_dir)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    launcher = Launcher()
    suffixes = ['install', 'is-installed', 'dev-setup-manifest']
    original = {s: launcher.command('get-game-property', {'game': 'muac', 'suffix': s}) for s in suffixes}
    try:
        manifest = f'http://127.0.0.1:{server.server_port}/muac-setup.json'
        launcher.command('set-game-property', {'game': 'muac', 'suffix': 'dev-setup-manifest', 'value': manifest})
        assert not launcher.command('start-muac-setup', {'source': str(args.source), 'output': 'relative'})['success']
        result = launcher.command('start-muac-setup', {'source': str(args.source), 'output': str(args.output)})
        assert result['success'], result
        assert not launcher.command('start-muac-setup', {'source': str(args.source), 'output': str(args.output)})['success']
        launcher.evaluate('MuacSetup.show()')
        if args.screenshot:
            launcher.screenshot(args.screenshot)
        deadline = time.monotonic() + 1800
        previous = None
        cancellation_sent = False
        while time.monotonic() < deadline:
            state = launcher.command('get-muac-setup')
            summary = (state.get('phase'), int(state.get('percent', 0)) // 10, state.get('error'))
            if summary != previous:
                print(json.dumps(state), flush=True)
                previous = summary
            if args.cancel and state.get('active') and state.get('phase') == 'Importing your disc' and not cancellation_sent:
                launcher.command('cancel-muac-setup')
                cancellation_sent = True
            if not state.get('active'):
                break
            time.sleep(1)
        else:
            launcher.command('cancel-muac-setup')
            raise TimeoutError('Setup did not finish')
        if args.cancel:
            assert cancellation_sent and not state.get('success'), state
            assert launcher.command('get-game-property', {'game': 'muac', 'suffix': 'install'}) == original['install']
        else:
            assert state.get('success'), state
            assert launcher.command('get-game-property', {'game': 'muac', 'suffix': 'install'}) == str(args.output)
            ready = launcher.command('get-muac-settings')
            assert ready['runtimeReady'], ready
            for name, expected in {'Mode': 'windowed', 'Watermark': '0', 'CaptureMouse': '0', 'ControllerSupport': '1', 'OnlineService': 'openspy'}.items():
                assert ready['values'][name] == expected, (name, ready)
            print('PASS prepared installation registered and defaults verified', flush=True)
    finally:
        for suffix, value in original.items():
            launcher.command('set-game-property', {'game': 'muac', 'suffix': suffix, 'value': value or ''})
        launcher.evaluate('MuacSetup.hide()')
        server.shutdown()


if __name__ == '__main__':
    main()
