#include "std_include.hpp"
#include "test.hpp"

#include "display/dxvk.hpp"

#include <utils/cryptography.hpp>

#include <miniz.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>

// The opt-in DXVK renderer (display/dxvk.cpp): the pinned release, unpacking only its two pinned files
// from a .tar.gz, refusing anything that doesn't match, never touching the player's own d3d8/d3d9, and the
// enable flow with an injected download (synthetic fixture archives; no network). With the environment
// variable UL_DXVK_REAL_ARCHIVE pointing at the official dxvk-3.1.1.tar.gz, one more test runs the real
// pinned release through the same flow (a local file stands in for the download).
namespace
{
    std::string lower_hex(const std::string& bytes)
    {
        auto hex = utils::cryptography::sha256::compute(bytes, true);
        std::transform(hex.begin(), hex.end(), hex.begin(), [](const unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return hex;
    }

    void tar_entry(std::string& tar, const std::string& name, const std::string& data, const char type = '0')
    {
        std::string header(512, '\0');
        std::copy(name.begin(), name.end(), header.begin());
        const auto octal = [&](const size_t offset, const size_t width, const std::uint64_t value) {
            char text[32];
            std::snprintf(text, sizeof(text), "%0*llo", static_cast<int>(width - 1), static_cast<unsigned long long>(value));
            std::copy(text, text + width - 1, header.begin() + offset);
        };
        octal(100, 8, 0755);
        octal(108, 8, 0);
        octal(116, 8, 0);
        octal(124, 12, data.size());
        octal(136, 12, 0);
        header[156] = type;
        std::copy_n("ustar", 5, header.begin() + 257);
        std::fill(header.begin() + 148, header.begin() + 156, ' ');
        unsigned sum = 0;
        for (const auto c : header) sum += static_cast<unsigned char>(c);
        octal(148, 7, sum);
        tar += header;
        tar += data;
        tar.append((512 - data.size() % 512) % 512, '\0');
    }

    std::string gzip(const std::string& data)
    {
        size_t length = 0;
        void* deflated = tdefl_compress_mem_to_heap(data.data(), data.size(), &length, TDEFL_DEFAULT_MAX_PROBES);
        std::string out("\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff", 10);
        out.append(static_cast<const char*>(deflated), length);
        mz_free(deflated);
        const auto crc = static_cast<std::uint32_t>(mz_crc32(MZ_CRC32_INIT, reinterpret_cast<const unsigned char*>(data.data()), data.size()));
        const auto size = static_cast<std::uint32_t>(data.size());
        for (const auto value : {crc, size})
            for (int i = 0; i < 4; ++i) out += static_cast<char>((value >> (8 * i)) & 0xff);
        return out;
    }

    // A release shaped like DXVK's: x32 and x64 folders, other DLLs beside the two that are pinned.
    struct fixture
    {
        std::filesystem::path root, game, cache;
        std::string d3d8 = std::string(70000, '8') + "synthetic 32-bit d3d8";
        std::string d3d9 = std::string(90000, '9') + "synthetic 32-bit d3d9";
        dxvk::release release;
        std::string archive;

        fixture()
        {
            static unsigned count{};
            root = std::filesystem::temp_directory_path() / ("ul-dxvk-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + "-" + std::to_string(++count));
            game = root / "game";
            cache = root / "cache";
            std::filesystem::create_directories(game);
            release = {"9.9.9", "https://example.invalid/dxvk-9.9.9.tar.gz", "dxvk-9.9.9.tar.gz", 0, "",
                {{"dxvk-9.9.9/x32/d3d8.dll", L"d3d8.dll", d3d8.size(), lower_hex(d3d8)},
                 {"dxvk-9.9.9/x32/d3d9.dll", L"d3d9.dll", d3d9.size(), lower_hex(d3d9)}}};
            archive = gzip(tar({}));
            release.size = archive.size();
            release.sha256 = lower_hex(archive);
        }

        ~fixture()
        {
            std::error_code ec;
            std::filesystem::remove_all(root, ec);
        }

        std::string tar(const std::map<std::string, std::string>& replace) const
        {
            const auto pick = [&](const std::string& name, const std::string& data) {
                const auto it = replace.find(name);
                return it == replace.end() ? data : it->second;
            };
            std::string out;
            tar_entry(out, "dxvk-9.9.9/", "", '5');
            tar_entry(out, "dxvk-9.9.9/x32/", "", '5');
            tar_entry(out, "dxvk-9.9.9/x32/d3d9.dll", pick("dxvk-9.9.9/x32/d3d9.dll", d3d9));
            tar_entry(out, "dxvk-9.9.9/x32/d3d11.dll", "synthetic d3d11");
            tar_entry(out, "dxvk-9.9.9/x32/d3d8.dll", pick("dxvk-9.9.9/x32/d3d8.dll", d3d8));
            tar_entry(out, "dxvk-9.9.9/x64/d3d8.dll", "synthetic 64-bit d3d8");
            tar_entry(out, "dxvk-9.9.9/x64/d3d9.dll", "synthetic 64-bit d3d9");
            out.append(1024, '\0');
            return out;
        }

        static void put(const std::filesystem::path& file, const std::string& bytes)
        {
            std::ofstream out(file, std::ios::binary | std::ios::trunc);
            out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
        }

        static std::string read(const std::filesystem::path& file)
        {
            std::ifstream in(file, std::ios::binary);
            return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
        }

        // The launcher's download, standing in: writes `bytes` (the fixture "server"'s answer).
        dxvk::download_fn serve(const std::string& bytes, int* calls = nullptr, std::string failure = {}) const
        {
            return [bytes, calls, failure](const std::string&, const std::filesystem::path& file, std::uint64_t, std::string& sha256) {
                if (calls) ++*calls;
                if (!failure.empty()) return failure;
                put(file, bytes);
                sha256 = lower_hex(bytes);
                return std::string{};
            };
        }
    };
}

TEST(dxvk_pin_is_the_official_3_1_1_release)
{
    const auto& pin = dxvk::pinned();
    CHECK(pin.version == "3.1.1");
    CHECK(pin.url == "https://github.com/doitsujin/dxvk/releases/download/v3.1.1/dxvk-3.1.1.tar.gz");
    CHECK(pin.size == 18041512);
    CHECK(pin.sha256 == "40565b4a724aadc4433fa4e010b4b23916d9b1f1baeee64e17186db94f54e608");
    CHECK(pin.files.size() == 2);
    CHECK(pin.files[0].member == "dxvk-3.1.1/x32/d3d8.dll" && pin.files[0].name == L"d3d8.dll");
    CHECK(pin.files[0].sha256 == "9152ba43386e756790a66f61cdcee01b3287d156d4161c7456d816faa82fc364");
    CHECK(pin.files[1].member == "dxvk-3.1.1/x32/d3d9.dll" && pin.files[1].name == L"d3d9.dll");
    CHECK(pin.files[1].sha256 == "265888c31ca78dffa290c39cb7e50bfb02762590e41927906e46fb32f01497fa");
}

TEST(dxvk_is_offered_on_x_men_legends_only)
{
    // Owen 11-15: X-Men Legends II gets it later, after testing. Turning it on is one line (dxvk::offered_for).
    CHECK(dxvk::offered_for("xml1"));
    CHECK(!dxvk::offered_for("xml2"));
    CHECK(!dxvk::offered_for("mua"));
    CHECK(!dxvk::offered_for("mua2"));
    CHECK(!dxvk::offered_for("muac"));
    CHECK(!dxvk::offered_for(""));
}

TEST(dxvk_extract_takes_only_the_pinned_32_bit_files)
{
    fixture f;
    std::string error;
    const auto files = dxvk::extract(f.archive, f.release, error);
    CHECK(files.has_value());
    CHECK(error.empty());
    if (!files) return;
    CHECK(files->size() == 2);
    CHECK(files->at("dxvk-9.9.9/x32/d3d8.dll") == f.d3d8);
    CHECK(files->at("dxvk-9.9.9/x32/d3d9.dll") == f.d3d9);
}

TEST(dxvk_extract_refuses_changed_missing_or_damaged_archives)
{
    fixture f;
    std::string error;
    // A member that isn't the pinned file.
    CHECK(!dxvk::extract(gzip(f.tar({{"dxvk-9.9.9/x32/d3d9.dll", f.d3d9 + "x"}})), f.release, error));
    CHECK(error.find("SHA-256") != std::string::npos);
    // A pinned member missing.
    std::string tar;
    tar_entry(tar, "dxvk-9.9.9/x32/d3d8.dll", f.d3d8);
    tar.append(1024, '\0');
    error.clear();
    CHECK(!dxvk::extract(gzip(tar), f.release, error));
    CHECK(error.find("does not contain") != std::string::npos);
    // Damaged: a flipped byte in the deflate stream or the CRC; not a gzip at all; cut short.
    auto damaged = f.archive;
    damaged[damaged.size() - 6] ^= 0x5a;
    CHECK(!dxvk::extract(damaged, f.release, error));
    auto inner = f.archive;
    inner[40] ^= 0x5a;
    CHECK(!dxvk::extract(inner, f.release, error));
    CHECK(!dxvk::extract("PK\x03\x04 not a tarball", f.release, error));
    CHECK(!dxvk::extract(std::string_view(f.archive).substr(0, f.archive.size() / 2), f.release, error));
}

TEST(dxvk_install_and_remove_touch_only_the_pinned_files)
{
    fixture f;
    fixture::put(f.game / "XMen2.exe", "synthetic exe");
    std::string error;
    const auto files = dxvk::extract(f.archive, f.release, error);
    CHECK(files.has_value());
    if (!files) return;
    CHECK(dxvk::inspect(f.game, f.release) == dxvk::files_state::none);
    CHECK(dxvk::install(f.game, f.release, *files).empty());
    CHECK(dxvk::inspect(f.game, f.release) == dxvk::files_state::ours);
    CHECK(fixture::read(f.game / "d3d8.dll") == f.d3d8);
    CHECK(!std::filesystem::exists(f.game / "d3d8.dll.ul-dxvk-new"));

    std::filesystem::remove(f.game / "d3d9.dll");
    CHECK(dxvk::inspect(f.game, f.release) == dxvk::files_state::partial);
    CHECK(dxvk::remove(f.game, f.release).empty());
    CHECK(dxvk::inspect(f.game, f.release) == dxvk::files_state::none);
    CHECK(!std::filesystem::exists(f.game / "d3d8.dll"));
    CHECK(fixture::read(f.game / "XMen2.exe") == "synthetic exe");

    // The player's own d3d9.dll (another wrapper): reported, never replaced, never removed.
    fixture::put(f.game / "d3d9.dll", "the player's own wrapper");
    CHECK(dxvk::inspect(f.game, f.release) == dxvk::files_state::foreign);
    CHECK(!dxvk::install(f.game, f.release, *files).empty());
    CHECK(!std::filesystem::exists(f.game / "d3d8.dll"));
    CHECK(dxvk::remove(f.game, f.release).empty());
    CHECK(fixture::read(f.game / "d3d9.dll") == "the player's own wrapper");

    // Contents that aren't the pinned files are refused before anything is written.
    std::filesystem::remove(f.game / "d3d9.dll");
    auto wrong = *files;
    wrong["dxvk-9.9.9/x32/d3d8.dll"] += "!";
    CHECK(!dxvk::install(f.game, f.release, wrong).empty());
    CHECK(dxvk::inspect(f.game, f.release) == dxvk::files_state::none);
}

TEST(dxvk_enable_downloads_once_checks_the_hash_and_installs)
{
    fixture f;
    int calls = 0;
    std::vector<std::string> phases;
    dxvk::enable_steps steps;
    steps.download = f.serve(f.archive, &calls);
    steps.phase = [&](const std::string& phase) { phases.push_back(phase); };
    CHECK(dxvk::enable(f.game, f.cache, f.release, steps).empty());
    CHECK(calls == 1);
    CHECK(dxvk::inspect(f.game, f.release) == dxvk::files_state::ours);
    CHECK(dxvk::archive_valid(f.cache / f.release.archive, f.release));
    CHECK(!std::filesystem::exists(f.cache / "dxvk-9.9.9.tar.gz.partial"));
    CHECK(!phases.empty() && phases.front() == "download" && phases.back() == "install");

    // Off, then on again: the kept download is reused, even offline.
    CHECK(dxvk::remove(f.game, f.release).empty());
    steps.offline = true;
    CHECK(dxvk::enable(f.game, f.cache, f.release, steps).empty());
    CHECK(calls == 1);
    CHECK(dxvk::inspect(f.game, f.release) == dxvk::files_state::ours);
}

TEST(dxvk_enable_refuses_a_download_that_is_not_the_pinned_archive)
{
    fixture f;
    int calls = 0;
    dxvk::enable_steps steps;
    // The "server" answers with another archive (same layout, a changed d3d8.dll).
    steps.download = f.serve(gzip(f.tar({{"dxvk-9.9.9/x32/d3d8.dll", f.d3d8 + "tampered"}})), &calls);
    const auto error = dxvk::enable(f.game, f.cache, f.release, steps);
    CHECK(calls == 1);
    CHECK(error.find("SHA-256") != std::string::npos);
    CHECK(dxvk::inspect(f.game, f.release) == dxvk::files_state::none);
    CHECK(!std::filesystem::exists(f.cache / f.release.archive));
    CHECK(!std::filesystem::exists(f.cache / "dxvk-9.9.9.tar.gz.partial"));

    // A damaged archive in the cache is not trusted: it is fetched again.
    fixture::put(f.cache / f.release.archive, "damaged");
    steps.download = f.serve(f.archive, &calls);
    CHECK(dxvk::enable(f.game, f.cache, f.release, steps).empty());
    CHECK(calls == 2);
}

TEST(dxvk_enable_offline_failed_and_cancelled_downloads_leave_nothing)
{
    fixture f;
    int calls = 0;
    dxvk::enable_steps steps;
    steps.offline = true;
    steps.download = f.serve(f.archive, &calls);
    auto error = dxvk::enable(f.game, f.cache, f.release, steps);
    CHECK(error.find("offline") != std::string::npos);
    CHECK(calls == 0);

    steps.offline = false;
    steps.download = f.serve(f.archive, &calls, "The download failed (Couldn't resolve host name).");
    error = dxvk::enable(f.game, f.cache, f.release, steps);
    CHECK(error == "The download failed (Couldn't resolve host name).");
    CHECK(calls == 1);

    steps.download = f.serve(f.archive, &calls, "cancelled");
    CHECK(dxvk::enable(f.game, f.cache, f.release, steps) == "cancelled");

    steps.download = f.serve(f.archive, &calls);
    steps.cancelled = [] { return true; };
    CHECK(dxvk::enable(f.game, f.cache, f.release, steps) == "cancelled");
    CHECK(dxvk::inspect(f.game, f.release) == dxvk::files_state::none);
    CHECK(!std::filesystem::exists(f.cache / "dxvk-9.9.9.tar.gz.partial"));
}

// Optional (agent check, not CI): the real pinned release from a local copy of the official archive.
TEST(dxvk_real_pinned_archive_when_provided)
{
    char* value = nullptr;
    size_t length = 0;
    if (_dupenv_s(&value, &length, "UL_DXVK_REAL_ARCHIVE") != 0 || !value)
    {
        std::printf("    (UL_DXVK_REAL_ARCHIVE not set: real-archive check skipped)\n");
        return;
    }
    const std::filesystem::path real = value;
    std::free(value);
    const auto& pin = dxvk::pinned();
    CHECK(dxvk::archive_valid(real, pin));
    std::string error;
    const auto files = dxvk::extract_file(real, pin, error);
    CHECK(files.has_value());
    CHECK(error.empty());

    fixture f;
    const auto bytes = fixture::read(real);
    dxvk::enable_steps steps;
    steps.download = f.serve(bytes);
    CHECK(dxvk::enable(f.game, f.cache, pin, steps).empty());
    CHECK(dxvk::inspect(f.game, pin) == dxvk::files_state::ours);
    CHECK(dxvk::sha256_file(f.game / "d3d8.dll") == pin.files[0].sha256);
    CHECK(dxvk::sha256_file(f.game / "d3d9.dll") == pin.files[1].sha256);
    CHECK(dxvk::remove(f.game, pin).empty());
    CHECK(dxvk::inspect(f.game, pin) == dxvk::files_state::none);
    std::printf("    (real DXVK %s archive: pinned SHA-256 and both x32 files verified)\n", pin.version.c_str());
}
