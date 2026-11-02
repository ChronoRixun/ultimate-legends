#include "std_include.hpp"
#include "save_import_args.hpp"
#include <system_error>

namespace save_import_args
{
    namespace
    {
        bool local_path(const std::filesystem::path& path)
        {
            const auto text = path.wstring();
            if (text.empty() || !path.is_absolute() || text.starts_with(L"\\\\") || text.starts_with(L"//")) return false;
            for (std::size_t i = 0; i < text.size(); ++i)
            {
                if (text[i] < 32 || (text[i] == L':' && i != 1)) return false;
            }
            for (const auto& part : path) if (part == L"..") return false;
            return true;
        }
        bool hex(const std::string& value, const std::size_t length)
        {
            return value.size() == length && std::all_of(value.begin(), value.end(), [](const char c)
            { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
        }
    }
    std::optional<std::vector<std::wstring>> build(const request& r,
        const std::filesystem::path& installed_build, std::string& error)
    {
        error = "Choose a local source folder or HDD image, target SaveLC folder and valid slot.";
        if (r.mode != "inspect" && r.mode != "slots" && r.mode != "preview" && r.mode != "apply" && r.mode != "undo") return std::nullopt;
        if (r.source_kind != "auto" && r.source_kind != "xemu" && r.source_kind != "recomp") return std::nullopt;
        if (!local_path(installed_build)) return std::nullopt;
        if (r.mode != "inspect" && !local_path(r.save_dir)) return std::nullopt;
        if (r.mode != "slots" && r.mode != "undo" && !local_path(r.source)) return std::nullopt;
        std::vector<std::wstring> args;
        if (r.mode == "inspect") args = {r.source.wstring(), L"--inspect-source"};
        else if (r.mode == "slots") args = {L"--list-slots", L"--save-dir", r.save_dir.wstring()};
        else if (r.mode == "undo")
        {
            if (!r.confirmed || !hex(r.transaction_id, 32)) return std::nullopt;
            args = {L"--undo-import", std::wstring(r.transaction_id.begin(), r.transaction_id.end()), L"--save-dir", r.save_dir.wstring()};
        }
        else
        {
            if (r.slot < 0 || r.slot > 9) return std::nullopt;
            args = {r.source.wstring(), L"--build", installed_build.wstring(), L"--save-dir", r.save_dir.wstring(), L"--slot", std::to_wstring(r.slot)};
            if (r.mode == "preview") args.push_back(L"--dry-run");
            else
            {
                if (!r.confirmed || !hex(r.preview_token, 64)) return std::nullopt;
                args.insert(args.end(), {L"--preview-token", std::wstring(r.preview_token.begin(), r.preview_token.end())});
            }
            if (r.merge_unlocks) args.push_back(L"--merge-unlocks");
            if (r.allow_inferred) args.push_back(L"--allow-inferred");
        }
        if (!r.campaign.empty() && r.mode != "slots" && r.mode != "undo")
        {
            // It is a virtual FATX path, not a host path. Preserve its spelling
            // and UTF-8 bytes; the CLI matches it against bounded discovery.
            error = "Choose a campaign returned by HDD image discovery.";
            if (r.campaign.size() > 4096 || std::any_of(r.campaign.begin(), r.campaign.end(),
                [](const unsigned char c) { return c < 32 || c == 127; })) return std::nullopt;
            try
            {
                const auto path = std::filesystem::path(std::u8string(r.campaign.begin(), r.campaign.end()));
                args.insert(args.end(), {L"--campaign", path.wstring()});
            }
            catch (const std::system_error&) { return std::nullopt; }
        }
        if (r.source_kind != "auto" && r.mode != "slots" && r.mode != "undo")
            args.insert(args.end(), {L"--source-kind", std::wstring(r.source_kind.begin(), r.source_kind.end())});
        error.clear();
        return args;
    }
}
