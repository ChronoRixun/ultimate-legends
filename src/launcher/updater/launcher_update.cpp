#include "std_include.hpp"
#include "launcher_update.hpp"
#include "progress_tracker.hpp"

#include "tools/archive.hpp"
#include "tools/tool_install.hpp"
#include "xml1/xml1_port.hpp"

#include <utils/finally.hpp>
#include <utils/flags.hpp>
#include <utils/http.hpp>
#include <utils/io.hpp>
#include <utils/logger.hpp>
#include <utils/nt.hpp>
#include <utils/properties.hpp>
#include <utils/property_keys.hpp>
#include <utils/string.hpp>

#include <version.hpp>

#include <rapidjson/writer.h>
#include <shellapi.h>

namespace launcher_update
{
    namespace
    {
        constexpr auto release_api = "https://api.github.com/repos/ChronoRixun/ultimate-legends/releases/latest";
        constexpr auto release_page = "https://github.com/ChronoRixun/ultimate-legends/releases/latest";
        constexpr auto exe_name = "ultimate-legends.exe";
        constexpr auto sums_name = "SHA256SUMS.txt";

        struct release
        {
            std::string version;
            std::string page;
            std::string zip;
            std::string zip_url;
            std::uint64_t size{};
            std::string sums_url;
        };

        struct state_t
        {
            // idle, checking, up-to-date, check-failed, available, downloading, ready, failed
            std::string state = "idle";
            std::optional<release> latest;
            std::uint64_t done{};
            std::uint64_t total{};
            std::string error;
            std::string install_error; // a downloaded update this start could not install
            std::string ready_version;
            std::string updated_to; // this start finished an update to this version
            std::chrono::system_clock::time_point checked{};
        };

        std::mutex mutex_;
        state_t state_;

        template <typename F>
        void with_state(F&& f)
        {
            std::lock_guard lock(mutex_);
            f(state_);
        }

        rapidjson::Value make_string(const std::string& text, rapidjson::Document::AllocatorType& allocator)
        {
            rapidjson::Value value{};
            value.SetString(text.data(), static_cast<rapidjson::SizeType>(text.size()), allocator);
            return value;
        }

        std::string json_string(const rapidjson::Value& object, const char* key)
        {
            if (!object.IsObject())
            {
                return {};
            }
            const auto member = object.FindMember(key);
            return member != object.MemberEnd() && member->value.IsString() ? member->value.GetString() : std::string{};
        }

        // A file or folder name without paths in it ("cef", "launcher-ui").
        bool is_plain_name(const std::string& name)
        {
            return tool_install::is_safe_version(name);
        }

        // The version this launcher is, for updating; empty for a development build, which never
        // updates: Debug builds (unless a test sets dev-launcher-version) and builds not made
        // exactly at a release tag (GIT_DESCRIBE "v0.1.1-3-gabc1234" or "v0.1.1-dirty").
        std::string current_version()
        {
#ifdef _DEBUG
            const auto version = utils::properties::load(property_keys::DEV_LAUNCHER_VERSION).value_or("");
            return tool_install::is_safe_version(version) ? version : std::string{};
#else
            const std::string version = VERSION_PRODUCT;
            const std::string describe = GIT_DESCRIBE;
            const std::string tag = GIT_TAG;
            if (version == "0.0.0" || version.find('-') != std::string::npos || tag.empty() || describe != tag)
            {
                return {};
            }
            return version;
#endif
        }

        std::string release_url()
        {
#ifdef _DEBUG
            return utils::properties::load(property_keys::DEV_LAUNCHER_RELEASE).value_or("");
#else
            return release_api;
#endif
        }

