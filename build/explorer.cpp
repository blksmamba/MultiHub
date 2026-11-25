#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <shlwapi.h>
#include <shellapi.h>
#include <appmodel.h>
#include <atomic>
#include <new>
#include <string>
#ifndef MULTIHUB_MODERN
#include "explorer-identity.h"
#endif

constexpr wchar_t title[] = L"Импортировать в MultiHub";
constexpr DWORD maxItems = 4096;
constexpr size_t maxManifestBytes = 16 * 1024 * 1024;
std::atomic<long> objects = 0;

#ifndef MULTIHUB_MODERN
constexpr CLSID commandClass{0xd13545aa,0x7932,0x40ea,{0xa8,0x39,0x56,0x74,0xfe,0x73,0x24,0x19}};
constexpr wchar_t classId[] = L"{D13545AA-7932-40EA-A839-5674FE732419}";
constexpr wchar_t classKey[] = L"Software\\Classes\\CLSID\\{D13545AA-7932-40EA-A839-5674FE732419}";
constexpr wchar_t verbKey[] = L"Software\\Classes\\SystemFileAssociations\\.jar\\shell\\MultiHub.Import";
constexpr wchar_t settingsKey[] = L"Software\\MultiHub";
constexpr wchar_t option[] = L"ExplorerImport";
ULONGLONG lastCall = 0;

std::wstring modulePath() {
    std::wstring path(32768, L'\0');
    const DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (!length || length >= path.size()) return {};
    path.resize(length);
    return path;
}

std::wstring externalLocation() {
    const auto path = modulePath();
    return path.empty() ? std::wstring{} : path.substr(0, path.find_last_of(L'\\'));
}

bool writeString(const std::wstring& key, const wchar_t* name, const std::wstring& value) {
    return RegSetKeyValueW(HKEY_CURRENT_USER, key.c_str(), name, REG_SZ, value.c_str(),
        static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t))) == ERROR_SUCCESS;
}

bool legacyRegistered() {
    wchar_t value[64]{};
    DWORD bytes = sizeof(value);
    const std::wstring key = std::wstring(verbKey) + L"\\command";
    if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), L"DelegateExecute", RRF_RT_REG_SZ, nullptr, value, &bytes) != ERROR_SUCCESS ||
        _wcsicmp(value, classId) != 0) return false;
    const std::wstring server = std::wstring(classKey) + L"\\LocalServer32";
    wchar_t path[32768]{};
    bytes = sizeof(path);
    return RegGetValueW(HKEY_CURRENT_USER, server.c_str(), nullptr, RRF_RT_REG_SZ, nullptr, path, &bytes) == ERROR_SUCCESS &&
        _wcsicmp(path, (L"\"" + modulePath() + L"\"").c_str()) == 0;
}

bool removeLegacy(bool forget) {
    const auto verb = SHDeleteKeyW(HKEY_CURRENT_USER, verbKey);
    const auto server = SHDeleteKeyW(HKEY_CURRENT_USER, classKey);
    if (forget) RegDeleteKeyValueW(HKEY_CURRENT_USER, settingsKey, option);
    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
    return (verb == ERROR_SUCCESS || verb == ERROR_FILE_NOT_FOUND || verb == ERROR_PATH_NOT_FOUND) &&
        (server == ERROR_SUCCESS || server == ERROR_FILE_NOT_FOUND || server == ERROR_PATH_NOT_FOUND);
}

