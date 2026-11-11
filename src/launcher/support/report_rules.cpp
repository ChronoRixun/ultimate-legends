#include "std_include.hpp"
#include "report_rules.hpp"

namespace support
{
    int scale_percent(const int dpi)
    {
        return dpi > 0 ? (dpi * 100 + 48) / 96 : 0;
    }

    display_report choose_display(const display_facts& facts)
    {
        display_report out;
        out.desktop = facts.desktop.valid() ? facts.desktop : facts.current;
        const bool changed = facts.desktop.valid() && facts.current.valid() && !facts.desktop.same_size(facts.current);
        if (changed)
        {
            out.current = facts.current;
        }

        if (!changed && facts.monitor_dpi > 0)
        {
            out.scale = scale_percent(facts.monitor_dpi);
            out.source = scale_source::now;
        }
        else if (facts.remembered_dpi > 0 && facts.remembered_mode.valid() && facts.remembered_mode.same_size(out.desktop))
        {
            out.scale = scale_percent(facts.remembered_dpi);
            out.source = scale_source::launcher_start;
        }
        else if (facts.system_dpi > 0)
        {
            out.scale = scale_percent(facts.system_dpi);
            out.source = scale_source::sign_in;
        }
        return out;
    }

    namespace
    {
        bool version_char(const char c)
        {
            return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '.' || c == '-' || c == '+';
        }

        // "<fix name> 1.11.0" in the log's first lines (after a "[hh:mm:ss.mmm] " stamp).
        std::string version_from_log(const std::string& head, const std::string& fix_name)
        {
            if (fix_name.empty()) return {};
            const auto needle = fix_name + " ";
            std::size_t lines = 0;
            for (std::size_t start = 0; start < head.size() && lines < 5; ++lines)
            {
                auto end = head.find('\n', start);
                if (end == std::string::npos) end = head.size();
                const auto line = head.substr(start, end - start);
                start = end + 1;
                const auto at = line.find(needle);
                if (at == std::string::npos) continue;
                auto pos = at + needle.size();
                if (pos >= line.size() || line[pos] < '0' || line[pos] > '9') continue;
                std::string version;
                while (pos < line.size() && version_char(line[pos])) version.push_back(line[pos++]);
                while (!version.empty() && (version.back() == '.' || version.back() == '-' || version.back() == '+')) version.pop_back();
                if (version.find('.') != std::string::npos) return version;
            }
            return {};
        }
    }

    fix_version choose_fix_version(const std::optional<std::string>& dll, const std::string& recorded, const std::string& log_head,
                                   const std::string& fix_name)
    {
        if (!dll) return {};
        if (!dll->empty()) return {*dll, version_source::dll};
        if (!recorded.empty()) return {recorded, version_source::record};
        if (auto version = version_from_log(log_head, fix_name); !version.empty()) return {std::move(version), version_source::log};
        return {{}, version_source::unknown};
    }
}
