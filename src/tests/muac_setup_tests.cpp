#include "test.hpp"
#include "muac/setup_admission.hpp"

namespace {
    constexpr auto complete = R"({"ok":true,"exit":0,"prepared":true,"files_complete":true,"install":"fixture"})";
    auto key(const std::string& value) { return std::wstring(value.begin(), value.end()); }
    bool ready(int exit = 0, bool process_cancelled = false, bool killed = false, bool cancelled = false,
               std::string_view json = complete) {
        return muac_setup::admission::ready(exit, process_cancelled, killed, cancelled, json, L"fixture", key);
    }
}
TEST(muac_setup_checks_actual_process_exit_despite_stdout_success) {
    CHECK(ready(muac_setup::admission::process_exit(0, false)));
    CHECK(!ready(muac_setup::admission::process_exit(7, false)));
    CHECK(!ready(muac_setup::admission::process_exit(0, true)));
    CHECK(!ready(0, false, true));
}
TEST(muac_setup_cancel_between_promotion_and_registration_refuses_admission) {
    CHECK(ready()); // The complete folder/result can exist before cancellation.
    CHECK(!ready(0, false, false, true)); // Recheck under the registration lock.
    CHECK(!ready(0, true));
}
TEST(muac_setup_requires_matching_path_and_complete_typed_result) {
    CHECK(!ready(0, false, false, false, R"({"ok":true,"prepared":true,"files_complete":true,"install":"other"})"));
    CHECK(!ready(0, false, false, false, R"({"ok":true,"prepared":true,"files_complete":true,"install":"fixture\u0000other"})"));
    CHECK(!ready(0, false, false, false, R"({"ok":true,"prepared":"true","files_complete":true,"install":"fixture"})"));
    CHECK(!ready(0, false, false, false, R"({"ok":true,"install":"fixture"})"));
    CHECK(!ready(0, false, false, false, "broken"));
}
