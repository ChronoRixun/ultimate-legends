#pragma once

// Include before any rapidjson header (std_include.hpp and properties.cpp do).
//
// rapidjson checks every typed read (GetString() on a value that is not a string, operator[] on a
// member that is not there, ...) with RAPIDJSON_ASSERT. By default that is assert(): in a Debug
// build a modal "Assertion failed" dialog that stops the thread (a command handler, a builder
// reader), in a Release build nothing - and the read is undefined behaviour. JSON the launcher
// reads comes from the page, from the builder and from files on disk, so a wrong type must be an
// error the caller can survive: here it throws, and the command dispatcher (cef_ui_scheme_handler)
// and the builder's event readers catch it. Checks inside noexcept functions stay assert()s
// (RAPIDJSON_ASSERT_THROWS): those are rapidjson's own invariants, not data.
#include <stdexcept>

#ifndef RAPIDJSON_ASSERT
#define RAPIDJSON_ASSERT_THROWS
#define RAPIDJSON_ASSERT(x) ((x) ? static_cast<void>(0) : throw std::logic_error("unexpected JSON: " #x))
#endif
