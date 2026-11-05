#pragma once

#include <chrono>
#include <functional>
#include <vector>
#include <Windows.h>

namespace models_tool
{
    // Poll while the pipe readers keep draining. No detached timer can outlive/reuse the handles.
    inline DWORD wait_for_process(HANDLE process, HANDLE job, const std::function<bool()>& cancelled,
                                  const std::chrono::milliseconds grace = std::chrono::seconds(2))
    {
        auto deadline = (std::chrono::steady_clock::time_point::max)();
        while (WaitForSingleObject(process, 50) == WAIT_TIMEOUT)
        {
            const auto now = std::chrono::steady_clock::now();
            if (deadline == (std::chrono::steady_clock::time_point::max)() && cancelled()) deadline = now + grace;
            if (now >= deadline)
            {
                break;
            }
        }
        // A parent's exit does not prove its converters have stopped using staging files.
        // Hold process handles before termination: job accounting can reach zero before
        // the processes' handles are signalled and their final I/O has unwound.
        std::vector<HANDLE> descendants;
        std::vector<ULONG_PTR> ids(66);
        for (;;)
        {
            auto* list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(ids.data());
            if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, static_cast<DWORD>(ids.size() * sizeof(ULONG_PTR)), nullptr))
            {
                for (DWORD i = 0; i < list->NumberOfProcessIdsInList; ++i)
                    if (const auto handle = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(list->ProcessIdList[i])))
                        descendants.push_back(handle);
                break;
            }
            if (GetLastError() != ERROR_MORE_DATA) break;
            ids.resize(ids.size() * 2);
        }
        TerminateJobObject(job, 130);
        WaitForSingleObject(process, INFINITE);
        DWORD code = 1;
        GetExitCodeProcess(process, &code);
        for (const auto handle : descendants)
        {
            WaitForSingleObject(handle, INFINITE);
            CloseHandle(handle);
        }
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
        while (QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)
               && accounting.ActiveProcesses != 0)
            Sleep(10);
        return code;
    }
}
