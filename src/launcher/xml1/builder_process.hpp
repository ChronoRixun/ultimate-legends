#pragma once

#include <chrono>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <functional>
#include <memory>
#include <string>
#include <vector>

// One run of the X-Men Legends builder (xml1-builder.exe, BUILDER_DESIGN.md section 2): the
// launcher starts it with --events jsonl, reads its JSON-lines events from stdout into a
// snapshot the UI polls, sends its stderr to the launcher log, and cancels it with a `cancel` line
// on stdin. The process runs in a job object that kills it (and any worker processes it started)
// when the job closes: when the run ends, and when the launcher exits or crashes. A builder that
// has not exited 15 seconds after a cancel is killed.
namespace xml1
{
    struct builder_stage
    {
        std::string id;
        std::string title;
        double weight{};
        bool cached{};
        std::string state = "pending"; // pending | running | done
        double seconds{};
    };

    struct builder_error
    {
        std::string stage;
        std::string code; // E_* from the builder, L_* from the launcher
        std::string msg;
        std::string hint;
        std::string detail; // JSON object text
    };

    struct builder_snapshot
    {
        int id{};
        std::string command; // info | build | verify | clean | version
        bool active{};
        bool finished{};
        bool cancel_requested{};
        bool killed{}; // the job was ended by the launcher (no exit after cancel)
        int exit_code = -1;

        std::string builder_version;
        int content_version{};

        std::vector<builder_stage> stages;
        std::string stage; // the running stage
        double overall{};  // 0-100
        double stage_pct{};
        long long eta_s = -1;
        std::uint64_t done{};
        std::uint64_t total{};
        std::string unit;
        std::string message; // the last log line

        int warnings{};
        std::vector<builder_error> errors;
        std::string result; // the result event (JSON text), empty until it arrives
        std::deque<std::string> log_tail; // the last lines of stderr and of log/warning/error events

        double seconds{}; // since the start
    };

    class builder_process
    {
    public:
        using finish_callback = std::function<void(const builder_snapshot&)>;

        builder_process(int id, std::string command);
        ~builder_process();

        builder_process(const builder_process&) = delete;
        builder_process& operator=(const builder_process&) = delete;

        // Starts `exe` with `args` (each quoted as needed) in the exe's folder. `on_finish` runs on
        // the waiter thread once the process has exited and its output is read, before the
        // snapshot says finished. false with `error` when it could not be started.
        bool start(const std::filesystem::path& exe, const std::vector<std::wstring>& args, finish_callback on_finish,
                   std::string& error);

        // Asks the builder to stop (a `cancel` line on stdin); kills it 15 s later if it is still running.
        void cancel();

        [[nodiscard]] builder_snapshot snapshot() const;
        [[nodiscard]] bool active() const;

        // Marks a run that could not start as finished with a launcher error (code L_*).
        void fail(const std::string& code, const std::string& message);

        static constexpr auto kill_after_cancel = std::chrono::seconds(15);
        static constexpr std::size_t log_tail_lines = 40;

    private:
        struct shared;
        std::shared_ptr<shared> state_;
    };

    // Quotes one argument for CreateProcess / CommandLineToArgvW.
    std::wstring quote_argument(const std::wstring& argument);
}
