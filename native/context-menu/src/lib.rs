#![allow(non_snake_case)]

mod command;
mod factory;
mod guid;

use std::sync::OnceLock;

use windows::core::{Interface, GUID, HRESULT};
use windows::Win32::Foundation::{
    CLASS_E_CLASSNOTAVAILABLE, E_FAIL, E_POINTER, HINSTANCE, HMODULE, S_FALSE, S_OK, TRUE,
};
use windows::Win32::System::Com::IClassFactory;
use windows_core::BOOL;

use crate::factory::CeterisClassFactory;
use crate::guid::CLSID_CETERIS_CONTEXT_MENU;

/// 自身 DLL 的 HINSTANCE,DllMain DLL_PROCESS_ATTACH 时记录。
/// command.rs 的 GetIcon 通过它拿 DLL 绝对路径,再拼 assets\menu-icon.ico。
/// 用 usize 存指针避免 Send/Sync 限制(HINSTANCE 是 *mut c_void)。
static DLL_HINSTANCE: OnceLock<usize> = OnceLock::new();

/// 给 command.rs 用的访问器。未初始化时返回 null HMODULE,
/// GetModuleFileNameW 会失败,GetIcon 走 E_NOTIMPL 退化路径(菜单仍能用,只是无图标)。
pub fn dll_hmodule() -> HMODULE {
    HMODULE(*DLL_HINSTANCE.get().unwrap_or(&0) as *mut _)
}

/// Windows DLL_PROCESS_ATTACH 常量(避开开启 Win32_System_SystemServices 整个 feature)。
const DLL_PROCESS_ATTACH: u32 = 1;

#[no_mangle]
pub extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut core::ffi::c_void,
) -> HRESULT {
    let result = std::panic::catch_unwind(|| unsafe {
        if rclsid.is_null() || riid.is_null() || ppv.is_null() {
            return E_POINTER;
        }
        *ppv = std::ptr::null_mut();

        if *rclsid != CLSID_CETERIS_CONTEXT_MENU {
            return CLASS_E_CLASSNOTAVAILABLE;
        }

        let factory: IClassFactory = CeterisClassFactory.into();
        match factory.query(&*riid, ppv) {
            hr if hr == S_OK => S_OK,
            hr => hr,
        }
    });

    match result {
        Ok(hr) => hr,
        Err(_) => E_FAIL,
    }
}

#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    S_FALSE
}

/// DllMain — 仅在 PROCESS_ATTACH 时记下自身 HINSTANCE,其他 reason 直接 TRUE。
///
/// `_reserved` 在静态/动态加载场景下含义不同,我们都不关心(GetIcon 只需要拿到 DLL 路径)。
/// 任何 panic 不会让 Explorer 崩,因为 catch_unwind 兜底。
#[no_mangle]
pub extern "system" fn DllMain(
    hinst: HINSTANCE,
    reason: u32,
    _reserved: *mut core::ffi::c_void,
) -> BOOL {
    if reason == DLL_PROCESS_ATTACH {
        let _ = std::panic::catch_unwind(|| {
            let _ = DLL_HINSTANCE.set(hinst.0 as usize);
        });
    }
    TRUE
}
