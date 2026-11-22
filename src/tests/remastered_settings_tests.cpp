#include "std_include.hpp"
#include "test.hpp"
#include "display/remastered_settings.hpp"

TEST(remastered_requires_a_known_capable_fix)
{
    CHECK(!remastered_settings::supports_version(std::nullopt));
    CHECK(!remastered_settings::supports_version(""));
    CHECK(!remastered_settings::supports_version("1.11.0"));
    CHECK(remastered_settings::supports_version("1.12.0"));
    CHECK(remastered_settings::supports_version("1.12.0-beta.1"));
    CHECK(remastered_settings::supports_version("1.13.0"));
}

TEST(remastered_rejects_values_that_the_fix_would_ignore)
{
    std::string error;
    CHECK(remastered_settings::normalise("Enabled", "1", error) == "1");
    CHECK(!remastered_settings::normalise("Enabled", "true", error));
    CHECK(!remastered_settings::normalise("CenteredHud", "2", error));
    CHECK(remastered_settings::normalise("MSAASamples", "6", error) == "6");
    CHECK(!remastered_settings::normalise("MSAASamples", "16", error));
    CHECK(remastered_settings::normalise("Anisotropy", "16", error) == "16");
    CHECK(!remastered_settings::normalise("Anisotropy", "6", error));
    CHECK(!remastered_settings::normalise("FrameRate", "60", error));
    CHECK(!remastered_settings::normalise("Enabled", "1;comment", error));
}
