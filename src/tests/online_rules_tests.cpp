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

    std::string changes(const mode mode, const std::vector<std::string>& present, const std::string& code = "ABCD2345",
                        const online_rules::host_options& options = {})
    {
        return text(online_rules::changes_for(mode, code, present, options));
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

TEST(only_host_public_room_name_and_join_code_are_the_launchers_keys)
{
    CHECK(online_rules::keys() == std::vector<std::string>({"Host", "Public", "RoomName", "JoinCode"}));
    CHECK(online_rules::known("Host") && online_rules::known("JoinCode") && online_rules::known("Public") && online_rules::known("RoomName"));
    CHECK(!online_rules::known("GameVersion"));
    CHECK(!online_rules::known("Broker"));
    CHECK(!online_rules::known("BrokerPin"));
    CHECK(!online_rules::known("Route"));
    CHECK(!online_rules::known("Domain"));
    CHECK(!online_rules::known("host"));
}

TEST(host_writes_host_and_public_and_removes_a_join_code)
{
    CHECK(changes(mode::host, {}) == "Host=broker;Public=0;");
    CHECK(changes(mode::host, {"Host"}) == "Host=broker;Public=0;");
    CHECK(changes(mode::host, {"JoinCode"}) == "Host=broker;Public=0;JoinCode=(removed);");
    CHECK(changes(mode::host, {"Host", "JoinCode"}) == "Host=broker;Public=0;JoinCode=(removed);");
}

TEST(a_public_host_writes_its_room_name_a_private_one_removes_it)
{
    const online_rules::host_options listed{true, "Saturday run"};
    CHECK(changes(mode::host, {}, "", listed) == "Host=broker;Public=1;RoomName=Saturday run;");
    CHECK(changes(mode::host, {"RoomName", "JoinCode"}, "", listed) == "Host=broker;Public=1;RoomName=Saturday run;JoinCode=(removed);");
    // Public without a name: the fix makes "<name>'s game"; an old name goes.
    CHECK(changes(mode::host, {"RoomName"}, "", {true, ""}) == "Host=broker;Public=1;RoomName=(removed);");
    // Private: the name is not written, whatever was asked.
    CHECK(changes(mode::host, {}, "", {false, "Saturday run"}) == "Host=broker;Public=0;");
    CHECK(changes(mode::host, {"Public", "RoomName"}, "", {false, "x"}) == "Host=broker;Public=0;RoomName=(removed);");
}

TEST(join_writes_the_code_and_removes_host_public_and_room_name)
{
    CHECK(changes(mode::join, {}) == "JoinCode=ABCD2345;");
    CHECK(changes(mode::join, {"JoinCode"}) == "JoinCode=ABCD2345;");
    CHECK(changes(mode::join, {"Host"}) == "JoinCode=ABCD2345;Host=(removed);");
    CHECK(changes(mode::join, {"Host", "JoinCode"}, "ZZZZ9999") == "JoinCode=ZZZZ9999;Host=(removed);");
    CHECK(changes(mode::join, {"Host", "Public", "RoomName"}) == "JoinCode=ABCD2345;Host=(removed);Public=(removed);RoomName=(removed);");
}

TEST(a_normal_start_removes_all_four_and_writes_nothing_when_none_is_there)
{
    CHECK(changes(mode::normal, {}).empty());
    CHECK(changes(mode::normal, {"Host"}) == "Host=(removed);");
    CHECK(changes(mode::normal, {"JoinCode"}) == "JoinCode=(removed);");
    CHECK(changes(mode::normal, {"Host", "JoinCode"}) == "Host=(removed);JoinCode=(removed);");
    CHECK(changes(mode::normal, {"RoomName", "Public", "JoinCode", "Host"})
          == "Host=(removed);Public=(removed);RoomName=(removed);JoinCode=(removed);");
}

TEST(a_room_name_is_trimmed_printable_ascii_of_at_most_32)
{
    CHECK(online_rules::normalise_room_name("  Saturday run \t") == "Saturday run");
    CHECK(online_rules::normalise_room_name("") == "");
    CHECK(online_rules::normalise_room_name("   ") == "");
    CHECK(online_rules::normalise_room_name(std::string(32, 'x')) == std::string(32, 'x'));
    CHECK(online_rules::normalise_room_name(" " + std::string(32, 'x') + " ") == std::string(32, 'x'));
    CHECK(!online_rules::normalise_room_name(std::string(33, 'x')));
    CHECK(online_rules::normalise_room_name("X-Men: 4 heroes & co. (EU) #1!") == "X-Men: 4 heroes & co. (EU) #1!");
    CHECK(!online_rules::normalise_room_name("run; Host=evil"));
    CHECK(!online_rules::normalise_room_name("\"quoted\""));
    CHECK(!online_rules::normalise_room_name("line\nbreak"));
    CHECK(!online_rules::normalise_room_name("tab\tinside"));
    CHECK(!online_rules::normalise_room_name("caf\xC3\xA9"));
}

TEST(the_room_list_host_is_brokers_without_its_port)
{
    CHECK(online_rules::rooms_host("broker.example.org:7777") == "broker.example.org");
    CHECK(online_rules::rooms_host("broker.example.org") == "broker.example.org");
    CHECK(online_rules::rooms_host(" 192.0.2.5:7777 ") == "192.0.2.5");
    CHECK(online_rules::rooms_host("[::1]:7777") == "::1");
    CHECK(online_rules::rooms_host("::1") == "::1");
    CHECK(online_rules::rooms_host("") == "broker.aethyrion.org");
    CHECK(online_rules::rooms_host("  ") == "broker.aethyrion.org");
    CHECK(online_rules::rooms_port == 10021 && online_rules::rooms_path == "/v1/rooms");
}

TEST(the_room_list_pin_is_brokerpin_or_the_project_brokers)
{
    const std::string pin(64, 'a');
    CHECK(online_rules::normalise_pin(std::string(64, 'A')) == pin);
    CHECK(!online_rules::normalise_pin(std::string(63, 'a')));
    CHECK(!online_rules::normalise_pin(std::string(65, 'a')));
    CHECK(!online_rules::normalise_pin(std::string(63, 'a') + "g"));
    CHECK(online_rules::rooms_pin(pin) == pin);
    CHECK(online_rules::rooms_pin("") == "ac569104f671775703f3e36a8109519f4e219fb1e8bc68aaa77793cfb3dbad09");
    CHECK(online_rules::rooms_pin("not a pin") == online_rules::default_broker_pin);
}
