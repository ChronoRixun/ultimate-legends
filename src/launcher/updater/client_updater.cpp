#include <std_include.hpp>

#include "client_updater.hpp"
#include "client_store.hpp"

#include <utils/cryptography.hpp>
#include <utils/http.hpp>
#include <utils/io.hpp>
#include <utils/logger.hpp>
#include <utils/string.hpp>
#include <utils/concurrency.hpp>

namespace client_updater
{
    namespace
    {
        // A manifest name must stay inside the install folder: relative, and never climbing out.
        bool is_safe_file_name(const std::string& name)
        {
            if (name.empty())
            {
                return false;
            }

            const auto path = utils::string::utf8_to_path(name);
            if (path.is_absolute() || path.has_root_name() || path.has_root_directory())
            {
                return false;
            }

            for (const auto& part : path)
            {
                if (part == "..")
                {
                    return false;
                }
            }

            return true;
        }

        // Manifest entries are ["name", size, "sha1"]. Older manifests carry a 4th destination
        // element, which is ignored: every patch file installs into the game folder.
        std::vector<updater::file_info> parse_file_infos(const std::string& json)
        {
            rapidjson::Document doc{};
            doc.Parse(json.data(), json.size());

            if (!doc.IsArray())
            {
                return {};
            }

            std::vector<updater::file_info> files{};

            for (const auto& element : doc.GetArray())
            {
                if (!element.IsArray())
                {
                    continue;
                }

                auto array = element.GetArray();
                if (array.Size() < 3 || !array[0].IsString() || !array[1].IsInt64() || !array[2].IsString())
                {
                    continue;
                }

                updater::file_info info{};
                info.name.assign(array[0].GetString(), array[0].GetStringLength());
                info.size = array[1].GetInt64();
                info.hash.assign(array[2].GetString(), array[2].GetStringLength());

                if (!is_safe_file_name(info.name))
                {
                    utils::logger::write("Skipping patch manifest entry outside the game folder: {}", info.name);
                    continue;
                }

                files.emplace_back(std::move(info));
            }

            return files;
        }

        std::string get_cache_buster()
        {
            return "?" + std::to_string(
                std::chrono::duration_cast<std::chrono::nanoseconds>(
                    std::chrono::system_clock::now().time_since_epoch()).count());
        }

        std::vector<updater::file_info> get_file_infos(const std::string& manifest_url)
        {
            const auto json = utils::http::get_data(manifest_url + get_cache_buster(), {}, {}, {}, 10L, 2U);
            if (!json || !json.has_value())
            {
                return {};
            }

            try
            {
                const auto& result = json.value();
                if (result.code != CURLE_OK)
                {
                    return {};
                }

                return parse_file_infos(result.buffer);
            }
            catch (...)
            {
                return {};
            }
        }

        std::string get_hash(const std::string& data)
        {
            return utils::cryptography::sha1::compute(data, true);
        }

        size_t get_optimal_concurrent_download_count(const size_t file_count)
        {
            size_t cores = std::thread::hardware_concurrency();
            cores = (cores * 2) / 3;
            return std::max(1ull, std::min(cores, file_count));
        }

        std::filesystem::path resolve_install_path(const game_config::game_config_t& config)
        {
            const auto install_path_prop = config.get_install_path();
            if (!install_path_prop || install_path_prop->empty())
            {
                throw std::runtime_error("Game install path not set for: " + config.id);
            }

            return *install_path_prop;
        }
    }

    client_updater::client_updater(const game_config::game_config_t& config, updater::ui_progress_listener* listener)
        : install_path_(resolve_install_path(config)), client_id_(config.game_key),
          update_manifest_url_(config.update_manifest_url), update_folder_url_(config.update_folder_url),
          progress_listener_(listener)
    {
        if (this->update_manifest_url_.empty() || this->update_folder_url_.empty())
        {
            return;
        }

        this->manifest_files_ = get_file_infos(this->update_manifest_url_);
        this->manifest_fetch_failed_ = this->manifest_files_.empty();
    }

    void client_updater::run() const
    {
        if (this->manifest_files_.empty())
        {
            return;
        }

        this->remove_stale_files();

        // Initialize progress tracking for verification phase
        if (this->progress_listener_)
        {
            this->progress_listener_->update_files(this->manifest_files_, updater::progress_mode::verifying);
        }

        const auto outdated_files = this->get_outdated_files(this->manifest_files_);
        if (outdated_files.empty())
        {
            this->store_applied_manifest();
            return;
        }

        // Reset progress tracking for download phase with only outdated files
        if (this->progress_listener_)
        {
            this->progress_listener_->update_files(outdated_files, updater::progress_mode::downloading);
        }

        this->update_files(outdated_files);
        this->store_applied_manifest();

        std::this_thread::sleep_for(1s);
    }

