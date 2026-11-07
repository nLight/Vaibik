#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <ole2.h>
#include <uiautomation.h>

#include <algorithm>
#include <cwctype>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

template<class T> struct Release {
    void operator()(T* value) const { if (value) value->Release(); }
};
template<class T> using Com = std::unique_ptr<T, Release<T>>;

static void answer(bool ok, const char* error = "") {
    if (ok) std::cout << "{\"ok\":true}" << std::endl;
    else std::cout << "{\"ok\":false,\"error\":\"" << error << "\"}" << std::endl;
}

static std::wstring decode(const std::string& encoded) {
    if (encoded.size() < 2 || encoded.size() > 640002 || encoded.front() != '"' ||
        encoded.back() != '"') throw std::runtime_error("Invalid draft.");
    const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
        encoded.data(), static_cast<int>(encoded.size()), nullptr, 0);
    if (length == 0) throw std::runtime_error("Invalid Unicode draft.");
    std::wstring input(length, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
        encoded.data(), static_cast<int>(encoded.size()), input.data(), length);

    std::wstring text;
    for (size_t i = 1; i + 1 < input.size(); ++i) {
        wchar_t c = input[i];
        if (c == L'\\') {
            if (++i + 1 >= input.size()) throw std::runtime_error("Invalid draft escape.");
            switch (input[i]) {
                case L'\\': c = L'\\'; break;
                case L'"': c = L'"'; break;
                case L'/': c = L'/'; break;
                case L'n': c = L'\n'; break;
                case L'r': c = L'\r'; break;
                case L't': c = L'\t'; break;
                case L'b': c = L'\b'; break;
                case L'f': c = L'\f'; break;
                case L'u': {
                    if (i + 5 >= input.size()) throw std::runtime_error("Invalid Unicode escape.");
                    const auto value = input.substr(i + 1, 4);
                    if (!std::all_of(value.begin(), value.end(), [](wchar_t v) { return iswxdigit(v); }))
                        throw std::runtime_error("Invalid Unicode escape.");
                    c = static_cast<wchar_t>(std::stoul(value, nullptr, 16));
                    i += 4;
                    break;
                }
                default: throw std::runtime_error("Invalid draft escape.");
            }
        }
        if (c >= L' ' || c == L'\n' || c == L'\r' || c == L'\t') text += c;
    }
    return text;
}

static std::wstring executable_name(HWND window, DWORD& pid) {
    GetWindowThreadProcessId(window, &pid);
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return L"";
    std::wstring value(32768, L'\0');
    DWORD length = static_cast<DWORD>(value.size());
    const bool read = QueryFullProcessImageNameW(process, 0, value.data(), &length) != 0;
    CloseHandle(process);
    if (!read) return L"";
    value.resize(length);
    const auto separator = value.find_last_of(L"\\/");
    if (separator != std::wstring::npos) value.erase(0, separator + 1);
    std::transform(value.begin(), value.end(), value.begin(), [](wchar_t c) { return towlower(c); });
    return value;
}

static std::wstring title(HWND window) {
    std::wstring name(GetWindowTextLengthW(window) + 1, L'\0');
    name.resize(GetWindowTextW(window, name.data(), static_cast<int>(name.size())));
    return name;
}

static Com<IUIAutomationElement> focused(IUIAutomation* automation, DWORD pid) {
    IUIAutomationElement* raw = nullptr;
    if (FAILED(automation->GetFocusedElement(&raw)) || !raw) return {};
    Com<IUIAutomationElement> element(raw);
    CONTROLTYPEID type = 0;
    int process = 0;
    BOOL enabled = FALSE;
    if (FAILED(element->get_CurrentProcessId(&process)) ||
        FAILED(element->get_CurrentControlType(&type)) ||
        FAILED(element->get_CurrentIsEnabled(&enabled)) ||
        static_cast<DWORD>(process) != pid || !enabled ||
        (type != UIA_EditControlTypeId && type != UIA_DocumentControlTypeId)) return {};
    VARIANT read_only;
    VariantInit(&read_only);
    element->GetCurrentPropertyValue(UIA_ValueIsReadOnlyPropertyId, &read_only);
    const bool locked = read_only.vt == VT_BOOL && read_only.boolVal == VARIANT_TRUE;
    VariantClear(&read_only);
    if (locked) return {};
    return element;
}

