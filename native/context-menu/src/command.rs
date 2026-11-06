use std::path::Path;

use windows::core::{implement, w, Error, Ref, Result, GUID, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, E_FAIL, E_INVALIDARG, E_NOTIMPL, E_OUTOFMEMORY,
};
use windows::Win32::System::Com::{CoTaskMemAlloc, CoTaskMemFree, IBindCtx};
use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    REG_VALUE_TYPE,
};
use windows::Win32::System::Threading::{
    CreateProcessW, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, STARTUPINFOW,
};
use windows::Win32::UI::Shell::{
    IEnumExplorerCommand, IExplorerCommand, IExplorerCommand_Impl, IShellItemArray,
    ECF_DEFAULT, ECS_ENABLED, SIGDN_FILESYSPATH,
};
use windows_core::BOOL;

use crate::dll_hmodule;
use crate::guid::CLSID_MARINA_CONTEXT_MENU;

const MENU_TITLE: PCWSTR = w!("在 Ceteris 终端中打开");

#[implement(IExplorerCommand)]
pub struct MarinaCommand;

impl IExplorerCommand_Impl for MarinaCommand_Impl {
    fn GetTitle(&self, _items: Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        guard(|| alloc_pwstr(MENU_TITLE))
    }

    fn GetIcon(&self, _items: Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        guard(|| {
            let icon_path = locate_menu_icon()?;
            alloc_pwstr_from_str(&icon_path)
        })
    }

    fn GetToolTip(&self, _items: Ref<'_, IShellItemArray>) -> Result<PWSTR> {
        Err(Error::from_hresult(E_NOTIMPL))
    }

    fn GetCanonicalName(&self) -> Result<GUID> {
        Ok(CLSID_MARINA_CONTEXT_MENU)
    }

    fn GetState(
        &self,
        _items: Ref<'_, IShellItemArray>,
        _ok_to_be_slow: BOOL,
    ) -> Result<u32> {
        Ok(ECS_ENABLED.0 as u32)
    }

    fn Invoke(
        &self,
        items: Ref<'_, IShellItemArray>,
        _bind_ctx: Ref<'_, IBindCtx>,
    ) -> Result<()> {
        guard(|| {
            let path = get_first_item_path(items)?;
            let marina_exe = locate_marina_exe()?;
            launch_marina(&marina_exe, &path)
        })
    }

    fn GetFlags(&self) -> Result<u32> {
        Ok(ECF_DEFAULT.0 as u32)
    }

    fn EnumSubCommands(&self) -> Result<IEnumExplorerCommand> {
        Err(Error::from_hresult(E_NOTIMPL))
    }
}

fn guard<F, T>(f: F) -> Result<T>
where
    F: FnOnce() -> Result<T>,
{
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(_) => Err(Error::from_hresult(E_FAIL)),
    }
}

fn alloc_pwstr(src: PCWSTR) -> Result<PWSTR> {
    unsafe {
        let len = src.len();
        let total = len + 1;
        let ptr = CoTaskMemAlloc(total * 2) as *mut u16;
        if ptr.is_null() {
            return Err(Error::from_hresult(E_OUTOFMEMORY));
        }
        std::ptr::copy_nonoverlapping(src.0, ptr, len);
        *ptr.add(len) = 0;
        Ok(PWSTR(ptr))
    }
}

