#include "std_include.hpp"
#include "diagnostics.hpp"
#include "redact.hpp"

#include <game_config.hpp>
#include <version.hpp>
#include <utils/flags.hpp>
#include <utils/nt.hpp>
#include <utils/properties.hpp>
#include <utils/string.hpp>

#include "display/xml2_display.hpp"
#include "fix/fix_ini.hpp"
#include "muac/settings.hpp"
#include "updater/patch_channel.hpp"
#include "updater/patch_status.hpp"
#include "updater/release_source.hpp"
#include "xml1/xml1_port.hpp"

namespace support
{
    namespace
    {
        // The games in the order the bug report form lists them.
        constexpr const char* game_order[] = {"xml1", "xml2", "muac", "mua", "mua2"};

        std::string env(const wchar_t* name)
        {
            std::wstring value(32768, L'\0');
            const auto length = GetEnvironmentVariableW(name, value.data(), static_cast<DWORD>(value.size()));
            if (length == 0 || length >= value.size()) return {};
            value.resize(length);
            return utils::string::convert(value);
        }

        const std::vector<redaction>& this_pc()
        {
            static const auto redactions = make_redactions(env(L"USERPROFILE"), env(L"USERNAME"), env(L"COMPUTERNAME"), env(L"HOME"));
            return redactions;
        }

        rapidjson::Value text(const std::string& value, rapidjson::Document::AllocatorType& allocator)
        {
            const auto clean = redact(value, this_pc());
            return rapidjson::Value(clean.data(), static_cast<rapidjson::SizeType>(clean.size()), allocator);
        }

        std::string fix_log_name(const std::string& key)
        {
            if (key == "muac") return "muac-fix.log";
            if (key == "xml1" || key == "xml2") return "xml2-fix.log";
            if (key == "mua" || key == "mua2") return "mua-controller-fix.log";
            return {};
        }

        std::string fix_name(const std::string& key)
        {
            if (key == "muac") return "MUA Classic Fix";
            if (key == "xml1" || key == "xml2") return "XML2 Fix";
            if (key == "mua" || key == "mua2") return "MUA Controller Fix";
            return {};
        }

        bool file_exists(const std::filesystem::path& path)
        {
            std::error_code error;
            return !path.empty() && std::filesystem::is_regular_file(path, error);
        }

        // The configured folder of a game whose files are there.
        std::optional<std::filesystem::path> installed_folder(const game_config::game_config_t& config)
        {
            const auto folder = config.get_install_path();
            if (!folder || folder->empty()) return std::nullopt;
            return game_config::validate_game_path(config.game_key, *folder) ? folder : std::nullopt;
        }

        std::string value_of(const std::map<std::string, std::string>& values, const char* name)
        {
            const auto it = values.find(name);
            return it == values.end() ? std::string{} : it->second;
        }

        void write_system(rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator)
        {
            out.SetObject();
            const auto wine = utils::nt::is_wine_environment();
            out.AddMember("wine", wine, allocator);
            std::string wine_version;
            const utils::nt::library ntdll{"ntdll.dll"};
            if (wine)
            {
                if (const auto get = ntdll.get_proc<const char*(__cdecl*)()>("wine_get_version"))
                {
                    if (const auto* const version = get()) wine_version = version;
                }
            }
            out.AddMember("wineVersion", text(wine_version, allocator), allocator);
            out.AddMember("steamDeck", env(L"SteamDeck") == "1", allocator);

            // RtlGetVersion: GetVersionEx reports what the manifest claims, not the real build.
            RTL_OSVERSIONINFOW info{};
            info.dwOSVersionInfoSize = sizeof(info);
            if (const auto get = ntdll.get_proc<LONG(WINAPI*)(RTL_OSVERSIONINFOW*)>("RtlGetVersion"))
            {
                get(&info);
            }
            std::string windows = "Windows";
            if (info.dwMajorVersion == 10)
            {
                windows = info.dwBuildNumber >= 22000 ? "Windows 11" : "Windows 10";
            }
            else if (info.dwMajorVersion)
            {
                windows = std::format("Windows {}.{}", info.dwMajorVersion, info.dwMinorVersion);
            }
            out.AddMember("windows", text(windows, allocator), allocator);
            out.AddMember("build", static_cast<unsigned>(info.dwBuildNumber), allocator);
            out.AddMember("monitors", GetSystemMetrics(SM_CMONITORS), allocator);

            // The primary monitor: MUA 2006 and the XML2 engine open on it, and its scaling decides the
            // window size of a DPI-unaware game (MUA Classic Fix 0.2.4). The launcher is per-monitor DPI
            // aware (app.manifest), so GetDpiForMonitor reports the real setting.
            rapidjson::Value primary(rapidjson::kObjectType);
            const auto desktop = xml2_display::desktop();
            primary.AddMember("width", desktop.width, allocator);
            primary.AddMember("height", desktop.height, allocator);
            primary.AddMember("refresh", desktop.refresh, allocator);
            UINT dpi = 0;
            const utils::nt::library shcore{"shcore.dll"};
            if (const auto get_dpi = shcore ? shcore.get_proc<HRESULT(WINAPI*)(HMONITOR, int, UINT*, UINT*)>("GetDpiForMonitor") : nullptr)
            {
                UINT dpi_x = 0, dpi_y = 0;
                const auto monitor = MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
                if (SUCCEEDED(get_dpi(monitor, 0 /*MDT_EFFECTIVE_DPI*/, &dpi_x, &dpi_y))) dpi = dpi_x;
            }
            primary.AddMember("dpi", dpi, allocator);
            primary.AddMember("scale", dpi ? static_cast<int>((dpi * 100 + 48) / 96) : 0, allocator);
            out.AddMember("primary", primary, allocator);
        }

