"""A stand-in for GitHub's releases API and release downloads, for checking the update channel by hand
with a Debug launcher (it never touches the real GitHub). Not run by CI and not driven by any script here:
the owner starts it, points the launcher at it, and walks the checks of docs/release/0.4.0-checklist.md
section I.

    python tools/dev/fake_github.py --releases releases.json [--port 8765]
    python tools/dev/fake_github.py --self-test

releases.json: {"<owner>/<repo>": [{"tag_name": "v1.8.0-beta.1", "prerelease": true, "draft": false,
                 "files": {"ultimate-legends.json": "path/on/disk", ...}}, ...], ...}

Serves
    GET /repos/<owner>/<repo>/releases/latest      the highest non-draft, non-pre-release (Stable)
    GET /repos/<owner>/<repo>/releases?per_page=30 every release, newest first (Beta)
    GET /download/<owner>/<repo>/<tag>/<file>      a release's file (each asset's browser_download_url)
    GET /__mode?status=403|429|500|200             from now on every API call answers that status (200: normal);
    GET /__mode?offline=1                          every API call drops the connection (offline, a timeout)
    GET /__mode?throttle=<bytes per second>        release downloads are sent that slowly from now on (0: at once)
    GET /__latest?repo=<owner>/<repo>&tag=<tag>    make <tag> the latest release (to move "latest" after a choice)

With a Debug launcher (launcher properties, Settings > Advanced or the properties file):
    dev-release-api = http://127.0.0.1:8765        discovery of all three repositories (release_source)
Asset URLs point back here, and a Debug launcher downloads a 127.0.0.1 asset by that URL.
"""
import argparse
import hashlib
import http.server
import json
import pathlib
import re
import sys
import threading
import time
import urllib.parse
import urllib.request

STATE = {"releases": {}, "status": 200, "offline": False, "latest": {}, "throttle": 0}
LOCK = threading.Lock()


def _version_key(tag):
    """SemVer precedence for v<x.y.z>[-<pre>] (numbers numerically; a release above its pre-releases)."""
    match = re.match(r"^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?", tag)
    core = tuple(int(part) for part in match.group(1).split(".")) if match else (0,)
    pre = match.group(2) if match else None
    if pre is None:
        return core, (1,)
    parts = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split("."))
    return core, (0,) + parts


def _asset(base, repo, release, name, path):
    data = pathlib.Path(path).read_bytes()
    return {"name": name, "size": len(data), "browser_download_url": f"{base}/download/{repo}/{release['tag_name']}/{name}",
            "sha1": hashlib.sha1(data).hexdigest()}


