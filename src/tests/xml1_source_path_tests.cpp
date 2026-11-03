#include "std_include.hpp"
#include "test.hpp"
#include "xml1/source_path.hpp"
#include <fstream>

TEST(xml1_source_path_accepts_files_and_extracted_folders_but_not_missing_inputs) {
    const auto folder = std::filesystem::temp_directory_path() / "ul-source-path-fixture";
    std::filesystem::create_directories(folder);
    const auto image = folder / "owned.xiso";
    { std::ofstream file(image); file << "synthetic path fixture"; }
    CHECK(xml1::source_path_exists(folder));
    CHECK(xml1::source_path_exists(image));
    CHECK(!xml1::source_path_exists(folder / "missing"));
    CHECK(!xml1::source_path_exists({}));
}
