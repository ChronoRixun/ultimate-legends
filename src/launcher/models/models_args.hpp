#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

// The character-model tool (legends-models, LAUNCHER-API.md, API version 1): the launcher's half of
// its command line and of what it leaves on disk, kept free of Windows, CEF and the network so the
// unit tests (src/tests/models_args_tests.cpp) cover it.
//
// The page never sends a command line: it asks for a command, a mode and costume choices, and
// build_args() turns those into arguments after checking every value, so nothing the page (or a
// stored setting) says can become another flag of the tool.
namespace models_args
{
    // The appearance modes the page offers (LAUNCHER-API.md, "Appearance selector -> commands");
    // "off" is not a mode of the tool: it is `remove` of the installed group.
    bool valid_mode(const std::string& mode);
    // The group (--pack) a mode's build writes: Models-Community, Models-Upgraded, ...
    std::string pack_for_mode(const std::string& mode);

    // A hero key of the tool's roster ("wolverine", "profxastral"): lower-case letters, digits, '_'.
    bool valid_hero(const std::string& hero);
    // A tier name: mua2, mua1, xml2, community, sharpen.
    bool valid_tier(const std::string& tier);
    // A costume choice as --costume takes it after "hero=": "ID" or "tier:ID". IDs are short names
    // or numbers ("0303", "Ultimate XML1", "Original"): letters, digits, spaces and - _ . ( ) ' &.
    bool valid_costume(const std::string& costume);
    // A group or folder name (--pack): letters, digits, - _ . ; not starting with '.', at most 64.
    bool valid_pack(const std::string& pack);
    // The community pack mirror: empty (the author's links only) or an https:// URL with no spaces,
    // quotes or control characters, at most 512 characters.
    bool valid_mirror(const std::string& mirror);

    struct request
    {
        std::string command; // scan | plan | build | verify | remove
        std::string port;    // the Legends Classic folder
        std::string work;    // the tool's private cache
        std::string mua1;    // optional
        std::string mua2;    // optional
        std::string mode;    // plan, build
        std::string pack;    // verify, remove (required); build (optional)
        std::string mirror;  // build (optional)
        std::map<std::string, std::string> costumes; // hero -> "ID" | "tier:ID" (plan, build)
        std::vector<std::string> heroes;             // build: only these heroes (optional)
        bool rebuild{};                              // build: ignore cached results
    };

    // The tool's arguments for `request` (UTF-8; the caller converts), starting with the command and
    // always with --json. nullopt with `error` when a value is missing or not allowed.
    std::optional<std::vector<std::string>> build_args(const request& request, std::string& error);

    // A costume map stored as JSON text ({"wolverine": "mua1:0303"}): only valid entries survive.
    std::map<std::string, std::string> parse_costumes(const std::string& json);
    std::string costumes_json(const std::map<std::string, std::string>& costumes);

    // What one legends-models folder's marker (mods\<folder>\legends-models.json) says.
    struct marker_character
    {
        std::string hero;
        std::string tier;
        std::string source;
    };

    struct marker
    {
        std::string pack;  // the folder name it was written as
        std::string group; // its group (= pack for --layout pack)
        std::string mode;
        std::string version;
        std::vector<marker_character> characters;
    };

    // nullopt unless the text is a JSON object whose "generator" is "legends-models".
    std::optional<marker> parse_marker(const std::string& json);

    // The exit codes (LAUNCHER-API.md "In five lines" 3) as stable names for the page:
    // ok, partial, nothing, missing_input, download, verify_mismatch, unsafe, usage, bug, cancelled,
    // else "unknown".
    std::string exit_name(int code);
}
