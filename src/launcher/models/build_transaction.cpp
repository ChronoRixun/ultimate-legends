#include "std_include.hpp"
#include "build_transaction.hpp"
#include "models_args.hpp"
#include <utils/cryptography.hpp>

#include <fstream>
#include <iterator>
#include <stdexcept>
#include <Windows.h>

namespace models_tool
{
    namespace
    {
        namespace fs = std::filesystem;

        void plain(const fs::path& path)
        {
            const auto attributes = GetFileAttributesW(path.c_str());
            if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
                throw std::runtime_error("Model build refuses a missing path or reparse point: " + path.string());
        }

        std::string read(const fs::path& path)
        {
            std::ifstream in(path, std::ios::binary);
            if (!in) throw std::runtime_error("Could not read " + path.string());
            return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
        }

        std::vector<std::string> owned(const fs::path& mods)
        {
            plain(mods);
            std::vector<std::string> names;
            for (const auto& entry : fs::directory_iterator(mods))
            {
                const auto name = entry.path().filename().string();
                if (name.starts_with('.')) continue;
                // Never follow a user mod junction while looking for ownership markers.
                const auto attributes = GetFileAttributesW(entry.path().c_str());
                if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) continue;
                if (!entry.is_directory() || !fs::exists(entry.path() / "legends-models.json")) continue;
                plain(entry.path() / "legends-models.json");
                if (fs::file_size(entry.path() / "legends-models.json") > (4u << 20))
                    throw std::runtime_error("Model ownership marker is too large");
                if (!models_args::parse_marker(read(entry.path() / "legends-models.json"))) continue;
                if (!models_args::valid_pack(name)) throw std::runtime_error("Invalid model folder name: " + name);
                names.push_back(name);
            }
            std::sort(names.begin(), names.end());
            return names;
        }

        void copy_tree(const fs::path& from, const fs::path& to)
        {
            plain(from);
            for (const auto& entry : fs::recursive_directory_iterator(from)) plain(entry.path());
            fs::copy(from, to, fs::copy_options::recursive);
        }

        std::string file_digest(const fs::path& path)
        {
            std::ifstream input(path, std::ios::binary);
            if (!input) throw std::runtime_error("Could not read " + path.string());
            utils::cryptography::sha256::stream hash;
            char buffer[65536];
            while (input)
            {
                input.read(buffer, sizeof(buffer));
                hash.update(buffer, static_cast<std::size_t>(input.gcount()));
            }
            if (input.bad()) throw std::runtime_error("Could not hash " + path.string());
            return hash.finish_hex();
        }

        std::map<std::string, std::string> fingerprints(const fs::path& mods, const std::vector<std::string>& names)
        {
            std::map<std::string, std::string> result;
            for (const auto& name : names)
            {
                std::map<fs::path, std::string> files;
                for (const auto& entry : fs::recursive_directory_iterator(mods / name))
                {
                    plain(entry.path());
                    files[entry.path().lexically_relative(mods / name)] = entry.is_directory() ? "directory" :
                        file_digest(entry.path());
                }
                std::string bytes;
                for (const auto& [path, hash] : files) bytes += path.generic_string() + '\0' + hash + '\0';
                result[name] = utils::cryptography::sha256::compute(bytes, true);
            }
            const auto order = mods / "load-order.txt";
            if (fs::exists(order))
            {
                plain(order);
                result["load-order.txt"] = file_digest(order);
            }
            return result;
        }
    }

    build_transaction::build_transaction(const fs::path& port, const std::string& token)
        : mods_(port / "mods"), root_(mods_ / (".ul-models-build-" + token)), game_(root_ / "game")
    {
        if (!models_args::valid_pack(token)) throw std::runtime_error("Invalid model build token");
        plain(port);
        fs::create_directories(mods_);
        plain(mods_);
        if (!fs::create_directory(root_)) throw std::runtime_error("Model build staging already exists");
        try
        {
            fs::create_directories(game_ / "mods");
            original_ = owned(mods_);
            baseline_ = fingerprints(mods_, original_);
            for (const auto& name : original_) copy_tree(mods_ / name, game_ / "mods" / name);
            const auto order = mods_ / "load-order.txt";
            if (fs::exists(order))
            {
                plain(order);
                fs::copy_file(order, game_ / "mods" / "load-order.txt");
            }
        }
        catch (...)
        {
            std::error_code ec;
            fs::remove_all(root_, ec);
            throw;
        }
    }

    build_transaction::~build_transaction()
    {
        if (!preserve_recovery_)
        {
            std::error_code ec;
            fs::remove_all(root_, ec);
        }
    }

    void build_transaction::commit()
    {
        const auto staged = game_ / "mods";
        const auto next = owned(staged);
        // An external ownership change or an unowned name collision must never be overwritten.
        if (owned(mods_) != original_) throw std::runtime_error("Model folders changed during the build; try again");
        if (fingerprints(mods_, original_) != baseline_)
            throw std::runtime_error("Model files or load order changed during the build; try again");
        const auto updated = fingerprints(staged, next);
        for (const auto& name : next)
        {
            if (fs::exists(mods_ / name) && !std::binary_search(original_.begin(), original_.end(), name))
                throw std::runtime_error("Refusing to replace an unrelated mod: " + name);
            plain(staged / name);
            for (const auto& entry : fs::recursive_directory_iterator(staged / name)) plain(entry.path());
        }
        const auto order = staged / "load-order.txt";
        if (fs::exists(order)) plain(order);
        if (fs::exists(mods_ / "load-order.txt")) plain(mods_ / "load-order.txt");
        const auto backup = root_ / "backup";
        fs::create_directory(backup);
        // Allocate the rollback plan before the first rename; recording a completed move
        // must not itself throw after the original has left its live location.
        std::vector<std::string> moving, installing;
        for (const auto& name : original_)
            if (!updated.contains(name) || updated.at(name) != baseline_.at(name)) moving.push_back(name);
        for (const auto& name : next)
            if (!baseline_.contains(name) || updated.at(name) != baseline_.at(name)) installing.push_back(name);
        std::size_t moved = 0, installed = 0;
        bool saved_order = false, installed_order = false;
        try
        {
            for (const auto& name : moving)
            {
                fs::rename(mods_ / name, backup / name);
                ++moved;
            }
            if (fs::exists(mods_ / "load-order.txt"))
            {
                fs::rename(mods_ / "load-order.txt", backup / "load-order.txt");
                saved_order = true;
            }
            for (const auto& name : installing)
            {
                fs::rename(staged / name, mods_ / name);
                ++installed;
            }
            if (fs::exists(order))
            {
                fs::rename(order, mods_ / "load-order.txt");
                installed_order = true;
            }
        }
        catch (...)
        {
            try
            {
                if (installed_order) fs::rename(mods_ / "load-order.txt", order);
                for (std::size_t i = 0; i < installed; ++i) fs::rename(mods_ / installing[i], staged / installing[i]);
                if (saved_order) fs::rename(backup / "load-order.txt", mods_ / "load-order.txt");
                for (std::size_t i = 0; i < moved; ++i) fs::rename(backup / moving[i], mods_ / moving[i]);
            }
            catch (...)
            {
                // Keep original bytes for manual recovery if another process blocks rollback.
                preserve_recovery_ = true;
                throw std::runtime_error("Model publication rollback blocked; originals retained in " + backup.string());
            }
            throw;
        }
    }
}