def _api_release(base, repo, release):
    return {"tag_name": release["tag_name"], "draft": bool(release.get("draft")), "prerelease": bool(release.get("prerelease")),
            "html_url": f"https://github.com/{repo}/releases/tag/{release['tag_name']}",
            "assets": [_asset(base, repo, release, name, path) for name, path in release.get("files", {}).items()]}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("fake_github: " + fmt % args + "\n")

    def _send(self, status, body=b"", content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        base = f"http://{self.headers.get('Host')}"
        with LOCK:
            if url.path == "/__mode":
                if "throttle" in query:
                    STATE["throttle"] = int(query["throttle"][0])
                    return self._send(200, b"ok", "text/plain")
                STATE["status"] = int(query.get("status", ["200"])[0])
                STATE["offline"] = query.get("offline", ["0"])[0] == "1"
                return self._send(200, b"ok", "text/plain")
            if url.path == "/__latest":
                STATE["latest"][query["repo"][0]] = query["tag"][0]
                return self._send(200, b"ok", "text/plain")

            download = re.match(r"^/download/([^/]+/[^/]+)/([^/]+)/(.+)$", url.path)
            data = None
            if download:
                repo, tag, name = download.groups()
                for release in STATE["releases"].get(repo, []):
                    if release["tag_name"] == tag and name in release.get("files", {}):
                        data = pathlib.Path(release["files"][name]).read_bytes()
                        throttle = STATE["throttle"]
                        break
                else:
                    return self._send(404, b"Not Found", "text/plain")
        if data is not None:
            if not throttle:
                return self._send(200, data, "application/octet-stream")
            # slowly, outside the lock (the API keeps answering meanwhile); a client that hangs up ends it
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            step = max(1, throttle // 10)
            try:
                for at in range(0, len(data), step):
                    self.wfile.write(data[at:at + step])
                    self.wfile.flush()
                    time.sleep(0.1)
            except OSError:
                pass
            return None
        with LOCK:
            api = re.match(r"^/repos/([^/]+/[^/]+)/releases(/latest)?$", url.path)
            if not api:
                return self._send(404, b'{"message":"Not Found"}')
            if STATE["offline"]:
                self.close_connection = True
                self.connection.close()
                return None
            if STATE["status"] != 200:
                return self._send(STATE["status"], b'{"message":"API rate limit exceeded"}')
            repo, latest = api.group(1), bool(api.group(2))
            releases = sorted(STATE["releases"].get(repo, []), key=lambda r: _version_key(r["tag_name"]), reverse=True)
            if latest:
                pinned = STATE["latest"].get(repo)
                stable = [r for r in releases if not r.get("draft") and not r.get("prerelease")]
                chosen = next((r for r in stable if r["tag_name"] == pinned), stable[0] if stable else None)
                if not chosen:
                    return self._send(404, b'{"message":"Not Found"}')
                return self._send(200, json.dumps(_api_release(base, repo, chosen)).encode())
            return self._send(200, json.dumps([_api_release(base, repo, r) for r in releases[:30]]).encode())


def serve(releases, port):
    STATE["releases"] = releases
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    return server


def self_test():
    import tempfile
    with tempfile.TemporaryDirectory() as folder:
        manifest = pathlib.Path(folder) / "ultimate-legends.json"
        manifest.write_text('[["dinput.dll",3,"0123456789ABCDEF0123456789ABCDEF01234567","game"]]')
        releases = {"ChronoRixun/xml2-fix": [
            {"tag_name": "v1.7.1", "files": {"ultimate-legends.json": str(manifest)}},
            {"tag_name": "v1.8.0-beta.2", "prerelease": True, "files": {"ultimate-legends.json": str(manifest)}},
            {"tag_name": "v1.8.0-beta.10", "prerelease": True, "files": {"ultimate-legends.json": str(manifest)}},
            {"tag_name": "v1.9.0", "draft": True},
        ]}
        server = serve(releases, 0)
        port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{port}"

        def get(path):
            try:
                with urllib.request.urlopen(base + path, timeout=5) as answer:
                    return answer.status, answer.read()
            except urllib.error.HTTPError as error:
                return error.code, error.read()

        failures = []
        status, body = get("/repos/ChronoRixun/xml2-fix/releases/latest")
        if status != 200 or json.loads(body)["tag_name"] != "v1.7.1":
            failures.append("latest is the highest stable release")
        status, body = get("/repos/ChronoRixun/xml2-fix/releases?per_page=30")
        tags = [r["tag_name"] for r in json.loads(body)]
        if tags[:3] != ["v1.9.0", "v1.8.0-beta.10", "v1.8.0-beta.2"]:
            failures.append(f"the list is newest first by SemVer: {tags}")
        url = json.loads(body)[1]["assets"][0]["browser_download_url"]
        if get(urllib.parse.urlparse(url).path)[1] != manifest.read_bytes():
            failures.append("an asset downloads by its tag")
        get("/__mode?status=403")
        if get("/repos/ChronoRixun/xml2-fix/releases/latest")[0] != 403:
            failures.append("rate-limit mode answers 403")
        get("/__mode?status=200")
        server.shutdown()
        for failure in failures:
            print("  FAIL ", failure)
        print(f"fake_github self-test: {'ok' if not failures else f'{len(failures)} failed'}")
        return 1 if failures else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--releases", help="the releases JSON (see the docstring)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if not args.releases:
        parser.error("--releases is needed")
    server = serve(json.loads(pathlib.Path(args.releases).read_text(encoding="utf-8")), args.port)
    print(f"fake GitHub on http://127.0.0.1:{args.port} (set the Debug launcher's dev-release-api to it)")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
