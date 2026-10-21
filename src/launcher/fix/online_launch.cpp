#include "std_include.hpp"
#include "online_launch.hpp"

#include "tools/tool_install.hpp"

#include <exception>

namespace online_launch
{
    namespace
    {
        bool is_online(const request& request)
        {
            return request.mode != online_rules::mode::normal;
        }

        result refused(std::string reason, std::string error)
        {
            return {false, std::move(reason), std::move(error), {}};
        }

        // The four keys removed (online_rules::changes_for normal: only those present, so nothing is written to a
        // file without them). "" when they are gone, else why not.
        std::string disarm(const steps& steps)
        {
            std::string error;
            try
            {
                const auto changes = online_rules::changes_for(online_rules::mode::normal, {}, steps.present());
                if (changes.empty() || steps.write(changes, error))
                {
                    return {};
                }
            }
            catch (const std::exception& e)
            {
                error = e.what();
            }
            return error.empty() ? std::string("the online settings could not be removed") : error;
        }

        // A refusal once the barrier is held: the keys removed (when `keys`), then the barrier released.
        result give_up(const steps& steps, result outcome, const bool keys)
        {
            if (keys)
            {
                outcome.cleanup_error = disarm(steps);
            }
            steps.release_barrier();
            return outcome;
        }

        // Why the folder's XML2 Fix can't host or join, or "".
        std::string fix_reason(const fix_state state)
        {
            switch (state)
            {
            case fix_state::ok:
                return {};
            case fix_state::old:
                return "fix_too_old";
            case fix_state::unknown:
                return "fix_unknown";
            case fix_state::missing:
                return "no_fix";
            }
            return "fix_unknown";
        }

        std::string fix_error(const fix_state state, const std::optional<std::string>& version)
        {
            const auto need = std::string(required_fix);
            switch (state)
            {
            case fix_state::old:
                return "The XML2 Fix in the game folder is " + version.value_or("") + "; online play needs " + need + " or later.";
            case fix_state::unknown:
                return "The version of the XML2 Fix in the game folder can't be read; online play needs " + need + " or later.";
            case fix_state::missing:
                return "The XML2 Fix is not in the game folder.";
            case fix_state::ok:
                break;
            }
            return {};
        }
    }

    fix_state check_fix(const std::optional<std::string>& version)
    {
        if (!version)
        {
            return fix_state::missing;
        }
        // A version resource has only numbers ("1.8.0", "1.8.0.2"); anything else isn't one to compare.
        if (version->empty() || !std::isdigit(static_cast<unsigned char>(version->front())) ||
            !std::all_of(version->begin(), version->end(), [](const char c)
            {
                return std::isdigit(static_cast<unsigned char>(c)) || c == '.';
            }))
        {
            return fix_state::unknown;
        }
        return tool_install::compare_versions(*version, std::string(required_fix)) >= 0 ? fix_state::ok : fix_state::old;
    }

    const char* fix_state_name(const fix_state state)
    {
        switch (state)
        {
        case fix_state::ok:
            return "ok";
        case fix_state::old:
            return "old";
        case fix_state::unknown:
            return "unknown";
        case fix_state::missing:
            return "missing";
        }
        return "unknown";
    }

    result accept(const request& request, const steps& steps)
    {
        const auto online = is_online(request);
        // Nothing is written before the barrier: another start may own the keys until then.
        if (online && steps.offline())
        {
            return refused("offline", "The launcher is in offline mode.");
        }
        if (!steps.take_barrier())
        {
            return refused("already_running", "A game is already launching or running.");
        }

        if (online)
        {
            // The game running read the keys when it started (the fix removes them then): the file is left alone.
            if (steps.game_running())
            {
                steps.release_barrier();
                return refused("running", "The game is running.");
            }
            if (steps.test_mode_on())
            {
                return give_up(steps, refused("test_mode_on", "Test mode is on: the XML2 Fix refuses online play."), true);
            }
            if (steps.fix_version() == std::nullopt)
            {
                return give_up(steps, refused("no_fix", fix_error(fix_state::missing, std::nullopt)), true);
            }
        }
        else
        {
            std::string error;
            const auto changes = online_rules::changes_for(online_rules::mode::normal, {}, steps.present());
            if (!changes.empty() && !steps.write(changes, error))
            {
                steps.release_barrier();
                return refused("write_failed", error);
            }
        }

        // Every start: a status left by an earlier game would read as this one's.
        std::string error;
        if (!steps.clear_status(error))
        {
            return give_up(steps, refused("status_locked", error), online);
        }
        return {true, {}, {}, {}};
    }

    result finish(const request& request, const steps& steps)
    {
        const auto online = is_online(request);
        try
        {
            std::string error;
            const auto updated = steps.update(error);
            if (updated == update_result::cancelled)
            {
                return give_up(steps, refused("update_cancelled", "The patch update was cancelled."), online);
            }
            // A normal start still starts after a failed update (the player has been told); an online one doesn't
            // fall through to whatever DLL the failure left.
            if (online && updated == update_result::failed)
            {
                return give_up(steps, refused("update_failed", error), true);
            }

            if (online)
            {
                // The DLL that will run, after any update: at least required_fix.
                const auto version = steps.fix_version();
                const auto state = check_fix(version);
                if (state != fix_state::ok)
                {
                    return give_up(steps, refused(fix_reason(state), fix_error(state, version)), true);
                }

                // Armed last, right before the process: the keys for this start, the others removed.
                const auto changes = online_rules::changes_for(request.mode, request.code, steps.present(), request.host);
                if (!steps.write(changes, error))
                {
                    return give_up(steps, refused("write_failed", error), true);
                }
            }

            const auto process = steps.start_process();
            if (!process.started)
            {
                return give_up(steps, refused(process.cancelled ? "launch_cancelled" : "launch_failed", process.error), online);
            }
            return {true, {}, {}, {}};
        }
        catch (const std::exception& e)
        {
            return give_up(steps, refused("launch_failed", e.what()), online);
        }
        catch (...)
        {
            return give_up(steps, refused("launch_failed", "An unknown error occurred during game launch."), online);
        }
    }

    bool close_after_start(const bool setting_on, const online_rules::mode mode)
    {
        return setting_on && mode == online_rules::mode::normal;
    }
}
