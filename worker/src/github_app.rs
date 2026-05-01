use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use chrono::{DateTime, Duration, Utc};
use js_sys::{Array, Object, Reflect, Uint8Array};
use serde::Serialize;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{CryptoKey, WorkerGlobalScope};

#[derive(Debug)]
pub enum JwtError {
    Crypto(String),
    InvalidPrivateKey,
    Serialization(serde_json::Error),
}

impl std::fmt::Display for JwtError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Crypto(error) => write!(formatter, "GitHub App JWT signing failed: {error}"),
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

pub async fn create_github_app_jwt(
    issuer: &str,
    private_key_pem: &str,
    now: DateTime<Utc>,
) -> Result<String, JwtError> {
    let private_key_der = private_key_pkcs8_der(private_key_pem)?;
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
    let signature = sign_rs256(&private_key_der, signing_input.as_bytes()).await?;

    Ok(format!(
        "{}.{}",
        signing_input,
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

async fn sign_rs256(private_key_der: &[u8], data: &[u8]) -> Result<Vec<u8>, JwtError> {
    let global: WorkerGlobalScope = js_sys::global().unchecked_into();
    let crypto = global.crypto().map_err(js_error)?;
    let subtle = crypto.subtle();
    let algorithm = rsassa_pkcs1_v1_5_algorithm()?;
    let key_data: Object = Uint8Array::from(private_key_der).buffer().unchecked_into();
    let usages = Array::new();
    usages.push(&JsValue::from_str("sign"));
    let key = JsFuture::from(
        subtle
            .import_key_with_object("pkcs8", &key_data, &algorithm, false, usages.as_ref())
            .map_err(js_error)?,
    )
    .await
    .map_err(js_error)?
    .dyn_into::<CryptoKey>()
    .map_err(js_error)?;
    let data: Object = Uint8Array::from(data).buffer().unchecked_into();
    let signature = JsFuture::from(
        subtle
            .sign_with_object_and_buffer_source(&algorithm, &key, &data)
            .map_err(js_error)?,
    )
    .await
    .map_err(js_error)?;

    Ok(Uint8Array::new(&signature).to_vec())
}

fn rsassa_pkcs1_v1_5_algorithm() -> Result<Object, JwtError> {
    let algorithm = Object::new();
    let hash = Object::new();

    Reflect::set(
        &hash,
        &JsValue::from_str("name"),
        &JsValue::from_str("SHA-256"),
    )
    .map_err(js_error)?;
    Reflect::set(
        &algorithm,
        &JsValue::from_str("name"),
        &JsValue::from_str("RSASSA-PKCS1-v1_5"),
    )
    .map_err(js_error)?;
    Reflect::set(&algorithm, &JsValue::from_str("hash"), hash.as_ref()).map_err(js_error)?;

    Ok(algorithm)
}

fn encode_json(value: &impl Serialize) -> Result<String, JwtError> {
    let bytes = serde_json::to_vec(value).map_err(JwtError::Serialization)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn private_key_pkcs8_der(private_key_pem: &str) -> Result<Vec<u8>, JwtError> {
    let normalized_key = normalize_private_key(private_key_pem);

    if normalized_key.contains("-----BEGIN PRIVATE KEY-----") {
        return decode_pem_block(&normalized_key, "PRIVATE KEY");
    }

    if normalized_key.contains("-----BEGIN RSA PRIVATE KEY-----") {
        let pkcs1_der = decode_pem_block(&normalized_key, "RSA PRIVATE KEY")?;

        return Ok(pkcs1_to_pkcs8(&pkcs1_der));
    }

    Err(JwtError::InvalidPrivateKey)
}

fn decode_pem_block(pem: &str, label: &str) -> Result<Vec<u8>, JwtError> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let mut body = String::new();
    let mut in_block = false;

    for line in pem.lines().map(str::trim) {
        if line == begin {
            in_block = true;
            continue;
        }

        if line == end {
            break;
        }

        if in_block {
            body.push_str(line);
        }
    }

    if body.is_empty() {
        return Err(JwtError::InvalidPrivateKey);
    }

    STANDARD
        .decode(body)
        .map_err(|_| JwtError::InvalidPrivateKey)
}

fn pkcs1_to_pkcs8(pkcs1_der: &[u8]) -> Vec<u8> {
    const RSA_ENCRYPTION_OID: &[u8] = &[
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    ];
    const NULL: &[u8] = &[0x05, 0x00];
    const VERSION_ZERO: &[u8] = &[0x02, 0x01, 0x00];

    let mut algorithm_identifier = Vec::new();
    algorithm_identifier.extend_from_slice(RSA_ENCRYPTION_OID);
    algorithm_identifier.extend_from_slice(NULL);
    let algorithm_identifier = der_wrap(0x30, &algorithm_identifier);
    let private_key = der_wrap(0x04, pkcs1_der);
    let mut private_key_info = Vec::new();
    private_key_info.extend_from_slice(VERSION_ZERO);
    private_key_info.extend_from_slice(&algorithm_identifier);
    private_key_info.extend_from_slice(&private_key);

    der_wrap(0x30, &private_key_info)
}

fn der_wrap(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut encoded = vec![tag];
    encoded.extend_from_slice(&der_len(content.len()));
    encoded.extend_from_slice(content);
    encoded
}

fn der_len(len: usize) -> Vec<u8> {
    if len < 128 {
        return vec![len as u8];
    }

    let bytes = len.to_be_bytes();
    let first_non_zero = bytes
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(bytes.len() - 1);
    let len_bytes = &bytes[first_non_zero..];
    let mut encoded = vec![0x80 | len_bytes.len() as u8];
    encoded.extend_from_slice(len_bytes);
    encoded
}

fn normalize_private_key(private_key_pem: &str) -> String {
    if private_key_pem.contains("\\n") && !private_key_pem.contains('\n') {
        private_key_pem.replace("\\n", "\n")
    } else {
        private_key_pem.to_string()
    }
}

fn js_error(value: JsValue) -> JwtError {
    JwtError::Crypto(
        value
            .as_string()
            .unwrap_or_else(|| "unexpected JavaScript error".to_string()),
    )
}