        bool is_download_url(const std::string& url)
        {
#ifdef _DEBUG
            if (url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:"))
            {
                return true; // the test's local server
            }
#endif
            return url.starts_with("https://");
        }

        std::filesystem::path portable_root()
        {
            return utils::properties::get_portable_root();
        }

        // Only the release zip's layout updates itself: portable by its marker file (not the
        // -portable flag alone), so the data folder is the one next to the executable.
        bool can_install()
        {
            std::error_code error;
            return utils::properties::is_portable() && std::filesystem::exists(utils::properties::get_portable_marker(), error);
        }

        std::filesystem::path updates_folder()
        {
            return portable_root() / "updates";
        }

        std::filesystem::path exe_path()
        {
            static const auto path = utils::nt::library{}.get_path();
            return path;
        }

        bool path_exists(const std::filesystem::path& path)
        {
            std::error_code error;
            return std::filesystem::exists(path, error);
        }

        bool remove_tree(const std::filesystem::path& path)
        {
            std::error_code error;
            std::filesystem::remove_all(path, error);
            return !path_exists(path);
        }

        bool move_path(const std::filesystem::path& from, const std::filesystem::path& to)
        {
            // On one drive a rename, which Windows allows for a running executable too.
            if (MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_WRITE_THROUGH))
            {
                return true;
            }
            utils::logger::write("launcher update: rename {} -> {} failed: {}", utils::string::path_to_utf8(from),
                                 utils::string::path_to_utf8(to), std::system_category().message(static_cast<int>(GetLastError())));
            return false;
        }

        std::string read_json_string(const std::filesystem::path& file, const char* key)
        {
            std::string data;
            if (!utils::io::read_file(file, &data))
            {
                return {};
            }
            rapidjson::Document document;
            document.Parse(data.data(), data.size());
            return document.HasParseError() ? std::string{} : json_string(document, key);
        }

        void write_document(const std::filesystem::path& file, const rapidjson::Document& document)
        {
            rapidjson::StringBuffer buffer;
            rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
            document.Accept(writer);
            utils::io::write_file(file, std::string(buffer.GetString(), buffer.GetLength()));
        }

        void write_json(const std::filesystem::path& file, const std::vector<std::pair<std::string, std::string>>& members)
        {
            rapidjson::Document document(rapidjson::kObjectType);
            auto& allocator = document.GetAllocator();
            for (const auto& [key, value] : members)
            {
                document.AddMember(make_string(key, allocator), make_string(value, allocator), allocator);
            }
            write_document(file, document);
        }

        // ---- the swap ----

        struct item
        {
            std::string name;           // "exe" or "data/<folder>"
            std::filesystem::path live; // where the launcher uses it
            std::filesystem::path next; // the new one, in updates\ready
            std::filesystem::path prev; // the old one while swapping, in updates\previous
        };

        std::vector<item> items_for(const std::vector<std::string>& names)
        {
            const auto updates = updates_folder();
            std::vector<item> items;
            for (const auto& name : names)
            {
                if (name == "exe")
                {
                    items.push_back({name, exe_path(), updates / "ready" / exe_name, updates / "previous" / exe_name});
                    continue;
                }
                const auto folder = utils::string::utf8_to_path(name.substr(5));
                items.push_back({name, portable_root() / "data" / folder, updates / "ready" / "data" / folder,
                                 updates / "previous" / "data" / folder});
            }
            return items;
        }

        // What updates\ready brings: every folder in its data\ (cef, launcher-ui), then the exe.
        std::vector<std::string> ready_names()
        {
            std::vector<std::string> names;
            std::error_code error;
            for (const auto& entry : std::filesystem::directory_iterator(updates_folder() / "ready" / "data", error))
            {
                const auto name = utils::string::path_to_utf8(entry.path().filename());
                if (entry.is_directory(error) && is_plain_name(name))
                {
                    names.push_back("data/" + name);
                }
            }
            names.push_back("exe");
            return names;
        }

        bool swap(const std::vector<item>& items)
        {
            for (const auto& entry : items)
            {
                if (path_exists(entry.live) && !move_path(entry.live, entry.prev))
                {
                    return false;
                }
                if (!move_path(entry.next, entry.live))
                {
                    return false;
                }
            }
            return true;
        }

