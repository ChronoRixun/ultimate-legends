#include "std_include.hpp"
#include "test.hpp"

#include "models/models_args.hpp"

// The character-model tool's command line as the launcher builds it (models/models_args.hpp): every
// value the page or a stored setting sends is checked, so none of them can become another flag; the
// costume store keeps only valid entries; and a folder's marker is the tool's only when it says so.
namespace
{
    models_args::request base(const std::string& command)
    {
        models_args::request request{};
        request.command = command;
        request.port = "D:\\Games\\Legends Classic";
        request.work = "D:\\Launcher\\ultimate-legends\\cache\\legends-models";
        return request;
    }

    std::vector<std::string> args_of(const models_args::request& request)
    {
        std::string error;
        const auto args = models_args::build_args(request, error);
        CHECK(args.has_value());
        CHECK(error.empty());
        return args.value_or(std::vector<std::string>{});
    }

    bool refused(const models_args::request& request)
    {
        std::string error;
        const auto args = models_args::build_args(request, error);
        return !args && !error.empty();
    }

    bool has_pair(const std::vector<std::string>& args, const std::string& flag, const std::string& value)
    {
        for (std::size_t i = 0; i + 1 < args.size(); ++i)
        {
            if (args[i] == flag && args[i + 1] == value)
            {
                return true;
            }
        }
        return false;
    }

    bool has_flag(const std::vector<std::string>& args, const std::string& flag)
    {
        return std::find(args.begin(), args.end(), flag) != args.end();
    }
}

TEST(models_modes_and_their_packs)
{
    CHECK(models_args::valid_mode("community"));
    CHECK(models_args::valid_mode("upgraded"));
    CHECK(models_args::valid_mode("xml2"));
    CHECK(models_args::valid_mode("sharpen"));
    CHECK(!models_args::valid_mode("off")); // not a tool mode: remove
    CHECK(!models_args::valid_mode(""));
    CHECK(!models_args::valid_mode("Community"));
    CHECK(models_args::pack_for_mode("community") == "Models-Community");
    CHECK(models_args::pack_for_mode("upgraded") == "Models-Upgraded");
    CHECK(models_args::pack_for_mode("xml2") == "Models-XML2-Look");
    CHECK(models_args::pack_for_mode("sharpen") == "Models-Sharpened");
    CHECK(models_args::pack_for_mode("off").empty());
}

TEST(models_values_are_checked)
{
    CHECK(models_args::valid_hero("wolverine"));
    CHECK(models_args::valid_hero("profxastral"));
    CHECK(!models_args::valid_hero("Wolverine"));
    CHECK(!models_args::valid_hero("wolverine --rebuild"));
    CHECK(!models_args::valid_hero(""));

    CHECK(models_args::valid_costume("0303"));
    CHECK(models_args::valid_costume("mua1:0303"));
    CHECK(models_args::valid_costume("Ultimate XML1"));
    CHECK(models_args::valid_costume("community:Ultimate XML1"));
    CHECK(models_args::valid_costume("X-Force (Classic)"));
    CHECK(!models_args::valid_costume("ps2:0303"));      // unknown tier
    CHECK(!models_args::valid_costume("--strict"));      // a flag
    CHECK(!models_args::valid_costume("a\"b"));
    CHECK(!models_args::valid_costume(" padded"));
    CHECK(!models_args::valid_costume(""));
    CHECK(!models_args::valid_costume("mua1:"));
    CHECK(!models_args::valid_costume(std::string(49, 'a')));

    CHECK(models_args::valid_pack("Models-Community"));
    CHECK(models_args::valid_pack("MUA2-Wolverine"));
    CHECK(!models_args::valid_pack(".staging"));
    CHECK(!models_args::valid_pack("..\\Actors"));
    CHECK(!models_args::valid_pack("a/b"));
    CHECK(!models_args::valid_pack("-x"));

    CHECK(models_args::valid_mirror(""));
    CHECK(models_args::valid_mirror("https://github.com/ChronoRixun/ultimate-legends/releases/download/models-1/"));
    CHECK(!models_args::valid_mirror("http://example.com/"));
    CHECK(!models_args::valid_mirror("https://"));
    CHECK(!models_args::valid_mirror("https:///path"));
    CHECK(!models_args::valid_mirror("https://example.com/a b"));
    CHECK(!models_args::valid_mirror("https://example.com/\" --strict"));
    CHECK(!models_args::valid_mirror("file:///C:/x"));
    CHECK(!models_args::valid_mirror("https://" + std::string(510, 'a')));
}

