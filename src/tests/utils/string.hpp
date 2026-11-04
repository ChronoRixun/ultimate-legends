#pragma once

// The native target links common for the production SHA-256 regression. Use its
// real formatter too, rather than defining a second va() when string.obj is linked.
namespace utils::string
{
    const char* va(const char* fmt, ...);
}
