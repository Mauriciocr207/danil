//! Login de Desk por el navegador del sistema contra `identity` (S1, decisión
//! `desk-auth` y contrato `mvp-v1` en `terminus-workspace`):
//! PKCE S256, retorno por loopback, canje en `POST /v1/identity/desk/token`,
//! refresh en el llavero y Bearer al borde. La webview recibe perfil y estado,
//! nunca tokens. No hay varias cuentas: cambiar de usuario es cerrar sesión.

pub(crate) mod pkce;
pub(crate) mod session;
#[cfg(test)]
mod tests;

use serde_json::{json, Value};
use session::{Desk, Fail, Stored, Vault};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::Emitter;

/// La única puerta: el borde `/v1`.
const EDGE: &str = "https://edge.danil.ai";
const LOGIN_WAIT: Duration = Duration::from_secs(600);
const KEYCHAIN_ACCOUNT: &str = "danil";

/// `DANIL_EDGE_URL` cambia el borde solo en builds de depuración.
fn edge() -> String {
    #[cfg(debug_assertions)]
    if let Some(value) = std::env::var("DANIL_EDGE_URL")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_owned())
        .filter(|v| v.starts_with("https://") || v.starts_with("http://127.0.0.1:"))
    {
        return value;
    }
    EDGE.to_owned()
}

/// El llavero del sistema, con la ACL del usuario. Sin llavero: solo memoria.
struct Keychain {
    service: String,
}

impl Keychain {
    fn entry(&self) -> Option<keyring::Entry> {
        if std::env::var_os("DANIL_DESK_SESSION_MEMORY").is_some() {
            return None;
        }
        keyring::Entry::new(&self.service, KEYCHAIN_ACCOUNT).ok()
    }
}

impl Vault for Keychain {
    fn load(&self) -> Option<Stored> {
        Stored::from_record(&self.entry()?.get_password().ok()?)
    }
    fn save(&self, stored: &Stored) -> bool {
        self.entry()
            .is_some_and(|e| e.set_password(&stored.to_record()).is_ok())
    }
    fn clear(&self) {
        if let Some(e) = self.entry() {
            let _ = e.delete_credential();
        }
    }
}

fn desk(app: &tauri::AppHandle) -> &'static Desk<Keychain> {
    static DESK: OnceLock<Desk<Keychain>> = OnceLock::new();
    DESK.get_or_init(|| {
        let app = app.clone();
        Desk::new(
            edge(),
            Keychain {
                service: format!("{}.desk-session", app.config().identifier),
            },
            move || announce(&app, &disconnected()),
        )
    })
}

fn disconnected() -> Value {
    json!({ "state": "disconnected" })
}

fn error(fail: &Fail) -> Value {
    let code = fail.code();
    let mut value = json!({ "what": { "clave": format!("danil.error.{code}") }, "detail": code });
    if let Some(wait) = fail.retry_after() {
        value["retry_after_ms"] = json!(wait.as_millis() as u64);
    }
    value
}

fn coded(code: &str) -> Value {
    json!({ "what": { "clave": format!("danil.error.{code}") }, "detail": code })
}

/// La forma de `DanilConnectStatus` que el front ya pinta (`danil-account.ts`).
pub(crate) fn status_from(me: Option<&Value>, persisted: bool) -> Value {
    let Some(me) = me else {
        return json!({ "state": "connected", "online": false, "storage": storage(persisted) });
    };
    // `me` puede venir plano (`{id, name, …}`) o con `user` (borrador); se tolera.
    let user = if me["user"].is_object() {
        &me["user"]
    } else {
        me
    };
    let text = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    json!({
        "state": "connected",
        "online": true,
        "account": text(&user["id"]),
        "email": text(&user["email"]),
        "account_name": text(&user["name"]),
        "storage": storage(persisted),
    })
}

fn storage(persisted: bool) -> &'static str {
    if persisted {
        "keychain"
    } else {
        "memory"
    }
}

fn announce(app: &tauri::AppHandle, value: &Value) {
    let _ = app.emit("danil-connect", value.clone());
}

/// El Bearer vigente, para otros módulos de la ventana que llaman al borde.
#[allow(dead_code)]
pub(crate) fn bearer(app: &tauri::AppHandle) -> Result<(String, String), Value> {
    let d = desk(app);
    let live = d.access().map_err(|f| error(&f))?;
    Ok((d.edge().to_owned(), live.access_token))
}

#[tauri::command(async)]
pub(super) fn danil_session_status(app: tauri::AppHandle) -> Value {
    desk(&app).status()
}

