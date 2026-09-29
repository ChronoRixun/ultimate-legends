#include "nt.hpp"
#include <TlHelp32.h>
#include <shellapi.h>
#include <delayimp.h>
#pragma comment(lib, "delayimp.lib")

#include <utils/string.hpp>

#include <mutex>
#include <chrono>
#include <algorithm>
#include <vector>
#include <optional>

#include "finally.hpp"

namespace utils::nt
{
    library library::load(const std::string& name)
    {
        return library(LoadLibraryA(name.data()));
    }

    library library::load(const std::filesystem::path& path)
    {
        return library(LoadLibraryExW(path.wstring().data(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH));
    }

    library library::get_by_address(void* address)
    {
        HMODULE handle = nullptr;
        GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           static_cast<LPCSTR>(address), &handle);
        return library(handle);
    }

    library::library()
    {
        this->module_ = GetModuleHandleA(nullptr);
    }

    library::library(const std::string& name)
    {
        this->module_ = GetModuleHandleA(name.data());
    }

    library::library(const HMODULE handle)
    {
        this->module_ = handle;
    }

    bool library::operator==(const library& obj) const
    {
        return this->module_ == obj.module_;
    }

    library::operator bool() const
    {
        return this->is_valid();
    }

    library::operator HMODULE() const
    {
        return this->get_handle();
    }

    PIMAGE_NT_HEADERS library::get_nt_headers() const
    {
        if (!this->is_valid()) return nullptr;
        return reinterpret_cast<PIMAGE_NT_HEADERS>(this->get_ptr() + this->get_dos_header()->e_lfanew);
    }

    PIMAGE_DOS_HEADER library::get_dos_header() const
    {
        return reinterpret_cast<PIMAGE_DOS_HEADER>(this->get_ptr());
    }

    PIMAGE_OPTIONAL_HEADER library::get_optional_header() const
    {
        if (!this->is_valid()) return nullptr;
        return &this->get_nt_headers()->OptionalHeader;
    }

    std::vector<PIMAGE_SECTION_HEADER> library::get_section_headers() const
    {
        std::vector<PIMAGE_SECTION_HEADER> headers;

        auto nt_headers = this->get_nt_headers();
        auto section = IMAGE_FIRST_SECTION(nt_headers);

        for (uint16_t i = 0; i < nt_headers->FileHeader.NumberOfSections; ++i, ++section)
        {
            if (section) headers.push_back(section);
            else OutputDebugStringA("There was an invalid section :O");
        }

        return headers;
    }

    std::uint8_t* library::get_ptr() const
    {
        return reinterpret_cast<std::uint8_t*>(this->module_);
    }

    size_t library::get_relative_entry_point() const
    {
        if (!this->is_valid()) return 0;
        return this->get_nt_headers()->OptionalHeader.AddressOfEntryPoint;
    }

    void* library::get_entry_point() const
    {
        if (!this->is_valid()) return nullptr;
        return this->get_ptr() + this->get_relative_entry_point();
    }

    bool library::is_valid() const
    {
        return this->module_ != nullptr && this->get_dos_header()->e_magic == IMAGE_DOS_SIGNATURE;
    }

    std::string library::get_name() const
    {
        if (!this->is_valid()) return {};

        const auto path = this->get_path();
        const auto pos = path.generic_string().find_last_of("/\\");
        if (pos == std::string::npos) return path.generic_string();

        return path.generic_string().substr(pos + 1);
    }

    std::filesystem::path library::get_path() const
    {
        if (!this->is_valid()) return {};

        wchar_t name[MAX_PATH]{};
        GetModuleFileNameW(this->module_, name, MAX_PATH);

        return std::filesystem::path{ name };
    }

    std::filesystem::path library::get_folder() const
    {
        if (!this->is_valid()) return {};

        const auto path = this->get_path();
        return path.parent_path();
    }

    void library::free()
    {
        if (this->is_valid())
        {
            FreeLibrary(this->module_);
            this->module_ = nullptr;
        }
    }

    HMODULE library::get_handle() const
    {
        return this->module_;
    }

