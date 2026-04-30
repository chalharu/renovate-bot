use crate::decision::{
    CheckRunPlan, Decision, IgnoreReason, check_run_body, decide_from_slice,
    parse_default_wait_days, sent_status,
};
use crate::github_app::create_github_app_jwt;
use crate::signature::verify_github_signature;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use worker::{
    Fetch, Headers, Method, Request, RequestInit, Response, Result, console_error, console_log,
    event,
};

const GITHUB_API_BASE: &str = "https://api.github.com";
const USER_AGENT: &str = "custom-stability-days-worker";

#[event(fetch)]
pub async fn fetch(
    mut request: Request,
    env: worker::Env,
    _ctx: worker::Context,
) -> Result<Response> {
    if request.method() != Method::Post {
        return Response::error("method not allowed", 405);
    }

    let event_header = request.headers().get("X-GitHub-Event")?;
    if event_header.as_deref() != Some("pull_request") {
        console_log!(
            "Ignoring webhook event {:?}; only pull_request is supported.",
            event_header
        );
        return Response::ok("OK");
    }

    let signature_header = request.headers().get("X-Hub-Signature-256")?;
    let body = match request.bytes().await {
        Ok(body) => body,
        Err(error) => {
            console_error!("Failed to read webhook body: {:?}", error);
            return Response::ok("OK");
        }
    };

    if let Some(secret) = optional_binding(&env, "GITHUB_APP_WEBHOOK_SECRET") {
        if !verify_github_signature(&secret, &body, signature_header.as_deref()) {
            console_error!("Invalid or missing GitHub webhook signature; skipping processing.");
            return Response::ok("OK");
        }
    } else {
        console_log!(
            "GITHUB_APP_WEBHOOK_SECRET is not configured; webhook signature verification skipped."
        );
    }

    let default_wait = parse_default_wait_days(optional_var(&env, "DEFAULT_WAIT_DAYS").as_deref());
    if default_wait.used_fallback {
        console_log!(
            "DEFAULT_WAIT_DAYS is missing or invalid; using safe fallback of {} days.",
            default_wait.days
        );
    }

    let now = now_utc();
    let plan = match decide_from_slice(&body, now, default_wait.days) {
        Ok(Decision::CreateCheck(plan)) => plan,
        Ok(Decision::Ignore(reason)) => {
            log_ignored(&reason);
            return Response::ok("OK");
        }
        Err(error) => {
            console_error!("Webhook payload could not be processed: {}", error);
            return Response::ok("OK");
        }
    };

    if let Err(error) = create_check_run(&env, &plan, now).await {
        console_error!(
            "Failed to send check-run repository={} pr={} wait_days={} days={} status={}: {}",
            plan.repository_full_name,
            plan.pr_number,
            plan.wait_days,
            plan.elapsed_days,
            sent_status(plan.status),
            error
        );
        return Response::ok("OK");
    }

    console_log!(
        "Sent check-run repository={} pr={} wait_days={} days={} status={}",
        plan.repository_full_name,
        plan.pr_number,
        plan.wait_days,
        plan.elapsed_days,
        sent_status(plan.status)
    );
    Response::ok("OK")
}

fn log_ignored(reason: &IgnoreReason) {
    match reason {
        IgnoreReason::UnsupportedAction(action) => {
            console_log!("Ignoring unsupported pull_request action={}", action)
        }
        IgnoreReason::NonRenovateBranch(branch) => {
            console_log!("Ignoring non-Renovate pull_request branch={}", branch)
        }
    }
}

async fn create_check_run(
    env: &worker::Env,
    plan: &CheckRunPlan,
    now: DateTime<Utc>,
) -> std::result::Result<(), String> {
    let client_id = required_binding(env, "GITHUB_APP_CLIENT_ID")?;
    let private_key = required_binding(env, "GITHUB_APP_PRIVATE_KEY")?;
    let jwt = create_github_app_jwt(&client_id, &private_key, now)
        .await
        .map_err(|error| error.to_string())?;
    let installation = get_installation(&plan.repository_full_name, &jwt).await?;
    let installation_token = create_installation_token(installation.id, &jwt).await?;
    post_check_run(plan, &installation_token.token).await
}

