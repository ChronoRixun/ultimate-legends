#pragma once

// The unit tests' stand-in for the launcher's precompiled header (src/launcher/std_include.hpp):
// the files they build from src/launcher include "std_include.hpp" first, and this include folder
// comes before src/launcher's. Only the standard library: what they test has no Windows, CEF or
// network in it.

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