    void client_updater::update_file(const updater::file_info& file) const
    {
        auto url = this->update_folder_url_ + utils::string::url_encode_path(file.name) + "?" + file.hash;
        utils::logger::write("Updating file {}", url);

        // Notify progress listener that file download is beginning
        if (this->progress_listener_)
        {
            this->progress_listener_->begin_file(file);
        }

        size_t last_progress = 0;
        const auto data = utils::http::get_data(url, {}, {}, [&](size_t progress, [[maybe_unused]] size_t total, [[maybe_unused]] size_t speed) -> bool
        {
            // Notify progress listener of download progress
            // Note: progress is cumulative bytes downloaded, so we calculate the delta
            if (this->progress_listener_)
            {
                const size_t delta = progress - last_progress;
                last_progress = progress;
                this->progress_listener_->file_progress(file, delta);
            }

            return !is_update_cancelled(); // Continue unless cancelled
        });

        if (!data || !data.has_value())
        {
            throw std::runtime_error(utils::string::va("Failed to download: %s - Data has no value", url.data()));
        }

        try
        {
            const auto& result = data.value();
            if (result.code == CURLE_ABORTED_BY_CALLBACK)
            {
                return;
            }

            if (result.code != CURLE_OK)
            {
                throw std::runtime_error(utils::string::va("Failed to download: %s - Invalid curl code (%u)", url.data(), result.code));
            }

            const auto result_size = result.buffer.size();
            if (result_size != file.size)
            {
                throw std::runtime_error(utils::string::va("Failed to download: %s - %zu != %zu", url.data(), result_size, file.size));
            }

            const auto result_hash = get_hash(result.buffer);
            if (result_hash != file.hash)
            {
                throw std::runtime_error(utils::string::va("Failed to download: %s - %s != %s", url.data(), result_hash.data(), file.hash.data()));
            }

            const auto out_file = this->get_drive_filename(file.name);
            if (!utils::io::write_file(out_file, result.buffer, false))
            {
                utils::logger::write("Failed to write {}. Error code: ", file.name,
                    std::system_category().message(static_cast<int>(::GetLastError())));
                throw std::runtime_error(utils::string::va("Failed to write: %s", out_file.string().data()));
            }

            utils::logger::write("Done updating file {}", file.name);

            // Notify progress listener that file is complete
            if (this->progress_listener_)
            {
                this->progress_listener_->end_file(file);
            }
        }
        catch (const std::exception& e)
        {
            throw std::runtime_error(utils::string::va("Failed to update patch file: %s", e.what()));
        }
        catch (...)
        {
            throw std::runtime_error("Unknown error occurred while updating patch file");
        }
    }

    std::vector<updater::file_info> client_updater::get_outdated_files(const std::vector<updater::file_info>& files) const
    {
        std::vector<updater::file_info> outdated_files{};

        for (const auto& info : files)
        {
            // Block here while paused; resume signals the cv. Cancellation is observed
            // separately via the existing libcurl-callback path or the next iteration.
            if (this->progress_listener_)
            {
                this->progress_listener_->wait_if_paused();
            }

            // Report that we're starting to verify this file
            if (this->progress_listener_)
            {
                this->progress_listener_->begin_file(info);
            }

            if (this->is_outdated_file(info))
            {
                outdated_files.emplace_back(info);
            }

            // Mark file as verified by adding its size to progress
            if (this->progress_listener_)
            {
                this->progress_listener_->file_progress(info, info.size);
            }

            // Report that we've finished verifying this file
            if (this->progress_listener_)
            {
                this->progress_listener_->end_file(info);
            }
        }

        return outdated_files;
    }

    void client_updater::update_files(const std::vector<updater::file_info>& outdated_files) const
    {
        const auto thread_count = get_optimal_concurrent_download_count(outdated_files.size());

        std::vector<std::thread> threads{};
        std::atomic<size_t> current_index{0};

        utils::concurrency::container<std::exception_ptr> exception{};

        for (size_t i = 0; i < thread_count; ++i)
        {
            threads.emplace_back([&]()
            {
                while (!exception.access<bool>([](const std::exception_ptr& ptr)
                {
                    return static_cast<bool>(ptr);
                }))
                {
                    // Block here while paused; resume signals the cv.
                    if (this->progress_listener_)
                        this->progress_listener_->wait_if_paused();
                    if (is_update_cancelled()) break;

                    const auto index = current_index++;
                    if (index >= outdated_files.size())
                    {
                        break;
                    }

                    try
                    {
                        const auto& file = outdated_files[index];
                        this->update_file(file);
                    }
                    catch (...)
                    {
                        exception.access([](std::exception_ptr& ptr)
                        {
                            ptr = std::current_exception();
                        });

                        return;
                    }
                }
            });
        }

        for (auto& thread : threads)
        {
            if (thread.joinable())
            {
                thread.join();
            }
        }

        exception.access([](const std::exception_ptr& ptr)
        {
            if (ptr)
            {
                std::rethrow_exception(ptr);
            }
        });
    }

    bool client_updater::is_outdated_file(const updater::file_info& file) const
    {
        std::string data{};
        const auto drive_name = this->get_drive_filename(file.name);
        if (!utils::io::read_file(drive_name, &data))
        {
            return true;
        }

        if (data.size() != file.size)
        {
            return true;
        }

        const auto hash = get_hash(data);
        return hash != file.hash;
    }