        void write_launcher(rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator)
        {
            out.SetObject();
            out.AddMember("version", text(VERSION, allocator), allocator);
            out.AddMember("channel", text(release_channel::channel_name(release_source::current_channel()), allocator), allocator);
            const auto portable = utils::properties::is_portable();
            out.AddMember("portable", portable, allocator);
            out.AddMember("offline", utils::flags::has_flag("offline"), allocator);
            // The data folder only when it is the per-user one (%USERPROFILE%\AppData\Local\...); a portable
            // folder can be anywhere, so it is not shown.
            out.AddMember("dataFolder",
                          text(portable ? std::string{} : utils::string::path_to_utf8(utils::properties::get_appdata_path()), allocator),
                          allocator);
        }

        void write_game(const game_config::game_config_t& config, rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator)
        {
            out.SetObject();
            const auto& key = config.game_key;
            out.AddMember("id", text(key, allocator), allocator);
            out.AddMember("name", text(config.display_name, allocator), allocator);
            const auto configured = config.get_install_path();
            const bool has_folder = configured && !configured->empty();
            const auto folder = installed_folder(config);
            out.AddMember("configured", has_folder, allocator);
            out.AddMember("installed", folder.has_value(), allocator);
            out.AddMember("folder", text(has_folder ? folder_name(utils::string::path_to_utf8(*configured)) : std::string{}, allocator),
                          allocator);

            rapidjson::Value fix(rapidjson::kObjectType);
            fix.AddMember("name", text(fix_name(key), allocator), allocator);
            std::optional<std::string> version;
            std::optional<std::string> runtime;
            if (folder)
            {
                if (key == "muac")
                {
                    version = patch_status::muac_installed_version(*folder);
                    runtime = patch_status::installed_version(*folder / L"dinput8.dll");
                }
                else if (!config.patch_file.empty())
                {
                    version = patch_channel::installed_version(config, *folder);
                }
            }
            // null: not installed; "": installed without a version the launcher can read.
            fix.AddMember("version", version ? text(*version, allocator) : rapidjson::Value(rapidjson::kNullType), allocator);
            if (key == "muac")
            {
                fix.AddMember("runtime", runtime ? text(*runtime, allocator) : rapidjson::Value(rapidjson::kNullType), allocator);
            }
            out.AddMember("fix", fix, allocator);

            // The display mode the launcher knows for this game.
            rapidjson::Value display(rapidjson::kObjectType);
            if (folder && key == "muac")
            {
                if (utils::nt::is_wine_environment())
                {
                    display.AddMember("proton", true, allocator);
                }
                else
                {
                    const auto values = muac::read(*folder);
                    display.AddMember("mode", text(value_of(values, "Mode"), allocator), allocator);
                    display.AddMember("resolution", text(value_of(values, "Resolution"), allocator), allocator);
                }
            }
            else if (folder && (key == "xml1" || key == "xml2"))
            {
                const auto where = fix_ini::locate(config);
                if (const auto ini = where.ini(); ini && where.fix_installed)
                {
                    const auto values = fix_ini::read(*ini, L"Display", {"Mode", "Width", "Height"});
                    display.AddMember("mode", text(value_of(values, "Mode"), allocator), allocator);
                    display.AddMember("width", text(value_of(values, "Width"), allocator), allocator);
                    display.AddMember("height", text(value_of(values, "Height"), allocator), allocator);
                }
            }
            out.AddMember("display", display, allocator);

            // Legends Classic: the build in the folder and the builder installed.
            if (key == "xml1")
            {
                rapidjson::Document status;
                xml1_port::write_status(status, status.GetAllocator());
                const auto section = [&](const char* name) -> const rapidjson::Value*
                {
                    return status.IsObject() && status.HasMember(name) && status[name].IsObject() ? &status[name] : nullptr;
                };
                const auto string_at = [&](const char* name, const char* member) -> std::string
                {
                    const auto* object = section(name);
                    return object && object->HasMember(member) && (*object)[member].IsString() ? (*object)[member].GetString() : std::string{};
                };
                const auto int_at = [&](const char* name, const char* member) -> int
                {
                    const auto* object = section(name);
                    return object && object->HasMember(member) && (*object)[member].IsInt() ? (*object)[member].GetInt() : 0;
                };
                rapidjson::Value build(rapidjson::kObjectType);
                build.AddMember("builder", text(string_at("build", "builderVersion"), allocator), allocator);
                build.AddMember("content", int_at("build", "contentVersion"), allocator);
                build.AddMember("builderInstalled", text(string_at("builder", "version"), allocator), allocator);
                out.AddMember("build", build, allocator);
            }
        }

