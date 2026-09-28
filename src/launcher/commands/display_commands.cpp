#include "std_include.hpp"
#include "display_commands.hpp"
#include "cef/cef_ui.hpp"
#include "display/xml2_display.hpp"

#include <utils/io.hpp>
#include <utils/string.hpp>

namespace commands::display_commands
{
    namespace
    {
        // Only X-Men Legends II has the fix with a [Display] section; MUA's controller fix has none.
        constexpr auto supported_game = "xml2";

        rapidjson::Value make_string(const std::string& text, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value value{};
            value.SetString(text.data(), static_cast<rapidjson::SizeType>(text.size()), allocator);
            return value;
        }

        std::optional<int> to_int(const std::string& text)
        {
            try
            {
                std::size_t used{};
                const auto value = std::stoi(text, &used);
                return used == text.size() ? std::optional{value} : std::nullopt;
            }
            catch (...)
            {
                return std::nullopt;
            }
        }

        // The ini's values as the UI wants them: Mode/FrameRate strings, Width/Height numbers,
        // the flags booleans; null when the key is absent (game default).
        rapidjson::Value values_json(const std::map<std::string, std::string>& values, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value object(rapidjson::kObjectType);
            for (const auto& key : xml2_display::keys())
            {
                rapidjson::Value name = make_string(key, allocator);
                const auto it = values.find(key);
                if (it == values.end())
                {
                    object.AddMember(name, rapidjson::Value(rapidjson::kNullType), allocator);
                    continue;
                }

                std::string unused;
                const auto normalised = xml2_display::normalise(key, it->second, unused);
                if (key == "Width" || key == "Height")
                {
                    const auto number = normalised ? to_int(*normalised) : std::nullopt;
                    if (number)
                    {
                        object.AddMember(name, *number, allocator);
                    }
                    else
                    {
                        object.AddMember(name, make_string(it->second, allocator), allocator); // unreadable: shown as is
                    }
                }
                else if (key == "Topmost" || key == "RunInBackground" || key == "VSync")
                {
                    if (normalised)
                    {
                        object.AddMember(name, *normalised == "1", allocator);
                    }
                    else
                    {
                        object.AddMember(name, make_string(it->second, allocator), allocator);
                    }
                }
                else
                {
                    object.AddMember(name, make_string(normalised.value_or(it->second), allocator), allocator);
                }
            }
            return object;
        }

        void set_result(rapidjson::Document& response, const bool success, const std::string& error = {})
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();
            response.AddMember("success", success, allocator);
            if (!error.empty())
            {
                response.AddMember("error", make_string(error, allocator), allocator);
            }
        }

        std::optional<std::filesystem::path> game_dir_or_fail(const command_context& ctx, const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto config = ctx.get_game_config_from_request(value);
            if (!config || config->get_game_key() != supported_game)
            {
                set_result(response, false, "This game has no display settings.");
                return std::nullopt;
            }
            const auto path = config->get_install_path();
            if (!path || !utils::io::directory_exists(*path))
            {
                set_result(response, false, "Set up the game first.");
                return std::nullopt;
            }
            if (!xml2_display::fix_installed(*path))
            {
                set_result(response, false, "Install the XML2 Fix first.");
                return std::nullopt;
            }
            return path;
        }
    }

    void register_commands(cef::cef_ui& cef_ui, command_context& ctx)
    {
        // { supported, installed, fixInstalled, running, ini, values: { Mode, Width, Height, Topmost,
        //   RunInBackground, FrameRate, VSync }, modes: [{ width, height }], desktop: { width, height, refresh } }
        cef_ui.add_command("get-display-settings", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            response.SetObject();
            auto& allocator = response.GetAllocator();

            const auto config = ctx.get_game_config_from_request(value);
            const auto supported = config && config->get_game_key() == supported_game;
            const auto path = supported ? config->get_install_path() : std::nullopt;
            const auto installed = path && utils::io::directory_exists(*path);
            const auto fix_installed = installed && xml2_display::fix_installed(*path);

            response.AddMember("supported", supported, allocator);
            response.AddMember("installed", installed, allocator);
            response.AddMember("fixInstalled", fix_installed, allocator);
            response.AddMember("running", supported && game_config::is_game_process_running(config->get_game_key()), allocator);

            std::map<std::string, std::string> values;
            if (fix_installed)
            {
                response.AddMember("ini", make_string(utils::string::path_to_utf8(xml2_display::ini_path(*path)), allocator), allocator);
                values = xml2_display::read(*path);
            }
            response.AddMember("values", values_json(values, allocator), allocator);

            rapidjson::Value modes(rapidjson::kArrayType);
            for (const auto& mode : xml2_display::display_modes())
            {
                rapidjson::Value item(rapidjson::kObjectType);
                item.AddMember("width", mode.width, allocator);
                item.AddMember("height", mode.height, allocator);
                modes.PushBack(item, allocator);
            }
            response.AddMember("modes", modes, allocator);

            const auto desktop = xml2_display::desktop();
            rapidjson::Value desktop_json(rapidjson::kObjectType);
            desktop_json.AddMember("width", desktop.width, allocator);
            desktop_json.AddMember("height", desktop.height, allocator);
            desktop_json.AddMember("refresh", desktop.refresh, allocator);
            response.AddMember("desktop", desktop_json, allocator);
        });

        // { game, values: { Key: value | null, ... } }: writes the given keys (null removes one) and
        // answers { success, error, values } with the ini's values afterwards.
        cef_ui.add_command("set-display-settings", [&ctx](const rapidjson::Value& value, rapidjson::Document& response)
        {
            const auto path = game_dir_or_fail(ctx, value, response);
            if (!path)
            {
                return;
            }

            std::vector<xml2_display::change> changes;
            if (value.HasMember("values") && value["values"].IsObject())
            {
                // (Not GetObject(): windows.h turns that name into GetObjectA.)
                const auto& values = value["values"];
                for (auto it = values.MemberBegin(); it != values.MemberEnd(); ++it)
                {
                    xml2_display::change change{};
                    change.key = it->name.GetString();
                    if (it->value.IsString())
                    {
                        change.value = it->value.GetString();
                    }
                    else if (it->value.IsBool())
                    {
                        change.value = it->value.GetBool() ? "1" : "0";
                    }
                    else if (it->value.IsNumber())
                    {
                        change.value = std::to_string(static_cast<long long>(it->value.GetDouble()));
                    }
                    else if (!it->value.IsNull())
                    {
                        set_result(response, false, "Unsupported value for " + change.key + ".");
                        return;
                    }
                    changes.push_back(std::move(change));
                }
            }
            if (changes.empty())
            {
                set_result(response, false, "Nothing to change.");
                return;
            }

            std::string error;
            const auto ok = xml2_display::write(*path, changes, error);
            set_result(response, ok, error);
            response.AddMember("values", values_json(xml2_display::read(*path), response.GetAllocator()), response.GetAllocator());
        });
    }
}
