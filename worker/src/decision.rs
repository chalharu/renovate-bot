use chrono::{DateTime, Utc};
use serde::Deserialize;

pub const CHECK_NAME: &str = "custom-stability-days";
pub const BUILTIN_CHECK_NAME: &str = "renovate/stability-days";
pub const DEFAULT_WAIT_DAYS_FALLBACK: u32 = 3;

const RENOVATE_BRANCH_PREFIX: &str = "renovate/";
const SECURITY_LABEL: &str = "security";
const WAIT_LABEL_PREFIX: &str = "renovate-wait-";
const WAIT_LABEL_SUFFIX: &str = "d";
const STATE_TOKEN_MARKER_PREFIX: &str = "<!-- custom-stability-days-jwt:";
const STATE_TOKEN_MARKER_SUFFIX: &str = " -->";
const QUEUE_ACTIONS: [&str; 3] = ["opened", "reopened", "synchronize"];
const REEVALUATE_ACTIONS: [&str; 2] = ["labeled", "unlabeled"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultWaitDays {
    pub days: u32,
    pub used_fallback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Queue(CheckRunTarget),
    Reevaluate(CheckRunTarget),
    Ignore(IgnoreReason),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IgnoreReason {
    UnsupportedAction(String),
    NonRenovateBranch(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckRunTarget {
    pub repository_full_name: String,
    pub pr_number: u64,
    pub head_sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckRunPlan {
    pub repository_full_name: String,
    pub pr_number: u64,
    pub head_sha: String,
    pub state: CheckState,
    pub wait_days: Option<u32>,
    pub elapsed_days: Option<u32>,
    pub summary: String,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckState {
    Queue,
    Pending,
    Success,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaitEvaluation {
    pub wait_days: u32,
    pub elapsed_days: u32,
    pub state: CheckState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecisionError {
    InvalidJson(String),
}

impl std::fmt::Display for DecisionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidJson(error) => write!(formatter, "invalid pull_request payload: {error}"),
        }
    }
}

impl std::error::Error for DecisionError {}

#[derive(Debug, Deserialize)]
struct PullRequestWebhook {
    action: String,
    repository: Repository,
    pull_request: PullRequest,
}

#[derive(Debug, Deserialize)]
struct Repository {
    full_name: String,
}

#[derive(Debug, Deserialize)]
struct PullRequest {
    number: u64,
    head: Head,
}

#[derive(Debug, Deserialize)]
struct Head {
    #[serde(rename = "ref")]
    branch_ref: String,
    sha: String,
}

pub fn parse_default_wait_days(raw_value: Option<&str>) -> DefaultWaitDays {
    match raw_value.and_then(|value| value.trim().parse::<u32>().ok()) {
        Some(days) if days >= 1 => DefaultWaitDays {
            days,
            used_fallback: false,
        },
        _ => DefaultWaitDays {
            days: DEFAULT_WAIT_DAYS_FALLBACK,
            used_fallback: true,
        },
    }
}

pub fn decide_from_slice(payload: &[u8]) -> Result<Decision, DecisionError> {
    let event: PullRequestWebhook = serde_json::from_slice(payload)
        .map_err(|error| DecisionError::InvalidJson(error.to_string()))?;

    if !event
        .pull_request
        .head
        .branch_ref
        .starts_with(RENOVATE_BRANCH_PREFIX)
    {
        return Ok(Decision::Ignore(IgnoreReason::NonRenovateBranch(
            event.pull_request.head.branch_ref,
        )));
    }

    let target = CheckRunTarget {
        repository_full_name: event.repository.full_name,
        pr_number: event.pull_request.number,
        head_sha: event.pull_request.head.sha,
    };

    if QUEUE_ACTIONS.contains(&event.action.as_str()) {
        return Ok(Decision::Queue(target));
    }
    if REEVALUATE_ACTIONS.contains(&event.action.as_str()) {
        return Ok(Decision::Reevaluate(target));
    }

    Ok(Decision::Ignore(IgnoreReason::UnsupportedAction(
        event.action,
    )))
}

pub fn wait_days_for_labels<'a>(
    labels: impl IntoIterator<Item = &'a str>,
    default_wait_days: u32,
) -> u32 {
    let mut parsed_wait_days = None;

    for label in labels {
        if label == SECURITY_LABEL {
            return 0;
        }

        if parsed_wait_days.is_none() {
            parsed_wait_days = parse_wait_label(label);
        }
    }

    parsed_wait_days.unwrap_or(default_wait_days)
}

pub fn parse_wait_label(label: &str) -> Option<u32> {
    let days = label
        .strip_prefix(WAIT_LABEL_PREFIX)?
        .strip_suffix(WAIT_LABEL_SUFFIX)?
        .parse::<u32>()
        .ok()?;

    (days >= 1).then_some(days)
}

pub fn elapsed_days_floor(created_at: DateTime<Utc>, now: DateTime<Utc>) -> u32 {
    let elapsed_seconds = now.signed_duration_since(created_at).num_seconds().max(0);
    (elapsed_seconds / 86_400) as u32
}

pub fn evaluate_wait_period<'a>(
    labels: impl IntoIterator<Item = &'a str>,
    default_wait_days: u32,
    version_created_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> WaitEvaluation {
    let wait_days = wait_days_for_labels(labels, default_wait_days);
    let elapsed_days = elapsed_days_floor(version_created_at, now);
    let state = if elapsed_days < wait_days {
        CheckState::Pending
    } else {
        CheckState::Success
    };

    WaitEvaluation {
        wait_days,
        elapsed_days,
        state,
    }
}

pub fn queue_plan(target: &CheckRunTarget, summary: impl Into<String>) -> CheckRunPlan {
    CheckRunPlan {
        repository_full_name: target.repository_full_name.clone(),
        pr_number: target.pr_number,
        head_sha: target.head_sha.clone(),
        state: CheckState::Queue,
        wait_days: None,
        elapsed_days: None,
        summary: summary.into(),
        text: None,
    }
}

pub fn builtin_success_plan(target: &CheckRunTarget, summary: impl Into<String>) -> CheckRunPlan {
    CheckRunPlan {
        repository_full_name: target.repository_full_name.clone(),
        pr_number: target.pr_number,
        head_sha: target.head_sha.clone(),
        state: CheckState::Success,
        wait_days: Some(0),
        elapsed_days: Some(0),
        summary: summary.into(),
        text: None,
    }
}

pub fn evaluated_plan(
    target: &CheckRunTarget,
    evaluation: &WaitEvaluation,
    version_created_at: DateTime<Utc>,
    state_token: &str,
) -> CheckRunPlan {
    let version_created_at_text = format_utc_timestamp(version_created_at);
    let summary = match evaluation.state {
        CheckState::Pending => format!(
            "Waiting {} full day(s) from release timestamp {}; {} day(s) elapsed.",
            evaluation.wait_days, version_created_at_text, evaluation.elapsed_days
        ),
        CheckState::Success => {
            if evaluation.wait_days == 0 {
                format!(
                    "Current labels allow this Renovate PR to pass immediately (release timestamp {}).",
                    version_created_at_text
                )
            } else {
                format!(
                    "Required wait of {} full day(s) from release timestamp {} has passed ({} day(s) elapsed).",
                    evaluation.wait_days, version_created_at_text, evaluation.elapsed_days
                )
            }
        }
        CheckState::Queue => unreachable!("queue plans are constructed separately"),
    };

    CheckRunPlan {
        repository_full_name: target.repository_full_name.clone(),
        pr_number: target.pr_number,
        head_sha: target.head_sha.clone(),
        state: evaluation.state,
        wait_days: Some(evaluation.wait_days),
        elapsed_days: Some(evaluation.elapsed_days),
        summary,
        text: Some(format_state_token_marker(state_token)),
    }
}

pub fn format_state_token_marker(state_token: &str) -> String {
    format!("{STATE_TOKEN_MARKER_PREFIX}{state_token}{STATE_TOKEN_MARKER_SUFFIX}")
}

fn format_utc_timestamp(value: DateTime<Utc>) -> String {
    serde_json::to_string(&value)
        .expect("DateTime<Utc> should serialize to a JSON string")
        .trim_matches('"')
        .to_string()
}

pub fn extract_state_token_marker(text: &str) -> Option<String> {
    let start_index = text.find(STATE_TOKEN_MARKER_PREFIX)? + STATE_TOKEN_MARKER_PREFIX.len();
    let end_index = text[start_index..].find(STATE_TOKEN_MARKER_SUFFIX)? + start_index;
    Some(text[start_index..end_index].to_string())
}

pub fn check_run_body(plan: &CheckRunPlan) -> serde_json::Value {
    match plan.state {
        CheckState::Queue => serde_json::json!({
            "name": CHECK_NAME,
            "head_sha": plan.head_sha,
            "status": "queued",
            "output": {
                "title": "Waiting for release metadata",
                "summary": plan.summary,
                "text": plan.text
            }
        }),
        CheckState::Pending => serde_json::json!({
            "name": CHECK_NAME,
            "head_sha": plan.head_sha,
            "status": "in_progress",
            "output": {
                "title": "Stability waiting period",
                "summary": plan.summary,
                "text": plan.text
            }
        }),
        CheckState::Success => serde_json::json!({
            "name": CHECK_NAME,
            "head_sha": plan.head_sha,
            "status": "completed",
            "conclusion": "success",
            "output": {
                "title": "Stability waiting period passed",
                "summary": plan.summary,
                "text": plan.text
            }
        }),
    }
}

pub fn check_run_update_body(plan: &CheckRunPlan) -> serde_json::Value {
    match plan.state {
        CheckState::Queue => serde_json::json!({
            "status": "queued",
            "output": {
                "title": "Waiting for release metadata",
                "summary": plan.summary,
                "text": plan.text
            }
        }),
        CheckState::Pending => serde_json::json!({
            "status": "in_progress",
            "output": {
                "title": "Stability waiting period",
                "summary": plan.summary,
                "text": plan.text
            }
        }),
        CheckState::Success => serde_json::json!({
            "status": "completed",
            "conclusion": "success",
            "output": {
                "title": "Stability waiting period passed",
                "summary": plan.summary,
                "text": plan.text
            }
        }),
    }
}

pub fn sent_status(state: CheckState) -> &'static str {
    match state {
        CheckState::Queue => "queued",
        CheckState::Pending => "in_progress",
        CheckState::Success => "completed/success",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 4, 30, 12, 0, 0).unwrap()
    }

    fn payload(action: &str, branch: &str) -> Vec<u8> {
        serde_json::json!({
            "action": action,
            "repository": { "full_name": "owner/repo" },
            "pull_request": {
                "number": 42,
                "head": {
                    "ref": branch,
                    "sha": "abc123"
                }
            }
        })
        .to_string()
        .into_bytes()
    }

    fn target() -> CheckRunTarget {
        CheckRunTarget {
            repository_full_name: "owner/repo".to_string(),
            pr_number: 42,
            head_sha: "abc123".to_string(),
        }
    }

    #[test]
    fn queues_supported_open_actions_for_renovate_branches() {
        assert_eq!(
            decide_from_slice(&payload("opened", "renovate/example")).unwrap(),
            Decision::Queue(target())
        );
        assert_eq!(
            decide_from_slice(&payload("reopened", "renovate/example")).unwrap(),
            Decision::Queue(target())
        );
        assert_eq!(
            decide_from_slice(&payload("synchronize", "renovate/example")).unwrap(),
            Decision::Queue(target())
        );
    }

    #[test]
    fn reevaluates_label_actions_for_renovate_branches() {
        assert_eq!(
            decide_from_slice(&payload("labeled", "renovate/example")).unwrap(),
            Decision::Reevaluate(target())
        );
        assert_eq!(
            decide_from_slice(&payload("unlabeled", "renovate/example")).unwrap(),
            Decision::Reevaluate(target())
        );
    }

    #[test]
    fn ignores_non_renovate_branch() {
        let decision = decide_from_slice(&payload("opened", "feature/example")).unwrap();

        assert_eq!(
            decision,
            Decision::Ignore(IgnoreReason::NonRenovateBranch(
                "feature/example".to_string()
            ))
        );
    }

    #[test]
    fn ignores_unsupported_action() {
        let decision = decide_from_slice(&payload("closed", "renovate/example")).unwrap();

        assert_eq!(
            decision,
            Decision::Ignore(IgnoreReason::UnsupportedAction("closed".to_string()))
        );
    }

    #[test]
    fn security_label_overrides_wait_label() {
        let evaluation = evaluate_wait_period(
            ["renovate-wait-10d", "security"],
            3,
            Utc.with_ymd_and_hms(2026, 4, 30, 12, 0, 0).unwrap(),
            now(),
        );

        assert_eq!(evaluation.wait_days, 0);
        assert_eq!(evaluation.state, CheckState::Success);
    }

    #[test]
    fn wait_label_parses_valid_integer_and_ignores_invalid_or_zero() {
        assert_eq!(parse_wait_label("renovate-wait-7d"), Some(7));
        assert_eq!(parse_wait_label("renovate-wait-0d"), None);
        assert_eq!(parse_wait_label("renovate-wait-abcd"), None);
        assert_eq!(
            wait_days_for_labels(["renovate-wait-0d", "renovate-wait-5d"], 3),
            5
        );
    }

    #[test]
    fn invalid_or_missing_default_wait_days_falls_back_to_three() {
        assert_eq!(
            parse_default_wait_days(Some("5")),
            DefaultWaitDays {
                days: 5,
                used_fallback: false
            }
        );
        assert_eq!(
            parse_default_wait_days(Some("0")),
            DefaultWaitDays {
                days: 3,
                used_fallback: true
            }
        );
        assert_eq!(
            parse_default_wait_days(Some("not-a-number")),
            DefaultWaitDays {
                days: 3,
                used_fallback: true
            }
        );
        assert_eq!(
            parse_default_wait_days(None),
            DefaultWaitDays {
                days: 3,
                used_fallback: true
            }
        );
    }

    #[test]
    fn elapsed_days_are_floored() {
        let created_at = Utc.with_ymd_and_hms(2026, 4, 29, 12, 0, 1).unwrap();

        assert_eq!(elapsed_days_floor(created_at, now()), 0);
        assert_eq!(
            elapsed_days_floor(Utc.with_ymd_and_hms(2026, 4, 29, 12, 0, 0).unwrap(), now()),
            1
        );
        assert_eq!(
            elapsed_days_floor(Utc.with_ymd_and_hms(2026, 5, 1, 12, 0, 0).unwrap(), now()),
            0
        );
    }

    #[test]
    fn pending_and_success_boundaries_use_version_created_at() {
        let pending = evaluate_wait_period(
            ["renovate-wait-3d"],
            1,
            Utc.with_ymd_and_hms(2026, 4, 27, 12, 0, 1).unwrap(),
            now(),
        );
        let success = evaluate_wait_period(
            ["renovate-wait-3d"],
            1,
            Utc.with_ymd_and_hms(2026, 4, 27, 12, 0, 0).unwrap(),
            now(),
        );

        assert_eq!(pending.elapsed_days, 2);
        assert_eq!(pending.state, CheckState::Pending);
        assert_eq!(success.elapsed_days, 3);
        assert_eq!(success.state, CheckState::Success);
    }

    #[test]
    fn malformed_payload_is_reported_without_panic() {
        let error = decide_from_slice(br#"{"action":"opened"}"#).unwrap_err();

        assert!(matches!(error, DecisionError::InvalidJson(_)));
    }

    #[test]
    fn state_token_markers_round_trip() {
        let marker = format_state_token_marker("token-value");

        assert_eq!(
            extract_state_token_marker(&format!("visible text {marker} trailing text")),
            Some("token-value".to_string())
        );
    }

    #[test]
    fn check_run_bodies_match_expected_api_shape() {
        let queue = queue_plan(
            &target(),
            "Waiting for the Renovate follow-up workflow to resolve release metadata.",
        );
        let evaluation = evaluate_wait_period(
            ["renovate-wait-3d"],
            1,
            Utc.with_ymd_and_hms(2026, 4, 28, 12, 0, 0).unwrap(),
            now(),
        );
        let pending = evaluated_plan(
            &target(),
            &evaluation,
            Utc.with_ymd_and_hms(2026, 4, 28, 12, 0, 0).unwrap(),
            "token",
        );
        let success = builtin_success_plan(
            &target(),
            "Renovate's built-in stability-days check exists on this commit.",
        );

        assert_eq!(check_run_body(&queue)["status"], "queued");
        assert_eq!(check_run_body(&pending)["status"], "in_progress");
        assert_eq!(
            check_run_body(&pending)["output"]["text"],
            "<!-- custom-stability-days-jwt:token -->"
        );
        assert_eq!(check_run_body(&success)["status"], "completed");
        assert_eq!(check_run_body(&success)["conclusion"], "success");
        assert_eq!(check_run_update_body(&success)["conclusion"], "success");
    }
}
