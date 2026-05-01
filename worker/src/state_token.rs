use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingStateTokenClaims {
    pub repository_full_name: String,
    pub pr_number: u64,
    pub head_sha: String,
    pub version_created_at: DateTime<Utc>,
    pub iat: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingStateTokenError {
    InvalidFormat,
    InvalidHeader,
    InvalidSignature,
    InvalidClaims,
    Serialization(String),
}

impl std::fmt::Display for PendingStateTokenError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidFormat => write!(formatter, "invalid pending state token format"),
            Self::InvalidHeader => write!(formatter, "invalid pending state token header"),
            Self::InvalidSignature => write!(formatter, "invalid pending state token signature"),
            Self::InvalidClaims => write!(formatter, "invalid pending state token claims"),
            Self::Serialization(error) => {
                write!(
                    formatter,
                    "failed to serialize pending state token: {error}"
                )
            }
        }
    }
}

impl std::error::Error for PendingStateTokenError {}

#[derive(Debug, Serialize, Deserialize)]
struct PendingStateTokenHeader {
    alg: String,
    typ: String,
}

pub fn encode_pending_state_token(
    secret: &str,
    claims: &PendingStateTokenClaims,
) -> Result<String, PendingStateTokenError> {
    let header = PendingStateTokenHeader {
        alg: "HS256".to_string(),
        typ: "JWT".to_string(),
    };
    let signing_input = format!("{}.{}", encode_json(&header)?, encode_json(claims)?);
    let signature = sign(secret, signing_input.as_bytes())?;

    Ok(format!(
        "{}.{}",
        signing_input,
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

pub fn decode_pending_state_token(
    secret: &str,
    token: &str,
) -> Result<PendingStateTokenClaims, PendingStateTokenError> {
    let mut segments = token.split('.');
    let Some(header_segment) = segments.next() else {
        return Err(PendingStateTokenError::InvalidFormat);
    };
    let Some(claims_segment) = segments.next() else {
        return Err(PendingStateTokenError::InvalidFormat);
    };
    let Some(signature_segment) = segments.next() else {
        return Err(PendingStateTokenError::InvalidFormat);
    };
    if segments.next().is_some() {
        return Err(PendingStateTokenError::InvalidFormat);
    }

    let header: PendingStateTokenHeader =
        decode_json(header_segment).map_err(|_| PendingStateTokenError::InvalidHeader)?;
    if header.alg != "HS256" || header.typ != "JWT" {
        return Err(PendingStateTokenError::InvalidHeader);
    }

    let signature = URL_SAFE_NO_PAD
        .decode(signature_segment)
        .map_err(|_| PendingStateTokenError::InvalidSignature)?;
    let signing_input = format!("{header_segment}.{claims_segment}");
    verify(secret, signing_input.as_bytes(), &signature)?;

    decode_json(claims_segment).map_err(|_| PendingStateTokenError::InvalidClaims)
}

pub fn normalize_shared_secret(secret: &str) -> String {
    let normalized_line_endings = secret.replace("\r\n", "\n");
    if normalized_line_endings.contains("\\n") && !normalized_line_endings.contains('\n') {
        normalized_line_endings.replace("\\n", "\n")
    } else {
        normalized_line_endings
    }
}

fn encode_json<T: Serialize>(value: &T) -> Result<String, PendingStateTokenError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| PendingStateTokenError::Serialization(error.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn decode_json<T: for<'de> Deserialize<'de>>(value: &str) -> Result<T, PendingStateTokenError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| PendingStateTokenError::InvalidFormat)?;
    serde_json::from_slice(&bytes).map_err(|_| PendingStateTokenError::InvalidFormat)
}

fn sign(secret: &str, payload: &[u8]) -> Result<Vec<u8>, PendingStateTokenError> {
    let normalized_secret = normalize_shared_secret(secret);
    let Ok(mut mac) = HmacSha256::new_from_slice(normalized_secret.as_bytes()) else {
        return Err(PendingStateTokenError::InvalidSignature);
    };
    mac.update(payload);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn verify(secret: &str, payload: &[u8], signature: &[u8]) -> Result<(), PendingStateTokenError> {
    let normalized_secret = normalize_shared_secret(secret);
    let Ok(mut mac) = HmacSha256::new_from_slice(normalized_secret.as_bytes()) else {
        return Err(PendingStateTokenError::InvalidSignature);
    };
    mac.update(payload);
    mac.verify_slice(signature)
        .map_err(|_| PendingStateTokenError::InvalidSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn claims() -> PendingStateTokenClaims {
        PendingStateTokenClaims {
            repository_full_name: "owner/repo".to_string(),
            pr_number: 42,
            head_sha: "abc123".to_string(),
            version_created_at: Utc.with_ymd_and_hms(2026, 4, 28, 12, 0, 0).unwrap(),
            iat: 1_777_777_777,
        }
    }

    #[test]
    fn round_trips_pending_state_tokens() {
        let token = encode_pending_state_token("secret", &claims()).unwrap();

        assert_eq!(
            decode_pending_state_token("secret", &token).unwrap(),
            claims()
        );
    }

    #[test]
    fn rejects_tampered_pending_state_tokens() {
        let token = encode_pending_state_token("secret", &claims()).unwrap();
        let mut tampered = token;
        tampered.push('x');

        assert_eq!(
            decode_pending_state_token("secret", &tampered),
            Err(PendingStateTokenError::InvalidSignature)
        );
    }

    #[test]
    fn normalizes_multiline_shared_secrets() {
        let token = encode_pending_state_token("line-1\nline-2", &claims()).unwrap();

        assert_eq!(
            decode_pending_state_token("line-1\\nline-2", &token).unwrap(),
            claims()
        );
    }
}
