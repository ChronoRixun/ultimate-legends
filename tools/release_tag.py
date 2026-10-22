#!/usr/bin/env python3
"""release_tag.py - what a launcher release tag publishes (the Build workflow's package and publish steps).

  python tools/release_tag.py v0.4.0                      {"version": "0.4.0", "prerelease": false, ...}
  python tools/release_tag.py v0.5.0-beta.1 --notes-out build/release-notes.md
  python tools/release_tag.py --self-test

Two kinds of tag, nothing else:

  stable       v<numbers>, as before (v0.4.0): a normal release, GitHub's latest. The version is the tag
               without its "v", which names the zip (ultimate-legends-<version>-win64-portable.zip).
  pre-release  v<major>.<minor>.<patch>-beta.<n> or -rc.<n> (v0.5.0-beta.1): published as a pre-release and
               never as latest, so the Stable update channel (releases/latest) never sees it and Beta does.
               The version keeps its suffix (0.5.0-beta.1): the zip's name, and what the launcher built at the
               tag calls itself (launcher_update::current_version reads GIT_TAG; VERSIONINFO stays numeric,
               premake's VERSION_PRODUCT_RC).

Any other suffix (v0.5.0-alpha, v0.5.0-hotfix) is refused: published by mistake it would become the latest
release every Stable launcher installs.

The notes: docs/release/v<base>-notes.md when it exists (v0.5.0-beta.1 reads v0.5.0-notes.md), else the
generic line; a pre-release's start with the "Beta - test build" banner. Standard library only, Python 3.8+.
"""
import argparse
import json
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[1]

STABLE = re.compile(r"^v(\d+(?:\.\d+)*)$")
PRERELEASE = re.compile(r"^v((\d+)\.(\d+)\.(\d+))-(beta|rc)\.(0|[1-9]\d*)$")

BANNER = ("> **Beta - test build.** A pre-release for testers: it may have bugs. Launchers on the Beta update "
          "channel (Settings > Update channel) get it; Stable never does. Switch back to Stable any time.\n\n")


def generic_notes(tag):
    return (f"Ultimate Legends {tag} - portable build: unzip anywhere and run ultimate-legends.exe. "
            "No game files are included; every game runs from your own install. SHA-256 in SHA256SUMS.txt.")


def classify(tag):
    """{tag, version, base, prerelease, title} for a release tag; ValueError for any other."""
    stable = STABLE.match(tag)
    if stable:
        return {"tag": tag, "version": stable.group(1), "base": stable.group(1), "prerelease": False,
                "title": f"Ultimate Legends {tag}"}
    pre = PRERELEASE.match(tag)
    if pre:
        return {"tag": tag, "version": tag[1:], "base": pre.group(1), "prerelease": True,
                "title": f"Ultimate Legends {tag}"}
    raise ValueError(f"{tag!r} is not a release tag: v<version> (stable) or v<major>.<minor>.<patch>-beta.<n> / -rc.<n> "
                     "(pre-release)")


def notes(info, docs=REPO / "docs" / "release"):
    """The release's notes (Markdown)."""
    file = docs / f"v{info['base']}-notes.md"
    body = file.read_text(encoding="utf-8") if file.is_file() else generic_notes(info["tag"])
    return (BANNER + body) if info["prerelease"] else body


def self_test():
    import tempfile

    failures = 0

    def check(ok, what):
        nonlocal failures
        if not ok:
            failures += 1
            print(f"  FAIL  {what}")

    v = classify("v0.4.0")
    check(v == {"tag": "v0.4.0", "version": "0.4.0", "base": "0.4.0", "prerelease": False, "title": "Ultimate Legends v0.4.0"},
          "v0.4.0 is stable, version 0.4.0")
    check(classify("v1.2")["version"] == "1.2" and not classify("v1.2")["prerelease"], "a stable tag is any v<numbers>, as before")
    for tag, version, base in (("v0.5.0-beta.1", "0.5.0-beta.1", "0.5.0"), ("v0.5.0-beta.12", "0.5.0-beta.12", "0.5.0"),
                               ("v1.0.0-rc.0", "1.0.0-rc.0", "1.0.0")):
        info = classify(tag)
        check(info["prerelease"] and info["version"] == version and info["base"] == base, f"{tag}: pre-release {version}")
    for tag in ("v0.5.0-alpha.1", "v0.5.0-beta", "v0.5.0-beta.01", "v0.5-beta.1", "v0.5.0-hotfix", "0.4.0", "v", "vnext",
                "v0.4.0-beta.1-dirty", "v0.4.0 "):
        try:
            classify(tag)
            check(False, f"{tag!r} refused")
        except ValueError:
            pass

    with tempfile.TemporaryDirectory() as folder:
        docs = pathlib.Path(folder)
        (docs / "v0.5.0-notes.md").write_text("# 0.5.0\n\nWhat changed.\n", encoding="utf-8")
        stable = notes(classify("v0.5.0"), docs)
        check(stable == "# 0.5.0\n\nWhat changed.\n", "a stable tag: its notes file, as is")
        beta = notes(classify("v0.5.0-beta.2"), docs)
        check(beta.startswith("> **Beta - test build.**") and beta.endswith("# 0.5.0\n\nWhat changed.\n"),
              "a beta tag: the banner, then v<base>-notes.md")
        check(notes(classify("v0.6.0"), docs) == generic_notes("v0.6.0"), "no notes file: the generic line, as before")
        rc = notes(classify("v0.6.0-rc.1"), docs)
        check(rc.startswith(BANNER) and rc.endswith(generic_notes("v0.6.0-rc.1")), "a pre-release without notes: banner + generic line")

    print(f"release_tag self-test: {'ok' if not failures else f'{failures} failed'}")
    return 1 if failures else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("tag", nargs="?", help="the tag (GITHUB_REF_NAME)")
    parser.add_argument("--notes-out", help="write the release notes here")
    parser.add_argument("--self-test", action="store_true", help="run the built-in tests")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if not args.tag:
        parser.error("a tag is needed")
    try:
        info = classify(args.tag)
    except ValueError as error:
        print(f"release_tag: {error}", file=sys.stderr)
        return 1
    if args.notes_out:
        out = pathlib.Path(args.notes_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(notes(info), encoding="utf-8")
        info["notes_file"] = str(out)
    print(json.dumps(info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
