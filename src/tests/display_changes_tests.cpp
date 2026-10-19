#include "std_include.hpp"
#include "test.hpp"

#include "display/xml2_display.hpp"

// The Display section's Fullscreen: the XML2 Fix honours [Display] Width/Height in exclusive
// fullscreen, so switching to it writes both as 0 (the game's own Video options) instead of keeping
// a size chosen for Windowed. These are the changes written for what the page sends.
namespace
{
    using xml2_display::change;

    std::string text(const std::vector<change>& changes)
    {
        std::string result;
        for (const auto& item : changes)
        {
            result += item.key + "=" + item.value.value_or("(removed)") + ";";
        }
        return result;
    }

    std::string implied(const std::vector<change>& changes)
    {
        return text(xml2_display::implied_changes(changes));
    }
}

TEST(fullscreen_sets_width_and_height_to_the_games_setting)
{
    CHECK(implied({{"Mode", "fullscreen"}}) == "Mode=fullscreen;Width=0;Height=0;");
}

TEST(fullscreen_replaces_a_size_sent_with_it)
{
    // A resolution picked in Windowed a moment before the switch (one debounced write) is not kept.
    CHECK(implied({{"Width", "1280"}, {"Mode", "fullscreen"}, {"Height", "720"}, {"VSync", "1"}})
          == "Mode=fullscreen;VSync=1;Width=0;Height=0;");
    CHECK(implied({{"Mode", "fullscreen"}, {"Width", std::nullopt}, {"Height", std::nullopt}}) == "Mode=fullscreen;Width=0;Height=0;");
}

TEST(the_other_modes_keep_their_size)
{
    CHECK(implied({{"Mode", "windowed"}, {"Width", "1280"}, {"Height", "720"}}) == "Mode=windowed;Width=1280;Height=720;");
    CHECK(implied({{"Mode", "borderless"}}) == "Mode=borderless;");
    // Game default removes Mode; the resolution stays for a later Borderless or Windowed.
    CHECK(implied({{"Mode", std::nullopt}}) == "Mode=(removed);");
}

TEST(changes_without_a_mode_are_written_as_sent)
{
    CHECK(implied({{"Width", "1920"}, {"Height", "1080"}}) == "Width=1920;Height=1080;");
    CHECK(implied({{"FrameRate", "refresh"}, {"RunInBackground", "0"}}) == "FrameRate=refresh;RunInBackground=0;");
    CHECK(implied({}).empty());
}

TEST(the_last_mode_sent_decides)
{
    CHECK(implied({{"Mode", "fullscreen"}, {"Mode", "windowed"}, {"Width", "1280"}}) == "Mode=fullscreen;Mode=windowed;Width=1280;");
    CHECK(implied({{"Mode", "windowed"}, {"Mode", "FullScreen"}}) == "Mode=windowed;Mode=FullScreen;Width=0;Height=0;");
}
