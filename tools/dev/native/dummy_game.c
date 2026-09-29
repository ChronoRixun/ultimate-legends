/* A stand-in for a game's exe in the launcher's tests (tools/dev/*_cdp.py). It opens no window
 * and does nothing but wait, for at most ten minutes, so a test can see it "running" and stop it.
 * The tests copy it as XMen2.exe into throwaway folders; it is never a real game.
 */
#include <windows.h>

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command_line, int show)
{
    (void)instance;
    (void)previous;
    (void)command_line;
    (void)show;
    Sleep(10 * 60 * 1000);
    return 0;
}