        // Undoes swap() from any point: what moved in goes back to ready\, what moved out comes back.
        bool roll_back(const std::vector<item>& items)
        {
            auto ok = true;
            for (auto it = items.rbegin(); it != items.rend(); ++it)
            {
                // Moved in: the new one is live and gone from ready\ (the exe only with the old one saved).
                if (path_exists(it->live) && !path_exists(it->next) && (path_exists(it->prev) || it->name != "exe"))
                {
                    ok = move_path(it->live, it->next) && ok;
                }
                if (path_exists(it->prev) && !path_exists(it->live))
                {
                    ok = move_path(it->prev, it->live) && ok;
                }
            }
            return ok;
        }

        void write_journal(const std::filesystem::path& file, const std::string& version, const std::vector<item>& items)
        {
            rapidjson::Document document(rapidjson::kObjectType);
            auto& allocator = document.GetAllocator();
            document.AddMember("version", make_string(version, allocator), allocator);
            rapidjson::Value names(rapidjson::kArrayType);
            for (const auto& entry : items)
            {
                names.PushBack(make_string(entry.name, allocator), allocator);
            }
            document.AddMember("items", names, allocator);
            write_document(file, document);
        }

        std::vector<std::string> read_journal(const std::filesystem::path& file)
        {
            std::string data;
            std::vector<std::string> names;
            if (!utils::io::read_file(file, &data))
            {
                return names;
            }
            rapidjson::Document document;
            document.Parse(data.data(), data.size());
            if (document.HasParseError() || !document.IsObject() || !document.HasMember("items") || !document["items"].IsArray())
            {
                return names;
            }
            for (const auto& value : document["items"].GetArray())
            {
                const std::string name = value.IsString() ? value.GetString() : "";
                if (name == "exe" || (name.starts_with("data/") && is_plain_name(name.substr(5))))
                {
                    names.push_back(name);
                }
            }
            return names;
        }

        void note_failure(const std::string& version, const std::string& message)
        {
            utils::logger::write("launcher update {}: {}", version, message);
            write_json(updates_folder() / "failed.json", {{"version", version}, {"error", message}});
        }

        // ---- the release ----

        std::optional<release> fetch_release(std::string& error)
        {
            const auto url = release_url();
            if (url.empty())
            {
                error = "No release address.";
                return std::nullopt;
            }
            const utils::http::headers headers{
                {"Accept", "application/vnd.github+json"},
                {"User-Agent", "ultimate-legends-launcher"},
                {"X-GitHub-Api-Version", "2022-11-28"},
            };
            const auto result = utils::http::get_data(url, {}, headers, {}, 20, 1);
            if (!result || result->code != CURLE_OK)
            {
                error = std::format("Could not reach GitHub ({}).", result ? curl_easy_strerror(result->code) : "no connection");
                return std::nullopt;
            }
            if (result->response_code == 404)
            {
                error = "No release has been published.";
                return std::nullopt;
            }
            if (result->response_code != 200)
            {
                error = std::format("GitHub answered HTTP {}.", result->response_code);
                return std::nullopt;
            }

            rapidjson::Document document;
            document.Parse(result->buffer.data(), result->buffer.size());
            if (document.HasParseError() || !document.IsObject())
            {
                error = "GitHub's answer is not valid JSON.";
                return std::nullopt;
            }

            release latest{};
            const auto tag = json_string(document, "tag_name");
            latest.version = tag.starts_with('v') || tag.starts_with('V') ? tag.substr(1) : tag;
            latest.page = json_string(document, "html_url");
            if (!latest.page.starts_with("https://"))
            {
                latest.page = release_page;
            }
            if (!tool_install::is_safe_version(latest.version) || !std::isdigit(static_cast<unsigned char>(latest.version.front())))
            {
                error = "The latest release has no version in its tag (" + tag + ").";
                return std::nullopt;
            }

            // tools/package-portable.ps1's names.
            const auto zip = "ultimate-legends-" + latest.version + "-win64-portable.zip";
            if (document.HasMember("assets") && document["assets"].IsArray())
            {
                for (const auto& asset : document["assets"].GetArray())
                {
                    const auto name = json_string(asset, "name");
                    const auto download = json_string(asset, "browser_download_url");
                    if (!is_download_url(download))
                    {
                        continue;
                    }
                    if (name == zip && asset.HasMember("size") && asset["size"].IsUint64())
                    {
                        latest.zip = name;
                        latest.zip_url = download;
                        latest.size = asset["size"].GetUint64();
                    }
                    else if (name == sums_name)
                    {
                        latest.sums_url = download;
                    }
                }
            }
            if (latest.zip.empty() || latest.sums_url.empty() || !latest.size)
            {
                // A release still being published (its files upload after it is created).
                error = "Release " + latest.version + " has no portable zip and SHA256SUMS.txt (yet).";
                return std::nullopt;
            }
            return latest;
        }

