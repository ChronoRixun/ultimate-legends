#include "std_include.hpp"
#include "setup.hpp"
#include "setup_admission.hpp"
#include "setup_cleanup.hpp"
#include "settings.hpp"
#include "game_config.hpp"
#include "tools/tool_install.hpp"
#include "updater/folder_work.hpp"
#include "updater/release_source.hpp"
#include "updater/launcher_update.hpp"
#include "xml1/builder_process.hpp"
#include <utils/cryptography.hpp>
#include <utils/flags.hpp>
#include <utils/io.hpp>
#include <utils/properties.hpp>
#include <utils/string.hpp>
#include <thread>

namespace muac_setup {
namespace {
    constexpr auto repo = "ChronoRixun/muac-fix";
    struct job {
        std::mutex mutex;
        bool active = true, cancelled = false, success = false;
        std::string phase = "Preparing setup", error, output;
        std::uint64_t done{}, total{};
        std::shared_ptr<xml1::builder_process> process;
        std::shared_ptr<updater::folder_work> hold;
    };
    std::mutex jobs_mutex;
    std::shared_ptr<job> current;
    bool cancelled(const std::shared_ptr<job>& work) { std::lock_guard lock(work->mutex); return work->cancelled; }
    void phase(const std::shared_ptr<job>& work, std::string text) {
        std::lock_guard lock(work->mutex); work->phase = std::move(text); work->done = work->total = 0;
    }
    void fail(const std::shared_ptr<job>& work, const std::string& error) {
        std::lock_guard lock(work->mutex); work->error = error; work->active = false; work->hold.reset();
    }
    void require_running(const std::shared_ptr<job>& work) {
        if (cancelled(work)) throw std::runtime_error("Setup cancelled. No installation was registered.");
    }
    bool valid_archive(const std::filesystem::path& file, std::uint64_t size, const std::string& hash) {
        std::error_code ec;
        if (std::filesystem::file_size(file, ec) != size || ec) return false;
        std::string bytes;
        return utils::io::read_file(file, &bytes) && utils::cryptography::sha256::compute(bytes, true) == hash;
    }
    void run(const std::shared_ptr<job>& work, const std::filesystem::path& source, const std::filesystem::path& output,
             release_channel::channel channel) {
        try {
            tool_install::tool tool{"muac-setup", "muac-setup.exe", ""};
            bool development = false;
#ifdef _DEBUG
            if (auto local = utils::properties::load("muac-dev-setup-manifest"); local && !local->empty()) {
                tool.manifest_url = *local; development = true;
            }
#endif
            const bool offline = utils::flags::has_flag("offline");
            std::string expected;
            if (!development) {
                const auto release = release_source::resolve(repo, channel, {"muac-setup.json"});
                if (!release.chosen) throw std::runtime_error("MUA 2006 setup is not available on this update channel yet. " + release.error);
                tool.manifest_url = release_source::file_url(repo, *release.chosen, "muac-setup.json");
                expected = release.chosen->version;
            }
            require_running(work);
            std::string error;
            auto manifest = offline ? tool_install::cached_manifest(tool, expected) : tool_install::fetch_manifest(tool, error);
            if (!manifest) throw std::runtime_error(error.empty() ? "Connect to the internet to download MUA 2006 setup." : error);
            if (manifest->api != 1 || (!expected.empty() && manifest->version != expected))
                throw std::runtime_error("The setup package does not match the selected release or supported protocol.");
            if (!manifest->min_launcher.empty() && tool_install::compare_versions(launcher_update::running_version(), manifest->min_launcher) < 0)
                throw std::runtime_error("This setup needs Ultimate Legends " + manifest->min_launcher + " or newer.");
            const auto progress = [work](std::uint64_t done, std::uint64_t total) {
                std::lock_guard lock(work->mutex); work->done = done; work->total = total;
            };
            const auto stop = [work] { return cancelled(work); };
            phase(work, "Downloading MUA 2006 setup");
            auto installed = tool_install::find(tool, manifest->version);
            if (installed && installed->version != manifest->version) installed.reset();
            if (!installed) {
                if (auto local = tool_install::find_local_zip(tool, *manifest)) {
                    std::optional<tool_install::zip_match> match;
                    installed = tool_install::install_from_zip(tool, *manifest, *local, match, error);
                } else if (!offline) installed = tool_install::install(tool, *manifest, progress, stop, error);
            }
            require_running(work);
            if (!installed) throw std::runtime_error(error.empty() ? "The setup package is not cached. Connect to the internet and try again." : error);
            const auto bundle = installed->folder / "runtime";
            std::string json;
            if (!utils::io::read_file(bundle / "package.json", &json) || json.size() > 128 * 1024)
                throw std::runtime_error("The installed setup package is incomplete.");
            rapidjson::Document data; data.Parse(json.data(), json.size());
            if (data.HasParseError() || !data.IsObject() || !data.HasMember("dgvoodoo") || !data["dgvoodoo"].IsObject())
                throw std::runtime_error("Invalid graphics dependency metadata.");
            const auto& graphics = data["dgvoodoo"];
            if (!graphics.HasMember("url") || !graphics["url"].IsString() || !graphics.HasMember("sha256") || !graphics["sha256"].IsString() ||
                !graphics.HasMember("size") || !graphics["size"].IsUint64()) throw std::runtime_error("Incomplete graphics dependency metadata.");
            const std::string url = graphics["url"].GetString(), hash = graphics["sha256"].GetString();
            const auto size = graphics["size"].GetUint64();
            if (!url.starts_with("https://github.com/dege-diosg/dgVoodoo2/releases/download/") ||
                hash.size() != 64 || hash.find_first_not_of("0123456789abcdef") != std::string::npos || !size || size > 128 * 1024 * 1024)
                throw std::runtime_error("The graphics dependency is not a supported upstream archive.");
            const auto cache = tool_install::root(tool) / "downloads";
            std::filesystem::create_directories(cache);
            const auto archive = cache / (hash + ".zip");
            phase(work, "Downloading graphics compatibility");
            if (!valid_archive(archive, size, hash)) {
                if (offline) throw std::runtime_error("Connect to the internet to download graphics compatibility.");
                const auto partial = cache / (hash + ".partial");
                std::string actual;
                const auto failure = tool_install::download_file(url, partial, size, progress, stop, actual);
                if (failure == "cancelled") require_running(work);
                if (!failure.empty()) throw std::runtime_error(failure);
                if (actual != hash) throw std::runtime_error("The graphics download failed SHA-256 verification.");
                std::error_code ec; std::filesystem::remove(archive, ec);
                std::filesystem::rename(partial, archive);
            }
            require_running(work);
            phase(work, "Importing your disc");
            auto process = std::make_shared<xml1::builder_process>(1, "setup");
            {
                std::lock_guard lock(work->mutex); work->process = process;
            }
            const auto finish = [work, output](const xml1::builder_snapshot& result) {
                try {
                    // builder_process invokes this only after the job is ended
                    // and both pipe readers have joined: no helper can still write.
                    if (result.killed && !result.staging.empty()) {
                        phase(work, "Cleaning up...");
                        std::error_code cleanup_error;
                        if (!cleanup::remove_stage(output, utils::string::utf8_to_path(result.staging), cleanup_error))
                            throw std::runtime_error("Setup stopped, but staging cleanup could not finish: " + cleanup_error.message() +
                                ". Reported staging folder: " + result.staging);
                    }
                    const auto ready = [&](bool was_cancelled) {
                        return admission::ready(result.exit_code, result.cancel_requested, result.killed, was_cancelled,
                            result.result, updater::folder_key(output), [](const std::string& path) {
                                return updater::folder_key(utils::string::utf8_to_path(path));
                            });
                    };
                    const bool ok = ready(cancelled(work));
                    if (!ok) {
                        fail(work, cancelled(work) ? "Setup cancelled. No installation was registered." :
                            result.errors.empty() ? "Setup did not complete. Check the source and choose a new empty output folder to retry." : result.errors.back().msg);
                        return;
                    }
                    if (!game_config::validate_game_path("muac", output) || !muac::missing_runtime(output).empty())
                        throw std::runtime_error("The prepared installation is missing required files.");
                    const auto game = game_config::get_game_config("muac");
                    if (!game) throw std::runtime_error("MUA 2006 configuration is unavailable.");
                    std::lock_guard lock(work->mutex);
                    if (!ready(work->cancelled)) {
                        work->error = "Setup cancelled after file preparation. The completed folder was kept, but not registered.";
                        work->active = false; work->hold.reset(); return;
                    }
                    game->set_install_path(output);
                    game->set_installed(true);
                    work->success = true; work->active = false; work->phase = "Ready to play"; work->hold.reset();
                } catch (const std::exception& e) { fail(work, e.what()); }
            };
            if (!process->start(installed->exe, {L"setup", L"--source", source.wstring(), L"--out", output.wstring(),
                    L"--bundle", bundle.wstring(), L"--dgvoodoo", archive.wstring()}, finish, error)) throw std::runtime_error(error);
            if (cancelled(work)) process->cancel();
        } catch (const std::exception& e) { fail(work, e.what()); }
    }
}

bool start(const std::filesystem::path& source, const std::filesystem::path& output, std::string& error) {
    std::lock_guard lock(jobs_mutex);
    if (current) { std::lock_guard job_lock(current->mutex); if (current->active) { error = "MUA 2006 setup is already running."; return false; } }
    if (source.empty() || output.empty() || !source.is_absolute() || !output.is_absolute()) { error = "Choose full source and output paths."; return false; }
    if (game_config::is_game_process_running("muac")) { error = "Close MUA 2006 before setting it up."; return false; }
    std::error_code ec;
    if (!std::filesystem::exists(source, ec) || ec) { error = "The disc source does not exist."; return false; }
    if (std::filesystem::exists(output, ec) && (!std::filesystem::is_directory(output, ec) || !std::filesystem::is_empty(output, ec))) {
        error = "Choose a new or empty output folder."; return false;
    }
    if (ec) { error = "The output folder cannot be accessed."; return false; }
    auto hold = updater::reserve(output, updater::folder_use::builder);
    if (!hold) { error = "Another operation is using the output folder."; return false; }
    auto work = std::make_shared<job>(); work->hold = std::move(hold); work->output = utils::string::path_to_utf8(output);
    current = work;
    std::thread([work, source, output, channel = release_source::current_channel()] { run(work, source, output, channel); }).detach();
    return true;
}
void cancel() {
    std::lock_guard lock(jobs_mutex);
    if (!current) return;
    std::shared_ptr<xml1::builder_process> process;
    { std::lock_guard job_lock(current->mutex); if (!current->active) return; current->cancelled = true; process = current->process; }
    if (process) process->cancel();
}
void state(rapidjson::Document& out) {
    out.SetObject(); auto& a = out.GetAllocator();
    std::lock_guard lock(jobs_mutex);
    const auto text = [&a](const std::string& value) { return rapidjson::Value(value.c_str(), static_cast<rapidjson::SizeType>(value.size()), a); };
    if (!current) { out.AddMember("active", false, a); out.AddMember("success", false, a); return; }
    std::lock_guard job_lock(current->mutex);
    const auto game = game_config::get_game_config("muac");
    const auto install = game ? game->get_install_path() : std::nullopt;
    const bool registered = current->success && game && game->is_installed() && install &&
        updater::folder_key(*install) == updater::folder_key(utils::string::utf8_to_path(current->output));
    out.AddMember("active", current->active, a); out.AddMember("success", registered, a);
    out.AddMember("cancelled", current->cancelled, a); out.AddMember("error", text(current->error), a);
    bool cleaning = current->active && (current->cancelled || current->phase == "Cleaning up...");
    if (current->process && current->active) cleaning = cleaning || current->process->snapshot().stage == "cleanup";
    out.AddMember("cleaning", cleaning, a);
    out.AddMember("phase", text(current->phase), a); out.AddMember("output", text(current->output), a);
    double percent = current->total ? 100.0 * static_cast<double>(current->done) / static_cast<double>(current->total) : 0;
    if (current->process && current->active) {
        const auto snapshot = current->process->snapshot(); percent = snapshot.overall;
        out.AddMember("message", text(snapshot.message), a);
    }
    out.AddMember("percent", current->success ? 100.0 : percent, a);
}
}
