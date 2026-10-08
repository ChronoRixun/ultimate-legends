#pragma once

#include <functional>
#include <string>
#include <vector>

// A minimal test runner: TEST(name) { CHECK(condition); }. main.cpp runs every test and exits 1
// when a check failed.
namespace tests
{
    struct test_case
    {
        const char* name;
        std::function<void()> body;
    };

    std::vector<test_case>& registry();
    void check(bool ok, const char* expression, const char* file, int line);

    struct registrar
    {
        registrar(const char* name, std::function<void()> body)
        {
            registry().push_back({name, std::move(body)});
        }
    };
}

#define TEST_CONCAT_INNER(a, b) a##b
#define TEST_CONCAT(a, b) TEST_CONCAT_INNER(a, b)
#define TEST(name)                                                                         \
    static void name();                                                                    \
    static const tests::registrar TEST_CONCAT(name, _registrar){#name, name};              \
    static void name()
#define CHECK(condition) tests::check(static_cast<bool>(condition), #condition, __FILE__, __LINE__)