        bool shell_open_folder(const std::filesystem::path& file)
        {
            if (!utils::nt::is_wine_environment())
            {
                const auto parameters = L"/select,\"" + file.wstring() + L"\"";
                return reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", L"explorer.exe", parameters.c_str(), nullptr, SW_SHOWNORMAL)) > 32;
            }
            // Wine routes "open" on a folder to the Linux file manager (winebrowser / xdg-open). The trailing
            // separator keeps Wine from running "<folder>.exe" instead: its ShellExecute looks for the name with
            // ".exe" first, and the portable data folder "ultimate-legends" sits beside ultimate-legends.exe.
            auto folder = file.parent_path().wstring();
            if (!folder.empty() && folder.back() != L'\\') folder.push_back(L'\\');
            auto result = ShellExecuteW(nullptr, L"explore", folder.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
            if (reinterpret_cast<INT_PTR>(result) <= 32)
            {
                result = ShellExecuteW(nullptr, L"open", folder.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
            }
            return reinterpret_cast<INT_PTR>(result) > 32;
        }
    }

    std::vector<log_location> logs()
    {
        std::vector<log_location> out;
        const auto add = [&](std::string id, std::string game, std::string file, std::filesystem::path path)
        {
            const bool available = file_exists(path);
            out.push_back({std::move(id), std::move(game), std::move(file), available, std::move(path)});
        };

        // ultimate-legends.log goes to the working directory, which main.cpp sets to the data folder.
        add("launcher", {}, "ultimate-legends.log", utils::properties::get_appdata_path() / L"ultimate-legends.log");
        // Self-update keeps its own log next to the portable launcher (updater/launcher_update.cpp).
        add("updates", {}, "update.log", utils::properties::get_portable_root() / L"updates" / L"update.log");

        for (const auto* key : game_order)
        {
            const auto config = game_config::get_game_config(key);
            if (!config) continue;
            const auto folder = installed_folder(*config);
            if (!folder) continue;
            const auto name = fix_log_name(key);
            add(std::string("fix:") + key, key, name, *folder / utils::string::utf8_to_path(name));
            if (std::string(key) == "xml1")
            {
                const auto log = xml1_port::build_log();
                add("builder", key, log ? utils::string::path_to_utf8(log->filename()) : std::string("builder.log"),
                    log.value_or(std::filesystem::path{}));
            }
        }
        return out;
    }

    void write_logs(rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator)
    {
        out.SetArray();
        for (const auto& log : logs())
        {
            rapidjson::Value entry(rapidjson::kObjectType);
            entry.AddMember("id", text(log.id, allocator), allocator);
            entry.AddMember("game", text(log.game, allocator), allocator);
            entry.AddMember("file", text(log.file, allocator), allocator);
            entry.AddMember("available", log.available, allocator);
            out.PushBack(entry, allocator);
        }
    }

    bool open_log(const std::string& id)
    {
        for (const auto& log : logs())
        {
            if (log.id == id)
            {
                return log.available && shell_open_folder(log.path);
            }
        }
        return false;
    }

    void write_diagnostics(rapidjson::Document& out)
    {
        out.SetObject();
        auto& allocator = out.GetAllocator();

        rapidjson::Value launcher;
        write_launcher(launcher, allocator);
        out.AddMember("launcher", launcher, allocator);

        rapidjson::Value system;
        write_system(system, allocator);
        out.AddMember("system", system, allocator);

        rapidjson::Value games(rapidjson::kArrayType);
        for (const auto* key : game_order)
        {
            if (const auto config = game_config::get_game_config(key))
            {
                rapidjson::Value game;
                write_game(*config, game, allocator);
                games.PushBack(game, allocator);
            }
        }
        out.AddMember("games", games, allocator);

        rapidjson::Value log_list;
        write_logs(log_list, allocator);
        out.AddMember("logs", log_list, allocator);
    }

    bool copy_text(const std::string& text_utf8, void* owner_window)
    {
        const auto wide = utils::string::convert(text_utf8);
        if (!OpenClipboard(static_cast<HWND>(owner_window))) return false;
        bool ok = false;
        if (EmptyClipboard())
        {
            const auto bytes = (wide.size() + 1) * sizeof(wchar_t);
            if (auto* const memory = GlobalAlloc(GMEM_MOVEABLE, bytes))
            {
                if (auto* const target = GlobalLock(memory))
                {
                    std::memcpy(target, wide.c_str(), bytes);
                    GlobalUnlock(memory);
                    ok = SetClipboardData(CF_UNICODETEXT, memory) != nullptr;
                }
                if (!ok) GlobalFree(memory);
            }
        }
        CloseClipboard();
        return ok;
    }
}
