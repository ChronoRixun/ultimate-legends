#pragma once

#include <filesystem>
#include <memory>
#include <string>

// Who may write a game folder at a time. Two kinds of hold:
// - patch work: client_updater installing, updating or removing patch files there (verify-game, a
//   launch's update, delete-game, the X-Men Legends port's update before a build), any number at
//   once, as before;
// - the X-Men Legends builder: a build into the folder, or a clean of it, alone.
// A hold is keyed by the folder itself (absolute, normalised), never by the game entry or its built
// flag: an X-Men Legends II entry pointed at the port's folder is the same folder. A command takes it
// before it starts its worker and hands it to the worker, which holds it to its last line - so it
// covers the whole worker, not its progress bar, which a cancel hides after at most a few seconds
// while the worker may still be fetching. No Windows, CEF or network in here: the unit tests build
// it on their own.
namespace updater
{
    enum class folder_use
    {
        patch,
        builder,
    };

    class folder_work
    {
    public:
        ~folder_work();

        folder_work(const folder_work&) = delete;
        folder_work& operator=(const folder_work&) = delete;

    private:
        friend std::shared_ptr<folder_work> reserve(const std::filesystem::path& folder, folder_use use);
        folder_work(std::wstring key, folder_use use);

        std::wstring key_;
        folder_use use_;
        bool committed_{}; // counted in the registry (reserve() succeeded)
    };

    // Takes `folder` for `use`, or nullptr when that would overlap: patch work never alongside the
    // builder, the builder never alongside anything. Checked and taken under one lock.
    std::shared_ptr<folder_work> reserve(const std::filesystem::path& folder, folder_use use);

    // Patch work is under way in `folder`.
    bool folder_patching(const std::filesystem::path& folder);

    // How folders are compared: absolute, lexically normal (symbolic links and junctions resolved
    // where the folder exists), '\' separators, no trailing one, lower case.
    std::wstring folder_key(const std::filesystem::path& folder);
}
