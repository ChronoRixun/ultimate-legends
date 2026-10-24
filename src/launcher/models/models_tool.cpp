#include "std_include.hpp"
#include "models_tool.hpp"

#include "game_config.hpp"
#include "tools/tool_install.hpp"
#include "xml1/builder_process.hpp"

#include <utils/io.hpp>
#include <utils/logger.hpp>
#include <utils/properties.hpp>
#include <utils/property_keys.hpp>
#include <utils/string.hpp>

#include <map>
#include <thread>

namespace models_tool
{
    namespace
    {
        constexpr auto port_key = "xml1";
        constexpr std::size_t max_lines = 20000;     // a build's events; older ones are dropped
        constexpr std::size_t stderr_lines = 60;
        constexpr std::size_t max_line_bytes = 1 << 20;
        constexpr std::uintmax_t max_marker_bytes = 4 << 20;
        constexpr std::uintmax_t max_credits_bytes = 256 << 10;

        struct run_state
        {
            job_snapshot snapshot;
            std::deque<std::string> lines; // snapshot.first is the index of lines.front()
            std::chrono::steady_clock::time_point started = std::chrono::steady_clock::now();
            HANDLE process{};
            HANDLE job{};
        };

        std::mutex mutex_;
        std::map<int, std::shared_ptr<run_state>> runs_;
        int next_id_ = 1;
        bool active_{};

        game_config::game_config_t port_config()
        {
            return *game_config::get_game_config(port_key);
        }

        std::string property(const char* suffix)
        {
            return port_config().get(suffix).value_or(std::string{});
        }

        // An entry's install folder when it is set up and still there.
        std::optional<std::filesystem::path> install_of(const char* game)
        {
            const auto config = game_config::get_game_config(game);
            if (!config)
            {
                return std::nullopt;
            }
            const auto path = config->get_install_path();
            if (!path || !utils::io::directory_exists(*path))
            {
                return std::nullopt;
            }
            return path;
        }

        std::string system_message(const DWORD code)
        {
            char* text = nullptr;
            FormatMessageA(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, code,
                           0, reinterpret_cast<char*>(&text), 0, nullptr);
            std::string message = text ? text : std::to_string(code);
            LocalFree(text);
            while (!message.empty() && (message.back() == '\n' || message.back() == '\r' || message.back() == ' '))
            {
                message.pop_back();
            }
            return message;
        }

        void read_lines(HANDLE pipe, const std::function<void(std::string)>& on_line)
        {
            std::string pending;
            char buffer[8192];
            DWORD read = 0;
            const auto emit = [&](std::string line)
            {
                if (!line.empty() && line.back() == '\r')
                {
                    line.pop_back();
                }
                if (!line.empty())
                {
                    on_line(std::move(line));
                }
            };
            while (ReadFile(pipe, buffer, sizeof(buffer), &read, nullptr) && read > 0)
            {
                pending.append(buffer, read);
                std::size_t newline;
                while ((newline = pending.find('\n')) != std::string::npos)
                {
                    emit(pending.substr(0, newline));
                    pending.erase(0, newline + 1);
                }
                if (pending.size() > max_line_bytes)
                {
                    emit(std::move(pending)); // a runaway line: kept as text, cut
                    pending.clear();
                }
            }
            if (!pending.empty())
            {
                emit(std::move(pending));
            }
        }

        // Starts `exe args` with stdout / stderr pipes (stdin: nothing) in a kill-on-close job.
        bool spawn(const std::shared_ptr<run_state>& state, const std::filesystem::path& exe, const std::vector<std::string>& args,
                   std::string& error)
        {
            SECURITY_ATTRIBUTES inherit{sizeof(inherit), nullptr, TRUE};
            HANDLE stdout_read{}, stdout_write{}, stderr_read{}, stderr_write{}, null_in{};
            const auto close_all = [&]
            {
                for (auto* handle : {stdout_read, stdout_write, stderr_read, stderr_write, null_in})
                {
                    if (handle && handle != INVALID_HANDLE_VALUE)
                    {
                        CloseHandle(handle);
                    }
                }
            };
            null_in = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit, OPEN_EXISTING, 0, nullptr);
            if (null_in == INVALID_HANDLE_VALUE || !CreatePipe(&stdout_read, &stdout_write, &inherit, 0) ||
                !CreatePipe(&stderr_read, &stderr_write, &inherit, 0))
            {
                error = "Could not create pipes for the tool: " + system_message(GetLastError());
                close_all();
                return false;
            }
            SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0);
            SetHandleInformation(stderr_read, HANDLE_FLAG_INHERIT, 0);

