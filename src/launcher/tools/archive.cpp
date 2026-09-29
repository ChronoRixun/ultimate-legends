#include "std_include.hpp"
#include "archive.hpp"

#include <utils/io.hpp>

namespace archive
{
    std::string extract_zip(const std::filesystem::path& archive, const std::filesystem::path& into)
    {
        wchar_t system[MAX_PATH]{};
        GetSystemDirectoryW(system, MAX_PATH);
        const auto tar = std::filesystem::path(system) / L"tar.exe";
        if (!utils::io::file_exists(tar))
        {
            return "Unpacking a .zip needs Windows 10 (1803) or newer.";
        }
        std::error_code created;
        std::filesystem::create_directories(into, created);
        if (!utils::io::directory_exists(into))
        {
            return "Could not create a folder to unpack into.";
        }

        auto command = L"\"" + tar.wstring() + L"\" -xf \"" + archive.wstring() + L"\" -C \"" + into.wstring() + L"\"";
        STARTUPINFOW startup{sizeof(startup)};
        PROCESS_INFORMATION process{};
        if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process))
        {
            return "Could not start the zip extractor.";
        }
        WaitForSingleObject(process.hProcess, INFINITE);
        DWORD exit_code = 1;
        GetExitCodeProcess(process.hProcess, &exit_code);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return exit_code == 0 ? std::string{} : "The file is not a valid zip archive, or it could not be unpacked.";
    }
}
