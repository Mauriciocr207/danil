use super::*;

#[test]
fn expired_family_is_removed_after_forced_refresh_fails_on_a_non_identity_route() {
    for refresh_status in [400, 401, 403] {
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
                json!({"items":[{"session_id":"family_a","contexts":[{"context_id":"context_new","org":"org_new"}]}]}),
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
    let (edge, seen) = serve(Arc::new(|req, _| match req.path.as_str() {
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
    assert_eq!(count(&seen, "/v1/identity/sessions"), 2);
    assert_eq!(
        seen.lock()
            .unwrap()
            .iter()
            .filter(|r| r.path == "/v1/identity/desk/refresh"
                && r.body["refresh_token"] == "refresh_family_a")
            .count(),
        2
    );
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
        .fetch(
            "GET",
            "/v1/machines/machine_a",
            None,
            "key",
            Some("context_a"),
        )
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
        ("", Some("unknown")),
        ("Uppercase", Some("unknown")),
        ("bad-value", Some("unknown")),
        ("á", Some("unknown")),
        (
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            Some("unknown"),
        ),
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

#[test]
fn sessions_401_refreshes_once_and_a_successful_retry_keeps_the_family() {
    let vault = VaultSet::default();
    catalog(&vault);
    let (edge, seen) = serve(Arc::new(|req, n| match req.path.as_str() {
        "/v1/identity/desk/refresh" => (200, refresh_for(req)),
        "/v1/capabilities" => (404, Value::Null),
        "/v1/identity/me" => (200, json!({"id":"person","__echo":req.context})),
        "/v1/identity/sessions" if n == 0 => (401, json!({"code":"session_expired"})),
        "/v1/identity/sessions" => {
            let a = req.authorization.as_deref() == Some("Bearer access_family_a");
            (
                200,
                json!({"items":[{"session_id":if a {"family_a"} else {"family_b"},"contexts":[]}]}),
            )
        }
        _ => (404, Value::Null),
    }));
    let families = Families::new(edge, vault.clone(), || {});
    assert_eq!(families.status()["sessions"].as_array().unwrap().len(), 2);
    assert!(vault.family("family_a").load().is_some());
    assert!(vault.index().unwrap().contains("family_a"));
    assert_eq!(
        seen.lock()
            .unwrap()
            .iter()
            .filter(|r| r.path == "/v1/identity/desk/refresh"
                && r.body["refresh_token"] == "refresh_family_a")
            .count(),
        2
    );
}

#[test]
fn transient_refresh_failure_after_expiry_preserves_family_and_returns_error() {
    for refresh_status in [503, 0] {
        let vault = VaultSet::default();
        catalog(&vault);
        let (edge, _) = serve(Arc::new(move |req, n| match req.path.as_str() {
            "/v1/identity/desk/refresh" if n > 0 => (refresh_status, Value::Null),
            "/v1/identity/desk/refresh" => (200, refresh_for(req)),
            _ => (401, json!({"code":"session_expired"})),
        }));
        let families = Families::new(edge, vault.clone(), || {});
        let error = families
            .fetch("GET", "/v1/workspaces", None, "key", Some("context_a"))
            .unwrap_err();
        assert!(matches!(error, Fail::Unavailable { .. }));
        assert!(vault.family("family_a").load().is_some());
        assert!(vault.index().unwrap().contains("family_a"));
        assert!(vault.family("family_b").load().is_some());
    }
}

#[test]
fn expiry_with_successful_refresh_retries_once_and_only_repeated_expiry_retires() {
    for after_refresh in [200, 401] {
        let vault = VaultSet::default();
        catalog(&vault);
        let (edge, seen) = serve(Arc::new(move |req, n| match req.path.as_str() {
            "/v1/identity/desk/refresh" => (200, refresh_for(req)),
            _ if n == 0 || after_refresh == 401 => (401, json!({"code":"session_expired"})),
            _ => (200, json!({"__echo":req.context,"items":[]})),
        }));
        let families = Families::new(edge, vault.clone(), || {});
        let result = families.fetch("GET", "/v1/workspaces", None, "key", Some("context_a"));
        assert_eq!(count(&seen, "/v1/workspaces"), 2);
        if after_refresh == 200 {
            assert_eq!(result.unwrap().status, 200);
            assert!(vault.family("family_a").load().is_some());
        } else {
            assert_eq!(result.unwrap_err(), Fail::NoSession);
            assert!(vault.family("family_a").load().is_none());
            assert!(!vault.index().unwrap().contains("family_a"));
        }
        assert!(vault.family("family_b").load().is_some());
    }
}

#[test]
fn a_resource_denial_or_missing_context_cannot_remove_a_context_still_in_identity() {
    for status in [403, 401] {
        let vault = VaultSet::default();
        catalog(&vault);
        let changes = Arc::new(AtomicUsize::new(0));
        let notified = changes.clone();
        let (edge, _) = serve(Arc::new(move |req, _| match req.path.as_str() {
            "/v1/identity/desk/refresh" => (200, refresh_for(req)),
            "/v1/identity/sessions" => (
                200,
                json!({"items":[{"session_id":"family_a","contexts":[{"context_id":"context_a","org":"org_a"}]}]}),
            ),
            _ => (
                status,
                json!({"code":if status == 403 {"organization_access_denied"} else {"session_not_in_set"}}),
            ),
        }));
        let families = Families::new(edge, vault.clone(), move || {
            notified.fetch_add(1, Ordering::SeqCst);
        });
        let reply = families
            .fetch(
                "GET",
                "/v1/machines/machine_a",
                None,
                "key",
                Some("context_a"),
            )
            .unwrap();
        assert_eq!(reply.status, status);
        let index: Value = serde_json::from_str(&vault.index().unwrap()).unwrap();
        assert_eq!(index["items"][0]["contexts"][0]["context_id"], "context_a");
        assert!(index["items"][0].get("retired_contexts").is_none());
        assert_eq!(changes.load(Ordering::SeqCst), 0);
        assert!(vault.family("family_a").load().is_some());
    }
}

#[test]
fn identity_can_restore_a_context_previously_hidden_by_a_legacy_tombstone() {
    let vault = VaultSet::default();
    catalog(&vault);
    let mut index: Value = serde_json::from_str(&vault.index().unwrap()).unwrap();
    index["items"][0]["contexts"] = json!([]);
    index["items"][0]["retired_contexts"] = json!(["context_a"]);
    vault.save_index(&index.to_string());
    let (edge, _) = serve(Arc::new(|req, _| match req.path.as_str() {
        "/v1/identity/desk/refresh" => (200, refresh_for(req)),
        "/v1/capabilities" => (404, Value::Null),
        "/v1/identity/me" => (200, json!({"id":"person","__echo":req.context})),
        "/v1/identity/sessions" => {
            let a = req.authorization.as_deref() == Some("Bearer access_family_a");
            (
                200,
                json!({"items":[{"session_id":if a {"family_a"} else {"family_b"},"contexts":[{"context_id":if a {"context_a"} else {"context_b"},"org":if a {"org_a"} else {"org_b"}}]}]}),
            )
        }
        _ => (404, Value::Null),
    }));
    let families = Families::new(edge, vault.clone(), || {});
    assert_eq!(
        families.status()["sessions"][0]["contexts"][0]["context_id"],
        "context_a"
    );
    assert!(!vault.index().unwrap().contains("retired_contexts"));
}

#[test]
fn a_different_401_after_expiry_refresh_does_not_destroy_an_identity_family() {
    let vault = VaultSet::default();
    catalog(&vault);
    let (edge, _) = serve(Arc::new(|req, n| match req.path.as_str() {
        "/v1/identity/desk/refresh" => (200, refresh_for(req)),
        _ if n == 0 => (401, json!({"code":"session_expired"})),
        _ => (401, json!({"code":"other_failure"})),
    }));
    let families = Families::new(edge, vault.clone(), || {});
    let reply = families
        .fetch(
            "GET",
            "/v1/identity/organizations",
            None,
            "key",
            Some("context_a"),
        )
        .unwrap();
    assert_eq!(reply.status, 401);
    assert!(vault.family("family_a").load().is_some());
    assert!(vault.index().unwrap().contains("family_a"));
}

#[test]
fn context_confirmation_network_does_not_hold_mutations_against_status() {
    let vault = VaultSet::default();
    catalog(&vault);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    let (edge, _) = serve(Arc::new(move |req, n| match req.path.as_str() {
        "/v1/identity/desk/refresh" => (200, refresh_for(req)),
        "/v1/capabilities" => (404, Value::Null),
        "/v1/identity/me" => (200, json!({"id":"person","__echo":req.context})),
        "/v1/machines/machine_a" => (403, json!({"code":"organization_access_denied"})),
        "/v1/identity/sessions" if n == 0 => {
            entered_tx.send(()).unwrap();
            release_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            (
                200,
                json!({"items":[{"session_id":"family_a","contexts":[]}]}),
            )
        }
        "/v1/identity/sessions" => {
            let a = req.authorization.as_deref() == Some("Bearer access_family_a");
            (
                200,
                json!({"items":[{"session_id":if a {"family_a"} else {"family_b"},"contexts":[{"context_id":if a {"context_a"} else {"context_b"},"org":if a {"org_a"} else {"org_b"}}]}]}),
            )
        }
        _ => (404, Value::Null),
    }));
    let families = Arc::new(Families::new(edge, vault, || {}));
    let actor = families.clone();
    let pending = std::thread::spawn(move || {
        actor.fetch(
            "GET",
            "/v1/machines/machine_a",
            None,
            "key",
            Some("context_a"),
        )
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let reader = std::thread::spawn(move || done_tx.send(families.status()).unwrap());
    let result = done_rx.recv_timeout(Duration::from_secs(2));
    release_tx.send(()).unwrap();
    pending.join().unwrap().unwrap();
    reader.join().unwrap();
    assert_eq!(result.unwrap()["sessions"].as_array().unwrap().len(), 2);
}
