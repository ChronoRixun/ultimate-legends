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
| X-Men Legends II: Rise of Apocalypse | `xml2` | 2005 PC | Launches your existing install; installs the [XML2 Fix](https://github.com/ChronoRixun/xml2-fix) for native Xbox controller support (online play through OpenSpy is in progress); a Display section edits the fix's window mode, resolution, frame rate limit and VSync (`xml2-fix.ini` next to the game) |
| Marvel: Ultimate Alliance (2006 PC) | `muac` | 2006 PC | Coming soon |
| X-Men Legends | `xml1` | Community port | Coming soon: the original never came to PC, and a port is in progress |

## Download

There is no public release yet. Until there is, [build it from source](#build-from-source).

## Command line arguments

The launcher accepts the following optional command line arguments.

| Argument | Value | Description |
|----------|-------|-------------|
| `-offline` | — | Runs the launcher in offline mode. Downloads and online features are disabled. |
| `-portable` | — | Runs the launcher in portable mode. Launcher data (user settings, CEF cache, the CEF runtime and UI files) lives in an `ultimate-legends` folder next to the executable instead of `%LOCALAPPDATA%\ultimate-legends`. Until there is a release, copy `data\cef\release` and `data\launcher-ui` into that folder yourself: `tools\stage-runtime.ps1` only stages `%LOCALAPPDATA%`. |
| `-launch` | game id | Launches the given game once the launcher finishes loading. Accepts `mua`, `mua2` and `xml2`, plus the aliases `mua1`, `ultimatealliance`, `ultimatealliance2` and `xmenlegends2`. (`muac`, `xml1` and `xmenlegends` are recognised, but until those games are supported they only open the game's page.) |
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
