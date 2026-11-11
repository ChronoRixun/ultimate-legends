#include "std_include.hpp"
#include "test.hpp"
#include "support/redact.hpp"

// Support > Copy diagnostics (support/redact.hpp): the report pasted into a public GitHub issue never
// shows the player's user name, profile folder, computer name or Linux home folder. Fake profiles only
// (JaneDoe, deckuser); the profile roots are put together here so the content guard's personal-path rule
// doesn't take these fixtures for someone's real folder.
namespace
{
    const std::string users = std::string("C:") + "\\" + "Users\\";       // the Windows profiles folder
    const std::string wine_users = std::string("C:") + "\\" + "users\\";  // Wine's, lower case
    const std::string home = std::string("/") + "home/";                  // Linux
    const std::string jane = users + "JaneDoe";
    const std::string deck = home + "deckuser";

    const auto windows_pc = support::make_redactions(jane, "JaneDoe", "JANE-PC", "");
    const auto proton_pc = support::make_redactions(wine_users + "steamuser", "steamuser", "", deck);

    bool has(const std::string& text, const std::string& part)
    {
        return text.find(part) != std::string::npos;
    }

    std::string forward(std::string text)
    {
        std::replace(text.begin(), text.end(), '\\', '/');
        return text;
    }

    std::string lower(std::string text)
    {
        std::transform(text.begin(), text.end(), text.begin(), [](const char c) { return static_cast<char>(std::tolower(static_cast<unsigned char>(c))); });
        return text;
    }
}

TEST(support_redact_profile_folder_any_case_and_slash)
{
    using support::redact;
    CHECK(redact(jane + "\\AppData\\Local\\Ultimate Legends", windows_pc) == "%USERPROFILE%\\AppData\\Local\\Ultimate Legends");
    CHECK(redact(lower(jane) + "\\Games", windows_pc) == "%USERPROFILE%\\Games");
    CHECK(redact(forward(jane) + "/Games/MUA", windows_pc) == "%USERPROFILE%/Games/MUA");
    CHECK(redact(jane, windows_pc) == "%USERPROFILE%");
    CHECK(redact("folder: \"" + jane + "\\x\"", windows_pc) == "folder: \"%USERPROFILE%\\x\"");
}

TEST(support_redact_user_and_computer_names_as_whole_words)
{
    using support::redact;
    // The user name outside the profile (another drive, a folder named after the player).
    CHECK(redact("D:\\JaneDoe\\Games", windows_pc) == "D:\\%USERNAME%\\Games");
    CHECK(redact("JaneDoe's MUA", windows_pc) == "%USERNAME%'s MUA");
    CHECK(redact("\\\\JANE-PC\\share", windows_pc) == "\\\\%COMPUTERNAME%\\share");
    // A longer word that starts with the name is someone else's text.
    CHECK(redact("JaneDoes " + jane + "2", windows_pc) == "JaneDoes " + jane + "2");
    // Placeholders are not matched again, and text without personal data is unchanged.
    CHECK(redact("Ultimate Legends 0.6.0-beta.3, Windows 11 build 26200", windows_pc) == "Ultimate Legends 0.6.0-beta.3, Windows 11 build 26200");
    const auto once = redact(jane + " JaneDoe", windows_pc);
    CHECK(once == "%USERPROFILE% %USERNAME%");
    CHECK(redact(once, windows_pc) == once);
}

TEST(support_redact_proton_home_folder)
{
    using support::redact;
    CHECK(redact("Z:\\home\\deckuser\\Games\\MUA", proton_pc) == "%HOME%\\Games\\MUA");
    CHECK(redact("Z:" + deck + "/Games", proton_pc) == "%HOME%/Games");
    CHECK(redact(deck + "/.steam", proton_pc) == "%HOME%/.steam");
    CHECK(redact(wine_users + "steamuser\\AppData", proton_pc) == "%USERPROFILE%\\AppData");
    const auto report = redact("data Z:\\home\\deckuser\\x, user deckuser, steamuser", proton_pc);
    CHECK(!has(report, "deckuser"));
    CHECK(!has(report, "steamuser"));
}

TEST(support_redact_skips_values_that_would_hide_everything)
{
    // A one-letter user name, a drive root or "/" as a profile would hide letters of every word.
    const auto odd = support::make_redactions("C:\\", "J", "", "/");
    CHECK(odd.empty());
    CHECK(support::redact("Just a C:\\ path", odd) == "Just a C:\\ path");
    // Longest first: the profile wins over the user name inside it.
    CHECK(windows_pc.front().placeholder == "%USERPROFILE%");
}

TEST(support_folder_name_keeps_only_the_last_part)
{
    using support::folder_name;
    CHECK(folder_name("D:\\Games\\MUA Classic\\") == "MUA Classic");
    CHECK(folder_name(jane + "\\Games\\X-Men Legends (Port)") == "X-Men Legends (Port)");
    CHECK(folder_name("Z:" + deck + "/Games/MUA") == "MUA");
    CHECK(folder_name("E:\\") == "E:");
    CHECK(folder_name("MUA") == "MUA");
}
