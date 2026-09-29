/* xml1-builder.exe for the fake X-Men Legends builder (tools/dev/fake_xml1_builder.py).
 *
 * The real builder ships as a PyInstaller one-folder app: xml1-builder.exe next to _internal\.
 * The fake keeps that layout so the launcher installs and runs it exactly like the real one:
 *
 *   xml1-builder.exe              this shim
 *   _internal\xml1-builder.py     the fake builder (a copy of fake_xml1_builder.py)
 *   _internal\python.txt          the full path of the python.exe to run it with (UTF-8)
 *
 * It runs `python -u _internal\xml1-builder.py <its own arguments>` with its own standard handles
 * (the launcher's pipes), waits, and exits with the script's exit code. The script inherits the
 * shim's job object, so the launcher's kill-on-close job ends both.
 */
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

static int fail(const char* message)
{
    fprintf(stderr, "xml1-builder (fake): %s\n", message);
    return 70;
}

/* The command line after the program name, as CommandLineToArgvW would split it. */
static const wchar_t* arguments_after_program(const wchar_t* line)
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
    wchar_t folder[MAX_PATH * 4];
    DWORD length = GetModuleFileNameW(NULL, folder, (DWORD)(sizeof(folder) / sizeof(folder[0])));
    if (length == 0 || length >= sizeof(folder) / sizeof(folder[0]))
    {
        return fail("cannot find its own folder");
    }
    wchar_t* slash = wcsrchr(folder, L'\\');
    if (!slash)
    {
        return fail("cannot find its own folder");
    }
    *slash = L'\0';

    wchar_t script[MAX_PATH * 4];
    wchar_t python_txt[MAX_PATH * 4];
    swprintf(script, sizeof(script) / sizeof(script[0]), L"%s\\_internal\\xml1-builder.py", folder);
    swprintf(python_txt, sizeof(python_txt) / sizeof(python_txt[0]), L"%s\\_internal\\python.txt", folder);

    HANDLE file = CreateFileW(python_txt, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE)
    {
        return fail("_internal\\python.txt is missing");
    }
    char utf8[MAX_PATH * 4] = {0};
    DWORD read = 0;
    ReadFile(file, utf8, sizeof(utf8) - 1, &read, NULL);
    CloseHandle(file);
    while (read > 0 && (utf8[read - 1] == '\r' || utf8[read - 1] == '\n' || utf8[read - 1] == ' '))
    {
        utf8[--read] = '\0';
    }
    const char* start = utf8;
    if (read >= 3 && (unsigned char)utf8[0] == 0xEF && (unsigned char)utf8[1] == 0xBB && (unsigned char)utf8[2] == 0xBF)
    {
        start += 3; /* byte order mark */
    }

    wchar_t python[MAX_PATH * 4];
    if (!MultiByteToWideChar(CP_UTF8, 0, start, -1, python, (int)(sizeof(python) / sizeof(python[0]))))
    {
        return fail("_internal\\python.txt is not a path");
    }

    static wchar_t command[32768];
    swprintf(command, sizeof(command) / sizeof(command[0]), L"\"%s\" -u \"%s\" %s", python, script,
             arguments_after_program(GetCommandLineW()));

    SetEnvironmentVariableW(L"PYTHONUTF8", L"1");
    SetEnvironmentVariableW(L"PYTHONIOENCODING", L"utf-8");

    STARTUPINFOW startup;
    ZeroMemory(&startup, sizeof(startup));
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);

    PROCESS_INFORMATION process;
    ZeroMemory(&process, sizeof(process));
    if (!CreateProcessW(python, command, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &process))
    {
        return fail("cannot start python");
    }

    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code = 70;
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return (int)code;
}