TEST(models_scan_has_the_launchers_inputs_only)
{
    auto request = base("scan");
    request.mua1 = "D:\\Steam\\Marvel - Ultimate Alliance";
    request.mode = "community"; // ignored by scan
    const auto args = args_of(request);
    CHECK(args.size() >= 6);
    CHECK(args[0] == "scan");
    CHECK(args[1] == "--json");
    CHECK(has_pair(args, "--port", request.port));
    CHECK(has_pair(args, "--work", request.work));
    CHECK(has_pair(args, "--mua1", request.mua1));
    CHECK(!has_flag(args, "--mua2"));
    CHECK(!has_flag(args, "--mode"));
}

TEST(models_build_takes_mode_costumes_heroes_and_mirror)
{
    auto request = base("build");
    request.mode = "upgraded";
    request.mua2 = "D:\\Steam\\MUA2";
    request.costumes = {{"wolverine", "mua1:0301"}, {"beast", "Classic"}};
    request.heroes = {"wolverine"};
    request.mirror = "https://example.com/packs/";
    request.rebuild = true;
    const auto args = args_of(request);
    CHECK(args[0] == "build");
    CHECK(has_pair(args, "--mode", "upgraded"));
    CHECK(has_pair(args, "--costume", "wolverine=mua1:0301"));
    CHECK(has_pair(args, "--costume", "beast=Classic"));
    CHECK(has_pair(args, "--hero", "wolverine"));
    CHECK(has_pair(args, "--mirror", "https://example.com/packs/"));
    CHECK(has_pair(args, "--mua2", "D:\\Steam\\MUA2"));
    CHECK(has_flag(args, "--rebuild"));
    CHECK(!has_flag(args, "--pack")); // the tool's default group for the mode

    // plan: costumes but never the build-only flags
    auto plan = base("plan");
    plan.mode = "community";
    plan.costumes = {{"wolverine", "Original"}};
    plan.mirror = "https://example.com/";
    plan.heroes = {"beast"};
    plan.rebuild = true;
    const auto plan_args = args_of(plan);
    CHECK(has_pair(plan_args, "--costume", "wolverine=Original"));
    CHECK(!has_flag(plan_args, "--mirror"));
    CHECK(!has_flag(plan_args, "--hero"));
    CHECK(!has_flag(plan_args, "--rebuild"));
}

TEST(models_bad_requests_are_refused)
{
    CHECK(refused(base("fetch")));
    CHECK(refused(base("--help")));
    auto no_port = base("scan");
    no_port.port.clear();
    CHECK(refused(no_port));

    auto build = base("build");
    CHECK(refused(build)); // no mode
    build.mode = "off";
    CHECK(refused(build));
    build.mode = "community";
    build.costumes = {{"wolverine", "--strict"}};
    CHECK(refused(build));
    build.costumes = {{"Wolverine", "Original"}};
    CHECK(refused(build));
    build.costumes = {};
    build.mirror = "http://insecure.example/";
    CHECK(refused(build));
    build.mirror = {};
    build.heroes = {"wolverine;rm"};
    CHECK(refused(build));
    build.heroes = {};
    build.pack = "..\\..\\Actors";
    CHECK(refused(build));

    CHECK(refused(base("verify"))); // no pack
    auto remove = base("remove");
    remove.pack = ".legends-models-old";
    CHECK(refused(remove));
    remove.pack = "Models-Community";
    const auto args = args_of(remove);
    CHECK(has_pair(args, "--pack", "Models-Community"));
}

TEST(models_costume_store_keeps_valid_entries)
{
    const auto costumes = models_args::parse_costumes(
        R"({"wolverine":"mua1:0303","beast":"Classic","Bad":"x","storm":"--x","cyclops":7,"rogue":""})");
    CHECK(costumes.size() == 2);
    CHECK(costumes.at("wolverine") == "mua1:0303");
    CHECK(costumes.at("beast") == "Classic");
    CHECK(models_args::parse_costumes("").empty());
    CHECK(models_args::parse_costumes("[1,2]").empty());
    CHECK(models_args::parse_costumes("{not json").empty());

    const auto json = models_args::costumes_json(costumes);
    CHECK(json == R"({"beast":"Classic","wolverine":"mua1:0303"})");
    CHECK(models_args::parse_costumes(json) == costumes);
}