    void** library::get_iat_entry(const std::string& module_name, const std::string& proc_name) const
    {
        if (!this->is_valid()) return nullptr;

        const library other_module(module_name);
        if (!other_module.is_valid()) return nullptr;

        auto* const target_function = other_module.get_proc<void*>(proc_name);
        if (!target_function) return nullptr;

        auto* header = this->get_optional_header();
        if (!header) return nullptr;

        auto* import_descriptor = reinterpret_cast<PIMAGE_IMPORT_DESCRIPTOR>(this->get_ptr() + header->DataDirectory
            [IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress);

        while (import_descriptor->Name)
        {
            if (!_stricmp(reinterpret_cast<char*>(this->get_ptr() + import_descriptor->Name), module_name.data()))
            {
                auto* original_thunk_data = reinterpret_cast<PIMAGE_THUNK_DATA>(import_descriptor->
                    OriginalFirstThunk + this->get_ptr());
                auto* thunk_data = reinterpret_cast<PIMAGE_THUNK_DATA>(import_descriptor->FirstThunk + this->
                    get_ptr());

                while (original_thunk_data->u1.AddressOfData)
                {
                    const size_t ordinal_number = original_thunk_data->u1.AddressOfData & 0xFFFFFFF;

                    if (ordinal_number > 0xFFFF) continue;

                    if (GetProcAddress(other_module.module_, reinterpret_cast<char*>(ordinal_number)) ==
                        FARPROC(target_function))
                    {
                        return reinterpret_cast<void**>(&thunk_data->u1.Function);
                    }

                    ++original_thunk_data;
                    ++thunk_data;
                }

                //break;
            }

            ++import_descriptor;
        }

        return nullptr;
    }

    void library::set_dll_directory(const std::filesystem::path& directory)
    {
        SetDllDirectoryW(directory.wstring().data());
    }

    void library::add_dll_directory(const std::filesystem::path& directory)
    {
        AddDllDirectory(directory.wstring().data());
    }

    std::filesystem::path library::get_dll_directory()
    {
        wchar_t directory[MAX_PATH] = {0};
        if (!GetDllDirectoryW(MAX_PATH, directory))
        {
            return {};
        }

        return {directory};
    }

    bool library::delay_load(const std::string& library)
    {
        __try
        {
            return SUCCEEDED(__HrLoadAllImportsForDll(library.data()));
        }
        __except (EXCEPTION_EXECUTE_HANDLER)
        {
            return false;
        }
    }

    bool is_wine_environment()
    {
        static const auto result = []() -> bool {
            const library ntdll("ntdll.dll");
            return ntdll.get_proc<void*>("wine_get_version") != nullptr;
        }();
        return result;
    }

    void raise_hard_exception()
    {
        int data = false;
        const library ntdll("ntdll.dll");
        ntdll.invoke_pascal<void>("RtlAdjustPrivilege", 19, true, false, &data);
        ntdll.invoke_pascal<void>("NtRaiseHardError", 0xC000007B, 0, nullptr, nullptr, 6, &data);
    }

    std::string load_resource(const int id)
    {
        auto* const res = FindResource(library(), MAKEINTRESOURCE(id), RT_RCDATA);
        if (!res) return {};

        auto* const handle = LoadResource(nullptr, res);
        if (!handle) return {};

        return std::string(LPSTR(LockResource(handle)), SizeofResource(nullptr, res));
    }

    void launch_process(const std::filesystem::path& process, const std::string& command_line)
    {
        STARTUPINFOW startup_info;
        PROCESS_INFORMATION process_info;

        ZeroMemory(&startup_info, sizeof(startup_info));
        ZeroMemory(&process_info, sizeof(process_info));
        startup_info.cb = sizeof(startup_info);

        wchar_t current_dir[MAX_PATH];
        GetCurrentDirectoryW(MAX_PATH, current_dir);

        // Prepend exe path to command line for proper argv[0] parsing
        auto full_command_line = L"\"" + process.wstring() + L"\" " + string::convert(command_line);
        const auto success = CreateProcessW(process.wstring().data(), full_command_line.data(), nullptr, nullptr, false, CREATE_NEW_PROCESS_GROUP, nullptr, current_dir,
                       &startup_info, &process_info);

        if (!success)
        {
            printf("CreateProcessW failed (error %lu): %s\n", GetLastError(), process.string().data());
        }

        if (process_info.hThread && process_info.hThread != INVALID_HANDLE_VALUE) CloseHandle(process_info.hThread);
        if (process_info.hProcess && process_info.hProcess != INVALID_HANDLE_VALUE) CloseHandle(process_info.hProcess);
    }

    unsigned long launch_process(const std::filesystem::path& process, const std::string& command_line, const std::filesystem::path& working_directory)
    {
        STARTUPINFOW startup_info;
        PROCESS_INFORMATION process_info;

        ZeroMemory(&startup_info, sizeof(startup_info));
        ZeroMemory(&process_info, sizeof(process_info));
        startup_info.cb = sizeof(startup_info);

        // Prepend exe path to command line for proper argv[0] parsing
        auto full_command_line = L"\"" + process.wstring() + L"\" " + string::convert(command_line);
        const auto success = CreateProcessW(process.wstring().data(), full_command_line.data(), nullptr, nullptr, false, CREATE_NEW_PROCESS_GROUP, nullptr, working_directory.wstring().data(),
                       &startup_info, &process_info);

        if (!success)
        {
            const auto error = GetLastError();
            printf("CreateProcessW failed (error %lu): %s (working dir: %s)\n",
                error, process.string().data(), working_directory.string().data());
            SetLastError(error);
        }

        const auto pid = process_info.dwProcessId;

        if (process_info.hThread && process_info.hThread != INVALID_HANDLE_VALUE) CloseHandle(process_info.hThread);
        if (process_info.hProcess && process_info.hProcess != INVALID_HANDLE_VALUE) CloseHandle(process_info.hProcess);

        return pid;
    }

    unsigned long launch_process_elevated(const std::filesystem::path& process, const std::string& command_line, const std::filesystem::path& working_directory, HANDLE* out_handle, const int show)
    {
        if (out_handle)
        {
            *out_handle = nullptr;
        }

        const auto file = process.wstring();
        const auto params = string::convert(command_line);
        const auto dir = working_directory.wstring();

        SHELLEXECUTEINFOW info{};
        info.cbSize = sizeof(info);
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.lpVerb = L"runas";
        info.lpFile = file.data();
        info.lpParameters = params.empty() ? nullptr : params.data();
        info.lpDirectory = dir.empty() ? nullptr : dir.data();
        info.nShow = show;

        if (!ShellExecuteExW(&info) || !info.hProcess)
        {
            const auto error = GetLastError();
            printf("ShellExecuteExW failed (error %lu): %s\n", error, process.string().data());
            SetLastError(error);
            return 0;
        }

        const auto pid = GetProcessId(info.hProcess);

        if (out_handle)
        {
            *out_handle = info.hProcess;
        }
        else
        {
            CloseHandle(info.hProcess);
        }

        return pid;
    }

    unsigned long launch_process_maybe_elevated(const std::filesystem::path& process, const std::string& command_line,
        const std::filesystem::path& working_directory, bool* elevated)
    {
        if (elevated) *elevated = false;

        const auto pid = launch_process(process, command_line, working_directory);
        if (pid)
        {
            return pid;
        }

        // 740 = the exe demands elevation (requireAdministrator manifest or the RUNASADMIN compat flag).
        if (GetLastError() != ERROR_ELEVATION_REQUIRED)
        {
            return 0;
        }

        printf("Launch requires elevation, retrying with UAC prompt: %s\n", process.string().data());
        if (elevated) *elevated = true;

        return launch_process_elevated(process, command_line, working_directory);
    }

    bool is_elevated()
    {
        HANDLE token{};
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
        {
            return false;
        }

        TOKEN_ELEVATION elevation{};
        DWORD size = sizeof(elevation);
        const auto success = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size);
        CloseHandle(token);

        return success && elevation.TokenIsElevated;
    }

