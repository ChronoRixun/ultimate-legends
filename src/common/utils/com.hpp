#pragma once

#include "nt.hpp"
#include <ShlObj.h>
#include <atlbase.h>
#include <vector>

namespace utils::com
{
    struct file_filter
    {
        std::string name;
        std::string pattern;
    };

    bool select_folder(std::string& out_folder, const std::string& title = "Select a Folder", const std::string& selected_folder = {});
    bool select_file(std::string& out_file, const std::string& title = "Select a File", const std::vector<file_filter>& filters = {}, const std::string& selected_folder = {});

    std::filesystem::path get_desktop_path();
    std::filesystem::path get_start_menu_programs_path();
    std::filesystem::path read_shortcut_target(const std::filesystem::path& shortcut_path);
    bool create_shortcut(
        const std::filesystem::path& target_path,
        const std::filesystem::path& shortcut_path,
        const std::string& description,
        const std::filesystem::path& working_directory = {});
}