        // The SHA-256 SHA256SUMS.txt gives `name` ("<hash>  <name>" or "<hash> *<name>" lines).
        std::string expected_sha256(const std::string& sums, const std::string& name)
        {
            std::istringstream lines(sums);
            std::string line;
            while (std::getline(lines, line))
            {
                if (!line.empty() && line.back() == '\r')
                {
                    line.pop_back();
                }
                if (line.size() < 66)
                {
                    continue;
                }
                const auto hash = utils::string::to_lower(line.substr(0, 64));
                auto file = line.substr(64);
                file.erase(0, file.find_first_not_of(' '));
                if (file.starts_with('*'))
                {
                    file.erase(0, 1);
                }
                const auto hex = std::all_of(hash.begin(), hash.end(), [](const char c)
                {
                    return std::isxdigit(static_cast<unsigned char>(c)) != 0;
                });
                if (hex && file == name)
                {
                    return hash;
                }
            }
            return {};
        }

        // The folder of an unpacked release that holds ultimate-legends.exe: the top, or the one
        // folder in it (the zip's ultimate-legends-<version>-win64-portable\).
        std::optional<std::filesystem::path> content_root(const std::filesystem::path& unpacked)
        {
            if (utils::io::file_exists(unpacked / exe_name))
            {
                return unpacked;
            }
            std::error_code error;
            std::optional<std::filesystem::path> only;
            for (const auto& entry : std::filesystem::directory_iterator(unpacked, error))
            {
                if (only)
                {
                    return std::nullopt;
                }
                only = entry.path();
            }
            if (only && std::filesystem::is_directory(*only, error) && utils::io::file_exists(*only / exe_name))
            {
                return only;
            }
            return std::nullopt;
        }

        // A launcher in `folder` (updates\ready's layout) has what it needs to start.
        bool is_complete(const std::filesystem::path& folder)
        {
            return utils::io::file_exists(folder / exe_name) &&
                   utils::io::file_exists(folder / "data" / "cef" / CONFIG_NAME / "libcef.dll") &&
                   utils::io::file_exists(folder / "data" / "launcher-ui" / "main.html");
        }