static void paste(HWND window, const std::wstring& text) {
    IDataObject* data = nullptr;
    if (FAILED(OleGetClipboard(&data))) throw std::runtime_error("Cannot read the clipboard.");
    Com<IDataObject> previous(data);
    const HWND owner = CreateWindowExW(0, L"STATIC", L"", 0, 0, 0, 0, 0,
        HWND_MESSAGE, nullptr, nullptr, nullptr);
    if (!owner) throw std::runtime_error("Cannot create a clipboard owner.");
    const SIZE_T bytes = (text.size() + 1) * sizeof(wchar_t);
    HGLOBAL buffer = GlobalAlloc(GMEM_MOVEABLE, bytes);
    bool written = false;
    if (buffer) {
        void* storage = GlobalLock(buffer);
        if (storage) {
            memcpy(storage, text.c_str(), bytes);
            GlobalUnlock(buffer);
            if (OpenClipboard(owner)) {
                written = EmptyClipboard() && SetClipboardData(CF_UNICODETEXT, buffer);
                CloseClipboard();
            }
        }
    }
    const DWORD sequence = GetClipboardSequenceNumber();
    auto restore = [&]() {
        if (GetClipboardSequenceNumber() == sequence &&
            SUCCEEDED(OleSetClipboard(previous.get()))) OleFlushClipboard();
        DestroyWindow(owner);
    };
    if (!written) {
        if (buffer) GlobalFree(buffer);
        restore();
        throw std::runtime_error("Cannot write to the clipboard.");
    }
    if (GetForegroundWindow() != window ||
        (GetAsyncKeyState(VK_CONTROL) | GetAsyncKeyState(VK_MENU) | GetAsyncKeyState(VK_SHIFT)) & 0x8000) {
        restore();
        throw std::runtime_error("Focus or modifier keys changed before paste.");
    }

    INPUT keys[4]{};
    for (auto& key : keys) key.type = INPUT_KEYBOARD;
    keys[0].ki.wVk = VK_CONTROL;
    keys[1].ki.wVk = keys[2].ki.wVk = 'V';
    keys[3].ki.wVk = VK_CONTROL;
    keys[2].ki.dwFlags = keys[3].ki.dwFlags = KEYEVENTF_KEYUP;
    const UINT sent = SendInput(4, keys, sizeof(INPUT));
    Sleep(450);
    restore();
    if (sent != 4) throw std::runtime_error("The target app rejected paste.");
}

int main() {
    if (FAILED(OleInitialize(nullptr))) {
        answer(false, "Cannot initialize Windows accessibility.");
        return 1;
    }
    try {
        const HWND window = GetForegroundWindow();
        DWORD pid = 0;
        const auto program = executable_name(window, pid);
        if (program != L"claude.exe" && program != L"codex.exe" && program != L"chatgpt.exe")
            throw std::runtime_error("Focus a Claude or Codex prompt before recording.");
        IUIAutomation* raw = nullptr;
        if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(&raw))) || !raw) throw std::runtime_error("Windows accessibility is unavailable.");
        Com<IUIAutomation> automation(raw);
        const auto original_title = title(window);
        const auto field = focused(automation.get(), pid);
        if (!field) throw std::runtime_error("Focus an editable Claude or Codex prompt.");
        answer(true);
        std::string line;
        if (std::getline(std::cin, line)) {
            const auto text = decode(line);
            const auto current = focused(automation.get(), pid);
            BOOL same = FALSE;
            if (!current || GetForegroundWindow() != window || title(window) != original_title ||
                FAILED(automation->CompareElements(field.get(), current.get(), &same)) || !same)
                throw std::runtime_error("The active prompt changed while dictating.");
            if (!text.empty()) paste(window, text);
            answer(true);
        }
    } catch (const std::exception& error) {
        answer(false, error.what());
        OleUninitialize();
        return 1;
    }
    OleUninitialize();
}
