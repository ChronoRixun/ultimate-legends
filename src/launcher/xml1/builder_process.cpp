#include "std_include.hpp"
#include "builder_process.hpp"

#include <utils/logger.hpp>
#include <utils/string.hpp>

#include <rapidjson/writer.h>

#include <thread>

namespace xml1
{
    struct builder_process::shared
    {
        mutable std::mutex mutex;
        builder_snapshot snapshot;
        std::chrono::steady_clock::time_point started = std::chrono::steady_clock::now();
        std::chrono::steady_clock::time_point cancel_time{};
        HANDLE process{};
        HANDLE job{};
        HANDLE stdin_write{};
        bool running{};
    };

    namespace
    {
        std::string json_text(const rapidjson::Value& value)
        {
            rapidjson::StringBuffer buffer;
            rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
            value.Accept(writer);
            return {buffer.GetString(), buffer.GetSize()};
        }

        std::string member_string(const rapidjson::Value& object, const char* key)
        {
            const auto member = object.FindMember(key);
            return member != object.MemberEnd() && member->value.IsString() ? member->value.GetString() : std::string{};
        }

        double member_number(const rapidjson::Value& object, const char* key, const double fallback = 0)
        {
            const auto member = object.FindMember(key);
            return member != object.MemberEnd() && member->value.IsNumber() ? member->value.GetDouble() : fallback;
        }

        void add_tail(builder_snapshot& snapshot, std::string line)
        {
            snapshot.log_tail.push_back(std::move(line));
            while (snapshot.log_tail.size() > builder_process::log_tail_lines)
            {
                snapshot.log_tail.pop_front();
            }
        }

        // One stdout line: an event, or (robustness, section 2.3) a stray line kept as log text.
        void handle_event(builder_snapshot& snapshot, const std::string& line)
        {
            rapidjson::Document event;
            event.Parse(line.data(), line.size());
            if (event.HasParseError() || !event.IsObject() || !event.HasMember("ev") || !event["ev"].IsString())
            {
                add_tail(snapshot, line);
                return;
            }

            const std::string ev = event["ev"].GetString();
            if (ev == "hello")
            {
                snapshot.builder_version = member_string(event, "builder");
                snapshot.content_version = static_cast<int>(member_number(event, "content_version"));
            }
            else if (ev == "plan")
            {
                snapshot.stages.clear();
                if (event.HasMember("stages") && event["stages"].IsArray())
                {
                    for (const auto& item : event["stages"].GetArray())
                    {
                        if (!item.IsObject())
                        {
                            continue;
                        }
                        builder_stage stage{};
                        stage.id = member_string(item, "id");
                        stage.title = member_string(item, "title");
                        stage.weight = member_number(item, "weight", 1);
                        stage.cached = item.HasMember("cached") && item["cached"].IsBool() && item["cached"].GetBool();
                        snapshot.stages.push_back(std::move(stage));
                    }
                }
            }
            else if (ev == "stage")
            {
                const auto id = member_string(event, "id");
                const auto state = member_string(event, "state");
                for (auto& stage : snapshot.stages)
                {
                    if (stage.id != id)
                    {
                        continue;
                    }
                    if (state == "start")
                    {
                        stage.state = "running";
                        snapshot.stage = id;
                        snapshot.stage_pct = 0;
                        snapshot.done = 0;
                        snapshot.total = 0;
                        snapshot.message = stage.title;
                    }
                    else if (state == "done")
                    {
                        stage.state = "done";
                        stage.seconds = member_number(event, "seconds");
                    }
                }
            }
            else if (ev == "progress")
            {
                snapshot.stage = member_string(event, "stage");
                snapshot.done = static_cast<std::uint64_t>(member_number(event, "done"));
                snapshot.total = static_cast<std::uint64_t>(member_number(event, "total"));
                snapshot.unit = member_string(event, "unit");
                snapshot.stage_pct = member_number(event, "pct");
                snapshot.overall = std::clamp(member_number(event, "overall", snapshot.overall), 0.0, 100.0);
                snapshot.eta_s = static_cast<long long>(member_number(event, "eta_s", -1));
            }
            else if (ev == "log")
            {
                snapshot.message = member_string(event, "msg");
                add_tail(snapshot, "[" + member_string(event, "stage") + "] " + snapshot.message);
            }
            else if (ev == "warning")
            {
                snapshot.warnings += std::max(1, static_cast<int>(member_number(event, "count", 1)));
                add_tail(snapshot, "warning " + member_string(event, "code") + ": " + member_string(event, "msg"));
            }
            else if (ev == "error")
            {
                builder_error error{};
                error.stage = member_string(event, "stage");
                error.code = member_string(event, "code");
                error.msg = member_string(event, "msg");
                error.hint = member_string(event, "hint");
                error.detail = event.HasMember("detail") && event["detail"].IsObject() ? json_text(event["detail"]) : "{}";
                add_tail(snapshot, "error " + error.code + ": " + error.msg);
                snapshot.errors.push_back(std::move(error));
            }
            else if (ev == "result")
            {
                snapshot.result = line;
                if (event.HasMember("exit") && event["exit"].IsInt())
                {
                    snapshot.exit_code = event["exit"].GetInt();
                }
                if (event.HasMember("ok") && event["ok"].IsBool() && event["ok"].GetBool())
                {
                    snapshot.overall = 100;
                }
            }
        }

