#include "std_include.hpp"
#include "test.hpp"

#include <cstdio>

namespace tests
{
    namespace
    {
        int failures = 0;
    }

    std::vector<test_case>& registry()
    {
        static std::vector<test_case> cases;
        return cases;
    }

    void check(const bool ok, const char* expression, const char* file, const int line)
    {
        if (!ok)
        {
            ++failures;
            std::printf("    FAIL  %s (%s:%d)\n", expression, file, line);
        }
    }
}

int main()
{
    auto failed_tests = 0;
    for (const auto& test : tests::registry())
    {
        const auto before = tests::failures;
        test.body();
        const auto ok = tests::failures == before;
        failed_tests += !ok;
        std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", test.name);
    }
    std::printf("%zu tests, %d failed\n", tests::registry().size(), failed_tests);
    return failed_tests ? 1 : 0;
}