    std::filesystem::path get_process_path(const unsigned long pid)
    {
        auto* const process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (!process)
        {
            return {};
        }

        const auto _ = utils::finally([&]()
        {
            CloseHandle(process);
        });

        // Long enough for a long path (up to 32767 characters).
        std::wstring buffer(32768, L'\0');
        DWORD size = static_cast<DWORD>(buffer.size());
        if (!QueryFullProcessImageNameW(process, 0, buffer.data(), &size))
        {
            return {};
        }

        buffer.resize(size);
        return std::filesystem::path(buffer);
    }

    namespace
    {
        struct process_entry
        {
            unsigned long pid{};
            std::string name; // lowercased
        };

        std::mutex process_names_mutex;
        std::vector<process_entry> cached_processes;
        std::chrono::steady_clock::time_point cached_process_time{};

        // Every running process (id and lowercased executable name). One snapshot, reused by every
        // name tested.
        std::vector<process_entry> snapshot_processes()
        {
            std::vector<process_entry> processes;

            HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snapshot == INVALID_HANDLE_VALUE)
            {
                return processes;
            }

            PROCESSENTRY32 entry;
            entry.dwSize = sizeof(PROCESSENTRY32);

            if (Process32First(snapshot, &entry))
            {
                do
                {
                    processes.push_back({entry.th32ProcessID, string::to_lower(entry.szExeFile)});
                } while (Process32Next(snapshot, &entry));
            }

