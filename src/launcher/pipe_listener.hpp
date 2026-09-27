#pragma once

#include <atomic>
#include <functional>
#include <thread>

namespace pipe
{
    // Single-instance overlapped named-pipe listener: owns pipe creation, accept,
    // stop-event handling, and the cancel+drain pattern for pending I/O on stop.
    class listener
    {
    public:
        struct options
        {
            const wchar_t* name{};
            unsigned long access{}; // PIPE_ACCESS_*; overlapped + first-instance flags added internally
            unsigned long out_buffer{};
            unsigned long in_buffer{};
            std::function<void(unsigned long)> on_create_error{}; // receives GetLastError()
        };

        using connection_handler = std::function<void(void* pipe)>;

        ~listener();

        void start(options opts, connection_handler handler);
        void stop();

        bool running() const { return this->running_; }

        // Overlapped read that unblocks on stop.
        bool read(void* pipe, void* buffer, unsigned long size, unsigned long& bytes_read) const;

    private:
        void run();
        bool wait_for_connection(void* pipe) const;

        options options_{};
        connection_handler handler_{};
        std::thread thread_{};
        std::atomic<bool> running_{false};
        void* stop_event_{nullptr};
    };
}
