//! El login usa el navegador del sistema; macOS aísla las cookies al agregar.
use serde_json::Value;
use tauri::AppHandle;

#[cfg(target_os = "macos")]
#[path = "login_macos.rs"]
mod native;

pub(super) enum LoginBrowser {
    System,
    #[cfg(target_os = "macos")]
    Private(native::PrivateLogin),
}

fn ephemeral(add: bool, macos: bool) -> bool {
    add && macos
}

impl LoginBrowser {
    pub fn open(app: &AppHandle, url: String, add: bool) -> Result<Self, Value> {
        if ephemeral(add, cfg!(target_os = "macos")) {
            #[cfg(target_os = "macos")]
            return Ok(Self::Private(native::PrivateLogin::open(app, url)?));
        }
        let _ = app;
        super::super::env::open_external(url).map_err(|_| super::coded("browser"))?;
        Ok(Self::System)
    }
    pub fn cancelled(&self) -> bool {
        match self {
            Self::System => false,
            #[cfg(target_os = "macos")]
            Self::Private(private) => private.cancelled(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ephemeral;
    #[test]
    fn only_macos_add_uses_private_authentication_session() {
        assert!(ephemeral(true, true));
        assert!(!ephemeral(false, true));
        assert!(!ephemeral(true, false));
        assert!(!ephemeral(false, false));
    }
    #[test]
    fn desktop_capability_only_covers_main() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../../../capabilities/default.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert_eq!(capability["webviews"], serde_json::json!(["main"]));
    }
}
