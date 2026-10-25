/* A stand-in legends-models.exe for the launcher's CDP test of the tool's install / update
 * (tools/dev/models_cdp.py --shim): the test zips it as legends-models.exe with a shim.txt beside it
 * that holds the command to run (the test's Python and fake_legends_models.py), serves the zip as a
 * GitHub release from tools/dev/fake_github.py, and the launcher installs it like the real tool. The
 * shim runs that command with its own arguments appended, on the same console handles, and exits with
 * its exit code. Nothing here is the real tool.
 *
 *   cl /nologo /O1 /W4 tools\dev\fake_models_shim.c /Fe:fake_models_shim.exe
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>

static const wchar_t* skip_argv0(const wchar_t* line)
{
    if (*line == L'"')
    {
        ++line;
        while (*line && *line != L'"')
        {
            ++line;
        }
        if (*line == L'"')
        {
            ++line;
        }
    }
    else
    {
        while (*line && *line != L' ' && *line != L'\t')
        {
            ++line;
        }
    }
    while (*line == L' ' || *line == L'\t')
    {
        ++line;
    }
    return line;
}

int wmain(void)
{
    wchar_t self[MAX_PATH];
    DWORD length = GetModuleFileNameW(NULL, self, MAX_PATH);
    if (length == 0 || length >= MAX_PATH)
    {
        return 1;
    }
    wchar_t* slash = wcsrchr(self, L'\\');
    if (!slash)
    {
        return 1;
    }
    wcscpy_s(slash + 1, MAX_PATH - (slash + 1 - self), L"shim.txt");

    HANDLE file = CreateFileW(self, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE)
    {
        return 1;
    }
    char prefix[4096];
    DWORD read = 0;
    BOOL ok = ReadFile(file, prefix, sizeof(prefix) - 1, &read, NULL);
    CloseHandle(file);
    if (!ok)
    {
        return 1;
    }
    while (read > 0 && (prefix[read - 1] == '\r' || prefix[read - 1] == '\n' || prefix[read - 1] == ' '))
    {
        --read;
    }
    prefix[read] = 0;

    static wchar_t command[32768];
    int written = MultiByteToWideChar(CP_UTF8, 0, prefix, -1, command, 32768);
    if (written <= 0)
    {
        return 1;
    }
    const wchar_t* args = skip_argv0(GetCommandLineW());
    if (*args)
    {
        wcscat_s(command, 32768, L" ");
        wcscat_s(command, 32768, args);
    }

    STARTUPINFOW startup = {sizeof(startup)};
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION process;
    if (!CreateProcessW(NULL, command, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, NULL, &startup, &process))
    {
        return 1;
    }
    CloseHandle(process.hThread);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hProcess);
    return (int)code;
}
