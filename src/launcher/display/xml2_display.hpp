#pragma once

#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <vector>

// Display settings of the XML2 Fix (dinput.dll next to XMen2.exe): the [Display] section of
// xml2-fix.ini in the game folder, which the fix reads when the game starts and its in-game
// Advanced options write. The launcher edits the same keys, with the same rules:
//
//   [Display]
//   Mode = fullscreen | borderless | windowed   ; absent = the game's own exclusive fullscreen
//   Width = 0 / Height = 0                      ; 0 = desktop size (borderless) / the game's setting
//   Topmost = 0
//   RunInBackground = 1
//   FrameRate = <n> | refresh | 0               ; absent = the stock 60 fps cap; 0 = unlimited
//   VSync = 0 | 1                               ; absent = the game's own presentation interval
//
// A key is only ever written when the user changes that row, through fix/fix_ini.hpp
// (WritePrivateProfileStringW), so the rest of the file and its comments survive; "game default"
// removes the key. The file is created when needed. Which games have the section, and where their
// ini is, comes from fix_ini's table (fix::display).
//
// VSync is offered in every mode: measured offline (2560x1440 @ 180 Hz, Windows 11), a windowed
// Direct3D 8 device presents about 7000 times a second with the default interval, so DWM does not
// make it wait for the vertical blank; D3DSWAPEFFECT_COPY_VSYNC pins it to the refresh rate.

namespace xml2_display
{
    struct display_mode
    {
        int width{};
        int height{};
    };

    struct desktop_mode
    {
        int width{};
        int height{};
        int refresh{}; // Hz, 0 when unknown
    };

    // The [Display] keys the fix reads, in the order the in-game menu shows them.
    const std::vector<std::string>& keys();

    // The [Display] values present in the ini, by key (as written, trimmed). Missing = absent.
    std::map<std::string, std::string> read(const std::filesystem::path& ini);

    // Checks a value for a key and returns it normalised (lower-case mode, plain integers), or
    // nullopt with `error` set.
    std::optional<std::string> normalise(const std::string& key, const std::string& value, std::string& error);

    struct change
    {
        std::string key;
        std::optional<std::string> value; // nullopt removes the key
    };

    // Writes every change (validated first, so nothing is written when one is bad). Creates the
    // ini when it does not exist yet.
    bool write(const std::filesystem::path& ini, const std::vector<change>& changes, std::string& error);

    // The primary display's 32-bit modes from 640x480 up, each size once, smallest first.
    std::vector<display_mode> display_modes();
    desktop_mode desktop();
}
