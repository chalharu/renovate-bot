use crate::decision::{
    BUILTIN_CHECK_NAME, CHECK_NAME, CheckRunPlan, CheckRunTarget, CheckState, Decision,
    IgnoreReason, builtin_success_plan, check_run_body, check_run_update_body, decide_from_slice,
    evaluate_wait_period, evaluated_plan, extract_state_token_marker, parse_default_wait_days,
    queue_plan, sent_status,
};
use crate::github_app::create_github_app_jwt;
use crate::signature::{SignatureVerificationError, verify_github_webhook};
use crate::state_token::{PendingStateTokenError, decode_pending_state_token};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use worker::{
    Fetch, Headers, Method, Request, RequestInit, Response, Result, console_error, console_log,
    event,
};

const GITHUB_API_BASE: &str = "https://api.github.com";
const USER_AGENT: &str = "custom-stability-days-worker";
const CHECK_RUNS_PAGE_SIZE: usize = 100;
const INITIAL_QUEUE_SUMMARY: &str =
    "Waiting for the Renovate follow-up workflow to resolve release metadata.";
const INVALID_METADATA_SUMMARY: &str = "Pending state metadata could not be validated; waiting for the Renovate follow-up workflow to refresh it.";
const BUILTIN_CHECK_SUMMARY: &str =
    "Renovate's built-in stability-days check exists on this commit.";
const BUILTIN_CHECK_PENDING_SUMMARY: &str =
    "Renovate's built-in stability-days check has not passed on this commit yet.";