    std::filesystem::path client_updater::get_drive_filename(const std::string& name) const
    {
        return this->install_path_ / utils::string::utf8_to_path(name);
    }

    // Removes files the previous patch release installed into this folder and the current one no
    // longer ships. Only names the launcher itself recorded are candidates, so the game's own
    // files and anything the player added are never touched.
    void client_updater::remove_stale_files() const
    {
        // A failed manifest fetch yields an empty manifest, which would diff as "the patch ships
        // nothing" and delete everything it ever installed.
        if (this->manifest_files_.empty())
        {
            return;
        }

        const auto cached_names = client_store::read_manifest_cache(this->client_id_, this->install_path_);
        if (cached_names.empty())
        {
            return;
        }

        std::unordered_set<std::string> current_names{};
        current_names.reserve(this->manifest_files_.size());
        for (const auto& file : this->manifest_files_)
        {
            current_names.emplace(file.name);
        }

        std::set<std::filesystem::path> directories_to_check{};

        for (const auto& name : cached_names)
        {
            if (current_names.contains(name) || !is_safe_file_name(name))
            {
                continue;
            }

            const auto path = this->get_drive_filename(name);
            if (!client_store::is_below(path, this->install_path_) || !utils::io::file_exists(path))
            {
                continue;
            }

            if (!utils::io::remove_file(path))
            {
                utils::logger::write("Failed to remove stale patch file {}", name);
                continue;
            }

            utils::logger::write("Removed stale patch file {}", name);

            // Walk up to (but never including) the install folder.
            for (auto parent = path.parent_path(); client_store::is_below(parent, this->install_path_);
                 parent = parent.parent_path())
            {
                directories_to_check.insert(parent);
            }
        }

        client_store::prune_empty_directories(directories_to_check);
    }

    void client_updater::store_applied_manifest() const
    {
        // Cancellation doesn't throw (an aborted download returns quietly), so a partial run
        // reaches here looking successful. Leave the old cache so the diff is retried.
        if (this->manifest_files_.empty() || this->is_update_cancelled())
        {
            return;
        }

        std::vector<std::string> names{};
        names.reserve(this->manifest_files_.size());
        for (const auto& file : this->manifest_files_)
        {
            names.emplace_back(file.name);
        }

        if (!client_store::write_manifest_cache(this->client_id_, this->install_path_, names))
        {
            utils::logger::write("Failed to write patch manifest cache {}",
                utils::string::path_to_utf8(client_store::manifest_cache_path(this->client_id_)));
        }
    }

    void client_updater::delete_client() const
    {
        // Everything the current manifest lists plus everything the last applied one recorded, so
        // an uninstall done offline (no manifest) still removes the files the launcher installed.
        std::vector<updater::file_info> candidates = this->manifest_files_;
        std::unordered_set<std::string> seen{};
        for (const auto& file : candidates)
        {
            seen.emplace(file.name);
        }

        for (const auto& name : client_store::read_manifest_cache(this->client_id_, this->install_path_))
        {
            if (!is_safe_file_name(name) || !seen.emplace(name).second)
            {
                continue;
            }

            const auto path = this->get_drive_filename(name);
            candidates.push_back(updater::file_info{name, utils::io::file_exists(path) ? utils::io::file_size(path) : 0, {}});
        }

        utils::io::remove_file(client_store::manifest_cache_path(this->client_id_));

        std::vector<updater::file_info> files_to_delete;
        for (const auto& file : candidates)
        {
            const auto drive_name = this->get_drive_filename(file.name);
            if (client_store::is_below(drive_name, this->install_path_) && utils::io::file_exists(drive_name))
            {
                files_to_delete.push_back(file);
            }
        }

        if (files_to_delete.empty())
        {
            return;
        }

        // Initialize progress tracking for deletion phase
        if (this->progress_listener_)
        {
            this->progress_listener_->update_files(files_to_delete, updater::progress_mode::deleting);
        }

        std::set<std::filesystem::path> directories_to_check;
        for (const auto& file : files_to_delete)
        {
            if (this->progress_listener_)
            {
                this->progress_listener_->begin_file(file);
            }

            const auto drive_name = this->get_drive_filename(file.name);
            if (!utils::io::remove_file(drive_name))
            {
                printf("Warning: Failed to delete patch file: %s\n", drive_name.string().data());
            }

            // Clean up directories the patch created, never the install folder itself.
            for (auto parent = drive_name.parent_path(); client_store::is_below(parent, this->install_path_);
                 parent = parent.parent_path())
            {
                directories_to_check.insert(parent);
            }

            if (this->progress_listener_)
            {
                this->progress_listener_->file_progress(file, file.size);
                this->progress_listener_->end_file(file);
            }
        }

        client_store::prune_empty_directories(directories_to_check);
    }

    bool client_updater::is_update_cancelled() const
    {
        return (this->progress_listener_ && this->progress_listener_->is_update_cancelled());
    }
}