        // Download, verify, unpack into updates\ready; "" or a message for the player.
        std::string stage(const release& latest)
        {
            const auto updates = updates_folder();
            std::error_code fs_error;
            std::filesystem::create_directories(updates, fs_error);
            const auto staging = updates / std::format(".staging-{}-{}", GetCurrentProcessId(), GetTickCount64());
            std::filesystem::create_directories(staging, fs_error);
            if (fs_error)
            {
                return "Could not create a folder in " + utils::string::path_to_utf8(updates) + ": " + fs_error.message();
            }
            const auto cleanup = utils::finally([&staging]
            {
                remove_tree(staging);
            });

            const auto sums = utils::http::get_data(latest.sums_url, {}, {}, {}, 30, 2);
            if (!sums || sums->code != CURLE_OK || sums->response_code != 200)
            {
                return "Could not download the release's SHA256SUMS.txt.";
            }
            const auto sha256 = expected_sha256(sums->buffer, latest.zip);
            if (sha256.empty())
            {
                return "The release's SHA256SUMS.txt has no line for " + latest.zip + ".";
            }

            const auto zip = staging / utils::string::utf8_to_path(latest.zip);
            std::string actual;
            std::string failure;
            for (int attempt = 0; attempt < 3; ++attempt)
            {
                failure = tool_install::download_file(latest.zip_url, zip, latest.size, [](const std::uint64_t done, const std::uint64_t total)
                {
                    with_state([&](state_t& state)
                    {
                        state.done = done;
                        state.total = total;
                    });
                }, {}, actual);
                if (failure.empty() || failure.starts_with("The download is larger"))
                {
                    break;
                }
                utils::logger::write("launcher update: download attempt {} failed: {}", attempt + 1, failure);
                std::this_thread::sleep_for(std::chrono::seconds(1));
            }
            if (!failure.empty())
            {
                return failure;
            }
            if (actual != sha256)
            {
                utils::logger::write("launcher update: {} SHA-256 {} expected {}", latest.zip, actual, sha256);
                return "The download does not match the release's SHA-256, so it was not used.";
            }

            const auto unpacked = staging / "unpacked";
            if (const auto error = archive::extract_zip(zip, unpacked); !error.empty())
            {
                return error;
            }
            utils::io::remove_file(zip);
            const auto content = content_root(unpacked);
            const auto data = content ? *content / "ultimate-legends" / "data" : std::filesystem::path{};
            if (!content || !utils::io::directory_exists(data))
            {
                return "The release's zip is not a portable Ultimate Legends.";
            }

            // updates\ready's layout: the exe and data\, update.json last.
            const auto ready = staging / "ready";
            std::filesystem::create_directories(ready, fs_error);
            if (!move_path(*content / exe_name, ready / exe_name) || !move_path(data, ready / "data") || !is_complete(ready))
            {
                return "The release's zip is missing parts of the launcher.";
            }
            write_json(ready / "update.json", {{"version", latest.version}, {"zip", latest.zip}, {"sha256", sha256}});

            const auto target = updates / "ready";
            if (!remove_tree(target) || !move_path(ready, target))
            {
                return "Could not move the update into place in " + utils::string::path_to_utf8(updates) + ".";
            }
            utils::logger::write("launcher update: {} downloaded and verified (SHA-256 {})", latest.version, sha256);
            return {};
        }

        // This process's -flags (not a deep link), to start the launcher again with.
        std::vector<std::wstring> flag_arguments()
        {
            std::vector<std::wstring> flags;
            int count = 0;
            auto* const argv = CommandLineToArgvW(GetCommandLineW(), &count);
            if (!argv)
            {
                return flags;
            }
            for (int i = 1; i < count; ++i)
            {
                if (argv[i][0] == L'-')
                {
                    flags.emplace_back(argv[i]);
                }
            }
            LocalFree(argv);
            return flags;
        }
    }

