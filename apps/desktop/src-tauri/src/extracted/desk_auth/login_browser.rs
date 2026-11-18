//! Agregar una persona nunca reutiliza las cookies del navegador habitual.
use serde_json::Value;
use tauri::AppHandle;

#[cfg(target_os = "macos")]
#[path = "login_macos.rs"]
mod native;

pub(super) enum LoginBrowser {
    System,
    #[cfg(target_os = "macos")]
    Private(native::PrivateLogin),
    #[cfg(not(target_os = "macos"))]
    Private(PrivateLogin),
}
impl LoginBrowser {
    pub fn open(app: &AppHandle, url: String, add: bool) -> Result<Self, Value> {
        if !add {
            super::super::env::open_external(url).map_err(|_| super::coded("browser"))?;
            return Ok(Self::System);
        }
        #[cfg(target_os = "macos")]
        let private = native::PrivateLogin::open(app, url)?;
        #[cfg(not(target_os = "macos"))]
        let private = PrivateLogin::open(app, url)?;
        Ok(Self::Private(private))
    }
    pub fn cancelled(&self) -> bool {
        match self {
            Self::System => false,
            Self::Private(private) => private.cancelled(),
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) struct PrivateLogin {
    window: tauri::WebviewWindow,
    directory: Option<tempfile::TempDir>,
}
#[cfg(not(target_os = "macos"))]
impl PrivateLogin {
    fn open(app: &AppHandle, url: String) -> Result<Self, Value> {
        let directory = private_storage()?;
        let label = format!(
            "desk-login-{}",
            super::pkce::random(18).ok_or_else(|| super::coded("browser"))?
        );
        let url = url.parse().map_err(|_| super::coded("browser"))?;
        let window = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::External(url))
            .title("Danil")
            .inner_size(540.0, 720.0)
            .incognito(true)
            .data_directory(directory.path().to_owned())
            .devtools(false)
            .disable_drag_drop_handler()
            .on_navigation(|url| {
                url.scheme() == "https"
                    || (url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
            })
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .build()
            .map_err(|_| super::coded("browser"))?;
        Ok(Self {
            window,
            directory: Some(directory),
        })
    }
    fn cancelled(&self) -> bool {
        self.window.is_visible().is_err()
    }
}
#[cfg(not(target_os = "macos"))]
impl Drop for PrivateLogin {
    fn drop(&mut self) {
        let _ = self.window.clear_all_browsing_data();
        let _ = self.window.close();
        // El directorio pertenece solo a este intento; nunca al perfil de la app.
        self.directory.take();
    }
}

#[cfg(any(test, not(target_os = "macos")))]
fn private_storage() -> Result<tempfile::TempDir, Value> {
    tempfile::tempdir().map_err(|_| super::coded("browser"))
}

#[cfg(test)]
mod tests {
    use super::private_storage;
    #[test]
    fn adding_account_allocates_empty_storage_and_erases_it_on_drop() {
        let first = private_storage().unwrap();
        let cookie = first.path().join("AuthKit-cookies");
        std::fs::write(&cookie, "account-a-test-cookie").unwrap();
        let second = private_storage().unwrap();
        assert_ne!(first.path(), second.path());
        assert!(!second.path().join("AuthKit-cookies").exists());
        let path = first.path().to_owned();
        drop(first);
        assert!(!path.exists());
    }
}