        // Reads a pipe to its end, one line at a time.
        void read_lines(HANDLE pipe, const std::function<void(const std::string&)>& on_line)
        {
            std::string pending;
            char buffer[4096];
            DWORD read = 0;
            while (ReadFile(pipe, buffer, sizeof(buffer), &read, nullptr) && read > 0)
            {
                pending.append(buffer, read);
                std::size_t newline;
                while ((newline = pending.find('\n')) != std::string::npos)
                {
                    auto line = pending.substr(0, newline);
                    pending.erase(0, newline + 1);
                    if (!line.empty() && line.back() == '\r')
                    {
                        line.pop_back();
                    }
                    if (!line.empty())
                    {
                        on_line(line);
                    }
                }
            }
            if (!pending.empty())
            {
                on_line(pending);
            }
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

        // What an exit code means when the builder left no error of its own (section 2.2).
        builder_error error_for_exit(const int exit_code, const bool killed)
        {
            if (killed)
            {
                return {"", "L_BUILDER_KILLED", "The builder did not stop when asked, so the launcher ended it.", "", "{}"};
            }
            switch (exit_code)
            {
            case 1: return {"", "E_BUILD_FAILED", "The build failed.", "", "{}"};
            case 2: return {"", "E_USAGE", "The builder refused the request.", "", "{}"};
            case 3: return {"", "E_INPUT", "The disc image or the X-Men Legends II install can't be used.", "", "{}"};
            case 4: return {"", "E_SPACE", "There is not enough free disk space.", "", "{}"};
            case 5: return {"", "E_CANCELLED", "The build was cancelled.", "", "{}"};
            case 6: return {"", "E_IO", "A file could not be read or written.", "", "{}"};
            default: return {"", "L_BUILDER_CRASH", std::format("The builder stopped unexpectedly (exit code {}).", exit_code), "", "{}"};
            }
        }
    }

    std::wstring quote_argument(const std::wstring& argument)
    {
        if (!argument.empty() && argument.find_first_of(L" \t\n\v\"") == std::wstring::npos)
        {
            return argument;
        }

        std::wstring quoted = L"\"";
        for (auto it = argument.begin();; ++it)
        {
            std::size_t backslashes = 0;
            while (it != argument.end() && *it == L'\\')
            {
                ++it;
                ++backslashes;
            }
            if (it == argument.end())
            {
                quoted.append(backslashes * 2, L'\\');
                break;
            }
            if (*it == L'"')
            {
                quoted.append(backslashes * 2 + 1, L'\\');
                quoted.push_back(*it);
            }
            else
            {
                quoted.append(backslashes, L'\\');
                quoted.push_back(*it);
            }
        }
        quoted.push_back(L'"');
        return quoted;
    }

    builder_process::builder_process(const int id, std::string command)
        : state_(std::make_shared<shared>())
    {
        this->state_->snapshot.id = id;
        this->state_->snapshot.command = std::move(command);
    }

    builder_process::~builder_process() = default;

