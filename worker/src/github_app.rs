use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use rsa::RsaPrivateKey;
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::DecodePrivateKey;
use serde::Serialize;
use sha2::Sha256;
use signature::{SignatureEncoding, Signer};

#[derive(Debug)]
pub enum JwtError {
    InvalidPrivateKey,
    Serialization(serde_json::Error),
}

impl std::fmt::Display for JwtError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPrivateKey => write!(formatter, "invalid GitHub App private key"),
            Self::Serialization(error) => {
                write!(formatter, "failed to serialize JWT payload: {error}")
            }
        }
    }
}

impl std::error::Error for JwtError {}

#[derive(Debug, Serialize)]
struct JwtHeader {
    alg: &'static str,
    typ: &'static str,
}

#[derive(Debug, Serialize)]
struct JwtClaims<'a> {
    iss: &'a str,
    iat: i64,
    exp: i64,
}

pub fn create_github_app_jwt(
    issuer: &str,
    private_key_pem: &str,
    now: DateTime<Utc>,
) -> Result<String, JwtError> {
    let normalized_key = normalize_private_key(private_key_pem);
    let private_key = RsaPrivateKey::from_pkcs1_pem(&normalized_key)
        .or_else(|_| RsaPrivateKey::from_pkcs8_pem(&normalized_key))
        .map_err(|_| JwtError::InvalidPrivateKey)?;
    let header = JwtHeader {
        alg: "RS256",
        typ: "JWT",
    };
    let claims = JwtClaims {
        iss: issuer,
        iat: (now - Duration::seconds(60)).timestamp(),
        exp: (now + Duration::minutes(9)).timestamp(),
    };
    let signing_input = format!("{}.{}", encode_json(&header)?, encode_json(&claims)?);
    let signing_key = SigningKey::<Sha256>::new(private_key);
    let signature = signing_key.sign(signing_input.as_bytes());

    Ok(format!(
        "{}.{}",
        signing_input,
        URL_SAFE_NO_PAD.encode(signature.to_vec())
    ))
}

fn encode_json(value: &impl Serialize) -> Result<String, JwtError> {
    let bytes = serde_json::to_vec(value).map_err(JwtError::Serialization)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn normalize_private_key(private_key_pem: &str) -> String {
    if private_key_pem.contains("\\n") && !private_key_pem.contains('\n') {
        private_key_pem.replace("\\n", "\n")
    } else {
        private_key_pem.to_string()
    }
}