TEST(models_marker_is_the_tools_only)
{
    const auto marker = models_args::parse_marker(R"({"generator":"legends-models","version":"0.3.0","pack":"MUA2-Wolverine",
        "mode":"upgraded","group":"Models-Upgraded","characters":{"wolverine":{"tier":"mua2","source":"0301","file":"Actors/14301.IGB"}},
        "files":{"Actors/14301.IGB":{"sha256":"ab"}}})");
    CHECK(marker.has_value());
    CHECK(marker->pack == "MUA2-Wolverine");
    CHECK(marker->group == "Models-Upgraded");
    CHECK(marker->mode == "upgraded");
    CHECK(marker->version == "0.3.0");
    CHECK(marker->characters.size() == 1);
    CHECK(marker->characters[0].hero == "wolverine");
    CHECK(marker->characters[0].tier == "mua2");
    CHECK(marker->characters[0].source == "0301");

    // --layout pack: no group, the pack is its own group
    const auto pack = models_args::parse_marker(R"({"generator":"legends-models","pack":"Models-Community","mode":"community"})");
    CHECK(pack.has_value() && pack->group == "Models-Community" && pack->characters.empty());

    CHECK(!models_args::parse_marker(R"({"name":"Some Mod","author":"someone"})"));
    CHECK(!models_args::parse_marker(R"({"generator":"other-tool"})"));
    CHECK(!models_args::parse_marker("not json"));
    // wrong types are skipped, not thrown
    const auto odd = models_args::parse_marker(R"({"generator":"legends-models","pack":5,"characters":{"x":3,"y":{"tier":1}}})");
    CHECK(odd.has_value() && odd->pack.empty() && odd->characters.size() == 1 && odd->characters[0].tier.empty());
}

TEST(models_exit_codes_have_names)
{
    CHECK(models_args::exit_name(0) == "ok");
    CHECK(models_args::exit_name(10) == "partial");
    CHECK(models_args::exit_name(11) == "nothing");
    CHECK(models_args::exit_name(3) == "missing_input");
    CHECK(models_args::exit_name(20) == "download");
    CHECK(models_args::exit_name(30) == "verify_mismatch");
    CHECK(models_args::exit_name(31) == "stale"); // verify: files intact, the port was rebuilt since (offer Rebuild)
    CHECK(models_args::exit_name(40) == "unsafe");
    CHECK(models_args::exit_name(2) == "usage");
    CHECK(models_args::exit_name(1) == "bug");
    CHECK(models_args::exit_name(130) == "cancelled");
    CHECK(models_args::exit_name(77) == "unknown");
}

TEST(models_offline_reaches_plan_and_build_only)
{
    for (const auto* command : {"plan", "build"})
    {
        auto request = base(command);
        request.mode = "community";
        CHECK(!has_flag(args_of(request), "--offline"));
        request.offline = true;
        CHECK(has_flag(args_of(request), "--offline"));
    }
    for (const auto* command : {"scan", "verify", "remove"})
    {
        auto request = base(command);
        request.pack = "Models-Community";
        request.offline = true;
        CHECK(!has_flag(args_of(request), "--offline")); // nothing to download there
    }
}

TEST(models_tool_install_failures_have_the_page_codes)
{
    // tool_install's own word for the player's Cancel (the Downloads tab or the models page)
    CHECK(models_args::tool_install_code("cancelled") == "L_TOOL_CANCELLED");
    CHECK(models_args::tool_install_code("The download did not match its SHA-256.") == "L_TOOL_HASH");
    CHECK(models_args::tool_install_code("The zip could not be opened.") == "L_TOOL_EXTRACT");
    CHECK(models_args::tool_install_code("could not unpack legends-models.exe") == "L_TOOL_EXTRACT");
    CHECK(models_args::tool_install_code("HTTP 404") == "L_TOOL_DOWNLOAD");
    // only the exact word: a message that merely mentions it is a download failure
    CHECK(models_args::tool_install_code("the server cancelled the transfer") == "L_TOOL_DOWNLOAD");
    CHECK(models_args::tool_install_code("") == "L_TOOL_DOWNLOAD");
}
