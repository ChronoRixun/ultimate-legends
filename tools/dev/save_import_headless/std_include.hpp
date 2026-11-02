#pragma once
// Test-only precompiled-header substitute for the production hidden process
// transport. No CEF, launcher window, desktop, game or network code is linked.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#include <atomic>
#include <mutex>
#include "../../../src/tests/std_include.hpp"
