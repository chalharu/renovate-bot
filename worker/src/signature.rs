use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

const GITHUB_SHA256_PREFIX: &str = "sha256=";

pub fn verify_github_signature(secret: &str, body: &[u8], signature_header: Option<&str>) -> bool {
    let Some(signature_header) = signature_header else {
        return false;
    };
    let Some(signature_hex) = signature_header.strip_prefix(GITHUB_SHA256_PREFIX) else {
        return false;
    };
    let Ok(signature_bytes) = hex::decode(signature_hex) else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };

    mac.update(body);
    mac.verify_slice(&signature_bytes).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_valid_signature() {
        let signature = "sha256=b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4";

        assert!(verify_github_signature(
            "secret",
            b"payload",
            Some(signature)
        ));
    }

    #[test]
    fn rejects_invalid_signature() {
        assert!(!verify_github_signature(
            "secret",
            b"payload",
            Some("sha256=0000000000000000000000000000000000000000000000000000000000000000")
        ));
        assert!(!verify_github_signature("secret", b"payload", None));
        assert!(!verify_github_signature(
            "secret",
            b"payload",
            Some("sha1=abc")
        ));
        assert!(!verify_github_signature(
            "secret",
            b"payload",
            Some("sha256=not-hex")
        ));
    }
}