/// 与 alloc_pwstr 同语义,但从 Rust &str 出发(动态字符串)。Shell 拿到后必须
/// CoTaskMemFree(它会负责释放,我们这里只管分配)。
fn alloc_pwstr_from_str(s: &str) -> Result<PWSTR> {
    let wide: Vec<u16> = s.encode_utf16().collect();
    unsafe {
        let total = wide.len() + 1;
        let ptr = CoTaskMemAlloc(total * 2) as *mut u16;
        if ptr.is_null() {
            return Err(Error::from_hresult(E_OUTOFMEMORY));
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
        *ptr.add(wide.len()) = 0;
        Ok(PWSTR(ptr))
    }
}

/// 拿当前 DLL 自身的绝对路径,定位到 `<dll-dir>\assets\menu-icon.ico`。
///
/// MSIX 包结构(Sparse Package + ExternalLocation):
///   <Ceteris InstallLocation>\resources\context-menu\
///     ├── marina_context_menu.dll      ← 我们就是这个 DLL
///     ├── marina-context-menu-host.exe
///     └── assets\menu-icon.ico         ← 由 build.ps1 stage 进来
///
/// 失败(取路径失败 / 文件缺失)就退回 E_NOTIMPL,Shell 会无图标显示菜单,功能不受影响。
fn locate_menu_icon() -> Result<String> {
    let hmod = dll_hmodule();
    if hmod.0.is_null() {
        return Err(Error::from_hresult(E_NOTIMPL));
    }
    let mut buf = [0u16; 1024];
    // windows 0.62 把 handle 入参统一改成 Option<Handle> 形式以显式区分 null
    let len = unsafe { GetModuleFileNameW(Some(hmod), &mut buf) };
    if len == 0 || len as usize >= buf.len() {
        return Err(Error::from_hresult(E_NOTIMPL));
    }
    let dll_path = String::from_utf16_lossy(&buf[..len as usize]);
    let dll_dir = Path::new(&dll_path)
        .parent()
        .ok_or_else(|| Error::from_hresult(E_NOTIMPL))?;
    let icon = dll_dir.join("assets").join("menu-icon.ico");
    if !icon.exists() {
        return Err(Error::from_hresult(E_NOTIMPL));
    }
    Ok(icon.to_string_lossy().into_owned())
}

fn get_first_item_path(items: Ref<'_, IShellItemArray>) -> Result<String> {
    let items = items.ok().map_err(|_| Error::from_hresult(E_INVALIDARG))?;
    unsafe {
        let count = items.GetCount()?;
        if count == 0 {
            return Err(Error::from_hresult(E_INVALIDARG));
        }
        let item = items.GetItemAt(0)?;
        let pwstr = item.GetDisplayName(SIGDN_FILESYSPATH)?;
        let s = pwstr.to_string().map_err(|_| Error::from_hresult(E_FAIL))?;
        CoTaskMemFree(Some(pwstr.0 as _));
        Ok(s)
    }
}

fn locate_marina_exe() -> Result<String> {
    if let Ok(p) = std::env::var("MARINA_EXE") {
        if !p.is_empty() && Path::new(&p).exists() {
            return Ok(p);
        }
    }
    if let Some(install) = read_hkcu_string(r"Software\Ceteris", "InstallLocation") {
        let trimmed = install.trim_end_matches('\\');
        let exe = format!(r"{}\Ceteris.exe", trimmed);
        if Path::new(&exe).exists() {
            return Ok(exe);
        }
    }
    Err(Error::new(E_FAIL, "Ceteris executable not found"))
}

fn read_hkcu_string(subkey: &str, name: &str) -> Option<String> {
    let subkey_w: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    let name_w: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut key = HKEY::default();
    unsafe {
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey_w.as_ptr()),
            Some(0),
            KEY_READ,
            &mut key,
        )
        .is_err()
        {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        let mut kind = REG_VALUE_TYPE::default();
        let r = RegQueryValueExW(
            key,
            PCWSTR(name_w.as_ptr()),
            None,
            Some(&mut kind),
            Some(buf.as_mut_ptr() as *mut u8),
            Some(&mut size),
        );
        let _ = RegCloseKey(key);
        if r.is_err() {
            return None;
        }
        let chars = (size as usize / 2).saturating_sub(1);
        Some(String::from_utf16_lossy(&buf[..chars]))
    }
}

fn launch_marina(exe: &str, path: &str) -> Result<()> {
    let cmdline = format!(r#""{}" --open-here "{}""#, exe, path);
    let mut cmdline_w: Vec<u16> = cmdline.encode_utf16().chain(std::iter::once(0)).collect();
    let mut si = STARTUPINFOW::default();
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut pi = PROCESS_INFORMATION::default();
    unsafe {
        CreateProcessW(
            PCWSTR::null(),
            Some(PWSTR(cmdline_w.as_mut_ptr())),
            None,
            None,
            false,
            PROCESS_CREATION_FLAGS(0),
            None,
            PCWSTR::null(),
            &si,
            &mut pi,
        )?;
        if !pi.hProcess.is_invalid() {
            let _ = CloseHandle(pi.hProcess);
        }
        if !pi.hThread.is_invalid() {
            let _ = CloseHandle(pi.hThread);
        }
    }
    Ok(())
}
