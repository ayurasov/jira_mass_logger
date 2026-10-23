//! Чтение значений реестра Windows (HKCU) напрямую через WinAPI (crate `winreg`).
//!
//! Раньше значения читались запуском `reg.exe query ...`. Из GUI-процесса
//! (`windows_subsystem = "windows"`) каждый такой запуск создаёт консольное окно,
//! которое на долю секунды появляется на экране — это и было «промаргивание»
//! на Windows 11 при каждом обращении к Jira (системный прокси читался при
//! построении HTTP-клиента). Прямое чтение реестра не порождает процессов вообще.

/// Читает строковое значение `name` из ключа `HKCU\<subkey>`.
#[cfg(target_os = "windows")]
pub fn hkcu_string(subkey: &str, name: &str) -> Option<String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(subkey)
        .ok()?
        .get_value::<String, _>(name)
        .ok()
}

/// Читает DWORD-значение `name` из ключа `HKCU\<subkey>`.
#[cfg(target_os = "windows")]
pub fn hkcu_dword(subkey: &str, name: &str) -> Option<u32> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(subkey)
        .ok()?
        .get_value::<u32, _>(name)
        .ok()
}
