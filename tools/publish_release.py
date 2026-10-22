#!/usr/bin/env python3
"""publish_release.py - publish a launcher release tag's files with gh, then check what GitHub really shows.

  python tools/publish_release.py --repo ChronoRixun/ultimate-legends --tag v0.5.0-beta.1 \\
      --notes-file build/release-notes.md dist/ultimate-legends-0.5.0-beta.1-win64-portable.zip dist/SHA256SUMS.txt
  python tools/publish_release.py --self-test

The Build workflow's Publish step (after tools/release_tag.py wrote the notes):

  1. The files given must include the tag's zip (ultimate-legends-<version>-win64-portable.zip) and SHA256SUMS.txt.
  2. releases/latest is read first (the release Stable launchers install).
  3. A release for the tag already (a re-run of the job): its files are uploaded again with --clobber - never
     deleted and created again (testers' links, and the Beta channel's choice, stay) - but only when its
     pre-release flag is the tag's: anything else is for a person to look at, so the job fails.
     No release yet: `gh release create`, with --prerelease --latest=false for a -beta.<n> / -rc.<n> tag.
  4. Then GitHub is asked again, and the job fails unless:
       - releases/tags/<tag> has the tag's `prerelease` flag (true for -beta.<n> / -rc.<n>, false for stable);
       - it has every file given (by name);
       - for a pre-release, releases/latest is still the release it was before (Stable never sees a beta).

Standard library only, Python 3.8+.
"""
import argparse
import json
import pathlib
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import release_tag  # noqa: E402


class PublishError(Exception):
    pass