/// Abre el navegador del sistema en `identity`, espera la vuelta por loopback y
/// canjea el código. `name` (el de la computadora) ya no se usa: se acepta para
/// no romper al front que lo manda.
#[tauri::command(async)]
pub(super) fn danil_sign_in(app: tauri::AppHandle, name: Option<String>) -> Result<Value, Value> {
    let _ = name;
    let d = desk(&app);
    let attempt = d.begin_sign_in();
    if d.capabilities()
        .announces(session::capability_of("/v1/identity/desk/authorize"))
        == Some(false)
    {
        return Err(coded("not_available_yet"));
    }
    let pkce = pkce::Pkce::open().ok_or_else(|| coded("unavailable"))?;
    let redirect_uri = pkce.redirect_uri();
    let url = d.authorize_url(&pkce.challenge, &pkce.state, &redirect_uri);
    super::env::open_external(url).map_err(|_| coded("browser"))?;
    let deadline = Instant::now() + LOGIN_WAIT;
    let code = loop {
        if !d.is_signing_in(attempt) {
            return Err(coded("cancelled"));
        }
        if Instant::now() > deadline {
            return Err(coded("timeout"));
        }
        match pkce.poll().map_err(|_| coded("unavailable"))? {
            Some(pkce::Returned::Code(code)) => break code,
            Some(pkce::Returned::Denied(_)) => return Err(coded("access_denied")),
            None => std::thread::sleep(Duration::from_millis(200)),
        }
    };
    let verifier = pkce.verifier.clone();
    drop(pkce);
    let live = d
        .exchange(attempt, &code, &verifier, &redirect_uri)
        .map_err(|f| error(&f))?;
    // La sesión de antes (WorkOS a Supabase) no convive con la nueva.
    super::agents_session::retire_legacy(&app);
    let value = d.status();
    d.publish_if_current(live.generation, || announce(&app, &value));
    Ok(value)
}

/// Cierra la sesión de esta instalación en `identity` y la borra del llavero.
#[tauri::command(async)]
pub(super) fn danil_sign_out(app: tauri::AppHandle) -> Result<Value, Value> {
    let d = desk(&app);
    let signed_out = d.sign_out();
    super::agents_session::retire_legacy(&app);
    // La cuenta del motor tampoco queda conectada; un motor sin la orden no impide salir.
    let _ = super::proxy::engine_call(&app, "danil_disconnect", json!({}));
    let value = disconnected();
    if let Some(generation) = signed_out {
        d.publish_if_current(generation, || announce(&app, &value));
    }
    Ok(value)
}

/// Una llamada al borde con el Bearer de Desk, solo a la lista cerrada de
/// `session::allowed`. Contesta `{status, body, location?, idempotency_key,
/// retry_after_ms?}` con el status del borde tal cual: un 404 o un 501 no es un
/// error de sesión, y el front reintenta solo. `Err` solo sin sesión, con una
/// ruta fuera de la lista o sin red.
#[tauri::command(async)]
pub(super) fn danil_edge_fetch(
    app: tauri::AppHandle,
    method: String,
    path: String,
    body: Option<Value>,
    idempotency_key: Option<String>,
) -> Result<Value, Value> {
    let method = method.to_ascii_uppercase();
    if !session::allowed(&method, &path) {
        return Err(coded("invalid_request"));
    }
    let key = match idempotency_key {
        Some(k) if (1..=128).contains(&k.len()) && k.bytes().all(|b| b.is_ascii_graphic()) => k,
        Some(_) => return Err(coded("invalid_request")),
        None => pkce::random(18).ok_or_else(|| coded("unavailable"))?,
    };
    edge_fetch(desk(&app), &method, &path, body.as_ref(), &key)
}

fn edge_fetch<V: Vault>(
    desk: &Desk<V>,
    method: &str,
    path: &str,
    body: Option<&Value>,
    key: &str,
) -> Result<Value, Value> {
    desk.fetch(method, path, body, key)
        .map(|reply| edge_reply(method, &reply, key))
        .map_err(|fail| error(&fail))
}

pub(crate) fn edge_reply(method: &str, reply: &session::Reply, key: &str) -> Value {
    let mut value = json!({ "status": reply.status, "body": reply.body });
    if let Some(location) = &reply.location {
        value["location"] = json!(location);
    }
    if method == "POST" {
        value["idempotency_key"] = json!(key);
    }
    if let Some(wait) = reply.retry_after {
        value["retry_after_ms"] = json!(wait.as_millis() as u64);
    }
    value
}
