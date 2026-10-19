"""End-to-end check of the X-Men Legends page's Online section (launcher 0.4.0) against a running Debug
build (see launcher_cdp.py), with a FAKE online-status.json: no broker, no network, no real game.

Points the X-Men Legends (port) entry of the Debug launcher at a throwaway folder that looks like a
finished build (a dummy XMen2.exe that only waits - tools/dev/native/dummy_game.c -, a stand-in
dinput.dll, _build/stamp.json) and an xml2-fix.ini with what a build leaves there, the builder's
[Online] Broker / BrokerPin included. Then:

- prepare-online-start and launch-game write exactly their key: Host=broker or JoinCode=<code>, the
  other removed, both removed by a normal Play; every other key, section, comment and byte of the file
  stays; Broker / BrokerPin are never written; bad codes, test mode on, the game running, no fix and an
  unfinished build are refused before a write; a stale online-status.json is deleted before a Host or
  Join start (and by a normal start);
- the page's Host / Join buttons start the dummy game as an online start, and every state and error id
  the test writes into online-status.json (as the XML2 Fix would: temp file + rename) renders;
- code input normalisation and the inline error, the disabled states and their reasons, the keyboard
  (Tab, Enter, a focus ring). Screenshots of the main states.

Never touches a real game install, and puts the entry's settings back afterwards. That nothing is
written while the builder holds the folder is checked by xml1_cdp.py, which runs real builds.

    tools\\run-test-debug.bat
    python tools\\dev\\online_cdp.py
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

import native
from launcher_cdp import Launcher, wait_for

PIN = "ab" * 32
# What a build leaves in the port's ini, with comments, a non-ASCII comment and blank lines, none of
# which may move. [Online] holds the builder's keys (Broker with an inline comment) and a key of the
# fix the launcher doesn't know.
INI_TEMPLATE = (
    "; XML2 Fix settings (test copy) — café\r\n"
    "[Game]\r\n"
    "NewGameTeam=wolverine\r\n"
    "XPCurve=xml1\r\n"
    "\r\n"
    "[Limits]\r\n"
    "ActorSlots=127\r\n"
    "\r\n"
    "[Online]\r\n"
    "; the project broker (the builder's defaults)\r\n"
    "Broker=broker.example.org:7777   ; host[:port]\r\n"
    f"BrokerPin={PIN}\r\n"
    "Domain=openspy.net\r\n"
    "\r\n"
    "[Display]\r\n"
    "; how the game is shown\r\n"
    "Mode=borderless\r\n"
    "RunInBackground=1\r\n"
    "\r\n"
    "[Discord]\r\n"
    "Enabled=0\r\n"
)
STAMP = {"builder": {"version": "0.3.0", "content_version": 3}, "profile": {"movies": True}, "finished": "2026-10-19T10:00:00Z"}
ERRORS = ["broker_unreachable", "broker_rejected", "code_not_found", "code_expired", "room_full",
          "version_mismatch", "test_mode_on", "tls_pin_mismatch", "internal"]


def sections(text):
    """[(header, [lines])] in file order; the lines before the first header under header None."""
    result = [[None, []]]
    for line in text.split("\r\n"):
        if line.startswith("[") and line.rstrip().endswith("]"):
            result.append([line, []])
        else:
            result[-1][1].append(line)
    return result


def main():
    launcher = Launcher()
    failures = 0

    def check(ok, label):
        nonlocal failures
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}")
        failures += not ok

    def cmd(name, payload=None):
        return launcher.command(name, payload)

    def js(expression):
        return launcher.evaluate(expression)

    def status(game="xml1"):
        return cmd("get-online-status", {"game": game})

    def prepare(mode, code="", game="xml1", **extra):
        return cmd("prepare-online-start", dict({"game": game, "mode": mode, "code": code}, **extra))

    def ui(expression):
        return js(f"(() => {{ const panel = document.getElementById('xml1-online-panel'); "
                  f"const $ = s => panel.querySelector(s); const text = s => {{ const e = $(s); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; }}; "
                  f"{expression} }})()")

    def phase():
        return ui("return text('.ul-online-phase-text');")

    def blocked():
        return ui("const n = $('.ul-online-blocked'); return n && !n.hidden ? panel.dataset.blocked : null;")

    def hidden_shown():
        """The section's parts with the hidden attribute that still take space on the page (main.css's
        display rules beat the attribute unless a [hidden] rule says display:none): [] when none."""
        return ui("return [...panel.querySelectorAll('[hidden]')].filter(e => getComputedStyle(e).display !== 'none')"
                  ".map(e => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);")

    def controls_disabled():
        return ui("return [$('.ul-online-host-button'), $('.ul-online-join-button'), $('.ul-online-code-input')].map(c => c.disabled);")

    keys = {"Tab": ("Tab", 9, ""), "Enter": ("Enter", 13, "\r")}

    def press(name, shift=False):
        """A real key press (CDP Input.dispatchKeyEvent), as a keyboard - or a controller mapped to one - sends it."""
        key, code, text = keys[name]
        base = {"key": key, "code": name, "windowsVirtualKeyCode": code, "modifiers": 8 if shift else 0}
        launcher.call("Input.dispatchKeyEvent", dict(base, type="keyDown", **({"text": text} if text else {})))
        launcher.call("Input.dispatchKeyEvent", dict(base, type="keyUp"))
        time.sleep(0.1)

    def focused():
        return js("""(() => { const e = document.activeElement; if (!e) return null;
            for (const c of ['ul-online-host-button', 'ul-online-code-input', 'ul-online-join-button', 'ul-online-copy', 'ul-online-again']) {
                if (e.classList.contains(c)) return c; }
            return e.tagName; })()""")

    def type_code(text):
        launcher.call("Runtime.evaluate", {"expression": "(() => { const i = document.querySelector('#xml1-online-panel .ul-online-code-input'); "
                                                       "i.value = ''; i.focus(); })()"})
        launcher.call("Input.insertText", {"text": text})
        time.sleep(0.2)

    def reload():
        js("window.OnlineView.reload('xml1')")
        time.sleep(0.6)

    def open_page():
        js("window.AppViews.navigateTo('xml1')")
        time.sleep(1.2)
        reload()

    def shot(name, selector="#xml1-page .detail-online"):
        js(f"document.querySelector({json.dumps(selector)}).scrollIntoView({{ block: 'center' }})")
        time.sleep(0.5)
        path = pathlib.Path(__file__).with_name(f"online-{name}.png")
        launcher.screenshot(path)
        print(f"  screenshot: {path}")

    dummy = native.dummy_game()
    saved = {suffix: cmd("get-game-property", {"game": "xml1", "suffix": suffix}) for suffix in ("install", "is-installed")}
    saved_props = {key: cmd("get-property", key) for key in ("launcher-skip-client-update", "launcher-skip-redist-check")}

    with tempfile.TemporaryDirectory(prefix="ul-fake-online-") as folder:
        game = pathlib.Path(folder)
        exe = game / "XMen2.exe"
        shutil.copy2(dummy, exe)
        (game / "dinput.dll").write_bytes(b"placeholder - not the real fix")
        (game / "_build").mkdir()
        (game / "_build" / "stamp.json").write_text(json.dumps(STAMP))
        ini = game / "xml2-fix.ini"
        status_file = game / "online-status.json"

        def raw():
            return ini.read_bytes() if ini.exists() else b""

        def text():
            return raw().decode("utf-8", errors="replace")

        def reset():
            ini.write_bytes(INI_TEMPLATE.encode("utf-8"))

        def only_online_changed(added=(), label=""):
            """Every section but [Online] byte for byte; [Online] is the template's plus exactly `added`."""
            now, before = sections(text()), sections(INI_TEMPLATE)
            others_same = [s for s in now if s[0] != "[Online]"] == [s for s in before if s[0] != "[Online]"]
            online_now = next((s[1] for s in now if s[0] == "[Online]"), [])
            online_before = next(s[1] for s in before if s[0] == "[Online]")
            kept = [line for line in online_now if line not in added]
            check(others_same and kept == online_before and all(online_now.count(line) == 1 for line in added),
                  f"{label}: {' + '.join(added) if added else 'nothing'} in [Online], every other byte as it was")
            if not (others_same and kept == online_before):
                print(text())

        def write_status(**fields):
            """online-status.json as the XML2 Fix writes it: one object, temp file + rename."""
            data = dict({"v": 1, "code": None, "players": 0, "error": None, "message": None,
                         "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, **fields)
            temp = game / "online-status.json.tmp"
            temp.write_text(json.dumps(data), encoding="utf-8")
            os.replace(temp, status_file)

        def running():
            return cmd("is-game-running", {"game": "xml1"}) is True

        def stop():
            if running():
                cmd("stop-game", {"game": "xml1"})
                wait_for(lambda: not running(), 10)
                time.sleep(2.5)  # the exit watchdog releases the launch barrier

        try:
            cmd("set-game-property", {"game": "xml1", "suffix": "install", "value": str(game)})
            cmd("set-game-property", {"game": "xml1", "suffix": "is-installed", "value": "true"})
            # No patch download and no redist prompt: the dummy game starts straight away.
            cmd("set-property", {"launcher-skip-client-update": "true", "launcher-skip-redist-check": "true"})
            check(cmd("get-game-property", {"game": "xml1", "suffix": "install"}) == str(game), "X-Men Legends pointed at the fake folder")

            print("which games have it")
            check(status("xml2")["supported"] is False and prepare("host", game="xml2").get("reason") == "not_supported",
                  "X-Men Legends II: no online section (the port's page only)")
            check(status("mua")["supported"] is False, "MUA: none")

            print("status: what the page reads")
            reset()
            state = status()
            check(state["supported"] and state["installed"] and state["fixInstalled"] and state["playable"], "a finished build with its fix")
            check(state["values"] == {"Host": None, "JoinCode": None} and state["testMode"] is False and state["running"] is False,
                  f"no Host / JoinCode yet, test mode off, not running: {state['values']}")
            check(state["status"] is None and state["statusUnreadable"] is False, "no status file")
            for state_name in ["connecting", "room", "joined", "in_game", "ended", "error"]:
                write_status(role="host", state=state_name, code="ABCD2345", players=2)
                read = status()["status"]
                check(read and read["state"] == state_name and read["code"] == "ABCD2345" and read["players"] == 2, f"status {state_name} read as written")
            status_file.write_text("{not json", encoding="utf-8")
            check(status()["status"] is None and status()["statusUnreadable"] is True, "a file that isn't one object: unreadable, not a state")
            check(raw() == INI_TEMPLATE.encode("utf-8"), "reading wrote nothing")

            print("Host: Host=broker, nothing else; a stale status deleted")
            write_status(role="host", state="room", code="OLDC0DE0", players=1)
            result = prepare("host")
            check(result.get("success") is True and result["values"] == {"Host": "broker", "JoinCode": None}, f"host {result}")
            only_online_changed(["Host=broker"], "host")
            check(not status_file.exists(), "the stale online-status.json is gone")
            check(text().count("Broker=") == 1 and text().count(f"BrokerPin={PIN}") == 1, "Broker / BrokerPin written once, by the builder")

            print("Join: JoinCode, Host removed")
            write_status(role="host", state="ended")
            result = prepare("join", " abcd-efgh ")
            check(result.get("success") is True and result.get("code") == "ABCDEFGH" and result["values"] == {"Host": None, "JoinCode": "ABCDEFGH"},
                  f"join, normalised {result}")
            only_online_changed(["JoinCode=ABCDEFGH"], "join after host")
            check(not status_file.exists(), "the stale status is gone")
            result = prepare("host")
            only_online_changed(["Host=broker"], "host after join (JoinCode's line gone)")

            print("a JoinCode written by hand with a comment: its line goes")
            ini.write_bytes(INI_TEMPLATE.replace("Domain=openspy.net\r\n", "Domain=openspy.net\r\nJoinCode = ZZZZ9999   ; from a friend\r\n").encode("utf-8"))
            prepare("host")
            only_online_changed(["Host=broker"], "host over a hand-written JoinCode")

            print("refused before a write")
            reset()
            before = raw()
            for code in ["", "ABCD", "ABCD234O", "ABCD2341", "abcd234l", "ABCD23456", "ABCD_234", "ÄBCD2345"]:
                result = prepare("join", code)
                check(result.get("success") is False and result.get("reason") == "bad_code", f"code {code!r}: bad_code")
            for mode in ["relay", "Host", ""]:
                check(prepare(mode).get("reason") == "bad_mode", f"mode {mode!r}: bad_mode")
            check(raw() == before, "the refused writes left the ini byte for byte")
            result = prepare("host", Broker="evil.example:1", BrokerPin="00" * 32, Route="relay")
            check(result.get("success") is True and "evil" not in text() and "Route" not in text() and text().count("BrokerPin=") == 1,
                  "extra fields (Broker, BrokerPin, Route) are never written")
            reset()
            check(cmd("set-test-mode-settings", {"game": "xml1", "values": {"Hotkeys": True}})["success"], "test mode on (Hotkeys)")
            with_test_mode = raw()
            for mode in ["host", "join"]:
                result = prepare(mode, "ABCD2345")
                check(result.get("reason") == "test_mode_on" and raw() == with_test_mode, f"{mode} with test mode on: refused, nothing written")
            check(status()["testMode"] is True, "the status says test mode is on")
            check(cmd("set-test-mode-settings", {"game": "xml1", "values": {"Hotkeys": None}})["success"] and status()["testMode"] is False, "test mode off again")
            reset()
            process = subprocess.Popen([str(exe)])
            try:
                check(wait_for(running, 5), "the game running")
                check(prepare("host").get("reason") == "running" and raw() == before, "host while it runs: refused")
                check(status()["running"] is True, "the status says it runs")
            finally:
                process.kill()
                wait_for(lambda: not running(), 5)
            (game / "_build" / "building.json").write_text("{}")
            check(prepare("host").get("reason") == "not_built" and status()["playable"] is False and raw() == before, "an unfinished build: not_built")
            (game / "_build" / "building.json").unlink()
            (game / "dinput.dll").rename(game / "dinput.dll.off")
            check(prepare("host").get("reason") == "no_fix" and raw() == before, "no fix: no_fix")
            (game / "dinput.dll.off").rename(game / "dinput.dll")

            print("normal: both removed; a file without them is not touched")
            prepare("host")
            check(prepare("normal").get("success") is True and raw() == INI_TEMPLATE.encode("utf-8"), "host, then normal: the template again, byte for byte")
            ini.unlink()
            check(prepare("normal").get("success") is True and not ini.exists(), "normal on no ini: none created")
            reset()

            print("Play: a normal start removes Host and JoinCode (and an old status)")
            open_page()
            prepare("host")
            write_status(role="host", state="room", code="ABCD2345", players=1)
            js("launchGame('xml1')")
            check(wait_for(running, 20), "Play: the game runs")
            check(raw() == INI_TEMPLATE.encode("utf-8"), "Host removed by Play: the template byte for byte")
            check(not status_file.exists(), "the old status deleted")
            stop()
            ini.write_bytes(INI_TEMPLATE.replace("Domain=openspy.net\r\n", "Domain=openspy.net\r\nJoinCode=ABCD2345\r\nHost=broker\r\n").encode("utf-8"))
            cmd("launch-game", {"game": "xml1"})
            check(wait_for(running, 20) and raw() == INI_TEMPLATE.encode("utf-8"), "launch-game without `online`: both removed")
            stop()
            reset()
            mtime = ini.stat().st_mtime_ns
            cmd("launch-game", {"game": "xml1"})
            check(wait_for(running, 20) and raw() == INI_TEMPLATE.encode("utf-8") and ini.stat().st_mtime_ns == mtime,
                  "Play on a file without them: not even rewritten")
            stop()

            print("page: the section")
            open_page()
            check(js("(() => { const s = document.querySelector('#xml1-page .detail-online'); return !!s && s.querySelector('.detail-display-title').textContent; })()") == "Online",
                  "an Online section")
            check(blocked() is None and controls_disabled() == [False, False, False], "Host and Join on")
            check(ui("return $('.ul-online-help summary').textContent;") == "How online works", "How online works")
            check(hidden_shown() == [], f"idle: every hidden part is display:none {hidden_shown()}")
            check(ui("return $('.ul-online-session').offsetParent === null && $('.ul-online-blocked').offsetParent === null;"),
                  "the session block and the reason line take no space")
            check(ui(f"return {json.dumps(ERRORS)}.every(id => !!$(`.ul-online-help-error[data-error=\"${{id}}\"]`));"), "the help explains every error id")
            shot("idle")
            js("document.querySelector('#xml1-online-panel .ul-online-help').open = true")
            shot("help", "#xml1-online-panel .ul-online-help")
            js("document.querySelector('#xml1-online-panel .ul-online-help').open = false")

            print("page: Host a game")
            write_status(role="host", state="room", code="OLDC0DE0", players=1)
            check(ui("const b = $('.ul-online-host-button'); if (b.disabled) return false; b.click(); return true;"), "Host clicked")
            check(phase() == "Connecting…", "Connecting… at once")
            check(hidden_shown() == [] and ui("return $('.ul-online-idle').offsetParent === null;"),
                  "Host / Join hidden while hosting: display:none, not just the attribute")
            check(wait_for(running, 20), "the game starts")
            only_online_changed(["Host=broker"], "the page's Host")
            check(not status_file.exists(), "the stale status deleted before the start")
            check(wait_for(lambda: phase() == "Open Play Online in the game – your code appears here.", 5), "the game up, no status yet: where to go (contract v1.2)")
            write_status(role="host", state="connecting")
            time.sleep(1)
            check(phase() == "Open Play Online in the game – your code appears here.", "connecting until Play Online opens the room")
            write_status(role="host", state="room", code="ABCD2345", players=1)
            check(wait_for(lambda: ui("return text('.ul-online-code');") == "ABCD-2345", 3), "room: the code, as ABCD-2345")
            check(ui("return text('.ul-online-code-hint');") == "Send this code to your friends. In the game: Play Online → Host.", "with the one line")
            check(ui("return text('.ul-online-players');") == "1 player in the room (you)", "1 player")
            check(ui("const s = getComputedStyle($('.ul-online-code')); return parseFloat(s.fontSize) >= 32;"), "large")
            shot("host-room")
            check(ui("$('.ul-online-copy').click(); return true;") and wait_for(lambda: js("navigator.clipboard ? navigator.clipboard.readText().then(t => t, () => null) : null") in ("ABCD-2345", None), 3),
                  "Copy (the clipboard holds ABCD-2345 where the page may read it)")
            write_status(role="host", state="room", code="ABCD2345", players=3)
            check(wait_for(lambda: ui("return text('.ul-online-players');") == "3 players in the room", 3), "the count follows: 3 players")
            write_status(role="host", state="room", code="ABCD2345", players=3, max_players=4)
            check(wait_for(lambda: ui("return text('.ul-online-players');") == "3 of 4 players in the room", 3), "with max_players (v1.1): 3 of 4")
            write_status(role="host", state="in_game", code="ABCD2345", players=3)
            check(wait_for(lambda: phase() == "Connected – playing together.", 3), "in_game: Connected – playing together")
            write_status(role="host", state="ended", code="ABCD2345", players=0)
            check(wait_for(lambda: phase() == "The online game has ended.", 3), "ended")
            stop()
            check(ui("$('.ul-online-again').click(); return true;"), "OK: back to Host / Join")
            check(wait_for(lambda: blocked() is None, 5), "Host and Join on again")

            print("page: every error id, for a host")
            for error_id in ERRORS:
                reset()
                ui("$('.ul-online-host-button').click(); return true;")
                wait_for(running, 20)
                write_status(role="host", state="error", error=error_id, message=f"log text for {error_id}")
                check(wait_for(lambda: ui(f"return !!$('.ul-online-error[data-error=\"{error_id}\"]');"), 3)
                      and f"log text for {error_id}" in (ui("return text('.ul-online-error-detail');") or ""), f"error {error_id}: {phase()}")
                if error_id == "broker_unreachable":
                    shot("host-error")
                stop()
                ui("$('.ul-online-again').click(); return true;")
                wait_for(lambda: blocked() is None, 5)

            print("page: Join a game")
            reset()
            type_code("abcd-234o")
            check("never 0, O, 1, I or L" in (ui("const e = $('.ul-online-code-error'); return e.hidden ? '' : e.textContent;") or ""),
                  "a character no code has: the inline error at once")
            check(ui("$('.ul-online-join-button').click(); return true;") and raw() == INI_TEMPLATE.encode("utf-8") and not running(),
                  "Join with it: nothing written, nothing started")
            shot("join-bad-code")
            type_code("abc")
            press("Enter")
            check("this one has 3" in (ui("const e = $('.ul-online-code-error'); return e.hidden ? '' : e.textContent;") or ""), "too short: once Join (Enter) is pressed")
            type_code(" abcd – efgh ")
            check(ui("const e = $('.ul-online-code-error'); return e.hidden;"), "pasted with spaces and a dash: fine")
            press("Enter")
            check(wait_for(running, 20), "Enter in the field joins: the game starts")
            only_online_changed(["JoinCode=ABCDEFGH"], "the page's Join")
            check(wait_for(lambda: phase() == "Open Play Online → Join Game in the game.", 5), "the game up: where to go (contract v1.2)")
            write_status(role="join", state="joined", code="ABCDEFGH", players=2)
            check(wait_for(lambda: phase() == "Found it. In the game: Play Online → Join Game, pick the game.", 3), "joined: Found it")
            shot("join-found")
            write_status(role="join", state="in_game", code="ABCDEFGH", players=2)
            check(wait_for(lambda: phase() == "Connected – playing together.", 3), "in_game: Connected – playing together")
            stop()
            check(wait_for(lambda: phase() == "The game was closed.", 5), "closed without `ended`: The game was closed.")
            ui("$('.ul-online-again').click(); return true;")

            print("page: every error id, for a joiner")
            for error_id in ERRORS:
                reset()
                wait_for(lambda: blocked() is None, 5)
                type_code("ABCD2345")
                ui("$('.ul-online-join-button').click(); return true;")
                wait_for(running, 20)
                write_status(role="join", state="error", error=error_id, message="from the fake fix")
                check(wait_for(lambda: ui(f"return !!$('.ul-online-error[data-error=\"{error_id}\"]');"), 3), f"error {error_id}: {phase()}")
                if error_id == "code_not_found":
                    shot("join-error")
                stop()
                ui("$('.ul-online-again').click(); return true;")

            print("page: off, with the reason")
            reset()
            reload()
            cmd("set-test-mode-settings", {"game": "xml1", "values": {"ForgeEverywhere": True}})
            js("window.TestModeView && window.TestModeView.reload('xml1')")
            reload()
            check(blocked() == "testMode" and controls_disabled() == [True, True, True], "test mode on: off")
            check(hidden_shown() == [], f"blocked: every hidden part is display:none {hidden_shown()}")
            shot("test-mode")
            check(ui("const b = $('.ul-online-testmode-off'); if (b.hidden || b.disabled) return false; b.click(); return true;"), "Turn test mode off, right there")
            check(wait_for(lambda: blocked() is None and controls_disabled() == [False, False, False], 5)
                  and cmd("get-test-mode-settings", {"game": "xml1"})["values"]["ForgeEverywhere"] is False, "Host and Join on again; test mode off in the file")
            process = subprocess.Popen([str(exe)])
            try:
                check(wait_for(lambda: (reload() or True) and blocked() == "running", 8), "the game running: off")
            finally:
                process.kill()
                wait_for(lambda: not running(), 5)
            (game / "_build" / "building.json").write_text("{}")
            reload()
            check(blocked() == "notBuilt" and controls_disabled() == [True, True, True], "an unfinished build: off")
            (game / "_build" / "building.json").unlink()
            js("window.Xml1Port.starting = new Promise(() => {}); window.Xml1Port.emit();")
            time.sleep(0.3)
            check(blocked() == "building", "a build starting: off")
            js("window.Xml1Port.starting = null; window.Xml1Port.emit();")
            reload()
            check(blocked() is None, "and on again")

            print("page: the keyboard reaches everything (Tab, Enter)")
            js("document.querySelector('#xml1-online-panel .ul-online-host-button').focus()")
            check(focused() == "ul-online-host-button", "Host focusable")
            # Establish keyboard focus before measuring :focus-visible.
            press("Tab")
            press("Tab", shift=True)
            check(ui("return getComputedStyle(document.activeElement).outlineStyle !== 'none';"), "with a focus ring")
            press("Tab")
            check(focused() == "ul-online-code-input", "Tab: the code field")
            press("Tab")
            check(focused() == "ul-online-join-button", "Tab: Join")
            press("Tab")
            check(focused() == "SUMMARY", "Tab: How online works")
            press("Enter")
            check(js("document.querySelector('#xml1-online-panel .ul-online-help').open === true"), "Enter opens it")
            press("Enter")
            press("Tab", shift=True)
            check(focused() == "ul-online-join-button", "Shift+Tab: back to Join")
            js("document.querySelector('#xml1-online-panel .ul-online-host-button').focus()")
            press("Enter")
            check(wait_for(running, 20), "Enter on Host hosts")
            write_status(role="host", state="room", code="ABCD2345", players=1)
            check(wait_for(lambda: focused() == "ul-online-copy", 3), "the code up: the focus is on Copy")
            stop()
            check(wait_for(lambda: focused() == "ul-online-again", 5), "the game closed: on OK")
            press("Enter")
            check(wait_for(lambda: focused() == "ul-online-host-button", 3), "Enter on OK: back on Host")
            js("document.activeElement.blur()")
            check(exe.exists() and (game / "_build" / "stamp.json").exists(), "game folder untouched")
        finally:
            stop()
            for suffix, value in saved.items():
                cmd("set-game-property", {"game": "xml1", "suffix": suffix, "value": value or ""})
            cmd("set-property", {key: value or "" for key, value in saved_props.items()})

    print(f"\n{'PASSED' if not failures else 'FAILED'} ({failures} failure{'s' if failures != 1 else ''})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
