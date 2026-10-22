# Beta channel: companion-pipeline handoff (XML2 Fix, Legends Classic)

For the owner. The launcher side of the Beta update channel is on `feature/beta-channel` (draft PR #14). This
file lists what the two companion repositories must publish for it, what was reviewed and already matches, and
the one change Legends Classic needed (**B2, done on the Legends Classic side**, owner, 2026-10-22). Nothing here
was applied to, committed in or published from those repositories from this one.

Reviewed companion commits (from the local pipeline handoff, 2026-10-22):

| Repository | Branch | Commit | Based on |
| --- | --- | --- | --- |
| ChronoRixun/xml2-fix | `feature/beta-tags` | `58a61c4f44a4eebec88b9b668b5701d5bdf2f980` | release-1.8.0 `de8c356ed84f0023a21f8dbf0fbbe2854e45b0ea` |
| ChronoRixun/legends-classic | `feature/beta-tags` | `869e5bd6676b600244f72eecb9bea8a5a5c12207` | release-0.3.0 `98856a44db218a736713deec0d19be6380986a7e` |

## What the launcher reads (both repositories)

- **Discovery.** Stable: `GET /repos/<repo>/releases/latest`. Beta: `GET /repos/<repo>/releases?per_page=30`,
  skipping drafts, tags that aren't `v` + SemVer (no leading zeros, no empty build identifiers) and releases
  that don't yet have every required file. Beta takes the highest version, final releases included
  (`beta.2 < beta.10 < rc.1 < final`), so Beta players move to the final release on their own.
- **Downloads.** Always from the chosen release's tag: `releases/download/<tag>/<file>`, never `latest/download`
  after a choice was made. The hash checks are unchanged (XML2 Fix: per-file SHA-1 from `ultimate-legends.json`;
  builder: size + SHA-256 from `xml1-builder.json`).
- **Required files per release.** XML2 Fix: `ultimate-legends.json` (and every file it lists). Legends Classic:
  `xml1-builder.json` (and the zip it names). A release that doesn't have them yet is not chosen.
- **Version authority.** The tag (`v1.8.0-beta.1` → `1.8.0-beta.1`). For the XML2 Fix the launcher records the
  tag's version with the SHA-1 of the `dinput.dll` it installed; the DLL's VERSIONINFO may stay numeric (`1.8.0.0`).

## XML2 Fix - matches, keep as is

- Tags `vX.Y.Z[-beta.N|-rc.N]`; pre-releases published with `--prerelease --latest=false`; stable publish flags
  unchanged; base-version notes; numeric VERSIONINFO of the base version.
- `ultimate-legends.json` stays **the original bare array** for stable, beta, rc and dev builds, e.g.
  `[["dinput.dll",2647040,"<40 upper-case hex SHA-1>","game"]]`: no envelope, no version field, no extra
  "release info" asset. The launcher's `client_updater` parses exactly this (old and new launchers alike);
  `src/tests/release_resolver_tests.cpp` (`the_xml2_fix_manifest_stays_a_bare_array`) pins the shape.
- The pipeline's own tests execute the workflow serializer and compare its bytes: keep them.

## Legends Classic - matches, keep as is

- Tags `vX.Y.Z[-beta.N|-rc.N]`; `--prerelease --latest=false` for those; stable flags unchanged; base-version
  notes; numeric VERSIONINFO of the base (`0.3.0`), the suffix in the frozen runtime / build info.
- `xml1-builder.json` keeps exactly: `version`, `content_version`, `zip`, `size`, `sha256`, `min_launcher`,
  `requires_xml2fix`. For the first beta: `version` `0.3.0-beta.1` (no leading `v`; equal to the tag's version -
  the launcher's switch back compares the installed builder against the tag), `zip`
  `xml1-builder-0.3.0-beta.1-win64.zip`, `content_version` 24, `min_launcher` `0.0.0`.

## B2 - Legends Classic: the builder's XML2 Fix requirement (done)

**What was wrong.** At the reviewed `869e5bd`, `tools/xml1build/fix_ini.py:238` had `REQUIRED_XML2FIX = '1.8'`, so
the manifest (`tools/freeze_builder.py:169+`) and every build's stamp (`tools/xml1builder/pipeline.py:432`,
`stamp.requires.xml2fix`) said `>=1.8` for beta builders too. By SemVer `1.8.0-beta.1 < 1.8`: the launcher's X-Men
Legends page (`src/launcher/xml1/xml1_port.cpp`, `fix.ok`, from the stamp) would have called the beta XML2 Fix too
old, while online play (`online_launch::check_fix`, deliberately `>=1.8.0-0`) accepts it.

**What Legends Classic does now** (owner, 2026-10-22): beta and rc builder tags write `requires_xml2fix: ">=1.8.0-0"`
(and the same `requires.xml2fix` into a build's stamp); stable builder tags keep `">=1.8"`. So:

| Builder | Requirement | Accepts | Refuses |
| --- | --- | --- | --- |
| `v0.3.0-beta.N`, `v0.3.0-rc.N` | `>=1.8.0-0` | `1.8.0-beta.N`, `1.8.0-rc.N`, `1.8.0`, later | `1.7.x` |
| `v0.3.0` (stable) | `>=1.8` | `1.8.0` and later releases | any `1.8.0` pre-release, `1.7.x` |

The launcher was not loosened: its comparison stays strict (an explicit `>=1.8.0` or `>=1.8` never accepts a
pre-release). A tester who keeps a beta fix after the stable 0.3.0 builder is installed sees "XML2 Fix too old" on
the X-Men Legends page until Verify Files brings 1.8.0 - the stable policy chosen. A build made by a builder from
before the change keeps `>=1.8` in its stamp until it is rebuilt.

**Launcher evidence.** `src/tests/release_resolver_tests.cpp`: `the_builder_manifest_of_legends_classic_0_3_0_beta_1`
(the emitted field set and values, `requires_xml2fix` exactly `>=1.8.0-0`, which 1.8.0-beta.1/2/10, rc.1, 1.8.0 and
the numeric 1.8.0.0 meet and 1.7.x does not; online play agrees) and `rc_and_stable_builders_require_their_fix` (rc
the same; stable `>=1.8` takes 1.8.0 / 1.8.0.0 and refuses every 1.8.0 pre-release; `>=1.8.0` stays strict).

**Still to confirm with real releases (checklist F2b):** a fresh beta build's `_build\stamp.json` and the published
`xml1-builder.json` carry `>=1.8.0-0`; the stable 0.3.0 release's carry `>=1.8`.

## Owner validation that only real releases prove

- Publish `v1.8.0-beta.1` (XML2 Fix) and `v0.3.0-beta.1` (Legends Classic) from their pipelines: each page says
  **Pre-release**, `releases/latest` still names 1.7.1 / 0.2.5, and `/releases?per_page=30` lists them with
  `"prerelease": true` and every required asset.
- Then the launcher checks in `docs/release/0.4.0-checklist.md` (sections F and I).