async fn get_installation(
    repository_full_name: &str,
    jwt: &str,
) -> std::result::Result<Installation, String> {
    let url = format!("{GITHUB_API_BASE}/repos/{repository_full_name}/installation");
    github_json_request(Method::Get, &url, jwt, None).await
}

async fn create_installation_token(
    installation_id: u64,
    jwt: &str,
) -> std::result::Result<InstallationToken, String> {
    let url = format!("{GITHUB_API_BASE}/app/installations/{installation_id}/access_tokens");
    github_json_request(Method::Post, &url, jwt, Some(serde_json::json!({}))).await
}

async fn post_check_run(plan: &CheckRunPlan, token: &str) -> std::result::Result<(), String> {
    let url = format!(
        "{GITHUB_API_BASE}/repos/{}/check-runs",
        plan.repository_full_name
    );
    let _: serde_json::Value =
        github_json_request(Method::Post, &url, token, Some(check_run_body(plan))).await?;
    Ok(())
}

async fn github_json_request<T: for<'de> Deserialize<'de>>(
    method: Method,
    url: &str,
    bearer_token: &str,
    body: Option<serde_json::Value>,
) -> std::result::Result<T, String> {
    let headers = Headers::new();
    headers
        .set("Authorization", &format!("Bearer {bearer_token}"))
        .map_err(|error| format!("failed to set Authorization header: {error:?}"))?;
    headers
        .set("Accept", "application/vnd.github+json")
        .map_err(|error| format!("failed to set Accept header: {error:?}"))?;
    headers
        .set("Content-Type", "application/json")
        .map_err(|error| format!("failed to set Content-Type header: {error:?}"))?;
    headers
        .set("User-Agent", USER_AGENT)
        .map_err(|error| format!("failed to set User-Agent header: {error:?}"))?;

    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if let Some(body) = body {
        init.with_body(Some(
            serde_json::to_string(&body)
                .map_err(|error| error.to_string())?
                .into(),
        ));
    }

    let request = Request::new_with_init(url, &init)
        .map_err(|error| format!("failed to build GitHub API request: {error:?}"))?;
    let mut response = Fetch::Request(request)
        .send()
        .await
        .map_err(|error| format!("GitHub API request failed: {error:?}"))?;
    let status = response.status_code();
    let response_text = response
        .text()
        .await
        .map_err(|error| format!("failed to read GitHub API response: {error:?}"))?;

    if !(200..300).contains(&status) {
        return Err(format!(
            "GitHub API returned HTTP {status}: {response_text}"
        ));
    }

    serde_json::from_str(&response_text).map_err(|error| {
        format!("failed to parse GitHub API response: {error}; body: {response_text}")
    })
}

fn required_binding(env: &worker::Env, name: &str) -> std::result::Result<String, String> {
    optional_binding(env, name).ok_or_else(|| format!("{name} is not configured"))
}

fn optional_binding(env: &worker::Env, name: &str) -> Option<String> {
    env.secret(name)
        .map(|secret| secret.to_string())
        .or_else(|_| env.var(name).map(|value| value.to_string()))
        .ok()
}

fn optional_var(env: &worker::Env, name: &str) -> Option<String> {
    env.var(name).ok().map(|value| value.to_string())
}

fn now_utc() -> DateTime<Utc> {
    let seconds = (js_sys::Date::now() / 1000.0).floor() as i64;
    DateTime::from_timestamp(seconds, 0).unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
}

#[derive(Debug, Deserialize)]
struct Installation {
    id: u64,
}

#[derive(Debug, Deserialize)]
struct InstallationToken {
    token: String,
}
