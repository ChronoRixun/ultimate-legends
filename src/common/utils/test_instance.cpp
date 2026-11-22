#include "test_instance.hpp"

#include <algorithm>
#include <cctype>

namespace utils::test_instance
{
    namespace
    {
#if defined(_DEBUG) || defined(DEBUG)
        constexpr bool debug_build = true;
#else
        constexpr bool debug_build = false;
#endif

        struct state
        {
            std::string name;
            startup_plan plan = test_instance::plan({}, debug_build);
        };

        state& current_state()
        {
            static state s;
            return s;
        }
    }

    bool valid_name(const std::string& name)
    {
        return !name.empty() && name.size() <= 32 && std::all_of(name.begin(), name.end(), [](const unsigned char c)
        {
            return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
        });
    }

    std::optional<std::string> resolve(const std::optional<std::string>& value, const bool portable, std::string& error)
    {
        error.clear();
        if (!value)
        {
            return std::nullopt;
        }
        std::string name = *value;
        std::transform(name.begin(), name.end(), name.begin(), [](const unsigned char c) { return static_cast<char>(std::tolower(c)); });
        if (!valid_name(name))
        {
            error = "-test-instance needs a name of 1-32 letters, digits or '-'.";
            return std::nullopt;
        }
        if (!portable)
        {
            error = "-test-instance is only accepted with -portable (its own data folder).";
            return std::nullopt;
        }
        return name;
    }

    std::string suffixed(const std::string& base, const std::string& name)
    {
        return name.empty() ? base : base + "-test-" + name;
    }

    std::wstring suffixed(const std::wstring& base, const std::string& name)
    {
        return name.empty() ? base : base + L"-test-" + std::wstring(name.begin(), name.end());
    }

    startup_plan plan(const std::string& name, const bool is_debug_build)
    {
        const bool test = !name.empty();
        startup_plan p;
        p.register_uri = !test;
        p.create_shortcuts = !test;
        p.hkcu_writes = !test;
        p.activate_window = !test;
        p.dev_overrides = test || is_debug_build;
        return p;
    }

    void run_startup(const startup_plan& plan, const startup_steps& steps)
    {
        if (plan.create_shortcuts && steps.create_shortcuts)
        {
            steps.create_shortcuts();
        }
        if (plan.register_uri && plan.hkcu_writes && steps.register_uri)
        {
            steps.register_uri();
        }
    }

    void set(const std::string& name)
    {
        auto& s = current_state();
        s.name = name;
        s.plan = plan(name, debug_build);
    }

    const std::string& name()
    {
        return current_state().name;
    }

    bool active()
    {
        return !current_state().name.empty();
    }

    const startup_plan& current()
    {
        return current_state().plan;
    }

    bool hkcu_writes_allowed()
    {
        return current().hkcu_writes;
    }

    bool dev_overrides()
    {
        return current().dev_overrides;
    }

    bool may_activate()
    {
        return current().activate_window;
    }

    std::uint32_t extra_window_ex_style()
    {
        return may_activate() ? 0u : 0x08000000u; // WS_EX_NOACTIVATE
    }
}