bool configure(const std::wstring& action) {
    const bool enable = action == L"--enable";
    if (enable || action == L"--disable") {
        const DWORD value = enable ? 1 : 0;
        if (RegSetKeyValueW(HKEY_CURRENT_USER, settingsKey, option, REG_DWORD, &value, sizeof(value)) != ERROR_SUCCESS) return false;
    }
    if (action == L"--uninstall" || action == L"--disable") {
        const bool removed = identity::remove();
        return removeLegacy(action == L"--uninstall") && removed;
    }
    DWORD choice = 1, size = sizeof(choice);
    if (action == L"--install" && RegGetValueW(HKEY_CURRENT_USER, settingsKey, option, RRF_RT_REG_DWORD, nullptr, &choice, &size) == ERROR_SUCCESS && choice == 0)
        return identity::remove() && removeLegacy(false);
    const auto helper = modulePath();
    if (helper.empty()) return false;
    const auto directory = externalLocation();
    if (identity::install(directory)) return removeLegacy(false);
    const auto app = directory + L"\\ModKit.exe";
    const auto command = std::wstring(verbKey) + L"\\command";
    const bool ok = writeString(std::wstring(classKey) + L"\\LocalServer32", nullptr, L"\"" + helper + L"\"") &&
        writeString(verbKey, nullptr, title) &&
        writeString(verbKey, L"MultiSelectModel", L"Player") &&
        writeString(verbKey, L"Icon", L"\"" + app + L"\",0") &&
        writeString(command, nullptr, L"") && writeString(command, L"DelegateExecute", classId);
    if (!ok) removeLegacy(false);
    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
    return ok;
}
#else
constexpr CLSID commandClass{0x662425d5,0x732c,0x4cc7,{0x9b,0x65,0x87,0x3f,0xb8,0x30,0xc0,0x8a}};

std::wstring externalLocation() {
    const auto kernel = GetModuleHandleW(L"kernelbase.dll");
    const auto getPath = kernel ? reinterpret_cast<decltype(&GetCurrentPackagePath2)>(GetProcAddress(kernel, "GetCurrentPackagePath2")) : nullptr;
    if (!getPath) return {};
    UINT32 length = 0;
    if (getPath(PackagePathType_EffectiveExternal, &length, nullptr) != ERROR_INSUFFICIENT_BUFFER) return {};
    std::wstring path(length, L'\0');
    if (getPath(PackagePathType_EffectiveExternal, &length, path.data()) != ERROR_SUCCESS) return {};
    path.resize(wcslen(path.c_str()));
    return path;
}
#endif

