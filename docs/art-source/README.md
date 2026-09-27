# Ultimate Legends artwork sources

All launcher artwork is original and generated from code: simple geometry (parallelograms,
discs, Ben-Day halftone screens) plus two Google Fonts, **Archivo** (variable width, used from
62% to 125%) and **IBM Plex Mono**. It contains no third-party logos, characters or trade dress.
Game titles appear only as plain text in Archivo.

| Path | What it is |
| --- | --- |
| `build.py` | The single source of truth: palette, per-game motifs, layouts, rendering and packing. |
| `html/` | The generated HTML/SVG page for every asset (open one in a browser to view it at 1:1). |
| `preview/brand-sheet.jpg` | Brand overview: mark, palette and per-game accents. |

## Palette

| Token | Hex | Use |
| --- | --- | --- |
| Ink | `#0C0D12` | Background |
| Surface | `#16171F` | Raised panels |
| Paper | `#F3EEE3` | Text, logos |
| Legend Yellow (primary) | `#FFC23D` | Brand mark, primary actions |
| Process Cyan (secondary) | `#36C5EE` | Links, secondary highlights |

| Game | Accent | Motif |
| --- | --- | --- |
| `mua` | Flare Orange `#FF7A3D` | Four bars in echelon with a halftone shadow |
| `mua2` | Cobalt `#6B78FF` | A disc split on the diagonal, one half solid, one halftone |
| `xml2` | Eclipse Violet `#AD6BFF` | Black sun, violet rim, halftone corona, one bright bead |
| `muac` | Proof Teal `#2FD4AE` | Four dots mid-print (inked, halftone, halftone, outline) |
| `xml1` | Dawn Crimson `#FF4D63` | A halftone sun rising over the horizon |

Coming-soon games are drawn partly "unprinted" (halftone or outline instead of solid ink).
The launcher adds its own COMING SOON badge, so the images do not include one.

## Re-rendering

Requirements: Windows with Microsoft Edge, Python 3.9+ and Pillow (`pip install Pillow`),
plus internet access so Edge can load the Google Fonts.

```
cd docs/art-source
python build.py            # regenerate html/ only
python build.py --render   # regenerate html/ and overwrite every deliverable in the repo
python build.py --render --only capsule   # re-render just the capsules (also: hero, logo, icon, brand/, mua2/ ...)
```

`--render` screenshots each page with headless Edge at 1x (`--window-size` = the asset size,
transparent background for logos and icons), then:

* `capsule.jpg` (600x900) and `hero.jpg` (1920x620): JPEG, quality 88.
* `logo.png` (1280x345) and `brand/ul-mark.png` (300x300): transparent PNG.
* `icon.ico`: 16/32/48/256 per game; the app icon `src/launcher/resource/icon.ico` has
  16/24/32/48/64/128/256 plus a 256x256 `icon.png`. Sizes up to 32 px use a pixel-grid
  drawing of the mark; larger sizes use the refined drawing. Each frame is box-filtered down
  from a supersampled render.

Set `EDGE` to point at another Chromium-based browser if Edge is installed elsewhere.

Outputs written by `--render`:

```
src/launcher-ui/assets/img/games/<id>/{capsule.jpg, hero.jpg, logo.png, icon.ico}
src/launcher-ui/assets/img/brand/ul-mark.png
src/launcher/resource/icon.ico
src/launcher/resource/icon.png
```

## Editing

* Colours, titles and per-game settings live in the `GAMES` table at the top of `build.py`.
* Motif geometry for capsules and heroes lives in `capsule_ctx()` and `hero_ctx()`.
  Capsules carry no title text: the launcher's library card draws the title, tag chip and
  Install button over the bottom ~45% and a COMING SOON badge in the top-left corner. So each
  motif stays in the upper ~55%, fades to Ink from y=440 to y=600 (`CAPSULE_FADE`), and the
  top-left corner is left empty. Motifs must still read in greyscale (uninstalled games are
  greyed out), so they rely on solid-vs-halftone contrast, not hue.
  Heroes keep the left ~55% dark because the launcher places the logo and buttons there.
* Icon glyphs are drawn on a 16-unit grid in `game_glyph()` and `ul_glyph()`.
