# Agent guidance for Ultimate Legends

These instructions apply throughout this repository, including automated pull-request reviews.

## Project and sources of truth

Ultimate Legends is a Windows C++/CEF launcher for legally owned games, including Legends Classic's builder, XML2 Fix and optional legends-models packs. Those tools live in separate repositories. Keep their CLI/events, manifests, update channels and minimum-version contracts compatible.

Read `README.md`, `premake5.lua`, `.github/workflows/`, and the affected `src/launcher/` backend and `src/launcher-ui/` scripts together. Native tests live in `src/tests/`; UI tests and their small DOM/backend harness live in `src/tests/ui/`. Release notes and companion checks live in `docs/release/`; portable packaging is `tools/package-portable.ps1`.

## Content and privacy boundaries

Ship our code, original documentation and original artwork only. Never add game files, decoded game data, official logos/store art, game screenshots, modified game executables, ownership bypasses, game-download links or personal paths/IPs/emails/tokens. Preserve upstream license notices and the GPL-3.0 license. Check original art provenance in `docs/art-source/` and review every `.content-guard-allow` change.

## Implementation and review

- Follow UI commands into the C++ backend and tool processes. Treat external text, URLs, archive paths and backend events as untrusted; preserve escaping, download hashes and bounded extraction.
- Preserve installs, saves, mods, user INI settings and unrelated load-order entries. Review cancellation, retries, staging, atomic swaps and recovery after interruption, including self-update and portable-mode paths.
- Keep Stable and Beta selection consistent across launcher, builder, patch and models downloads. Check the selected release's manifest and version together; disclose companion changes instead of assuming simultaneous updates.
- Keep controller, keyboard, mouse and touch navigation working. For new or changed dropdowns, use an in-page accessible choice control rather than a native HTML `<select>` popup: Proton/Steam Deck compatibility is a required check. Existing native selects at this revision are not evidence that they work under Proton. Preserve focus, Escape/back behavior and gamepad selection.
- Keep downloads and online orchestration in the launcher; the builder remains offline. Review online readiness, version/Test-mode mismatch refusals and the handoff to the game's online screens.
- Report concrete defects with file/line, trigger and consequence after following callers and consumers. Distinguish hypotheses and validation gaps; avoid unrelated rewrites.

## Validation

The build needs Git history and submodules, Windows and Visual Studio C++ tools. CI generates with `tools/premake5 vs2022`, builds Release/x64, then runs:

```
python tools/release_tag.py --self-test
python tools/publish_release.py --self-test
build/bin/x64/Release/ultimate-legends-tests.exe
node src/tests/ui/run.js
python tools/check_no_game_content.py --self-test
python tools/check_no_game_content.py --all
```

The UI runner uses Node and the committed harness, without an npm install. Do not replace it with an assumed npm/pytest command. Add relevant native and UI regressions when changing a shared contract. UI unit tests do not prove actual CEF rendering, controller hardware, self-update or Proton behavior; state those limits.

CI explicitly uses LF checkout before generation. Preserve byte-sensitive assets and avoid unrelated line-ending churn. On a shared desktop run builds/tests at Idle priority, with serial MSBuild (`/m:1 /nr:false`); CEF generation may download dependencies. Do not run staging/launch scripts or open the launcher/game merely to check code without testing authorization.

`tools/package-portable.ps1`, release policy helpers and `docs/release/` define release verification. A `v*` tag can publish automatically; do not create/push tags as validation. Keep changes scoped, preserve unrelated work and report companion-repository requirements. Reviews do not authorize commits, pushes, merges, publishing, deployment or announcements.