HRESULT importItems(IShellItemArray* selection) {
    if (!selection) return E_INVALIDARG;
    const auto location = externalLocation();
    if (location.empty()) return E_FAIL;
    DWORD count = 0;
    if (FAILED(selection->GetCount(&count)) || !count || count > maxItems) return E_INVALIDARG;
    std::wstring files;
    for (DWORD index = 0; index < count; ++index) {
        IShellItem* item = nullptr;
        if (FAILED(selection->GetItemAt(index, &item))) continue;
        PWSTR raw = nullptr;
        const auto result = item->GetDisplayName(SIGDN_FILESYSPATH, &raw);
        item->Release();
        if (SUCCEEDED(result) && raw) {
            const std::wstring path(raw);
            CoTaskMemFree(raw);
            if (path.size() > 4 && _wcsicmp(path.c_str() + path.size() - 4, L".jar") == 0 &&
                path.find_first_of(L"\r\n") == std::wstring::npos) files += path + L'\n';
        }
        if (files.size() * sizeof(wchar_t) > maxManifestBytes) return HRESULT_FROM_WIN32(ERROR_FILE_TOO_LARGE);
    }
    if (files.empty()) return E_INVALIDARG;

    PWSTR rawFolder = nullptr;
    if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DEFAULT, nullptr, &rawFolder))) return E_FAIL;
    const std::wstring folder = std::wstring(rawFolder) + L"\\MultiHub";
    CoTaskMemFree(rawFolder);
    const auto inbox = folder + L"\\ExplorerImports";
    if (!CreateDirectoryW(folder.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) return E_FAIL;
    if (!CreateDirectoryW(inbox.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) return E_FAIL;
    GUID batch;
    wchar_t rawId[40]{};
    if (FAILED(CoCreateGuid(&batch)) || !StringFromGUID2(batch, rawId, 40)) return E_FAIL;
    const std::wstring id(rawId + 1, 36);
    const auto manifest = inbox + L"\\" + id + L".paths";
    const auto temporary = manifest + L".tmp";
    HANDLE file = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return HRESULT_FROM_WIN32(GetLastError());
    DWORD written = 0;
    const DWORD bytes = static_cast<DWORD>(files.size() * sizeof(wchar_t));
    const bool ok = WriteFile(file, files.data(), bytes, &written, nullptr) && written == bytes;
    CloseHandle(file);
    if (!ok || !MoveFileExW(temporary.c_str(), manifest.c_str(), MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(temporary.c_str());
        return E_FAIL;
    }
    const auto app = location + L"\\ModKit.exe";
    auto command = L"\"" + app + L"\" --multihub-import=" + id;
    STARTUPINFOW startup{sizeof(startup)};
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(app.c_str(), command.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &startup, &process)) {
        const auto error = GetLastError();
        DeleteFileW(manifest.c_str());
        return HRESULT_FROM_WIN32(error);
    }
    AllowSetForegroundWindow(process.dwProcessId);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return S_OK;
}

#ifndef MULTIHUB_MODERN
class Command final : public IExecuteCommand, public IObjectWithSelection {
    ULONG refs = 1;
    IShellItemArray* selection = nullptr;
public:
    Command() { ++objects; }
    ~Command() { if (selection) selection->Release(); --objects; lastCall = GetTickCount64(); }
    STDMETHODIMP QueryInterface(REFIID iid, void** result) override {
        if (!result) return E_POINTER;
        *result = nullptr;
        if (iid == IID_IUnknown || iid == IID_IExecuteCommand) *result = static_cast<IExecuteCommand*>(this);
        else if (iid == IID_IObjectWithSelection) *result = static_cast<IObjectWithSelection*>(this);
        else return E_NOINTERFACE;
        AddRef();
        return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return ++refs; }
    STDMETHODIMP_(ULONG) Release() override { const auto remaining = --refs; if (!remaining) delete this; return remaining; }
    STDMETHODIMP SetSelection(IShellItemArray* value) override {
        if (value) value->AddRef();
        if (selection) selection->Release();
        selection = value;
        return S_OK;
    }
    STDMETHODIMP GetSelection(REFIID iid, void** result) override { return selection ? selection->QueryInterface(iid, result) : E_FAIL; }
    STDMETHODIMP SetKeyState(DWORD) override { return S_OK; }
    STDMETHODIMP SetParameters(LPCWSTR) override { return S_OK; }
    STDMETHODIMP SetPosition(POINT) override { return S_OK; }
    STDMETHODIMP SetShowWindow(int) override { return S_OK; }
    STDMETHODIMP SetNoShowUI(BOOL) override { return S_OK; }
    STDMETHODIMP SetDirectory(LPCWSTR) override { return S_OK; }
    STDMETHODIMP Execute() override {
        lastCall = GetTickCount64();
        try { return importItems(selection); } catch (const std::bad_alloc&) { return E_OUTOFMEMORY; }
    }
};
#else
class Command final : public IExplorerCommand {
    std::atomic<ULONG> refs = 1;
public:
    Command() { ++objects; }
    ~Command() { --objects; }
    STDMETHODIMP QueryInterface(REFIID iid, void** result) override {
        if (!result) return E_POINTER;
        *result = nullptr;
        if (iid != IID_IUnknown && iid != IID_IExplorerCommand) return E_NOINTERFACE;
        *result = static_cast<IExplorerCommand*>(this);
        AddRef();
        return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return ++refs; }
    STDMETHODIMP_(ULONG) Release() override { const auto remaining = --refs; if (!remaining) delete this; return remaining; }
    STDMETHODIMP GetTitle(IShellItemArray*, PWSTR* text) override { return SHStrDupW(title, text); }
    STDMETHODIMP GetIcon(IShellItemArray*, PWSTR* icon) override {
        try {
            const auto directory = externalLocation();
            if (directory.empty()) { *icon = nullptr; return E_NOTIMPL; }
            return SHStrDupW((directory + L"\\ModKit.exe,0").c_str(), icon);
        } catch (const std::bad_alloc&) { return E_OUTOFMEMORY; }
    }
    STDMETHODIMP GetToolTip(IShellItemArray*, PWSTR* text) override { *text = nullptr; return E_NOTIMPL; }
    STDMETHODIMP GetCanonicalName(GUID* name) override { *name = commandClass; return S_OK; }
    STDMETHODIMP GetFlags(EXPCMDFLAGS* flags) override { *flags = ECF_DEFAULT; return S_OK; }
    STDMETHODIMP GetState(IShellItemArray* selection, BOOL, EXPCMDSTATE* state) override {
        DWORD count = 0;
        *state = selection && SUCCEEDED(selection->GetCount(&count)) && count && count <= maxItems ? ECS_ENABLED : ECS_HIDDEN;
        return S_OK;
    }
    STDMETHODIMP Invoke(IShellItemArray* selection, IBindCtx*) override {
        try { return importItems(selection); } catch (const std::bad_alloc&) { return E_OUTOFMEMORY; }
    }
    STDMETHODIMP EnumSubCommands(IEnumExplorerCommand** commands) override { *commands = nullptr; return E_NOTIMPL; }
};
#endif

class Factory final : public IClassFactory {
    std::atomic<ULONG> refs = 1;
public:
#ifdef MULTIHUB_MODERN
    Factory() { ++objects; }
    ~Factory() { --objects; }
#endif
    STDMETHODIMP QueryInterface(REFIID iid, void** result) override {
        if (!result) return E_POINTER;
        *result = nullptr;
        if (iid != IID_IUnknown && iid != IID_IClassFactory) return E_NOINTERFACE;
        *result = static_cast<IClassFactory*>(this);
        AddRef();
        return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return ++refs; }
    STDMETHODIMP_(ULONG) Release() override {
        const auto remaining = --refs;
#ifdef MULTIHUB_MODERN
        if (!remaining) delete this;
#endif
        return remaining;
    }
    STDMETHODIMP CreateInstance(IUnknown* outer, REFIID iid, void** result) override {
        if (outer) return CLASS_E_NOAGGREGATION;
        auto command = new (std::nothrow) Command();
        if (!command) return E_OUTOFMEMORY;
        const auto status = command->QueryInterface(iid, result);
        command->Release();
        return status;
    }
    STDMETHODIMP LockServer(BOOL lock) override { lock ? ++objects : --objects; return S_OK; }
};

#ifndef MULTIHUB_MODERN
int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    int argc = 0;
    const auto argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    const std::wstring action(argc > 1 ? argv[1] : L"");
    LocalFree(argv);
    if (action == L"--registered") return legacyRegistered() || identity::registered(externalLocation()) ? 0 : 2;
    if (action == L"--install" || action == L"--enable" || action == L"--disable" || action == L"--uninstall") return configure(action) ? 0 : 1;
    if (_wcsicmp(action.c_str(), L"-Embedding") != 0 && _wcsicmp(action.c_str(), L"/Embedding") != 0) return 1;
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE))) return 1;
    Factory factory;
    DWORD cookie = 0;
    const auto result = CoRegisterClassObject(commandClass, &factory, CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE, &cookie);
    if (SUCCEEDED(result)) {
        MSG message;
        PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
        lastCall = GetTickCount64();
        const auto timer = SetTimer(nullptr, 0, 1000, nullptr);
        while (timer && GetMessageW(&message, nullptr, 0, 0) > 0) {
            if (message.message == WM_TIMER && objects == 0 && GetTickCount64() - lastCall > 15000) break;
            DispatchMessageW(&message);
        }
        if (timer) KillTimer(nullptr, timer);
        CoRevokeClassObject(cookie);
    }
    CoUninitialize();
    return FAILED(result) ? 1 : 0;
}
#else
STDAPI DllGetClassObject(REFCLSID clsid, REFIID iid, void** result) {
    if (!result) return E_POINTER;
    *result = nullptr;
    if (clsid != commandClass) return CLASS_E_CLASSNOTAVAILABLE;
    auto factory = new (std::nothrow) Factory();
    if (!factory) return E_OUTOFMEMORY;
    const auto status = factory->QueryInterface(iid, result);
    factory->Release();
    return status;
}

STDAPI DllCanUnloadNow() { return objects == 0 ? S_OK : S_FALSE; }
#endif
