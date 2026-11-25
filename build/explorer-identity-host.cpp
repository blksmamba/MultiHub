#include <windows.h>

// The sparse package needs an application executable with its matching identity.
// Explorer activates the separate packaged COM DLL.
int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) { return 0; }
