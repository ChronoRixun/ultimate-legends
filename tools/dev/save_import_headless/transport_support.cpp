#include "std_include.hpp"
#include <utils/logger.hpp>
#include <utils/string.hpp>

// Only these logging/path utilities are substituted. builder_process.cpp itself
// is compiled unchanged, including CreateProcess, pipes, events, jobs and cancel.
namespace utils::logger {
    void log_format(const std::string_view&, std::format_args&&) {}
}
namespace utils::string {
    std::string convert(const std::wstring& text) {
        if (text.empty()) return {};
        const auto count = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
        std::string out(count, '\0');
        WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), count, nullptr, nullptr);
        return out;
    }
    std::string path_to_utf8(const std::filesystem::path& path) { return convert(path.wstring()); }
}