            CloseHandle(snapshot);
            return processes;
        }

        // The process table, taken now or reused when the last snapshot is younger than max_age_ms.
        std::vector<process_entry> running_processes(const unsigned int max_age_ms)
        {
            std::lock_guard lock(process_names_mutex);
            const auto now = std::chrono::steady_clock::now();
            const auto age = std::chrono::duration_cast<std::chrono::milliseconds>(now - cached_process_time);
            if (max_age_ms == 0 || cached_processes.empty() || age.count() > static_cast<long long>(max_age_ms))
            {
                cached_processes = snapshot_processes();
                cached_process_time = now;
            }
            return cached_processes;
        }

        std::wstring normalised_path(const std::filesystem::path& path)
        {
            auto text = path.lexically_normal().make_preferred().wstring();
            while (text.size() > 3 && (text.back() == L'\\' || text.back() == L'/'))
            {
                text.pop_back();
            }
            CharLowerBuffW(text.data(), static_cast<DWORD>(text.size()));
            return text;
        }

        struct file_identity
        {
            DWORD volume{};
            DWORD index_high{};
            DWORD index_low{};

            bool operator==(const file_identity&) const = default;
        };

        std::optional<file_identity> identify(const std::filesystem::path& path)
        {
            // FILE_FLAG_BACKUP_SEMANTICS opens directories too; no access rights are needed to read
            // the file id, and every share mode lets a running exe be opened.
            const auto file = CreateFileW(path.wstring().c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                          nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
            if (file == INVALID_HANDLE_VALUE)
            {
                return std::nullopt;
            }

            BY_HANDLE_FILE_INFORMATION info{};
            const auto ok = GetFileInformationByHandle(file, &info);
            CloseHandle(file);
            if (!ok)
            {
                return std::nullopt;
            }
            return file_identity{info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow};
        }
    }

    bool is_same_file(const std::filesystem::path& a, const std::filesystem::path& b)
    {
        if (a.empty() || b.empty())
        {
            return false;
        }
        if (normalised_path(a) == normalised_path(b))
        {
            return true;
        }

        const auto first = identify(a);
        const auto second = first ? identify(b) : std::nullopt;
        return first && second && *first == *second;
    }

    std::vector<unsigned long> find_processes_by_image(const std::vector<std::filesystem::path>& images, const unsigned int max_age_ms)
    {
        std::vector<unsigned long> found;

        std::vector<std::string> names;
        for (const auto& image : images)
        {
            if (!image.empty())
            {
                names.push_back(string::to_lower(string::convert(image.filename().wstring())));
            }
        }
        if (names.empty())
        {
            return found;
        }

        for (const auto& process : running_processes(max_age_ms))
        {
            if (std::find(names.begin(), names.end(), process.name) == names.end())
            {
                continue;
            }

            // Same name: only the full path says whose it is.
            const auto path = get_process_path(process.pid);
            if (path.empty())
            {
                continue;
            }

            for (const auto& image : images)
            {
                if (!image.empty() && is_same_file(path, image))
                {
                    found.push_back(process.pid);
                    break;
                }
            }
        }

        return found;
    }

    bool is_any_image_running(const std::vector<std::filesystem::path>& images, const unsigned int max_age_ms)
    {
        return !find_processes_by_image(images, max_age_ms).empty();
    }

    bool stop_processes_by_image(const std::vector<std::filesystem::path>& images)
    {
        bool terminated = false;
        for (const auto pid : find_processes_by_image(images, 0))
        {
            const auto process = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
            if (process)
            {
                terminated = TerminateProcess(process, 0) != FALSE || terminated;
                CloseHandle(process);
            }
        }
        return terminated;
    }

