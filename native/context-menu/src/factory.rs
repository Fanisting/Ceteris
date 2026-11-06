use windows::core::{implement, IUnknown, Interface, Ref, Result, GUID};
use windows::Win32::Foundation::{CLASS_E_NOAGGREGATION, E_FAIL, E_POINTER, S_OK};
use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl};
use windows::Win32::UI::Shell::IExplorerCommand;
use windows_core::BOOL;

use crate::command::CeterisCommand;

#[implement(IClassFactory)]
pub struct CeterisClassFactory;

impl IClassFactory_Impl for CeterisClassFactory_Impl {
    fn CreateInstance(
        &self,
        punkouter: Ref<'_, IUnknown>,
        riid: *const GUID,
        ppvobject: *mut *mut core::ffi::c_void,
    ) -> Result<()> {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            if punkouter.ok().is_ok() {
                return Err(CLASS_E_NOAGGREGATION.into());
            }
            if riid.is_null() || ppvobject.is_null() {
                return Err(windows::core::Error::from_hresult(E_POINTER));
            }
            *ppvobject = std::ptr::null_mut();
            let cmd: IExplorerCommand = CeterisCommand.into();
            let hr = cmd.query(&*riid, ppvobject);
            if hr == S_OK {
                Ok(())
            } else {
                Err(windows::core::Error::from_hresult(hr))
            }
        }));
        match result {
            Ok(r) => r,
            Err(_) => Err(windows::core::Error::from_hresult(E_FAIL)),
        }
    }

    fn LockServer(&self, _flock: BOOL) -> Result<()> {
        Ok(())
    }
}
