#include "std_include.hpp"
#include "test.hpp"

#include "fix/online_rules.hpp"

// Online play of the X-Men Legends port (launcher 0.4.0): the join codes the launcher takes and the
// [Online] keys it writes for each kind of start (the launcher <-> XML2 Fix contract, v1).
namespace
{
    using online_rules::mode;

    std::string text(const std::vector<online_rules::change>& changes)
    {
        std::string result;
        for (const auto& item : changes)
        {
            result += item.key + "=" + item.value.value_or("(removed)") + ";";
        }
        return result;
    }

    std::string changes(const mode mode, const std::vector<std::string>& present, const std::string& code = "ABCD2345")
    {
        return text(online_rules::changes_for(mode, code, present));
    }
}

TEST(a_join_code_is_upper_cased_without_spaces_or_dashes)
{
    CHECK(online_rules::normalise_code("ABCD2345") == "ABCD2345");
    CHECK(online_rules::normalise_code("abcd2345") == "ABCD2345");
    CHECK(online_rules::normalise_code("abcd-2345") == "ABCD2345");
    CHECK(online_rules::normalise_code(" ab cd - 23 45 ") == "ABCD2345");
    CHECK(online_rules::normalise_code("aBcD\t2345\r\n") == "ABCD2345");
    CHECK(online_rules::normalise_code("ZZZZ-9999") == "ZZZZ9999");
}

TEST(a_join_code_is_eight_characters_of_the_alphabet)
{
    CHECK(!online_rules::normalise_code(""));
    CHECK(!online_rules::normalise_code("----"));
    CHECK(!online_rules::normalise_code("ABCD234"));
    CHECK(!online_rules::normalise_code("ABCD23456"));
    // No 0 O 1 I L: the characters people mix up are not in it.
    CHECK(!online_rules::normalise_code("ABCD2340"));
    CHECK(!online_rules::normalise_code("ABCD234O"));
    CHECK(!online_rules::normalise_code("ABCD2341"));
    CHECK(!online_rules::normalise_code("ABCD234I"));
    CHECK(!online_rules::normalise_code("ABCD234L"));
    CHECK(!online_rules::normalise_code("abcd234l"));
    CHECK(!online_rules::normalise_code("ABCD_2345"));
    CHECK(!online_rules::normalise_code("ABCD.2345"));
    CHECK(!online_rules::normalise_code("ABCD2345\xC3\xA9"));
    for (const auto c : online_rules::code_alphabet)
    {
        CHECK(online_rules::normalise_code(std::string(8, c)) == std::string(8, c));
    }
}

TEST(a_join_code_is_shown_in_two_halves)
{
    CHECK(online_rules::display_code("ABCD2345") == "ABCD-2345");
    CHECK(online_rules::display_code("ABC") == "ABC");
}

TEST(the_modes_are_normal_host_and_join)
{
    CHECK(online_rules::parse_mode("normal") == mode::normal);
    CHECK(online_rules::parse_mode("host") == mode::host);
    CHECK(online_rules::parse_mode("join") == mode::join);
    CHECK(!online_rules::parse_mode("Host"));
    CHECK(!online_rules::parse_mode("relay"));
    CHECK(!online_rules::parse_mode(""));
}

TEST(only_host_and_join_code_are_the_launchers_keys)
{
    CHECK(online_rules::keys() == std::vector<std::string>({"Host", "JoinCode"}));
    CHECK(online_rules::known("Host") && online_rules::known("JoinCode"));
    CHECK(!online_rules::known("Broker"));
    CHECK(!online_rules::known("BrokerPin"));
    CHECK(!online_rules::known("Route"));
    CHECK(!online_rules::known("Domain"));
    CHECK(!online_rules::known("host"));
}

TEST(host_writes_host_and_removes_a_join_code)
{
    CHECK(changes(mode::host, {}) == "Host=broker;");
    CHECK(changes(mode::host, {"Host"}) == "Host=broker;");
    CHECK(changes(mode::host, {"JoinCode"}) == "Host=broker;JoinCode=(removed);");
    CHECK(changes(mode::host, {"Host", "JoinCode"}) == "Host=broker;JoinCode=(removed);");
}

TEST(join_writes_the_code_and_removes_host)
{
    CHECK(changes(mode::join, {}) == "JoinCode=ABCD2345;");
    CHECK(changes(mode::join, {"JoinCode"}) == "JoinCode=ABCD2345;");
    CHECK(changes(mode::join, {"Host"}) == "JoinCode=ABCD2345;Host=(removed);");
    CHECK(changes(mode::join, {"Host", "JoinCode"}, "ZZZZ9999") == "JoinCode=ZZZZ9999;Host=(removed);");
}

TEST(a_normal_start_removes_both_and_writes_nothing_when_neither_is_there)
{
    CHECK(changes(mode::normal, {}).empty());
    CHECK(changes(mode::normal, {"Host"}) == "Host=(removed);");
    CHECK(changes(mode::normal, {"JoinCode"}) == "JoinCode=(removed);");
    CHECK(changes(mode::normal, {"Host", "JoinCode"}) == "Host=(removed);JoinCode=(removed);");
}
