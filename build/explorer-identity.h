#pragma once

#include <winrt/Windows.ApplicationModel.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Management.Deployment.h>
#include <winrt/Windows.Storage.h>
#include "explorer-publisher.h"

namespace identity {
using namespace winrt::Windows::Management::Deployment;
using winrt::Windows::ApplicationModel::Package;
using winrt::Windows::Foundation::Uri;
constexpr wchar_t name[] = L"MultiHub.Explorer";

class Apartment {
    HRESULT result;
public:
    Apartment() : result(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) { winrt::check_hresult(result); }
    ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
};

inline auto packages(const PackageManager& manager) {
    return manager.FindPackagesForUser(L"", name, multiHubPublisher);
}

inline bool atLocation(const Package& package, const std::wstring& directory) {
    try { return _wcsicmp(package.EffectiveExternalLocation().Path().c_str(), directory.c_str()) == 0; }
    catch (const winrt::hresult_error&) { return false; }
}

inline bool registered(const std::wstring& directory) {
    try {
        const Apartment apartment;
        const PackageManager manager;
        for (auto package : packages(manager)) if (atLocation(package, directory)) return true;
    } catch (const winrt::hresult_error&) {}
    return false;
}

inline bool remove() {
    try {
        const Apartment apartment;
        const PackageManager manager;
        for (auto package : packages(manager)) {
            if (manager.RemovePackageAsync(package.Id().FullName()).get().ExtendedErrorCode() != 0) return false;
        }
        return true;
    } catch (const winrt::hresult_error&) { return false; }
}

inline Uri fileUri(const std::wstring& path) {
    std::wstring uri(32768, L'\0');
    DWORD length = static_cast<DWORD>(uri.size());
    winrt::check_hresult(UrlCreateFromPathW(path.c_str(), uri.data(), &length, 0));
    return Uri(uri.c_str());
}

inline bool install(const std::wstring& directory) {
    const auto packagePath = directory + L"\\MultiHub.Explorer.msix";
    if (GetFileAttributesW(packagePath.c_str()) == INVALID_FILE_ATTRIBUTES) return false;
    try {
        const Apartment apartment;
        const PackageManager manager;
        AddPackageOptions options;
        options.ExternalLocationUri(fileUri(directory + L"\\"));
        const auto result = manager.AddPackageByUriAsync(fileUri(packagePath), options).get();
        if (result.ExtendedErrorCode() == 0) return true;
    } catch (const winrt::hresult_error&) {}
    return registered(directory);
}
}
