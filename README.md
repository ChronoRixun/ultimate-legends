[![build](https://img.shields.io/github/actions/workflow/status/ChronoRixun/ultimate-legends/build.yml?branch=main&label=Build&logo=github)](https://github.com/ChronoRixun/ultimate-legends/actions)
[![issues](https://img.shields.io/github/issues/ChronoRixun/ultimate-legends?label=Issues)](https://github.com/ChronoRixun/ultimate-legends/issues)

# Ultimate Legends

A community launcher for the Marvel: Ultimate Alliance and X-Men Legends games. It finds the games you already own, adds community fixes such as native Xbox controller support, and launches them from one place.

Ultimate Legends never downloads or distributes game files. Every game runs from your own install.

**NOTE:** Ultimate Legends is a fan project. It is not affiliated with or endorsed by Marvel, Activision, Raven Software or CB Servers.

## Games

| Game | Id | Version | What Ultimate Legends adds |
|------|----|---------|----------------------------|
| Marvel: Ultimate Alliance | `mua` | 2016 PC (Steam app 433300) | Finds your Steam install; installs the [MUA Controller Fix](https://github.com/ChronoRixun/mua-controller-fix) for native Xbox controller support |
| Marvel: Ultimate Alliance 2 | `mua2` | 2016 PC (Steam app 433320) | Finds your Steam install; installs the [MUA Controller Fix](https://github.com/ChronoRixun/mua-controller-fix) |
| X-Men Legends II: Rise of Apocalypse | `xml2` | 2005 PC | Launches your existing install; installs the [XML2 Fix](https://github.com/ChronoRixun/xml2-fix) for native Xbox controller support and online play through OpenSpy; a Display section edits the fix's window mode, resolution, frame rate limit and VSync, and a Discord section turns its Rich Presence on or off (on by default; `xml2-fix.ini` next to the game) |
| Marvel: Ultimate Alliance (2006 PC) | `muac` | 2006 PC | Coming soon |
| X-Men Legends | `xml1` | Community port ([Legends Classic](https://github.com/ChronoRixun/legends-classic)) | Builds a PC version on your PC from your own Xbox disc image and your X-Men Legends II install, then runs it with the XML2 Fix ([details](#x-men-legends-community-port)) |

## X-Men Legends (community port)

X-Men Legends (2004) never came to PC. [Legends Classic](https://github.com/ChronoRixun/legends-classic), a
community port, rebuilds it on the engine of X-Men Legends II's PC version, and Ultimate Legends sets it up for you:

1. Set up X-Men Legends II first.
2. On the X-Men Legends card, choose **Set up**, pick a disc image of **your own** X-Men Legends Xbox disc and a
   folder for the new game.
3. The launcher downloads the port's builder, which checks your disc image and your XML2 install and builds the
   game in that folder, on your PC. The first build takes a while (it converts every sound bank); you can hide,
   cancel and resume it.
4. The launcher installs the XML2 Fix into the new folder. Play.

The page shows whether your build is up to date and offers a rebuild when the builder is updated. Display, Discord
and Mods work as for X-Men Legends II. Uninstalling removes the built game and, if you want, the build cache; your
saves in `Documents\Activision\X-Men Legends` are kept.

Nothing from the games is downloaded: the builder uses only your disc image and your XML2 install, and it never
connects to the internet. The first build takes about 6-8 minutes on a current PC and needs about 8 GB free.

## Download

Get `ultimate-legends-<version>-win64-portable.zip` from [Releases](https://github.com/ChronoRixun/ultimate-legends/releases)
(check it against `SHA256SUMS.txt`), unzip it anywhere and run `ultimate-legends.exe`. It is a portable build: its
settings, its browser runtime and its UI live in the `ultimate-legends` folder next to the executable, so moving or
deleting that folder moves or removes the launcher and nothing else. The release is not code-signed yet, so Windows
SmartScreen may warn about it on first start; compare the SHA-256 with the release page, or
[build it from source](#build-from-source).

The launcher updates itself: when a newer release is out, a bar at the top of the window offers it. Update downloads
the new portable zip, checks it against the release's `SHA256SUMS.txt` and installs it when the launcher restarts
(or at once with Restart now). Only the executable, `data\cef` and `data\launcher-ui` are replaced; your settings,
mods, builds and the rest of the `ultimate-legends` folder stay as they are, and a failed or interrupted update puts
the previous version back. A launcher you moved to `%LOCALAPPDATA%` (Settings, portable mode off) only links to the
release page. Development builds (Debug, or built from anything but a release tag) never update themselves.

Help, bug reports and co-op partners: the community Discord, [discord.gg/tFxwHtZv8k](https://discord.gg/tFxwHtZv8k).
No game files, disc images or links to them there either.

## Command line arguments

The launcher accepts the following optional command line arguments.

| Argument | Value | Description |
|----------|-------|-------------|
| `-offline` | — | Runs the launcher in offline mode. Downloads and online features are disabled. |
| `-portable` | — | Runs the launcher in portable mode. Launcher data (user settings, CEF cache, the CEF runtime and UI files) lives in an `ultimate-legends` folder next to the executable instead of `%LOCALAPPDATA%\ultimate-legends`. Until there is a release, copy `data\cef\release` and `data\launcher-ui` into that folder yourself: `tools\stage-runtime.ps1` only stages `%LOCALAPPDATA%`. |
| `-launch` | game id | Launches the given game once the launcher finishes loading. Accepts `mua`, `mua2`, `xml2` and `xml1`, plus the aliases `mua1`, `ultimatealliance`, `ultimatealliance2`, `xmenlegends2` and `xmenlegends`. (`muac` is recognised, but until it is supported it only opens the game's page; `xml1` opens its setup until the port has been built.) |
| `-install` | game id | Opens the given game's page and its setup flow (or its Manage install dialog if the game is already set up) once the launcher finishes loading. Accepts the same ids as `-launch`. If both are given, `-install` wins. |

## URL scheme (`ultimatelegends://`)

The launcher registers an `ultimatelegends://` URL protocol on startup (per-user, no admin required), so links from a browser or another app can drive it. If the launcher is already running, the link is handed to the existing instance instead of opening a second one.

| Link | Action |
|------|--------|
| `ultimatelegends://play/<game>` | Launches the game. If it isn't set up yet, the setup flow opens instead. |
| `ultimatelegends://game/<game>` | Opens the game's page without launching. |
| `ultimatelegends://install/<game>` | Opens the game's page and starts its setup flow, or its Manage install dialog if it is already set up. |

`<game>` accepts the same ids and aliases as `-launch` (e.g. `mua`, `mua2`, `xml2`).

## Build from source

You need Windows, [Git](https://git-scm.com/install/windows) and Visual Studio 2022 with the "Desktop development with C++" workload.

1. Clone the repository with Git (`git clone https://github.com/ChronoRixun/ultimate-legends.git`). **Do not download it as a ZIP**: the build needs the Git submodules and history.
2. Run `generate.bat`. It updates the submodules and generates `build\ultimate-legends.sln`. The first run also downloads CEF (about 260 MB) into `deps\cef`.
3. Build the `Release` / `x64` configuration of `build\ultimate-legends.sln`.
4. Run `tools\run-test-release.bat`. It copies the CEF runtime and the launcher UI into `%LOCALAPPDATA%\ultimate-legends` (`tools\stage-runtime.ps1`) and starts `build\bin\x64\Release\ultimate-legends.exe`.

## Privacy

Ultimate Legends sends no telemetry. It only connects to the internet in these cases:

- When you set up, launch or verify Marvel: Ultimate Alliance or Marvel: Ultimate Alliance 2, it checks the latest [MUA Controller Fix release](https://github.com/ChronoRixun/mua-controller-fix/releases) on GitHub and downloads `dinput8.dll` if it is missing or out of date. Turn on "Skip patch update on launch" in Settings, or use `-offline`, to stop the launch-time check.
- X-Men Legends II works the same way with the latest [XML2 Fix release](https://github.com/ChronoRixun/xml2-fix/releases) and its `dinput.dll`.
- When you set up X-Men Legends (community port), or its page checks for updates, the launcher checks the latest
  release of the port's builder on GitHub and downloads it if it is missing or out of date (its SHA-256 is checked).
  The builder itself never connects to the internet: it reads your disc image and your X-Men Legends II install and
  writes the new game folder on your PC.
- When the launcher starts (and every six hours while it runs, or when you press Check for updates in Settings), it
  asks GitHub's API for the latest [Ultimate Legends release](https://github.com/ChronoRixun/ultimate-legends/releases).
  It downloads that release only when you press Update. `-offline` turns the check off.
- If the Visual C++ 2012 runtime that MUA and MUA2 need is missing, the launcher offers to download Microsoft's installer from download.microsoft.com.
- Links on the Support and Settings pages open in your browser.
- Steam install detection reads your local Steam library folders; it does not contact Steam.

## Credits

Ultimate Legends is a fork of the [CB Servers Launcher](https://github.com/CBServers/cb-launcher) by CB Servers, licensed under the GPL-3.0. Its foundation is the XLabs Launcher, originally developed by [momo5502](https://github.com/momo5502) and the XLabs Project.

Marvel: Ultimate Alliance, X-Men Legends and all related characters are trademarks of Marvel. The games were published by Activision. Ultimate Legends only launches and patches copies you already own.

## License

Ultimate Legends is licensed under the [GNU General Public License v3.0](LICENSE), the same license as the CB Servers Launcher it is based on.

## Disclaimer

Project maintainers are not responsible or liable for misuse of the software. Use responsibly.