def run_gh(args):
    """gh with these arguments: (exit code, stdout, stderr)."""
    # (UTF-8 whatever the runner's code page: release notes may hold any character.)
    done = subprocess.run(["gh"] + args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return done.returncode, done.stdout, done.stderr


def api(gh, path):
    """GET <path> through `gh api`: the parsed JSON, or None for a 404 (no such release)."""
    code, out, err = gh(["api", path])
    if code != 0:
        if "HTTP 404" in err or "Not Found" in err:
            return None
        raise PublishError(f"gh api {path} failed: {err.strip() or out.strip()}")
    try:
        return json.loads(out)
    except ValueError as error:
        raise PublishError(f"gh api {path}: not JSON ({error})") from error


def latest_tag(gh, repo):
    release = api(gh, f"repos/{repo}/releases/latest")
    return release.get("tag_name") if isinstance(release, dict) else None


def required_files(info):
    return [f"ultimate-legends-{info['version']}-win64-portable.zip", "SHA256SUMS.txt"]


def publish(repo, tag, notes_file, files, gh=run_gh, sleep=time.sleep, log=print):
    """Publishes `files` for `tag` and checks the result (PublishError when anything is off)."""
    info = release_tag.classify(tag)
    names = [pathlib.Path(file).name for file in files]
    missing = [name for name in required_files(info) if name not in names]
    if missing:
        raise PublishError(f"{tag}: the files to publish lack {', '.join(missing)}")

    before = latest_tag(gh, repo)
    log(f"releases/latest before: {before or '(none)'}")

    existing = api(gh, f"repos/{repo}/releases/tags/{tag}")
    if existing is not None:
        if bool(existing.get("prerelease")) != info["prerelease"]:
            raise PublishError(f"{tag}: a release already exists with prerelease={bool(existing.get('prerelease'))}; "
                               f"the tag needs prerelease={info['prerelease']}. Not changed: fix it by hand, then re-run.")
        log(f"{tag}: the release exists (a re-run) - uploading its files again with --clobber")
        code, out, err = gh(["release", "upload", tag] + list(files) + ["--clobber", "--repo", repo])
        if code != 0:
            raise PublishError(f"gh release upload failed: {err.strip() or out.strip()}")
    else:
        channel = ["--prerelease", "--latest=false"] if info["prerelease"] else []
        code, out, err = gh(["release", "create", tag] + list(files) +
                            ["--repo", repo, "--title", info["title"], "--notes-file", str(notes_file)] + channel)
        if code != 0:
            raise PublishError(f"gh release create failed: {err.strip() or out.strip()}")

    # What GitHub shows now (asked a few times: a fresh release can take a moment to show everywhere).
    problems = []
    for attempt in range(3):
        if attempt:
            sleep(5)
        problems = []
        release = api(gh, f"repos/{repo}/releases/tags/{tag}")
        if release is None:
            problems.append(f"releases/tags/{tag} is not there")
        else:
            if bool(release.get("prerelease")) != info["prerelease"]:
                problems.append(f"releases/tags/{tag} has prerelease={bool(release.get('prerelease'))}, not {info['prerelease']}")
            have = {asset.get("name") for asset in release.get("assets") or [] if isinstance(asset, dict)}
            lacking = [name for name in names if name not in have]
            if lacking:
                problems.append(f"releases/tags/{tag} lacks {', '.join(lacking)}")
        if info["prerelease"]:
            after = latest_tag(gh, repo)
            if after != before:
                problems.append(f"releases/latest is {after or '(none)'}, was {before or '(none)'}: Stable would see this pre-release")
        if not problems:
            break
    if problems:
        raise PublishError("; ".join(problems))
    log(f"{tag}: published, prerelease={info['prerelease']}, {len(names)} files; releases/latest {latest_tag(gh, repo) or '(none)'}")


# ---- self-test: a fake gh over an in-memory GitHub ----

class FakeGitHub:
    def __init__(self, releases=(), latest=None):
        self.releases = {r["tag_name"]: r for r in releases}
        self.latest = latest
        self.calls = []
        self.ignore = set()   # flags this fake gh drops ("--prerelease", "--latest=false"), to play a broken publish
        self.lose = set()     # asset names this fake GitHub never keeps
        self.fail = set()     # gh subcommands that fail ("create", "upload")

    def __call__(self, args):
        self.calls.append(args)
        if args[0] == "api":
            path = args[1]
            if path.endswith("/releases/latest"):
                release = self.releases.get(self.latest)
            else:
                release = self.releases.get(path.rsplit("/", 1)[1])
            return (0, json.dumps(release), "") if release else (1, "", "gh: Not Found (HTTP 404)")
        command, tag = args[1], args[2]
        if command in self.fail:
            return 1, "", f"{command} failed"
        files = [a for a in args[3:] if a.endswith((".zip", ".txt"))]
        names = [pathlib.Path(f).name for f in files if pathlib.Path(f).name not in self.lose]
        if command == "create":
            if tag in self.releases:
                return 1, "", "a release with the same tag name already exists"
            flags = [a for a in args if a not in self.ignore]
            prerelease = "--prerelease" in flags
            self.releases[tag] = {"tag_name": tag, "prerelease": prerelease, "assets": [{"name": n} for n in names]}
            if "--latest=false" not in flags:
                self.latest = tag
            return 0, "", ""
        if command == "upload":
            if "--clobber" not in args:
                return 1, "", "asset under the same name already exists"
            have = self.releases[tag]["assets"]
            for name in names:
                if name not in [a["name"] for a in have]:
                    have.append({"name": name})
            return 0, "", ""
        return 1, "", "unknown"


def self_test():
    failures = 0

    def check(ok, what):
        nonlocal failures
        if not ok:
            failures += 1
            print(f"  FAIL  {what}")

    def stable(tag):
        return {"tag_name": tag, "prerelease": False, "assets": []}

    def files(version):
        return [f"dist/ultimate-legends-{version}-win64-portable.zip", "dist/SHA256SUMS.txt"]

    def attempt(gh, tag, version):
        try:
            publish("o/r", tag, "notes.md", files(version), gh=gh, sleep=lambda _: None, log=lambda _: None)
            return None
        except PublishError as error:
            return str(error)

    def commands(gh):
        return [c[1] for c in gh.calls if c[0] == "release"]

    # A new beta: created as a pre-release, never latest; latest still 0.4.0.
    gh = FakeGitHub([stable("v0.4.0")], "v0.4.0")
    check(attempt(gh, "v0.5.0-beta.1", "0.5.0-beta.1") is None, "a new beta publishes")
    create = next(c for c in gh.calls if c[:2] == ["release", "create"])
    check("--prerelease" in create and "--latest=false" in create, "a beta: --prerelease --latest=false")
    check(gh.latest == "v0.4.0" and gh.releases["v0.5.0-beta.1"]["prerelease"], "latest unchanged, the beta flagged")

    # A re-run: the release exists, so its files are uploaded with --clobber; never created again.
    check(attempt(gh, "v0.5.0-beta.1", "0.5.0-beta.1") is None, "a re-run of the beta passes")
    check(commands(gh) == ["create", "upload"], "a re-run uploads (no second create, no delete)")
    upload = next(c for c in gh.calls if c[:2] == ["release", "upload"])
    check("--clobber" in upload, "the re-run's upload has --clobber")

    # The first repo release ever (no latest): still none after a beta.
    gh = FakeGitHub()
    check(attempt(gh, "v0.5.0-rc.1", "0.5.0-rc.1") is None and gh.latest is None, "no releases yet: an rc publishes, latest stays none")

    # A stable tag: created without the flags, prerelease false; it may become latest.
    gh = FakeGitHub([stable("v0.4.0")], "v0.4.0")
    check(attempt(gh, "v0.4.1", "0.4.1") is None, "a stable tag publishes")
    create = next(c for c in gh.calls if c[:2] == ["release", "create"])
    check("--prerelease" not in create and "--latest=false" not in create, "stable: no pre-release flags, as before")
    check(not gh.releases["v0.4.1"]["prerelease"], "stable: prerelease false")

    # A publish that made the beta latest: the job fails.
    gh = FakeGitHub([stable("v0.4.0")], "v0.4.0")
    gh.ignore = {"--latest=false"}
    error = attempt(gh, "v0.5.0-beta.2", "0.5.0-beta.2")
    check(error is not None and "releases/latest is v0.5.0-beta.2, was v0.4.0" in error, "latest moved to the beta: fails")

    # A publish that lost the pre-release flag: fails.
    gh = FakeGitHub([stable("v0.4.0")], "v0.4.0")
    gh.ignore = {"--prerelease"}
    error = attempt(gh, "v0.5.0-beta.3", "0.5.0-beta.3")
    check(error is not None and "prerelease=False, not True" in error, "the pre-release flag missing: fails")

    # A file that never arrived: fails.
    gh = FakeGitHub([stable("v0.4.0")], "v0.4.0")
    gh.lose = {"SHA256SUMS.txt"}
    error = attempt(gh, "v0.5.0-beta.4", "0.5.0-beta.4")
    check(error is not None and "lacks SHA256SUMS.txt" in error, "a missing asset: fails")

    # An existing release with the wrong flag (made by hand as a full release): no upload, fails.
    gh = FakeGitHub([stable("v0.4.0"), stable("v0.5.0-beta.5")], "v0.4.0")
    error = attempt(gh, "v0.5.0-beta.5", "0.5.0-beta.5")
    check(error is not None and "already exists with prerelease=False" in error and commands(gh) == [],
          "an existing release with the wrong flag: refused, nothing uploaded")

    # The zip of another version, or no checksums: refused before anything is published.
    gh = FakeGitHub([stable("v0.4.0")], "v0.4.0")
    try:
        publish("o/r", "v0.5.0-beta.6", "notes.md", ["dist/ultimate-legends-0.5.0-win64-portable.zip"], gh=gh,
                sleep=lambda _: None, log=lambda _: None)
        check(False, "the wrong zip refused")
    except PublishError as error:
        check("ultimate-legends-0.5.0-beta.6-win64-portable.zip" in str(error) and "SHA256SUMS.txt" in str(error)
              and gh.calls == [], "the wrong zip and no checksums: refused before any call")

    # gh failing: fails.
    gh = FakeGitHub([stable("v0.4.0")], "v0.4.0")
    gh.fail = {"create"}
    check("gh release create failed" in (attempt(gh, "v0.5.0-beta.7", "0.5.0-beta.7") or ""), "a failed create: fails")

    # Not a release tag (an upper-case pre-release included): refused.
    for tag in ("v0.5.0-Beta.1", "v0.5.0-alpha.1"):
        try:
            publish("o/r", tag, "notes.md", files("x"), gh=FakeGitHub(), log=lambda _: None)
            check(False, f"{tag} refused")
        except ValueError:
            pass

    print(f"publish_release self-test: {'ok' if not failures else f'{failures} failed'}")
    return 1 if failures else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("files", nargs="*", help="the files to publish (the zip and SHA256SUMS.txt)")
    parser.add_argument("--repo", help="owner/name (GITHUB_REPOSITORY)")
    parser.add_argument("--tag", help="the tag (GITHUB_REF_NAME)")
    parser.add_argument("--notes-file", help="the release notes (tools/release_tag.py --notes-out)")
    parser.add_argument("--self-test", action="store_true", help="run the built-in tests")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if not (args.repo and args.tag and args.notes_file and args.files):
        parser.error("--repo, --tag, --notes-file and the files are needed")
    try:
        publish(args.repo, args.tag, args.notes_file, args.files)
    except (PublishError, ValueError) as error:
        print(f"publish_release: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