    // Walks the process table once and tests every name against it. Callers used to ask per name,
    // which meant a full system snapshot each time and hundreds of milliseconds on the UI thread.
    // A polling caller can accept a recent snapshot; anything that acts on the answer passes 0.
    bool is_any_process_running(const std::vector<std::string>& process_names, const unsigned int max_age_ms)
    {
        if (process_names.empty())
        {
            return false;
        }

        const auto running = running_processes(max_age_ms);

        for (const auto& wanted : process_names)
        {
            if (wanted.empty())
            {
                continue;
            }

            const auto lowered = string::to_lower(wanted);
            const auto match = std::find_if(running.begin(), running.end(), [&](const process_entry& process)
            {
                return process.name == lowered;
            });
            if (match != running.end())
            {
                return true;
            }
        }

        return false;
    }

    bool is_process_running(const std::string& processName)
    {
        HANDLE hProcessSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (hProcessSnap == INVALID_HANDLE_VALUE)
        {
            return false;
        }

        PROCESSENTRY32 pe32;
        pe32.dwSize = sizeof(PROCESSENTRY32);

        if (!Process32First(hProcessSnap, &pe32))
        {
            CloseHandle(hProcessSnap);
            return false;
        }

        do
        {
            if (_stricmp(pe32.szExeFile, processName.data()) == 0)
            {
                CloseHandle(hProcessSnap);
                return true;
            }
        } while (Process32Next(hProcessSnap, &pe32));

        CloseHandle(hProcessSnap);
        return false;
    }

    bool terminate_process_handle(HANDLE process)
    {
        if (!process || process == INVALID_HANDLE_VALUE)
        {
            return false;
        }

        return TerminateProcess(process, 0) != FALSE;
    }

    bool stop_process(const std::string& processName)
    {
        HANDLE hProcessSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (hProcessSnap == INVALID_HANDLE_VALUE)
        {
            return false;
        }

        PROCESSENTRY32 pe32;
        pe32.dwSize = sizeof(PROCESSENTRY32);

        if (!Process32First(hProcessSnap, &pe32))
        {
            CloseHandle(hProcessSnap);
            return false;
        }

        bool terminated = false;
        do
        {
            if (_stricmp(pe32.szExeFile, processName.data()) == 0)
            {
                HANDLE hProcess = OpenProcess(PROCESS_TERMINATE, FALSE, pe32.th32ProcessID);
                if (hProcess != nullptr)
                {
                    terminated = TerminateProcess(hProcess, 0);
                    CloseHandle(hProcess);
                }
            }
        } while (Process32Next(hProcessSnap, &pe32));

        CloseHandle(hProcessSnap);
        return terminated;
    }

    void relaunch_self(std::string command_line)
    {
        const utils::nt::library self;
        launch_process(self.get_path(), command_line);
    }

    HANDLE relaunch_self_elevated(const std::string& command_line)
    {
        const library self;
        HANDLE handle{};
        launch_process_elevated(self.get_path(), command_line, self.get_path().parent_path(), &handle, SW_HIDE);
        return handle;
    }

    void update_dll_search_path(const std::filesystem::path& directory)
    {
        const library self;
        self.set_dll_directory(directory);
    }

    unsigned long get_parent_pid()
    {
        const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE) return 0;

        const auto _ = utils::finally([&]()
        {
            CloseHandle(snapshot);
        });

        PROCESSENTRY32 pe32;
        ZeroMemory(&pe32, sizeof(pe32));
        pe32.dwSize = sizeof(pe32);

        if (!Process32First(snapshot, &pe32))
        {
            return 0;
        }

        const auto pid = GetCurrentProcessId();
        do
        {
            if (pe32.th32ProcessID == pid)
            {
                return pe32.th32ParentProcessID;
            }
        } while (Process32Next(snapshot, &pe32));

        return 0;
    }

    bool wait_for_process(const unsigned long pid)
    {
        auto* const process_handle = OpenProcess(SYNCHRONIZE, FALSE, pid);
        if (!process_handle)
        {
            return false;
        }

        const auto _ = utils::finally([&]()
        {
            CloseHandle(process_handle);
        });

        WaitForSingleObject(process_handle, INFINITE);
        return true;
    }

    __declspec(noreturn) void terminate(const uint32_t code)
    {
        TerminateProcess(GetCurrentProcess(), code);
    }
}
