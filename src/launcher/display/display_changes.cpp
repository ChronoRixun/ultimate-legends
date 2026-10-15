#include "std_include.hpp"
#include "xml2_display.hpp"

// The part of xml2_display that only looks at a list of changes (no ini, no Windows), so the unit
// tests (src/tests) build it on their own.
namespace xml2_display
{
    namespace
    {
        bool sets_fullscreen(const change& item)
        {
            constexpr std::string_view fullscreen = "fullscreen";
            if (item.key != "Mode" || !item.value || item.value->size() != fullscreen.size())
            {
                return false;
            }
            return std::equal(item.value->begin(), item.value->end(), fullscreen.begin(), [](const char a, const char b)
            {
                return std::tolower(static_cast<unsigned char>(a)) == b;
            });
        }
    }

    std::vector<change> implied_changes(const std::vector<change>& changes)
    {
        // The last Mode change is the one the ini keeps.
        const auto mode = std::find_if(changes.rbegin(), changes.rend(), [](const change& item)
        {
            return item.key == "Mode";
        });
        if (mode == changes.rend() || !sets_fullscreen(*mode))
        {
            return changes;
        }

        std::vector<change> result;
        for (const auto& item : changes)
        {
            if (item.key != "Width" && item.key != "Height")
            {
                result.push_back(item);
            }
        }
        result.push_back({"Width", "0"});
        result.push_back({"Height", "0"});
        return result;
    }
}
