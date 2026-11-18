//! Familias independientes; el índice contiene solo metadatos públicos.
use super::session::{self, Desk, Fail, Reply, Vault};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

pub(super) trait FamilyVault: Vault + Clone + 'static {
    fn family(&self, id: &str) -> Self;
    fn index(&self) -> Option<String>;
    fn save_index(&self, index: &str) -> bool;
}

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Context {
    pub context_id: String,
    pub org: String,
    pub org_name: Option<String>,
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspaces: Option<String>,
}
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Metadata {
    family: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    available_contexts: Option<u64>,
    email: Option<String>,
    contexts: Vec<Context>,
}
#[derive(Default, Serialize, Deserialize)]
struct Index {
    version: u8,
    #[serde(default)]
    legacy_retired: bool,
    items: Vec<Metadata>,
    default_family: Option<String>,
    default_context: Option<String>,
}
struct Family<V: FamilyVault> {
    metadata: Metadata,
    desk: Arc<Desk<V>>,
}
struct Set<V: FamilyVault> {
    families: Vec<Family<V>>,
    default_family: Option<String>,
    default_context: Option<String>,
    attempt: u64,
    legacy_family: Option<String>,
}
pub(super) struct Families<V: FamilyVault> {
    edge: String,
    vault: V,
    set: Mutex<Set<V>>,
    mutations: Mutex<()>,
    changed: Arc<dyn Fn() + Send + Sync>,
}
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
fn refused(code: &str) -> Fail {
    Fail::Refused {
        status: 400,
        code: code.into(),
    }
}
impl<V: FamilyVault> Families<V> {
    pub fn new(edge: String, vault: V, changed: impl Fn() + Send + Sync + 'static) -> Self {
        let mut index = vault
            .index()
            .and_then(|s| serde_json::from_str::<Index>(&s).ok())
            .filter(|i| i.version == 1)
            .unwrap_or_default();
        let mut legacy_family = None;
        if !index.legacy_retired {
            if let Some(stored) = vault.load() {
                let id = index
                    .items
                    .iter()
                    .find(|m| m.session_id.as_deref() == Some(&stored.sid))
                    .map(|m| m.family.clone())
                    .unwrap_or_else(|| super::pkce::random(24).expect("OS randomness"));
                if index.items.is_empty() {
                    index.items.push(Metadata {
                        family: id.clone(),
                        session_id: Some(stored.sid.clone()),
                        ..Metadata::default()
                    });
                    index.default_family = Some(id.clone());
                }
                index.version = 1;
                index.legacy_retired = true;
                // El marcador evita resucitar el secreto anterior si falla su borrado.
                if vault.family(&id).save(&stored)
                    && vault.save_index(
                        &serde_json::to_string(&index).expect("public session metadata"),
                    )
                {
                    vault.clear();
                } else {
                    index.legacy_retired = false;
                    legacy_family = Some(id);
                }
            }
        }
        let changed: Arc<dyn Fn() + Send + Sync> = Arc::new(changed);
        let families = index
            .items
            .into_iter()
            .filter(|m| session::opaque_id(&m.family))
            .take(20)
            .map(|metadata| {
                let notify = changed.clone();
                let desk = Arc::new(Desk::new(
                    edge.clone(),
                    if legacy_family.as_ref() == Some(&metadata.family) {
                        vault.clone()
                    } else {
                        vault.family(&metadata.family)
                    },
                    move || notify(),
                ));
                Family { metadata, desk }
            })
            .collect();
        Self {
            edge,
            vault,
            set: Mutex::new(Set {
                families,
                default_family: index.default_family,
                default_context: index.default_context,
                attempt: 0,
                legacy_family,
            }),
            changed,
            mutations: Mutex::new(()),
        }
    }
    fn persist(&self, set: &Set<V>) {
        let index = Index {
            version: 1,
            legacy_retired: set.legacy_family.is_none(),
            items: set.families.iter().map(|f| f.metadata.clone()).collect(),
            default_family: set.default_family.clone(),
            default_context: set.default_context.clone(),
        };
        self.vault
            .save_index(&serde_json::to_string(&index).expect("public session metadata"));
    }
    fn selected(&self, family: Option<&str>, context: Option<&str>) -> Result<Arc<Desk<V>>, Fail> {
        let set = lock(&self.set);
        let found = if let Some(context) = context {
            let mut owners = set
                .families
                .iter()
                .filter(|f| f.metadata.contexts.iter().any(|c| c.context_id == context));
            let first = owners.next();
            if owners.next().is_some() {
                return Err(refused("session_not_in_set"));
            }
            first
        } else {
            let id = family.or(set.default_family.as_deref());
            set.families
                .iter()
                .find(|f| Some(f.metadata.family.as_str()) == id)
        };
        found
            .map(|f| f.desk.clone())
            .ok_or_else(|| refused("session_not_in_set"))
    }
    pub fn access(&self) -> Result<session::Live, Fail> {
        self.selected(None, None)?.access()
    }
    pub fn edge(&self) -> &str {
        &self.edge
    }
    pub fn begin_sign_in(&self) -> u64 {
        let mut set = lock(&self.set);
        set.attempt += 1;
        set.attempt
    }
    pub fn is_signing_in(&self, attempt: u64) -> bool {
        lock(&self.set).attempt == attempt
    }
    pub fn authorize_url(&self, challenge: &str, state: &str, redirect: &str, add: bool) -> String {
        let temp = Desk::new(&self.edge, self.vault.clone(), || {});
        let mut url = temp.authorize_url(challenge, state, redirect);
        if add {
            url.push_str("&mode=add");
        }
        url
    }
    pub fn prepare_authorize(&self, url: String, add: bool) -> (String, bool) {
        if add
            && session::request(&url, "GET", None, None)
                .is_ok_and(|r| matches!(r.status, 404 | 501))
        {
            return (
                url.strip_suffix("&mode=add").unwrap_or(&url).to_owned(),
                false,
            );
        }
        (url, add)
    }
    pub fn capabilities(&self) -> session::Capabilities {
        Desk::new(&self.edge, self.vault.clone(), || {}).capabilities()
    }
    pub fn exchange(
        &self,
        attempt: u64,
        code: &str,
        verifier: &str,
        redirect: &str,
        add: bool,
    ) -> Result<(), Fail> {
        let reply = session::request(
            &format!("{}/v1/identity/desk/token", self.edge),
            "POST",
            None,
            Some(
                &json!({"grant_type":"authorization_code", "code":code, "code_verifier":verifier,
                "redirect_uri":redirect, "client_id":session::CLIENT_ID}),
            ),
        )?;
        if reply.status != 200 {
            return Err(session::failure(&reply, "invalid_grant"));
        }
        let issued = session::tokens(&reply.body).ok_or_else(|| refused("invalid_response"))?;
        let server_id = reply.body["session_id"]
            .as_str()
            .unwrap_or(&issued.3)
            .to_owned();
        if !session::opaque_id(&server_id) {
            return Err(refused("invalid_response"));
        }
        let id = super::pkce::random(24).ok_or_else(|| refused("unavailable"))?;
        let mut contexts: Vec<Context> = match reply.body.get("contexts") {
            Some(value) => {
                serde_json::from_value(value.clone()).map_err(|_| refused("invalid_response"))?
            }
            None => Vec::new(),
        };
        if contexts.len() > 20
            || contexts
                .iter()
                .any(|c| !session::opaque_id(&c.context_id) || !session::opaque_id(&c.org))
        {
            return Err(refused("invalid_response"));
        }
        for context in &mut contexts {
            if !matches!(context.workspaces.as_deref(), Some("all" | "later")) {
                context.workspaces = None;
            }
        }
        let _mutation = lock(&self.mutations);
        let mut set = lock(&self.set);
        if set.attempt != attempt {
            return Err(refused("cancelled"));
        }
        if add && set.families.len() >= 20 && !set.families.iter().any(|f| f.metadata.family == id)
        {
            return Err(refused("too_many_sessions"));
        }
        if !add {
            for f in &set.families {
                f.desk.sign_out();
            }
            set.families.clear();
            set.legacy_family = None;
            set.default_context = None;
        }
        if let Some(old) = set.families.iter().find(|f| f.metadata.family == id) {
            old.desk.forget();
        }
        if set.legacy_family.as_ref() == Some(&id) {
            set.legacy_family = None;
            self.vault.clear();
        }
        let notify = self.changed.clone();
        let desk = Arc::new(Desk::new(&self.edge, self.vault.family(&id), move || {
            notify()
        }));
        desk.install(issued);
        let profile = desk.status();
        set.families.retain(|f| f.metadata.family != id);
        set.families.push(Family {
            metadata: Metadata {
                family: id.clone(),
                session_id: Some(server_id),
                sub: profile["account"].as_str().map(str::to_owned),
                email: profile["email"].as_str().map(str::to_owned),
                contexts,
                available_contexts: reply.body["available_contexts"].as_u64(),
            },
            desk,
        });
        if !add || set.default_family.is_none() {
            set.default_family = Some(id);
        }
        self.prune_duplicates(&mut set);
        self.persist(&set);
        drop(set);
        (self.changed)();
        Ok(())
    }
    pub fn status(&self) -> Value {
        let _mutation = lock(&self.mutations);
        let before = {
            let set = lock(&self.set);
            (
                set.families
                    .iter()
                    .map(|f| f.metadata.clone())
                    .collect::<Vec<_>>(),
                set.default_context.clone(),
            )
        };
        let snapshot: Vec<_> = lock(&self.set)
            .families
            .iter()
            .map(|f| (f.metadata.clone(), f.desk.clone()))
            .collect();
        let mut value = super::disconnected();
        let mut supported = Vec::new();
        let mut fallback = None;
        let mut lost = Vec::new();
        for (metadata, desk) in snapshot {
            let id = metadata.family.clone();
            let state = desk.status();
            if state["state"] == "disconnected" {
                lost.push((id, desk));
                continue;
            }
            fallback.get_or_insert_with(|| json!({"state":"connected", "online":state["online"], "storage":state["storage"]}));
            if lock(&self.set).default_family.as_ref() == Some(&id) {
                value = state.clone();
            }
            if let Ok(reply) = desk.fetch("GET", "/v1/identity/sessions", None, "") {
                if reply.status == 200 {
                    if let Some(items) = reply.body["items"].as_array() {
                        // El portador solo puede describir su propia familia.
                        if let Some(item) = items
                            .iter()
                            .find(|i| {
                                i["session_id"].as_str()
                                    == metadata.session_id.as_deref().or(Some(id.as_str()))
                            })
                            .or_else(|| (items.len() == 1).then(|| &items[0]))
                        {
                            if !item["session_id"].as_str().is_some_and(session::opaque_id) {
                                continue;
                            }
                            if let Some(contexts) = item["contexts"]
                                .as_array()
                                .and_then(|c| serde_json::from_value::<Vec<Context>>(json!(c)).ok())
                            {
                                let contexts: Vec<_> = contexts
                                    .into_iter()
                                    .filter(|c| {
                                        session::opaque_id(&c.context_id)
                                            && session::opaque_id(&c.org)
                                    })
                                    .take(20)
                                    .collect();
                                if let Some(first) = contexts.first() {
                                    if desk
                                        .fetch_context(
                                            "GET",
                                            "/v1/identity/me",
                                            None,
                                            "",
                                            Some(&first.context_id),
                                        )
                                        .is_err()
                                    {
                                        continue;
                                    }
                                }
                                let mut set = lock(&self.set);
                                if let Some(f) = set.families.iter_mut().find(|f| {
                                    f.metadata.family == id && Arc::ptr_eq(&f.desk, &desk)
                                }) {
                                    f.metadata.session_id = item["session_id"]
                                        .as_str()
                                        .filter(|s| session::opaque_id(s))
                                        .map(str::to_owned);
                                    f.metadata.email = item["email"]
                                        .as_str()
                                        .or(state["email"].as_str())
                                        .map(str::to_owned);
                                    f.metadata.sub = state["account"]
                                        .as_str()
                                        .map(str::to_owned)
                                        .or(f.metadata.sub.clone());
                                    f.metadata.available_contexts =
                                        desk.available_contexts().or(f.metadata.available_contexts);
                                    // Las listas viejas no traen la elección sellada en el canje.
                                    f.metadata.contexts = contexts
                                        .into_iter()
                                        .map(|mut c| {
                                            if c.workspaces.is_none() {
                                                c.workspaces = f
                                                    .metadata
                                                    .contexts
                                                    .iter()
                                                    .find(|old| old.context_id == c.context_id)
                                                    .and_then(|old| old.workspaces.clone());
                                            }
                                            c
                                        })
                                        .collect();
                                    supported.push(id.clone());
                                }
                                if set.default_family.as_ref() == Some(&id) {
                                    set.default_context = reply.body["default_context"]
                                        .as_str()
                                        .map(str::to_owned)
                                        .filter(|c| {
                                            set.families.iter().any(|f| {
                                                f.metadata.family == id
                                                    && f.metadata
                                                        .contexts
                                                        .iter()
                                                        .any(|x| &x.context_id == c)
                                            })
                                        });
                                }
                                self.persist(&set);
                            }
                        }
                    }
                }
            }
        }
        let mut set = lock(&self.set);
        if !lost.is_empty() {
            if set
                .legacy_family
                .as_ref()
                .is_some_and(|legacy| lost.iter().any(|(id, _)| id == legacy))
            {
                set.legacy_family = None;
            }
            set.families.retain(|f| {
                !lost
                    .iter()
                    .any(|(id, desk)| &f.metadata.family == id && Arc::ptr_eq(&f.desk, desk))
            });
            self.persist(&set);
        }
        self.prune_duplicates(&mut set);
        if set
            .default_family
            .as_ref()
            .is_some_and(|id| !set.families.iter().any(|f| &f.metadata.family == id))
        {
            set.default_family = None;
            set.default_context = None;
        }
        if !set.families.is_empty() && value["state"] == "disconnected" {
            if let Some(connected) = fallback {
                value = connected;
            }
        }
        self.persist(&set);
        if !set.families.is_empty() && supported.len() == set.families.len() {
            value["sessions"] = json!(set
                .families
                .iter()
                .map(|f| {
                    let mut value = json!({"family":f.metadata.family,"email":f.metadata.email,"contexts":f.metadata.contexts});
                    if let Some(count) = f.metadata.available_contexts { value["available_contexts"] = json!(count); }
                    value
                })
                .collect::<Vec<_>>());
            value["default_context"] = json!(set.default_context);
        }
        let after = (
            set.families
                .iter()
                .map(|f| f.metadata.clone())
                .collect::<Vec<_>>(),
            set.default_context.clone(),
        );
        drop(set);
        if before != after {
            (self.changed)();
        }
        value
    }
    pub fn fetch(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        key: &str,
        context: Option<&str>,
    ) -> Result<Reply, Fail> {
        if context.is_some_and(|c| !session::opaque_id(c)) {
            return Err(refused("session_not_in_set"));
        }
        let default = lock(&self.set).default_context.clone();
        let desk = self.selected(None, context.or(default.as_deref()))?;
        // Sin selector explícito se conserva el contrato del cliente viejo, sin exigir eco.
        desk.fetch_scoped(
            method,
            path,
            body,
            key,
            context.or(default.as_deref()),
            context.is_some(),
        )
    }
    fn prune_duplicates(&self, set: &mut Set<V>) {
        for newer in (0..set.families.len()).rev() {
            let newest = set.families[newer].metadata.clone();
            for older in 0..newer {
                let old = &mut set.families[older];
                if !same_person(&newest, &old.metadata) {
                    continue;
                }
                let duplicate_ids: Vec<_> = old
                    .metadata
                    .contexts
                    .iter()
                    .filter(|c| newest.contexts.iter().any(|n| n.org == c.org))
                    .map(|c| c.context_id.clone())
                    .collect();
                for id in duplicate_ids {
                    let Some(key) = super::pkce::random(18) else {
                        continue;
                    };
                    if old
                        .desk
                        .fetch(
                            "POST",
                            &format!("/v1/identity/contexts/{id}/logout"),
                            None,
                            &key,
                        )
                        .is_ok_and(|reply| matches!(reply.status, 200..=299 | 404))
                    {
                        old.metadata.contexts.retain(|c| c.context_id != id);
                        if set.default_context.as_ref() == Some(&id) {
                            set.default_context = None;
                            set.default_family = None;
                        }
                    }
                }
            }
        }
    }
    pub fn sign_out(
        &self,
        family: Option<&str>,
        context: Option<&str>,
        key: &str,
    ) -> Result<(), Fail> {
        let _mutation = lock(&self.mutations);
        if let Some(context) = context {
            if !session::opaque_id(context) {
                return Err(refused("session_not_in_set"));
            }
            let Ok(desk) = self.selected(None, Some(context)) else {
                return Ok(());
            };
            let reply = desk.fetch(
                "POST",
                &format!("/v1/identity/contexts/{context}/logout"),
                None,
                key,
            )?;
            if !matches!(reply.status, 200..=299 | 404) {
                return Err(session::failure(&reply, "request_failed"));
            }
            let mut set = lock(&self.set);
            for f in &mut set.families {
                f.metadata.contexts.retain(|c| c.context_id != context);
            }
            if set.default_context.as_deref() == Some(context) {
                set.default_context = None;
                set.default_family = None;
            }
            self.persist(&set);
        } else if let Some(id) = family {
            if !session::opaque_id(id) {
                return Err(refused("session_not_in_set"));
            }
            let mut set = lock(&self.set);
            let Some(anchor) = set
                .families
                .iter()
                .find(|f| f.metadata.family == id)
                .map(|f| f.metadata.clone())
            else {
                return Ok(());
            };
            let ids: Vec<_> = set
                .families
                .iter()
                .filter(|f| same_person(&anchor, &f.metadata) || f.metadata.family == id)
                .map(|f| f.metadata.family.clone())
                .collect();
            let mut failure = None;
            for local in ids {
                let Some(f) = set.families.iter().find(|f| f.metadata.family == local) else {
                    continue;
                };
                let server_id = f
                    .metadata
                    .session_id
                    .as_deref()
                    .unwrap_or(&f.metadata.family);
                let reply = f.desk.fetch(
                    "POST",
                    &format!("/v1/identity/sessions/{server_id}/logout"),
                    None,
                    &format!("{key}-{local}"),
                );
                match reply {
                    Ok(reply) if matches!(reply.status, 200..=299 | 404) => {}
                    Ok(reply) => {
                        failure = Some(session::failure(&reply, "request_failed"));
                        continue;
                    }
                    Err(Fail::NoSession) => {}
                    Err(error) => {
                        failure = Some(error);
                        continue;
                    }
                }
                f.desk.forget();
                set.families.retain(|f| f.metadata.family != local);
                if set.legacy_family.as_ref() == Some(&local) {
                    set.legacy_family = None;
                }
                if set.default_family.as_ref() == Some(&local) {
                    set.default_family = None;
                    set.default_context = None;
                }
            }
            self.persist(&set);
            if let Some(error) = failure {
                drop(set);
                (self.changed)();
                return Err(error);
            }
        } else {
            let mut set = lock(&self.set);
            set.attempt += 1;
            for f in &set.families {
                f.desk.sign_out();
            }
            set.families.clear();
            set.legacy_family = None;
            set.default_family = None;
            set.default_context = None;
            self.vault.clear();
            self.persist(&set);
        }
        (self.changed)();
        Ok(())
    }
}

fn same_person(a: &Metadata, b: &Metadata) -> bool {
    match (&a.sub, &b.sub) {
        (Some(a), Some(b)) => a == b,
        _ => a
            .email
            .as_ref()
            .zip(b.email.as_ref())
            .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b)),
    }
}
