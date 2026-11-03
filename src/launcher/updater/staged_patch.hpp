#pragma once

#include <atomic>
#include <chrono>
#include <filesystem>
#include <functional>
#include <stdexcept>
#include <string>
#include <vector>

// Prepare every changed patch file before exposing any of them to the builder. A failed
// download/cancel leaves a fresh folder empty (or absent), and a failed commit restores
// existing files. Staging is on the destination volume so publication uses renames.
namespace updater::staged_patch
{
    inline void apply(const std::filesystem::path& folder, const std::vector<std::filesystem::path>& names,
                      const std::function<void(const std::filesystem::path&)>& populate,
                      const std::function<bool()>& cancelled)
    {
        for (const auto& name : names)
        {
            if (name.empty() || name.is_absolute() || name.has_root_name()) throw std::runtime_error("Invalid patch file name.");
            for (const auto& part : name)
                if (part == "..") throw std::runtime_error("Invalid patch file name.");
        }
        std::vector<std::filesystem::path> created;
        const auto ensure = [&](const std::filesystem::path& path)
        {
            std::vector<std::filesystem::path> missing;
            for (auto current = path; !current.empty() && !std::filesystem::exists(current); current = current.parent_path())
                missing.push_back(current);
            for (auto it = missing.rbegin(); it != missing.rend(); ++it)
                if (std::filesystem::create_directory(*it)) created.push_back(*it);
        };
        struct change { std::filesystem::path name; bool backed{}; bool placed{}; };
        std::vector<change> changes;
        std::filesystem::path stage;
        bool owns_stage = false;
        const auto cleanup = [&]
        {
            std::error_code ignored;
            if (owns_stage) std::filesystem::remove_all(stage, ignored);
            for (auto it = created.rbegin(); it != created.rend(); ++it) std::filesystem::remove(*it, ignored);
        };
        try
        {
            ensure(folder);
            static std::atomic<unsigned> next{};
            do
            {
                stage = folder / (".ul-fix-stage-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) +
                                  "-" + std::to_string(next++));
            } while (!std::filesystem::create_directory(stage));
            owns_stage = true;
            std::filesystem::create_directory(stage / "files");
            populate(stage / "files");
            for (const auto& name : names)
            {
                if (cancelled()) throw std::runtime_error("XML2 Fix preparation was cancelled.");
                const auto source = stage / "files" / name;
                if (!std::filesystem::is_regular_file(source)) throw std::runtime_error("A prepared patch file is missing.");
                ensure((folder / name).parent_path());
                changes.push_back({name});
                auto& changed = changes.back();
                if (std::filesystem::exists(folder / name))
                {
                    if (!std::filesystem::is_regular_file(folder / name)) throw std::runtime_error("A patch file conflicts with a directory.");
                    std::filesystem::create_directories((stage / "backup" / name).parent_path());
                    std::filesystem::rename(folder / name, stage / "backup" / name);
                    changed.backed = true;
                }
                std::filesystem::rename(source, folder / name);
                changed.placed = true;
            }
            if (cancelled()) throw std::runtime_error("XML2 Fix preparation was cancelled.");
        }
        catch (...)
        {
            // Preserve backups if a filesystem failure prevents rollback; never delete the
            // player's only remaining copy. The error surfaces to the build preparation UI.
            for (auto it = changes.rbegin(); it != changes.rend(); ++it)
            {
                if (it->placed) std::filesystem::remove(folder / it->name);
                if (it->backed) std::filesystem::rename(stage / "backup" / it->name, folder / it->name);
            }
            cleanup();
            throw;
        }
        cleanup();
    }
}