#[event(fetch)]
pub async fn fetch(
    mut request: Request,
    env: worker::Env,
    _ctx: worker::Context,
) -> Result<Response> {
    if request.method() != Method::Post {
        return Response::error("method not allowed", 405);
    }

    let signature_header = request.headers().get("X-Hub-Signature-256")?;
    let body = match request.bytes().await {
        Ok(body) => body,
        Err(error) => {
            console_error!("Failed to read webhook body: {:?}", error);
            return Response::ok("OK");
        }
    };

    match verify_github_webhook(
        optional_binding(&env, "GITHUB_APP_WEBHOOK_SECRET").as_deref(),
        &body,
        signature_header.as_deref(),
    ) {
        Ok(()) => {}
        Err(SignatureVerificationError::MissingSecret) => {
            console_error!("GITHUB_APP_WEBHOOK_SECRET is not configured.");
            return Response::error("server misconfigured", 500);
        }
        Err(SignatureVerificationError::InvalidSignature) => {
            console_error!("Invalid or missing GitHub webhook signature.");
            return Response::error("invalid webhook signature", 401);
        }
    }

    let event_header = request.headers().get("X-GitHub-Event")?;
    if event_header.as_deref() != Some("pull_request") {
        console_log!(
            "Ignoring webhook event {:?}; only pull_request is supported.",
            event_header
        );
        return Response::ok("OK");
    }

    let default_wait = parse_default_wait_days(optional_var(&env, "DEFAULT_WAIT_DAYS").as_deref());
    if default_wait.used_fallback {
        console_log!(
            "DEFAULT_WAIT_DAYS is missing or invalid; using safe fallback of {} days.",
            default_wait.days
        );
    }

    let decision = match decide_from_slice(&body) {
        Ok(decision) => decision,
        Err(error) => {
            console_error!("Webhook payload could not be processed: {}", error);
            return Response::ok("OK");
        }
    };

    let target = match &decision {
        Decision::Queue(target) => target.clone(),
        Decision::Reevaluate(target) => target.clone(),
        Decision::Ignore(reason) => {
            log_ignored(reason);
            return Response::ok("OK");
        }
    };

    let now = now_utc();
    let client_id = match required_binding(&env, "GITHUB_APP_CLIENT_ID") {
        Ok(value) => value,
        Err(error) => {
            console_error!("{error}");
            return Response::ok("OK");
        }
    };
    let private_key = match required_binding(&env, "GITHUB_APP_PRIVATE_KEY") {
        Ok(value) => value,
        Err(error) => {
            console_error!("{error}");
            return Response::ok("OK");
        }
    };
    let app_jwt = match create_github_app_jwt(&client_id, &private_key, now).await {
        Ok(jwt) => jwt,
        Err(error) => {
            console_error!("Failed to create GitHub App JWT: {}", error);
            return Response::ok("OK");
        }
    };
    let installation = match get_installation(&target.repository_full_name, &app_jwt).await {
        Ok(installation) => installation,
        Err(error) => {
            console_error!(
                "Failed to resolve installation for repository={}: {}",
                target.repository_full_name,
                error
            );
            return Response::ok("OK");
        }
    };
    let installation_token = match create_installation_token(installation.id, &app_jwt).await {
        Ok(token) => token,
        Err(error) => {
            console_error!(
                "Failed to create installation token for repository={}: {}",
                target.repository_full_name,
                error
            );
            return Response::ok("OK");
        }
    };

    let planned_check_run = match build_check_run_plan(
        &decision,
        &target,
        &installation_token.token,
        &private_key,
        default_wait.days,
        now,
    )
    .await
    {
        Ok(planned_check_run) => planned_check_run,
        Err(error) => {
            console_error!(
                "Failed to build check-run repository={} pr={}: {}",
                target.repository_full_name,
                target.pr_number,
                error
            );
            return Response::ok("OK");
        }
    };

    if let Err(error) = ensure_check_run(
        &planned_check_run.plan,
        planned_check_run.existing_check_run.as_ref(),
        &installation_token.token,
    )
    .await
    {
        console_error!(
            "Failed to send check-run repository={} pr={} status={}: {}",
            planned_check_run.plan.repository_full_name,
            planned_check_run.plan.pr_number,
            sent_status(planned_check_run.plan.state),
            error
        );
        return Response::ok("OK");
    }

    console_log!(
        "Sent check-run repository={} pr={} status={}",
        planned_check_run.plan.repository_full_name,
        planned_check_run.plan.pr_number,
        sent_status(planned_check_run.plan.state)
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

async fn build_check_run_plan(
    decision: &Decision,
    target: &CheckRunTarget,
    installation_token: &str,
    shared_secret: &str,
    default_wait_days: u32,
    now: DateTime<Utc>,
) -> std::result::Result<PlannedCheckRun, String> {
    match decision {
        Decision::Queue(_) => Ok(PlannedCheckRun {
            plan: queue_plan(target, INITIAL_QUEUE_SUMMARY),
            existing_check_run: latest_custom_check_run(
                &target.repository_full_name,
                &target.head_sha,
                installation_token,
            )
            .await?,
        }),
        Decision::Reevaluate(_) => {
            reevaluate_check_run(
                target,
                installation_token,
                shared_secret,
                default_wait_days,
                now,
            )
            .await
        }
        Decision::Ignore(_) => Err("ignored webhook decisions should not be executed".to_string()),
    }
}

async fn reevaluate_check_run(
    target: &CheckRunTarget,
    installation_token: &str,
    shared_secret: &str,
    default_wait_days: u32,
    now: DateTime<Utc>,
) -> std::result::Result<PlannedCheckRun, String> {
    let check_runs = list_check_runs(
        &target.repository_full_name,
        &target.head_sha,
        installation_token,
    )
    .await?;
    let existing_check_run = check_runs
        .iter()
        .filter(|check_run| check_run.name == CHECK_NAME)
        .max_by_key(|check_run| check_run.id)
        .cloned();
    if let Some(check_run) = check_runs
        .iter()
        .filter(|check_run| check_run.name == BUILTIN_CHECK_NAME)
        .max_by_key(|check_run| check_run.id)
    {
        return Ok(PlannedCheckRun {
            plan: if check_run_has_passing_conclusion(check_run) {
                builtin_success_plan(target, BUILTIN_CHECK_SUMMARY)
            } else {
                builtin_pending_plan(target)
            },
            existing_check_run,
        });
    }

    let (state_token, claims) =
        match extract_latest_pending_state(&check_runs, shared_secret, target) {
            Some(value) => value,
            None => {
                return Ok(PlannedCheckRun {
                    plan: queue_plan(target, INVALID_METADATA_SUMMARY),
                    existing_check_run,
                });
            }
        };
    let labels = get_issue_labels(
        &target.repository_full_name,
        target.pr_number,
        installation_token,
    )
    .await?;
    let evaluation = evaluate_wait_period(
        labels.iter().map(String::as_str),
        default_wait_days,
        claims.version_created_at,
        now,
    );

    Ok(PlannedCheckRun {
        plan: evaluated_plan(target, &evaluation, claims.version_created_at, &state_token),
        existing_check_run,
    })
}

fn extract_latest_pending_state(
    check_runs: &[CheckRun],
    shared_secret: &str,
    target: &CheckRunTarget,
) -> Option<(String, crate::state_token::PendingStateTokenClaims)> {
    let Some(check_run) = check_runs
        .iter()
        .filter(|check_run| check_run.name == CHECK_NAME)
        .max_by_key(|check_run| check_run.id)
    else {
        return None;
    };
    let Some(output) = &check_run.output else {
        return None;
    };
    let Some(text) = output.text.as_deref() else {
        return None;
    };
    let Some(state_token) = extract_state_token_marker(text) else {
        return None;
    };
    let claims = match decode_pending_state_token(shared_secret, &state_token) {
        Ok(claims) => claims,
        Err(error) => {
            console_log!(
                "Ignoring invalid pending state token repository={} pr={}: {}",
                target.repository_full_name,
                target.pr_number,
                invalid_state_token_error(error, target)
            );
            return None;
        }
    };

    if claims.repository_full_name != target.repository_full_name
        || claims.pr_number != target.pr_number
        || claims.head_sha != target.head_sha
    {
        console_log!(
            "Ignoring mismatched pending state token repository={} pr={}",
            target.repository_full_name,
            target.pr_number
        );
        return None;
    }

    Some((state_token, claims))
}

fn invalid_state_token_error(error: PendingStateTokenError, target: &CheckRunTarget) -> String {
    format!(
        "{}; repository={} pr={}",
        match error {
            PendingStateTokenError::InvalidFormat => INVALID_METADATA_SUMMARY.to_string(),
            PendingStateTokenError::InvalidHeader => INVALID_METADATA_SUMMARY.to_string(),
            PendingStateTokenError::InvalidSignature => INVALID_METADATA_SUMMARY.to_string(),
            PendingStateTokenError::InvalidClaims => INVALID_METADATA_SUMMARY.to_string(),
            PendingStateTokenError::Serialization(message) => message,
        },
        target.repository_full_name,
        target.pr_number
    )
}

async fn latest_custom_check_run(
    repository_full_name: &str,
    head_sha: &str,
    installation_token: &str,
) -> std::result::Result<Option<CheckRun>, String> {
    let check_runs = list_check_runs(repository_full_name, head_sha, installation_token).await?;
    Ok(check_runs
        .into_iter()
        .filter(|check_run| check_run.name == CHECK_NAME)
        .max_by_key(|check_run| check_run.id))
}

struct PlannedCheckRun {
    plan: CheckRunPlan,
    existing_check_run: Option<CheckRun>,
}

async fn ensure_check_run(
    plan: &CheckRunPlan,
    existing_check_run: Option<&CheckRun>,
    installation_token: &str,
) -> std::result::Result<(), String> {
    match existing_check_run {
        Some(existing_check_run)
            if existing_check_run.status == "completed" && plan.state != CheckState::Success =>
        {
            post_check_run(plan, installation_token).await
        }
        Some(existing_check_run) if check_run_matches_plan(existing_check_run, plan) => Ok(()),
        Some(existing_check_run) => {
            patch_check_run(
                &plan.repository_full_name,
                existing_check_run.id,
                plan,
                installation_token,
            )
            .await
        }
        None => post_check_run(plan, installation_token).await,
    }
}

fn check_run_matches_plan(existing_check_run: &CheckRun, plan: &CheckRunPlan) -> bool {
    let (expected_status, expected_conclusion) = match plan.state {
        CheckState::Queue => ("queued", None),
        CheckState::Pending => ("in_progress", None),
        CheckState::Success => ("completed", Some("success")),
    };
    let Some(output) = &existing_check_run.output else {
        return false;
    };

    existing_check_run.status == expected_status
        && existing_check_run.conclusion.as_deref() == expected_conclusion
        && output.summary == plan.summary
        && output.text.as_deref() == plan.text.as_deref()
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

async fn get_issue_labels(
    repository_full_name: &str,
    issue_number: u64,
    installation_token: &str,
) -> std::result::Result<Vec<String>, String> {
    let url = format!("{GITHUB_API_BASE}/repos/{repository_full_name}/issues/{issue_number}");
    let issue: Issue = github_json_request(Method::Get, &url, installation_token, None).await?;
    Ok(issue.labels.into_iter().map(|label| label.name).collect())
}

async fn list_check_runs(
    repository_full_name: &str,
    head_sha: &str,
    installation_token: &str,
) -> std::result::Result<Vec<CheckRun>, String> {
    let mut page = 1;
    let mut all_check_runs = Vec::new();

    loop {
        let url = format!(
            "{GITHUB_API_BASE}/repos/{repository_full_name}/commits/{head_sha}/check-runs?per_page={CHECK_RUNS_PAGE_SIZE}&page={page}"
        );
        let response: CheckRunsResponse =
            github_json_request(Method::Get, &url, installation_token, None).await?;
        let page_len = response.check_runs.len();
        all_check_runs.extend(response.check_runs);
        if page_len < CHECK_RUNS_PAGE_SIZE {
            break;
        }
        page += 1;
    }

    Ok(all_check_runs)
}

fn builtin_pending_plan(target: &CheckRunTarget) -> CheckRunPlan {
    CheckRunPlan {
        repository_full_name: target.repository_full_name.clone(),
        pr_number: target.pr_number,
        head_sha: target.head_sha.clone(),
        state: CheckState::Pending,
        wait_days: None,
        elapsed_days: None,
        summary: BUILTIN_CHECK_PENDING_SUMMARY.to_string(),
        text: None,
    }
}

fn check_run_has_passing_conclusion(check_run: &CheckRun) -> bool {
    check_run.status == "completed"
        && matches!(
            check_run.conclusion.as_deref(),
            Some("success" | "neutral" | "skipped")
        )
}

async fn post_check_run(
    plan: &CheckRunPlan,
    installation_token: &str,
) -> std::result::Result<(), String> {
    let url = format!(
        "{GITHUB_API_BASE}/repos/{}/check-runs",
        plan.repository_full_name
    );
    let _: serde_json::Value = github_json_request(
        Method::Post,
        &url,
        installation_token,
        Some(check_run_body(plan)),
    )
    .await?;
    Ok(())
}

async fn patch_check_run(
    repository_full_name: &str,
    check_run_id: u64,
    plan: &CheckRunPlan,
    installation_token: &str,
) -> std::result::Result<(), String> {
    let url = format!("{GITHUB_API_BASE}/repos/{repository_full_name}/check-runs/{check_run_id}");
    let _: serde_json::Value = github_json_request(
        Method::Patch,
        &url,
        installation_token,
        Some(check_run_update_body(plan)),
    )
    .await?;
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

#[derive(Debug, Deserialize)]
struct Issue {
    #[serde(default)]
    labels: Vec<Label>,
}

#[derive(Debug, Deserialize)]
struct Label {
    name: String,
}

#[derive(Debug, Deserialize)]
struct CheckRunsResponse {
    #[serde(default)]
    check_runs: Vec<CheckRun>,
}

#[derive(Debug, Clone, Deserialize)]
struct CheckRun {
    id: u64,
    name: String,
    status: String,
    conclusion: Option<String>,
    output: Option<CheckRunOutput>,
}

#[derive(Debug, Clone, Deserialize)]
struct CheckRunOutput {
    #[serde(default)]
    summary: String,
    text: Option<String>,
}
