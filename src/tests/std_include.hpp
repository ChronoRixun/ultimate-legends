#pragma once

// The unit tests' stand-in for the launcher's precompiled header (src/launcher/std_include.hpp):
// the files they build from src/launcher include "std_include.hpp" first, and this include folder
// comes before src/launcher's. Only the standard library and rapidjson (header-only, configured as
// src/common/utils/rapidjson_config.hpp does): what they test has no Windows, CEF or network in it.

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <format>
#include <functional>
#include <optional>
#include <string>
#include <vector>

using namespace std::literals;

// src/common/utils/rapidjson_config.hpp: a wrong JSON type throws instead of asserting.
#include <stdexcept>
#ifndef RAPIDJSON_ASSERT
#define RAPIDJSON_ASSERT_THROWS
#define RAPIDJSON_ASSERT(x) ((x) ? static_cast<void>(0) : throw std::logic_error("unexpected JSON: " #x))
#endif
#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
