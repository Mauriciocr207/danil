//! ASWebAuthenticationSession efímera; el código sigue entrando por loopback.
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, AnyProtocol, ClassBuilder, Sel};
use objc2::{msg_send, sel};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::CString;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc,
};
use std::time::Duration;
use tauri::AppHandle;

#[link(name = "AuthenticationServices", kind = "framework")]
extern "C" {}
thread_local! {
    static SESSIONS: RefCell<HashMap<u64, (Retained<AnyObject>, Retained<AnyObject>)>> = RefCell::default();
}
static NEXT: AtomicU64 = AtomicU64::new(1);
pub(crate) struct PrivateLogin {
    app: AppHandle,
    id: u64,
    cancelled: Arc<AtomicBool>,
}
impl PrivateLogin {
    pub fn open(app: &AppHandle, url: String) -> Result<Self, Value> {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let cancelled = Arc::new(AtomicBool::new(false));
        let done = cancelled.clone();
        let (send, recv) = mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let result = unsafe { start(&url, done) };
            let ok = if let Some(objects) = result {
                SESSIONS.with(|sessions| sessions.borrow_mut().insert(id, objects));
                true
            } else {
                false
            };
            let _ = send.send(ok);
        })
        .map_err(|_| super::super::coded("browser"))?;
        if recv.recv_timeout(Duration::from_secs(10)) != Ok(true) {
            let app = app.clone();
            let _ = app.run_on_main_thread(move || remove(id));
            return Err(super::super::coded("browser"));
        }
        Ok(Self {
            app: app.clone(),
            id,
            cancelled,
        })
    }
    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}
impl Drop for PrivateLogin {
    fn drop(&mut self) {
        let id = self.id;
        let _ = self.app.run_on_main_thread(move || remove(id));
    }
}
fn remove(id: u64) {
    if let Some((session, _provider)) = SESSIONS.with(|s| s.borrow_mut().remove(&id)) {
        unsafe {
            let _: () = msg_send![&*session, cancel];
        }
    }
}
extern "C-unwind" fn anchor(
    _this: &AnyObject,
    _cmd: Sel,
    _session: *mut AnyObject,
) -> *mut AnyObject {
    unsafe {
        let Some(class) = AnyClass::get(c"NSApplication") else {
            return std::ptr::null_mut();
        };
        let app: *mut AnyObject = msg_send![class, sharedApplication];
        msg_send![app, mainWindow]
    }
}
unsafe fn provider() -> Option<Retained<AnyObject>> {
    let class = if let Some(class) = AnyClass::get(c"DanilPrivateLoginAnchor") {
        class
    } else {
        let mut builder =
            ClassBuilder::new(c"DanilPrivateLoginAnchor", AnyClass::get(c"NSObject")?)?;
        builder.add_protocol(AnyProtocol::get(
            c"ASWebAuthenticationPresentationContextProviding",
        )?);
        builder.add_method(
            sel!(presentationAnchorForWebAuthenticationSession:),
            anchor as extern "C-unwind" fn(_, _, _) -> _,
        );
        builder.register()
    };
    let allocated: *mut AnyObject = msg_send![class, alloc];
    let initialized: *mut AnyObject = msg_send![allocated, init];
    Retained::from_raw(initialized)
}
unsafe fn start(
    url: &str,
    cancelled: Arc<AtomicBool>,
) -> Option<(Retained<AnyObject>, Retained<AnyObject>)> {
    let class = AnyClass::get(c"ASWebAuthenticationSession")?;
    let string_class = AnyClass::get(c"NSString")?;
    let raw = CString::new(url).ok()?;
    let text: *mut AnyObject = msg_send![string_class, stringWithUTF8String: raw.as_ptr()];
    let nsurl: *mut AnyObject = msg_send![AnyClass::get(c"NSURL")?, URLWithString: text];
    let completion = block2::RcBlock::new(move |_url: *mut AnyObject, _error: *mut AnyObject| {
        cancelled.store(true, Ordering::Release);
    });
    let allocated: *mut AnyObject = msg_send![class, alloc];
    // Sin esquema personalizado: el servidor local recibe el callback HTTP.
    let initialized: *mut AnyObject = msg_send![allocated, initWithURL: nsurl, callbackURLScheme: std::ptr::null::<AnyObject>(), completionHandler: &*completion];
    let session = Retained::from_raw(initialized)?;
    let provider = provider()?;
    let _: () = msg_send![&*session, setPresentationContextProvider: &*provider];
    if !isolate(&session) {
        return None;
    }
    let started: bool = msg_send![&*session, start];
    started.then_some((session, provider))
}

unsafe fn isolate(session: &AnyObject) -> bool {
    let _: () = msg_send![session, setPrefersEphemeralWebBrowserSession: true];
    msg_send![session, prefersEphemeralWebBrowserSession]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_authentication_session_requests_ephemeral_cookies() {
        objc2::rc::autoreleasepool(|_| unsafe {
            let class = AnyClass::get(c"ASWebAuthenticationSession").unwrap();
            let allocated: *mut AnyObject = msg_send![class, alloc];
            let text: *mut AnyObject = msg_send![AnyClass::get(c"NSString").unwrap(), stringWithUTF8String: c"https://edge.example.test/v1/identity/desk/authorize?mode=add".as_ptr()];
            let url: *mut AnyObject =
                msg_send![AnyClass::get(c"NSURL").unwrap(), URLWithString:text];
            let completion = block2::RcBlock::new(|_: *mut AnyObject, _: *mut AnyObject| {});
            let initialized: *mut AnyObject = msg_send![allocated, initWithURL:url, callbackURLScheme: std::ptr::null::<AnyObject>(), completionHandler:&*completion];
            let session = Retained::from_raw(initialized).unwrap();
            assert!(isolate(&session));
            let ephemeral: bool = msg_send![&*session, prefersEphemeralWebBrowserSession];
            assert!(ephemeral);
        });
    }
}
