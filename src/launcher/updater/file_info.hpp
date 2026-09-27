#pragma once

#include <string>

namespace updater
{
    // One entry of a patch manifest: ["name", size, "sha1"]. The name is relative to the game's
    // install folder. Older manifests carry a 4th destination element, which is ignored: every
    // patch file installs into the game folder.
    struct file_info
    {
        std::string name;
        std::size_t size;
        std::string hash;
    };
}
