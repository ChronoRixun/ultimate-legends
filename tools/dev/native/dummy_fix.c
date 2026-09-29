/* A stand-in for the XML2 Fix (dinput.dll) in the launcher's tests: an empty DLL that carries a
 * version resource (dummy_fix.rc, written by native.py with the version a test asks for), so the
 * launcher's check of the fix's file version against a build's requirement can be exercised.
 * Nothing ever loads it.
 */
#include <windows.h>

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved)
{
    (void)instance;
    (void)reason;
    (void)reserved;
    return TRUE;
}