    void builder_process::fail(const std::string& code, const std::string& message)
    {
        std::lock_guard lock(this->state_->mutex);
        auto& snapshot = this->state_->snapshot;
        snapshot.active = false;
        snapshot.finished = true;
        snapshot.errors.push_back({"", code, message, "", "{}"});
        add_tail(snapshot, "error " + code + ": " + message);
    }

    bool builder_process::start(const std::filesystem::path& exe, const std::vector<std::wstring>& args, finish_callback on_finish,
                                std::string& error)
    {
        auto state = this->state_;

        SECURITY_ATTRIBUTES inherit{sizeof(inherit), nullptr, TRUE};
        HANDLE stdin_read{}, stdin_write{}, stdout_read{}, stdout_write{}, stderr_read{}, stderr_write{};
        const auto close_all = [&]
        {
            for (auto* handle : {stdin_read, stdin_write, stdout_read, stdout_write, stderr_read, stderr_write})
            {
                if (handle)
                {
                    CloseHandle(handle);
                }
            }
        };
        if (!CreatePipe(&stdin_read, &stdin_write, &inherit, 0) || !CreatePipe(&stdout_read, &stdout_write, &inherit, 0) ||
            !CreatePipe(&stderr_read, &stderr_write, &inherit, 0))
        {
            error = "Could not create pipes for the builder: " + system_message(GetLastError());
            close_all();
            return false;
        }
        // Our ends stay in the launcher.
        SetHandleInformation(stdin_write, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(stderr_read, HANDLE_FLAG_INHERIT, 0);

        // Only the three pipe ends are inherited, never any other handle the launcher has open.
        HANDLE inherited[] = {stdin_read, stdout_write, stderr_write};
        SIZE_T attribute_size = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_size);
        std::vector<std::uint8_t> attribute_buffer(attribute_size);
        auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_buffer.data());
        if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_size) ||
            !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr))
        {
            error = "Could not prepare the builder's process: " + system_message(GetLastError());
            close_all();
            return false;
        }

        STARTUPINFOEXW startup{};
        startup.StartupInfo.cb = sizeof(startup);
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin_read;
        startup.StartupInfo.hStdOutput = stdout_write;
        startup.StartupInfo.hStdError = stderr_write;
        startup.lpAttributeList = attributes;

        std::wstring command_line = quote_argument(exe.wstring());
        for (const auto& argument : args)
        {
            command_line += L" " + quote_argument(argument);
        }

        const auto job = CreateJobObjectW(nullptr, nullptr);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
        {
            error = "Could not create a job object for the builder: " + system_message(GetLastError());
            if (job)
            {
                CloseHandle(job);
            }
            DeleteProcThreadAttributeList(attributes);
            close_all();
            return false;
        }

        PROCESS_INFORMATION process{};
        const auto folder = exe.parent_path().wstring();
        const auto created = CreateProcessW(exe.wstring().c_str(), command_line.data(), nullptr, nullptr, TRUE,
                                            CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                                            nullptr, folder.c_str(), &startup.StartupInfo, &process);
        const auto create_error = GetLastError();
        DeleteProcThreadAttributeList(attributes);
        // The child's ends now belong to the child.
        CloseHandle(stdin_read);
        CloseHandle(stdout_write);
        CloseHandle(stderr_write);
        stdin_read = stdout_write = stderr_write = nullptr;

        if (!created)
        {
            error = "Could not start the builder: " + system_message(create_error);
            CloseHandle(job);
            close_all();
            return false;
        }
        if (!AssignProcessToJobObject(job, process.hProcess))
        {
            utils::logger::write("xml1-builder: could not assign the job object ({})", system_message(GetLastError()));
        }
        ResumeThread(process.hThread);
        CloseHandle(process.hThread);

        {
            std::lock_guard lock(state->mutex);
            state->process = process.hProcess;
            state->job = job;
            state->stdin_write = stdin_write;
            state->running = true;
            state->started = std::chrono::steady_clock::now();
            state->snapshot.active = true;
        }

        std::string args_text;
        for (const auto& argument : args)
        {
            args_text += " " + utils::string::convert(quote_argument(argument));
        }
        utils::logger::write("xml1-builder: started {}{} (pid {})", utils::string::path_to_utf8(exe), args_text, process.dwProcessId);

        std::thread stdout_reader([state, stdout_read]
        {
            read_lines(stdout_read, [&](const std::string& line)
            {
                std::lock_guard lock(state->mutex);
                handle_event(state->snapshot, line);
                if (line.find("\"ev\":\"progress\"") == std::string::npos && line.find("\"ev\": \"progress\"") == std::string::npos)
                {
                    utils::logger::write("xml1-builder: {}", line);
                }
            });
            CloseHandle(stdout_read);
        });

        std::thread stderr_reader([state, stderr_read]
        {
            read_lines(stderr_read, [&](const std::string& line)
            {
                utils::logger::write("xml1-builder stderr: {}", line);
                std::lock_guard lock(state->mutex);
                add_tail(state->snapshot, line);
            });
            CloseHandle(stderr_read);
        });

        std::thread([state, on_finish = std::move(on_finish), stdout_reader = std::move(stdout_reader),
                     stderr_reader = std::move(stderr_reader)]() mutable
        {
            bool killed = false;
            while (WaitForSingleObject(state->process, 250) == WAIT_TIMEOUT)
            {
                std::lock_guard lock(state->mutex);
                if (state->snapshot.cancel_requested && !killed &&
                    std::chrono::steady_clock::now() - state->cancel_time > kill_after_cancel)
                {
                    utils::logger::write("xml1-builder: no exit {} s after cancel; ending its job",
                                         std::chrono::duration_cast<std::chrono::seconds>(kill_after_cancel).count());
                    TerminateJobObject(state->job, 5);
                    killed = true;
                }
            }

            DWORD exit_code = 70;
            GetExitCodeProcess(state->process, &exit_code);

            // Anything the builder started ends with its job; then its pipes close and the readers finish.
            {
                std::lock_guard lock(state->mutex);
                CloseHandle(state->job);
                state->job = nullptr;
                CloseHandle(state->stdin_write);
                state->stdin_write = nullptr;
            }
            stdout_reader.join();
            stderr_reader.join();

            builder_snapshot copy;
            {
                std::lock_guard lock(state->mutex);
                CloseHandle(state->process);
                state->process = nullptr;
                state->running = false;
                auto& snapshot = state->snapshot;
                snapshot.killed = killed;
                if (snapshot.result.empty() || killed)
                {
                    snapshot.exit_code = killed ? 5 : static_cast<int>(exit_code);
                    // Only when the builder said nothing itself.
                    if (snapshot.errors.empty() && snapshot.exit_code != 0)
                    {
                        auto error = error_for_exit(snapshot.exit_code, killed);
                        add_tail(snapshot, "error " + error.code + ": " + error.msg);
                        snapshot.errors.push_back(std::move(error));
                    }
                }
                snapshot.seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - state->started).count();
                copy = snapshot;
            }
            utils::logger::write("xml1-builder: {} exited with {}{}", copy.command, copy.exit_code, killed ? " (ended by the launcher)" : "");

            if (on_finish)
            {
                try
                {
                    on_finish(copy);
                }
                catch (const std::exception& e)
                {
                    utils::logger::write("xml1-builder: after {}: {}", copy.command, e.what());
                }
            }

            std::lock_guard lock(state->mutex);
            state->snapshot.active = false;
            state->snapshot.finished = true;
        }).detach();

        return true;
    }

    void builder_process::cancel()
    {
        std::lock_guard lock(this->state_->mutex);
        if (!this->state_->running || this->state_->snapshot.cancel_requested)
        {
            return;
        }
        this->state_->snapshot.cancel_requested = true;
        this->state_->cancel_time = std::chrono::steady_clock::now();
        if (this->state_->stdin_write)
        {
            DWORD written = 0;
            WriteFile(this->state_->stdin_write, "cancel\n", 7, &written, nullptr);
        }
        utils::logger::write("xml1-builder: cancel sent to {}", this->state_->snapshot.command);
    }

    builder_snapshot builder_process::snapshot() const
    {
        std::lock_guard lock(this->state_->mutex);
        auto copy = this->state_->snapshot;
        if (this->state_->running)
        {
            copy.seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - this->state_->started).count();
        }
        return copy;
    }

    bool builder_process::active() const
    {
        std::lock_guard lock(this->state_->mutex);
        return this->state_->snapshot.active;
    }
}