            HANDLE inherited[] = {null_in, stdout_write, stderr_write};
            SIZE_T attribute_size = 0;
            InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_size);
            std::vector<std::uint8_t> attribute_buffer(attribute_size);
            auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_buffer.data());
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_size) ||
                !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr))
            {
                error = "Could not prepare the tool's process: " + system_message(GetLastError());
                close_all();
                return false;
            }

            STARTUPINFOEXW startup{};
            startup.StartupInfo.cb = sizeof(startup);
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = null_in;
            startup.StartupInfo.hStdOutput = stdout_write;
            startup.StartupInfo.hStdError = stderr_write;
            startup.lpAttributeList = attributes;

            std::wstring command_line = xml1::quote_argument(exe.wstring());
            for (const auto& argument : args)
            {
                command_line += L" " + xml1::quote_argument(utils::string::convert(argument));
            }

            const auto job = CreateJobObjectW(nullptr, nullptr);
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
            {
                error = "Could not create a job object for the tool: " + system_message(GetLastError());
                if (job)
                {
                    CloseHandle(job);
                }
                DeleteProcThreadAttributeList(attributes);
                close_all();
                return false;
            }

            // The tool's own environment: UTF-8 output whatever the console code page says.
            std::wstring environment;
            if (auto* block = GetEnvironmentStringsW())
            {
                for (auto* entry = block; *entry; entry += wcslen(entry) + 1)
                {
                    const std::wstring_view text(entry);
                    if (!text.starts_with(L"PYTHONIOENCODING=") && !text.starts_with(L"PYTHONUTF8="))
                    {
                        environment.append(text).push_back(L'\0');
                    }
                }
                FreeEnvironmentStringsW(block);
            }
            environment.append(L"PYTHONIOENCODING=utf-8").push_back(L'\0');
            environment.append(L"PYTHONUTF8=1").push_back(L'\0');
            environment.push_back(L'\0');

            PROCESS_INFORMATION process{};
            const auto folder = exe.parent_path().wstring();
            const auto created = CreateProcessW(exe.wstring().c_str(), command_line.data(), nullptr, nullptr, TRUE,
                                                CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                                                environment.data(), folder.c_str(), &startup.StartupInfo, &process);
            const auto create_error = GetLastError();
            DeleteProcThreadAttributeList(attributes);
            CloseHandle(stdout_write);
            CloseHandle(stderr_write);
            CloseHandle(null_in);
            stdout_write = stderr_write = null_in = nullptr;
            if (!created)
            {
                error = "Could not start the character-model tool: " + system_message(create_error);
                CloseHandle(job);
                close_all();
                return false;
            }
            if (!AssignProcessToJobObject(job, process.hProcess))
            {
                utils::logger::write("legends-models: could not assign the job object ({})", system_message(GetLastError()));
            }
            ResumeThread(process.hThread);
            CloseHandle(process.hThread);

            {
                std::lock_guard lock(mutex_);
                state->process = process.hProcess;
                state->job = job;
                state->started = std::chrono::steady_clock::now();
                state->snapshot.active = true;
            }

            std::string args_text;
            for (const auto& argument : args)
            {
                args_text += " " + utils::string::convert(xml1::quote_argument(utils::string::convert(argument)));
            }
            utils::logger::write("legends-models: started {}{} (pid {})", utils::string::path_to_utf8(exe), args_text, process.dwProcessId);

            std::thread stdout_reader([state, stdout_read]
            {
                read_lines(stdout_read, [&](std::string line)
                {
                    if (line.find("\"progress\"") == std::string::npos)
                    {
                        utils::logger::write("legends-models: {}", line.size() > 2000 ? line.substr(0, 2000) + "..." : line);
                    }
                    std::lock_guard lock(mutex_);
                    state->lines.push_back(std::move(line));
                    ++state->snapshot.total_lines;
                    while (state->lines.size() > max_lines)
                    {
                        state->lines.pop_front();
                        ++state->snapshot.first;
                    }
                });
                CloseHandle(stdout_read);
            });

            std::thread stderr_reader([state, stderr_read]
            {
                read_lines(stderr_read, [&](std::string line)
                {
                    utils::logger::write("legends-models stderr: {}", line);
                    std::lock_guard lock(mutex_);
                    state->snapshot.stderr_tail.push_back(std::move(line));
                    while (state->snapshot.stderr_tail.size() > stderr_lines)
                    {
                        state->snapshot.stderr_tail.pop_front();
                    }
                });
                CloseHandle(stderr_read);
            });

            std::thread([state, stdout_reader = std::move(stdout_reader), stderr_reader = std::move(stderr_reader)]() mutable
            {
                WaitForSingleObject(state->process, INFINITE);
                DWORD exit_code = 1;
                GetExitCodeProcess(state->process, &exit_code);
                {
                    // Converter processes the tool left behind end with the job; then the pipes close.
                    std::lock_guard lock(mutex_);
                    CloseHandle(state->job);
                    state->job = nullptr;
                }
                stdout_reader.join();
                stderr_reader.join();

                std::lock_guard lock(mutex_);
                CloseHandle(state->process);
                state->process = nullptr;
                auto& snapshot = state->snapshot;
                snapshot.exit_code = snapshot.cancel_requested ? 130 : static_cast<int>(exit_code);
                snapshot.seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - state->started).count();
                snapshot.active = false;
                snapshot.finished = true;
                active_ = false;
                utils::logger::write("legends-models: {} exited with {}{}", snapshot.command, exit_code,
                                     snapshot.cancel_requested ? " (cancelled by the launcher)" : "");
            }).detach();

            return true;
        }

        // Load-order state of every listed folder, read only: +Name / -Name (the XML2 Fix loader's syntax).
        std::map<std::string, bool> read_load_order(const std::filesystem::path& mods)
        {
            std::map<std::string, bool> entries;
            std::string text;
            if (!utils::io::read_file(mods / L"load-order.txt", &text))
            {
                return entries;
            }
            if (text.starts_with("\xEF\xBB\xBF"))
            {
                text.erase(0, 3);
            }
            for (auto& line : utils::string::split(text, '\n'))
            {
                while (!line.empty() && (line.back() == '\r' || line.back() == ' ' || line.back() == '\t'))
                {
                    line.pop_back();
                }
                if (line.size() < 2 || (line.front() != '+' && line.front() != '-'))
                {
                    continue;
                }
                entries[utils::string::to_lower(line.substr(1))] = line.front() == '+';
            }
            return entries;
        }
    }

    std::optional<tool_location> find_tool()
    {
#ifdef _DEBUG
        if (const auto exe = port_config().get(property_keys::DEV_MODELS_TOOL); exe && !exe->empty())
        {
            const auto path = utils::string::utf8_to_path(*exe);
            if (utils::io::file_exists(path))
            {
                return tool_location{path, "dev", true};
            }
        }
#endif
        const tool_install::tool tool{"legends-models", "legends-models.exe", {}};
        if (const auto installed = tool_install::find(tool))
        {
            return tool_location{installed->exe, installed->version, false};
        }
        return std::nullopt;
    }

    std::filesystem::path work_folder()
    {
        return utils::properties::get_appdata_path() / "cache" / "legends-models";
    }

    std::optional<std::filesystem::path> port_folder()
    {
        const auto config = port_config();
        const auto path = config.get_install_path();
        if (!path || !config.is_installed() || !utils::io::directory_exists(*path))
        {
            return std::nullopt;
        }
        return path;
    }

    settings read_settings()
    {
        settings result{};
        result.mode = property(property_keys::MODELS_MODE);
        if (result.mode != "off" && !models_args::valid_mode(result.mode))
        {
            result.mode.clear();
        }
        result.mirror = property(property_keys::MODELS_MIRROR);
        if (!models_args::valid_mirror(result.mirror))
        {
            result.mirror.clear();
        }
        result.costumes = models_args::parse_costumes(property(property_keys::MODELS_COSTUMES));
        return result;
    }

    bool write_settings(const settings& settings, std::string& error)
    {
        if (!settings.mode.empty() && settings.mode != "off" && !models_args::valid_mode(settings.mode))
        {
            error = "Unknown appearance mode.";
            return false;
        }
        if (!models_args::valid_mirror(settings.mirror))
        {
            error = "The mirror must be an https:// address.";
            return false;
        }
        for (const auto& [hero, costume] : settings.costumes)
        {
            if (!models_args::valid_hero(hero) || !models_args::valid_costume(costume))
            {
                error = "A costume choice is not valid: " + hero;
                return false;
            }
        }
        const auto config = port_config();
        config.set(property_keys::MODELS_MODE, settings.mode);
        config.set(property_keys::MODELS_MIRROR, settings.mirror);
        config.set(property_keys::MODELS_COSTUMES, models_args::costumes_json(settings.costumes));
        return true;
    }

    std::string default_mirror()
    {
        // Our GitHub release of the community archives, once the author has OK'd it and it is published;
        // until then the tool downloads from the author's own links.
        return {};
    }

    std::optional<int> start(models_args::request request, failure& error)
    {
        const auto tool = find_tool();
        if (!tool)
        {
            error = {"L_TOOL_MISSING", "The character-model tool is not installed."};
            return std::nullopt;
        }
        const auto port = port_folder();
        if (!port)
        {
            error = {"L_NOT_BUILT", "Build X-Men Legends first."};
            return std::nullopt;
        }
        const auto writes = request.command == "build" || request.command == "remove";
        if (writes && game_config::is_game_process_running(port_key))
        {
            error = {"L_GAME_RUNNING", "Close X-Men Legends first."};
            return std::nullopt;
        }

        request.port = utils::string::path_to_utf8(*port);
        request.work = utils::string::path_to_utf8(work_folder());
        if (const auto mua1 = install_of("mua"))
        {
            request.mua1 = utils::string::path_to_utf8(*mua1);
        }
        if (const auto mua2 = install_of("mua2"))
        {
            request.mua2 = utils::string::path_to_utf8(*mua2);
        }
        if (request.command == "build" && request.mirror.empty())
        {
            const auto stored = read_settings().mirror;
            request.mirror = stored.empty() ? default_mirror() : stored;
        }

        std::string args_error;
        const auto args = models_args::build_args(request, args_error);
        if (!args)
        {
            error = {"L_USAGE", args_error};
            return std::nullopt;
        }

        std::shared_ptr<run_state> state;
        {
            std::lock_guard lock(mutex_);
            if (active_)
            {
                error = {"L_BUSY", "The character-model tool is already running."};
                return std::nullopt;
            }
            state = std::make_shared<run_state>();
            state->snapshot.id = next_id_++;
            state->snapshot.command = request.command;
            runs_[state->snapshot.id] = state;
            // Only the newest few runs are kept.
            while (runs_.size() > 8)
            {
                runs_.erase(runs_.begin());
            }
            active_ = true;
        }

        utils::io::create_directory(work_folder());
        std::string spawn_error;
        if (!spawn(state, tool->exe, *args, spawn_error))
        {
            std::lock_guard lock(mutex_);
            state->snapshot.start_error = spawn_error;
            state->snapshot.finished = true;
            state->snapshot.exit_code = -1;
            active_ = false;
            error = {"L_TOOL_START", spawn_error};
            utils::logger::write("legends-models: {}", spawn_error);
            return std::nullopt;
        }
        return state->snapshot.id;
    }

    std::optional<job_snapshot> job(const int id, const std::size_t from)
    {
        std::lock_guard lock(mutex_);
        const auto found = runs_.find(id);
        if (found == runs_.end())
        {
            return std::nullopt;
        }
        const auto& state = *found->second;
        auto copy = state.snapshot;
        const auto start = std::max(from, state.snapshot.first);
        copy.first = start;
        for (auto index = start; index < state.snapshot.first + state.lines.size(); ++index)
        {
            copy.lines.push_back(state.lines[index - state.snapshot.first]);
        }
        if (copy.active)
        {
            copy.seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - state.started).count();
        }
        return copy;
    }

    std::optional<job_snapshot> last()
    {
        std::lock_guard lock(mutex_);
        if (runs_.empty())
        {
            return std::nullopt;
        }
        auto copy = runs_.rbegin()->second->snapshot;
        copy.lines.clear();
        return copy;
    }

    bool cancel(const int id)
    {
        std::lock_guard lock(mutex_);
        const auto found = runs_.find(id);
        if (found == runs_.end() || !found->second->snapshot.active || !found->second->job)
        {
            return false;
        }
        // LAUNCHER-API.md: kill the process to cancel; staging folders are cleaned on the next run and
        // the previous pack stays as it was.
        found->second->snapshot.cancel_requested = true;
        TerminateJobObject(found->second->job, 130);
        utils::logger::write("legends-models: {} cancelled", found->second->snapshot.command);
        return true;
    }

    bool busy()
    {
        std::lock_guard lock(mutex_);
        return active_;
    }

    std::vector<installed_folder> installed(const std::filesystem::path& port)
    {
        std::vector<installed_folder> result;
        const auto mods = port / L"mods";
        std::error_code ec;
        if (!std::filesystem::is_directory(mods, ec))
        {
            return result;
        }
        const auto order = read_load_order(mods);
        for (const auto& entry : std::filesystem::directory_iterator(mods, ec))
        {
            const auto name = utils::string::path_to_utf8(entry.path().filename());
            if (!entry.is_directory(ec) || name.empty() || name.front() == '.')
            {
                continue;
            }
            const auto marker_file = entry.path() / L"legends-models.json";
            if (!utils::io::file_exists(marker_file) || std::filesystem::file_size(marker_file, ec) > max_marker_bytes)
            {
                continue;
            }
            auto marker = models_args::parse_marker(utils::io::read_file(marker_file));
            if (!marker)
            {
                continue;
            }
            installed_folder folder{};
            folder.folder = name;
            const auto listed = order.find(utils::string::to_lower(name));
            folder.listed = listed != order.end();
            folder.enabled = folder.listed && listed->second;
            folder.has_credits = utils::io::file_exists(entry.path() / L"CREDITS.md");
            folder.marker = std::move(*marker);
            result.push_back(std::move(folder));
        }
        std::ranges::sort(result, {}, &installed_folder::folder);
        return result;
    }

    std::vector<std::pair<std::string, std::string>> credits(const std::filesystem::path& port, const std::string& group)
    {
        std::vector<std::pair<std::string, std::string>> result;
        std::set<std::string> seen;
        for (const auto& folder : installed(port))
        {
            if (!folder.has_credits || (!group.empty() && utils::string::to_lower(folder.marker.group) != utils::string::to_lower(group)))
            {
                continue;
            }
            const auto file = port / L"mods" / utils::string::utf8_to_path(folder.folder) / L"CREDITS.md";
            std::error_code ec;
            if (std::filesystem::file_size(file, ec) > max_credits_bytes || ec)
            {
                continue;
            }
            auto text = utils::io::read_file(file);
            if (text.starts_with("\xEF\xBB\xBF"))
            {
                text.erase(0, 3);
            }
            if (!text.empty() && seen.insert(text).second)
            {
                result.emplace_back(folder.folder, std::move(text));
            }
        }
        return result;
    }
}
