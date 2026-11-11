#pragma once

#include <string>
#include <vector>

// Support > Copy diagnostics must not carry personal data: the report players paste into a public
// GitHub issue never shows their user name, user profile folder, computer name or Linux home folder.
// support::diagnostics runs every string of the report through redact(); a game's folder is shown by
// its name only (folder_name). Pure string code: the native tests run it against fake profiles.
namespace support
{
    struct redaction
    {
        std::string value;       // what to hide (the profile folder, %USERPROFILE%); matched without regard to ASCII case, '/' = '\'
        std::string placeholder; // what to show instead ("%USERPROFILE%")
    };

    // The redactions for this PC's values, longest first: the profile folder, the Linux home folder Wine
    // shows (as $HOME and as Z: followed by it), the user name and the computer name. Empty or one-character values
    // are skipped (a one-letter user name would hide letters of every word).
    std::vector<redaction> make_redactions(const std::string& profile, const std::string& user, const std::string& computer,
                                           const std::string& unix_home);

    // `text` with every occurrence of a redaction's value replaced. A value only matches as a whole:
    // the characters next to it must not be letters, digits or '_' ("Jane" hides "Jane's MUA" and
    // %USERPROFILE%\Games, not "Janet"). One pass: placeholders are never matched again.
    std::string redact(const std::string& text, const std::vector<redaction>& redactions);

    // The last component of a UTF-8 path ("D:\Games\MUA Classic\" -> "MUA Classic"); a drive root as is.
    std::string folder_name(const std::string& path);
}
