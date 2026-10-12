#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn native_keyring_roundtrip() {
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Cleanup {
        service: String,
        account: String,
    }
    impl Cleanup {
        fn entry(&self) -> keyring::Entry {
            keyring::Entry::new(&self.service, &self.account)
                .expect("Required native credential backend is unavailable")
        }
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            if let Ok(entry) = keyring::Entry::new(&self.service, &self.account) {
                let _ = entry.delete_credential();
            }
        }
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let identity = Cleanup {
        service: format!("com.hee10k.tajagi.TEST-ONLY.{}.{nonce}", std::process::id()),
        account: format!("TEST-ONLY-provider-{nonce}"),
    };

    assert!(matches!(
        identity.entry().get_password(),
        Err(keyring::Error::NoEntry)
    ));
    identity
        .entry()
        .set_password("test-only-first-value")
        .expect("Native set failed");
    assert_eq!(
        identity
            .entry()
            .get_password()
            .expect("Fresh native read failed"),
        "test-only-first-value"
    );
    identity
        .entry()
        .set_password("test-only-overwritten-value")
        .expect("Native overwrite failed");
    assert_eq!(
        identity
            .entry()
            .get_password()
            .expect("Fresh overwrite read failed"),
        "test-only-overwritten-value"
    );
    identity
        .entry()
        .delete_credential()
        .expect("Native delete failed");
    assert!(matches!(
        identity.entry().get_password(),
        Err(keyring::Error::NoEntry)
    ));
}
