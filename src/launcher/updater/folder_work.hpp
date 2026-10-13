#pragma once

#include <filesystem>
#include <string>

// Patch work under way in a folder: client_updater installing, updating or removing a game's patch
// files there (verify-game, a launch's update, delete-game, the X-Men Legends port's update before
// a build). A command registers it before it starts its worker thread and the worker holds it to
// its last line, so it covers the whole worker - not its progress bar, which a cancel hides after
// at most a few seconds while the worker may still be fetching. The X-Men Legends builder never
// starts in a folder with patch work under way (xml1_port::start_build), and the page waits for it
// before a build. No Windows, CEF or network in here: the unit tests build it on their own.
namespace updater
{
    class folder_work
    {
    public:
        explicit folder_work(const std::filesystem::path& folder);
        ~folder_work();

        folder_work(const folder_work&) = delete;
        folder_work& operator=(const folder_work&) = delete;

    private:
        std::wstring key_;
    };

    // Patch work is under way in `folder` (the same folder however its path is spelled: case,
    // separators, a trailing one).
    bool folder_busy(const std::filesystem::path& folder);

    // How folders are compared: lexically normal, '\' separators, no trailing one, lower case.
    std::wstring folder_key(const std::filesystem::path& folder);
}
