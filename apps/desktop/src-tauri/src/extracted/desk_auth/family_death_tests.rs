use super::*;

#[test]
fn expired_family_is_removed_after_forced_refresh_fails_on_a_non_identity_route() {
    for refresh_status in [400, 503] {
        let vault = VaultSet::default();
        catalog(&vault);
        let changes = Arc::new(AtomicUsize::new(0));
        let notified = changes.clone();
        let (edge, _) = serve(Arc::new(move |req, n| match req.path.as_str() {
            "/v1/identity/desk/refresh"
                if n > 0 && req.body["refresh_token"] == "refresh_family_a" =>
            {
                (refresh_status, json!({"code":"invalid_grant"}))
            }
            "/v1/identity/desk/refresh" => (200, refresh_for(req)),
            _ if req.context.as_deref() == Some("context_a") => {
                (401, json!({"code":"session_expired","private":"discard"}))
            }
            _ => (200, json!({"__echo":req.context,"items":[]})),
        }));
        let families = Families::new(edge, vault.clone(), move || {
            notified.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(
            families
                .fetch("GET", "/v1/workspaces", None, "key", Some("context_a"))
                .unwrap_err(),
            Fail::NoSession
        );
        assert!(vault.family("family_a").load().is_none());
        assert!(!vault.index().unwrap().contains("family_a"));
        assert!(vault.family("family_b").load().is_some());
        assert!(families
            .fetch("GET", "/v1/workspaces", None, "key", Some("context_b"))
            .is_ok());
        assert!(changes.load(Ordering::SeqCst) > 0);
    }
}

#[test]
fn missing_context_only_removes_that_context_and_refreshes_its_family_list() {
    let vault = VaultSet::default();
    catalog(&vault);
    let (edge, seen) = serve(Arc::new(|req, _| match req.path.as_str() {
        "/v1/identity/desk/refresh" => (200, refresh_for(req)),
        "/v1/workspaces" if req.context.as_deref() == Some("context_a") => (
            401,
            json!({"code":"session_not_in_set","private":"discard"}),
        ),
        "/v1/identity/sessions" => {
            if req.authorization.as_deref() == Some("Bearer access_family_b") {
                return (
                    200,
                    json!({"items":[{"session_id":"family_b","contexts":[{"context_id":"context_b","org":"org_b"}]}]}),
                );
            }
            (
                200,
                json!({"items":[{"session_id":"family_a","contexts":[{"context_id":"context_a","org":"org_a"},{"context_id":"context_new","org":"org_new"}]}]}),
            )
        }
        _ => (200, json!({"__echo":req.context,"items":[]})),
    }));
    let families = Families::new(edge, vault.clone(), || {});
    let reply = families
        .fetch("GET", "/v1/workspaces", None, "key", Some("context_a"))
        .unwrap();
    assert_eq!(reply.status, 401);
    assert!(reply.body.is_null());
    assert!(vault.family("family_a").load().is_some());
    let index: Value = serde_json::from_str(&vault.index().unwrap()).unwrap();
    let contexts = index["items"][0]["contexts"].as_array().unwrap();
    assert_eq!(contexts.len(), 1);
    assert_eq!(contexts[0]["context_id"], "context_new");
    assert!(families
        .fetch("GET", "/v1/workspaces", None, "key", Some("context_new"))
        .is_ok());
    assert!(families
        .fetch("GET", "/v1/workspaces", None, "key", Some("context_b"))
        .is_ok());
    assert_eq!(count(&seen, "/v1/identity/sessions"), 1);
    let status = families.status();
    let family = status["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["family"] == "family_a")
        .unwrap();
    assert_eq!(family["contexts"].as_array().unwrap().len(), 1);
    assert_eq!(family["contexts"][0]["context_id"], "context_new");
    assert_eq!(
        seen.lock()
            .unwrap()
            .iter()
            .filter(|r| r.path == "/v1/identity/desk/refresh"
                && r.body["refresh_token"] == "refresh_family_a")
            .count(),
        1
    );
}

#[test]
fn missing_context_followed_by_unauthorized_sessions_retires_the_family() {
    let vault = VaultSet::default();
    catalog(&vault);
    let (edge, _) = serve(Arc::new(|req, _| match req.path.as_str() {
        "/v1/identity/desk/refresh" => (200, refresh_for(req)),
        "/v1/identity/sessions" => (401, json!({"code":"session_not_in_set"})),
        _ if req.context.as_deref() == Some("context_a") => {
            (401, json!({"code":"session_not_in_set"}))
        }
        _ => (200, json!({"__echo":req.context})),
    }));
    let families = Families::new(edge, vault.clone(), || {});
    families
        .fetch("GET", "/v1/workspaces", None, "key", Some("context_a"))
        .unwrap();
    assert!(vault.family("family_a").load().is_none());
    assert!(!vault.index().unwrap().contains("family_a"));
    assert!(families
        .fetch("GET", "/v1/workspaces", None, "key", Some("context_b"))
        .is_ok());
}

#[test]
fn denied_membership_reports_removed_context_once_without_revoking_the_family() {
    let vault = VaultSet::default();
    catalog(&vault);
    let changes = Arc::new(AtomicUsize::new(0));
    let notified = changes.clone();
    let (edge, _) = serve(Arc::new(|req, _| match req.path.as_str() {
        "/v1/identity/desk/refresh" => (200, refresh_for(req)),
        "/v1/capabilities" => (404, Value::Null),
        "/v1/identity/me" => (200, json!({"id":"person","__echo":req.context})),
        "/v1/identity/sessions"
            if req.authorization.as_deref() == Some("Bearer access_family_a") =>
        {
            (
                200,
                json!({"items":[{"session_id":"family_a","contexts":[]}]}),
            )
        }
        "/v1/identity/sessions" => (
            200,
            json!({"items":[{"session_id":"family_b","contexts":[{"context_id":"context_b","org":"org_b"}]}]}),
        ),
        _ if req.context.as_deref() == Some("context_a") => (
            403,
            json!({"code":"organization_access_denied","private":"discard"}),
        ),
        _ => (200, json!({"__echo":req.context})),
    }));
    let families = Families::new(edge, vault.clone(), move || {
        notified.fetch_add(1, Ordering::SeqCst);
    });
    let reply = families
        .fetch("GET", "/v1/workspaces", None, "key", Some("context_a"))
        .unwrap();
    assert_eq!(reply.status, 403);
    assert!(reply.body.is_null());
    assert!(vault.family("family_a").load().is_some());
    let status = families.status();
    assert_eq!(
        status["removed"],
        json!([{"context_id":"context_a","org":"org_a","reason":"organization_access_denied"}])
    );
    assert!(families.status().get("removed").is_none());
    assert!(changes.load(Ordering::SeqCst) > 0);
    assert!(families
        .fetch("GET", "/v1/workspaces", None, "key", Some("context_b"))
        .is_ok());
}

#[test]
fn empty_reason_header_is_normalized_before_reaching_the_webview() {
    for (raw, expected) in [
        (
            "organization_access_denied",
            Some("organization_access_denied"),
        ),
        ("no_organization", Some("no_organization")),
        ("no_workspace_access", Some("no_workspace_access")),
        ("future_reason", Some("unknown")),
        ("", None),
        ("Uppercase", None),
        ("bad-value", None),
    ] {
        let raw = raw.to_owned();
        let vault = VaultSet::default();
        catalog(&vault);
        let (edge, _) = serve(Arc::new(move |req, _| match req.path.as_str() {
            "/v1/identity/desk/refresh" => (200, refresh_for(req)),
            _ => (
                200,
                json!({"__echo":req.context,"__empty_reason":raw,"items":[]}),
            ),
        }));
        let families = Families::new(edge, vault, || {});
        let reply = families
            .fetch("GET", "/v1/workspaces", None, "key", Some("context_a"))
            .unwrap();
        let value = super::super::super::edge_reply("GET", &reply, "key");
        assert_eq!(value.get("empty_reason").and_then(Value::as_str), expected);
    }
}

#[test]
fn sessions_expose_only_normalized_empty_reasons_for_families_and_contexts() {
    let vault = VaultSet::default();
    catalog(&vault);
    let (edge, _) = serve(Arc::new(|req, _| match req.path.as_str() {
        "/v1/identity/desk/refresh" => (200, refresh_for(req)),
        "/v1/capabilities" => (404, Value::Null),
        "/v1/identity/me" => (200, json!({"id":"person","__echo":req.context})),
        "/v1/identity/sessions" => {
            let a = req.authorization.as_deref() == Some("Bearer access_family_a");
            (
                200,
                json!({"items":[{"session_id":if a {"family_a"} else {"family_b"},"empty_reason":if a {"no_workspace_access"} else {"future_reason"},"contexts":[{"context_id":if a {"context_a"} else {"context_b"},"org":if a {"org_a"} else {"org_b"},"empty_reason":if a {"no_organization"} else {"arbitrary_reason"}}]}]}),
            )
        }
        _ => (404, Value::Null),
    }));
    let families = Families::new(edge, vault, || {});
    let status = families.status();
    assert_eq!(status["sessions"][0]["empty_reason"], "no_workspace_access");
    assert_eq!(
        status["sessions"][0]["contexts"][0]["empty_reason"],
        "no_organization"
    );
    assert_eq!(status["sessions"][1]["empty_reason"], "unknown");
    assert_eq!(
        status["sessions"][1]["contexts"][0]["empty_reason"],
        "unknown"
    );
    assert!(!status.to_string().contains("future_reason"));
    assert!(!status.to_string().contains("arbitrary_reason"));
}

#[test]
fn native_sessions_and_context_creation_without_selectors_do_not_require_echo() {
    let vault = VaultSet::default();
    catalog(&vault);
    let (edge, _) = serve(Arc::new(|req, _| match req.path.as_str() {
        "/v1/identity/desk/refresh" => (200, refresh_for(req)),
        "/v1/identity/sessions" => (200, json!({"items":[]})),
        "/v1/identity/contexts" => (201, json!({"context_id":"new","org":"org"})),
        _ => (404, Value::Null),
    }));
    let desk = Desk::new(edge, vault.family("family_a"), || {});
    let sessions = desk
        .fetch("GET", "/v1/identity/sessions", None, "key")
        .unwrap();
    assert_eq!(sessions.body, json!({"items":[]}));
    let created = desk
        .fetch(
            "POST",
            "/v1/identity/contexts",
            Some(&json!({"organization":"org"})),
            "key",
        )
        .unwrap();
    assert_eq!(created.body["context_id"], "new");
}