    bool apply_pending()
    {
        if (!can_install())
        {
            return false;
        }

        const auto updates = updates_folder();
        const auto journal = updates / "applying.json";
        const auto ready = updates / "ready";
        const auto previous = updates / "previous";

        // A swap that never finished (the process died mid-way): put the old launcher back.
        if (path_exists(journal))
        {
            const auto version = read_json_string(journal, "version");
            const auto items = items_for(read_journal(journal));
            const auto exe_moved = path_exists(previous / exe_name);
            if (!roll_back(items))
            {
                utils::logger::write("launcher update: rolling back the interrupted update to {} failed; trying again next start", version);
                return false;
            }
            utils::io::remove_file(journal);
            remove_tree(ready);
            note_failure(version, "The update was interrupted and the previous version was put back.");
            if (exe_moved)
            {
                return true; // this process may be the new executable: start the restored one
            }
        }

        const auto version = read_json_string(ready / "update.json", "version");
        if (version.empty())
        {
            return false;
        }
        const auto current = current_version();
        if (current.empty())
        {
            return false; // a development build never installs one
        }
        if (!tool_install::is_safe_version(version) || tool_install::compare_versions(version, current) <= 0 || !is_complete(ready))
        {
            utils::logger::write("launcher update: discarding updates\\ready ({}; this is {})", version, current);
            remove_tree(ready);
            return false;
        }

        // Leftovers of an earlier update; still in use means an older launcher process still runs.
        for (auto attempt = 0; !remove_tree(previous); ++attempt)
        {
            if (attempt >= 20)
            {
                note_failure(version, "The previous version's files stayed in use.");
                remove_tree(ready);
                return false;
            }
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
        std::error_code fs_error;
        std::filesystem::create_directories(previous / "data", fs_error);

        const auto items = items_for(ready_names());
        write_journal(journal, version, items);
        utils::logger::write("launcher update: installing {} over {}", version, current);

        // The previous launcher's processes (CEF's helpers outlive it by a few seconds) hold its
        // files: a folder that can't be renamed yet rolls everything back, and it waits and retries.
        auto installed = false;
        for (auto attempt = 0; attempt < 30 && !installed; ++attempt)
        {
            installed = swap(items);
            if (!installed)
            {
                if (!roll_back(items))
                {
                    utils::logger::write("launcher update: roll back failed; the next start finishes it");
                    return false;
                }
                std::this_thread::sleep_for(std::chrono::seconds(1));
            }
        }
        if (!installed)
        {
            utils::io::remove_file(journal);
            remove_tree(ready);
            note_failure(version, "Its files could not be put in place (another program held the launcher's files).");
            return false;
        }

        // Committed: from here on the new version stands.
        utils::io::remove_file(journal);
        remove_tree(ready);
        write_json(updates / "applied.json", {{"from", current}, {"to", version}});
        utils::logger::write("launcher update: installed {}", version);
        return true;
    }

    void relaunch()
    {
        std::wstring command_line = L"\"" + exe_path().wstring() + L"\"";
        for (const auto& flag : flag_arguments())
        {
            command_line += L" \"" + flag + L"\"";
        }

        STARTUPINFOW startup_info{};
        startup_info.cb = sizeof(startup_info);
        PROCESS_INFORMATION process_info{};
        if (CreateProcessW(exe_path().c_str(), command_line.data(), nullptr, nullptr, FALSE, CREATE_NEW_PROCESS_GROUP, nullptr,
                           nullptr, &startup_info, &process_info))
        {
            CloseHandle(process_info.hThread);
            CloseHandle(process_info.hProcess);
        }
        else
        {
            utils::logger::write("launcher update: could not start {}: {}", utils::string::path_to_utf8(exe_path()),
                                 std::system_category().message(static_cast<int>(GetLastError())));
        }
    }

    void cleanup()
    {
        if (!can_install())
        {
            return;
        }
        const auto updates = updates_folder();

        if (const auto to = read_json_string(updates / "applied.json", "to"); !to.empty())
        {
            with_state([&](state_t& state)
            {
                state.updated_to = to;
            });
        }
        utils::io::remove_file(updates / "applied.json");

        if (const auto version = read_json_string(updates / "failed.json", "version"); !version.empty())
        {
            const auto error = read_json_string(updates / "failed.json", "error");
            with_state([&](state_t& state)
            {
                state.install_error = "Version " + version + " could not be installed. " + error + " Your launcher was not changed.";
            });
        }
        utils::io::remove_file(updates / "failed.json");

        std::thread([updates]
        {
            // The previous executable may still run for a moment (it started this one).
            for (auto attempt = 0; attempt < 30 && path_exists(updates / "previous"); ++attempt)
            {
                if (remove_tree(updates / "previous"))
                {
                    break;
                }
                std::this_thread::sleep_for(std::chrono::seconds(1));
            }
            std::error_code error;
            for (const auto& entry : std::filesystem::directory_iterator(updates, error))
            {
                if (entry.path().filename().wstring().starts_with(L".staging-"))
                {
                    remove_tree(entry.path());
                }
            }
        }).detach();
    }

    void check()
    {
        if (current_version().empty() || utils::flags::has_flag("offline"))
        {
            return;
        }
        {
            std::lock_guard lock(mutex_);
            if (state_.state == "checking" || state_.state == "downloading" || state_.state == "ready")
            {
                return;
            }
            state_.state = "checking";
        }

        std::thread([]
        {
            std::string error;
            const auto latest = fetch_release(error);
            const auto current = current_version();
            with_state([&](state_t& state)
            {
                state.checked = std::chrono::system_clock::now();
                if (!latest)
                {
                    utils::logger::write("launcher update: check: {}", error);
                    state.state = "check-failed";
                    state.error = error;
                    return;
                }
                state.latest = latest;
                state.error.clear();
                state.state = tool_install::compare_versions(latest->version, current) > 0 ? "available" : "up-to-date";
            });
        }).detach();
    }

    bool start_download()
    {
        std::optional<release> latest;
        {
            std::lock_guard lock(mutex_);
            if (!can_install() || current_version().empty() || !state_.latest ||
                (state_.state != "available" && state_.state != "failed") ||
                tool_install::compare_versions(state_.latest->version, current_version()) <= 0)
            {
                return false;
            }
            latest = state_.latest;
            state_.state = "downloading";
            state_.done = 0;
            state_.total = latest->size;
            state_.error.clear();
            state_.install_error.clear();
        }

        std::thread([latest]
        {
            const auto error = stage(*latest);
            with_state([&](state_t& state)
            {
                if (error.empty())
                {
                    state.state = "ready";
                    state.ready_version = latest->version;
                    return;
                }
                utils::logger::write("launcher update {}: {}", latest->version, error);
                state.state = "failed";
                state.error = error;
            });
        }).detach();
        return true;
    }

    bool restart(std::string& error)
    {
        {
            std::lock_guard lock(mutex_);
            if (state_.state != "ready")
            {
                error = "not-ready";
                return false;
            }
        }
        if (xml1_port::is_working() || updater::progress_tracker::instance().get_progress().is_active)
        {
            error = "busy";
            return false;
        }

        std::thread([]
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(300)); // let the answer reach the UI
            utils::logger::write("launcher update: restarting to install it");
            relaunch();
            utils::nt::terminate();
        }).detach();
        return true;
    }

    void write_status(rapidjson::Value& out, rapidjson::Document::AllocatorType& allocator)
    {
        const auto current = current_version();
        const auto installable = can_install();
        std::lock_guard lock(mutex_);
        out.SetObject();
        out.AddMember("enabled", !current.empty(), allocator);
        out.AddMember("current", make_string(current, allocator), allocator);
        out.AddMember("canInstall", installable, allocator);
        out.AddMember("state", make_string(state_.state, allocator), allocator);
        out.AddMember("latest", make_string(state_.latest ? state_.latest->version : std::string{}, allocator), allocator);
        out.AddMember("page", make_string(state_.latest ? state_.latest->page : std::string{release_page}, allocator), allocator);
        out.AddMember("size", state_.latest ? state_.latest->size : std::uint64_t{0}, allocator);
        out.AddMember("done", state_.done, allocator);
        out.AddMember("total", state_.total, allocator);
        out.AddMember("error", make_string(state_.error, allocator), allocator);
        out.AddMember("installError", make_string(state_.install_error, allocator), allocator);
        out.AddMember("readyVersion", make_string(state_.ready_version, allocator), allocator);
        out.AddMember("updatedTo", make_string(state_.updated_to, allocator), allocator);
        const auto checked = state_.checked.time_since_epoch().count() == 0 ? 0 :
            std::chrono::duration_cast<std::chrono::milliseconds>(state_.checked.time_since_epoch()).count();
        out.AddMember("checkedAt", static_cast<int64_t>(checked), allocator);
    }
}
