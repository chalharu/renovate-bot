use chrono::{DateTime, Utc};
use serde::Deserialize;

pub const CHECK_NAME: &str = "custom-stability-days";
pub const DEFAULT_WAIT_DAYS_FALLBACK: u32 = 3;

const RENOVATE_BRANCH_PREFIX: &str = "renovate/";
const SECURITY_LABEL: &str = "security";
const WAIT_LABEL_PREFIX: &str = "renovate-wait-";
const WAIT_LABEL_SUFFIX: &str = "d";
const SUPPORTED_ACTIONS: [&str; 5] = ["opened", "reopened", "synchronize", "labeled", "unlabeled"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultWaitDays {
    pub days: u32,
    pub used_fallback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    CreateCheck(CheckRunPlan),
    Ignore(IgnoreReason),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IgnoreReason {
    UnsupportedAction(String),
    NonRenovateBranch(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckRunPlan {
    pub repository_full_name: String,
    pub pr_number: u64,
    pub head_sha: String,
    pub wait_days: u32,
    pub elapsed_days: u32,
    pub status: CheckStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStatus {
    Pending,
    Success,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecisionError {
    InvalidJson(String),
    InvalidCreatedAt(String),
}

impl std::fmt::Display for DecisionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidJson(error) => write!(formatter, "invalid pull_request payload: {error}"),
            Self::InvalidCreatedAt(value) => {
                write!(formatter, "invalid pull_request.created_at: {value}")
            }
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
    created_at: String,
    head: Head,
    #[serde(default)]
    labels: Vec<Label>,
}

#[derive(Debug, Deserialize)]
struct Head {
    #[serde(rename = "ref")]
    branch_ref: String,
    sha: String,
}

#[derive(Debug, Deserialize)]
struct Label {
    name: String,
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

pub fn decide_from_slice(
    payload: &[u8],
    now: DateTime<Utc>,
    default_wait_days: u32,
) -> Result<Decision, DecisionError> {
    let event: PullRequestWebhook = serde_json::from_slice(payload)
        .map_err(|error| DecisionError::InvalidJson(error.to_string()))?;

    if !SUPPORTED_ACTIONS.contains(&event.action.as_str()) {
        return Ok(Decision::Ignore(IgnoreReason::UnsupportedAction(
            event.action,
        )));
    }

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

    let wait_days = wait_days_for_labels(
        event
            .pull_request
            .labels
            .iter()
            .map(|label| label.name.as_str()),
        default_wait_days,
    );
    let created_at = DateTime::parse_from_rfc3339(&event.pull_request.created_at)
        .map_err(|_| DecisionError::InvalidCreatedAt(event.pull_request.created_at.clone()))?
        .with_timezone(&Utc);
    let elapsed_days = elapsed_days_floor(created_at, now);
    let status = if elapsed_days < wait_days {
        CheckStatus::Pending
    } else {
        CheckStatus::Success
    };

    Ok(Decision::CreateCheck(CheckRunPlan {
        repository_full_name: event.repository.full_name,
        pr_number: event.pull_request.number,
        head_sha: event.pull_request.head.sha,
        wait_days,
        elapsed_days,
        status,
    }))
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

pub fn check_run_body(plan: &CheckRunPlan) -> serde_json::Value {
    match plan.status {
        CheckStatus::Pending => serde_json::json!({
            "name": CHECK_NAME,
            "head_sha": plan.head_sha,
            "status": "in_progress",
            "output": {
                "title": "Stability waiting period",
                "summary": "This Renovate PR is in a waiting period before it can be merged."
            }
        }),
        CheckStatus::Success => serde_json::json!({
            "name": CHECK_NAME,
            "head_sha": plan.head_sha,
            "status": "completed",
            "conclusion": "success",
            "output": {
                "title": "Stability waiting period passed",
                "summary": "The waiting period for this Renovate PR has passed."
            }
        }),
    }
}

pub fn sent_status(status: CheckStatus) -> &'static str {
    match status {
        CheckStatus::Pending => "in_progress",
        CheckStatus::Success => "completed/success",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 4, 30, 12, 0, 0).unwrap()
    }

    fn payload(action: &str, branch: &str, created_at: &str, labels: &[&str]) -> Vec<u8> {
        let labels = labels
            .iter()
            .map(|label| serde_json::json!({ "name": label }))
            .collect::<Vec<_>>();

        serde_json::json!({
            "action": action,
            "repository": { "full_name": "owner/repo" },
            "pull_request": {
                "number": 42,
                "created_at": created_at,
                "head": {
                    "ref": branch,
                    "sha": "abc123"
                },
                "labels": labels
            }
        })
        .to_string()
        .into_bytes()
    }

    fn plan_for(labels: &[&str], created_at: &str, default_wait_days: u32) -> CheckRunPlan {
        match decide_from_slice(
            &payload("opened", "renovate/example", created_at, labels),
            now(),
            default_wait_days,
        )
        .unwrap()
        {
            Decision::CreateCheck(plan) => plan,
            Decision::Ignore(reason) => panic!("expected check plan, ignored: {reason:?}"),
        }
    }

    #[test]
    fn ignores_non_renovate_branch() {
        let decision = decide_from_slice(
            &payload("opened", "feature/example", "2026-04-28T12:00:00Z", &[]),
            now(),
            3,
        )
        .unwrap();

        assert_eq!(
            decision,
            Decision::Ignore(IgnoreReason::NonRenovateBranch(
                "feature/example".to_string()
            ))
        );
    }

    #[test]
    fn ignores_unsupported_action() {
        let decision = decide_from_slice(
            &payload("closed", "renovate/example", "2026-04-28T12:00:00Z", &[]),
            now(),
            3,
        )
        .unwrap();

        assert_eq!(
            decision,
            Decision::Ignore(IgnoreReason::UnsupportedAction("closed".to_string()))
        );
    }

    #[test]
    fn security_label_overrides_wait_label() {
        let plan = plan_for(
            &["renovate-wait-10d", "security"],
            "2026-04-30T12:00:00Z",
            3,
        );

        assert_eq!(plan.wait_days, 0);
        assert_eq!(plan.status, CheckStatus::Success);
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
    fn default_wait_days_applies_when_no_label_matches() {
        let plan = plan_for(&["renovate"], "2026-04-28T12:00:00Z", 4);

        assert_eq!(plan.wait_days, 4);
        assert_eq!(plan.status, CheckStatus::Pending);
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
    fn pending_and_success_boundaries() {
        let pending = plan_for(&["renovate-wait-3d"], "2026-04-27T12:00:01Z", 1);
        let success = plan_for(&["renovate-wait-3d"], "2026-04-27T12:00:00Z", 1);

        assert_eq!(pending.elapsed_days, 2);
        assert_eq!(pending.status, CheckStatus::Pending);
        assert_eq!(success.elapsed_days, 3);
        assert_eq!(success.status, CheckStatus::Success);
    }

    #[test]
    fn malformed_payload_is_reported_without_panic() {
        let error = decide_from_slice(br#"{"action":"opened"}"#, now(), 3).unwrap_err();

        assert!(matches!(error, DecisionError::InvalidJson(_)));
    }

    #[test]
    fn invalid_created_at_is_reported_without_panic() {
        let error = decide_from_slice(
            &payload("opened", "renovate/example", "not-a-date", &[]),
            now(),
            3,
        )
        .unwrap_err();

        assert_eq!(
            error,
            DecisionError::InvalidCreatedAt("not-a-date".to_string())
        );
    }

    #[test]
    fn check_run_bodies_match_expected_api_shape() {
        let pending = plan_for(&["renovate-wait-3d"], "2026-04-28T12:00:00Z", 1);
        let success = plan_for(&["security"], "2026-04-30T12:00:00Z", 3);

        assert_eq!(check_run_body(&pending)["status"], "in_progress");
        assert_eq!(
            check_run_body(&pending)["output"]["title"],
            "Stability waiting period"
        );
        assert_eq!(check_run_body(&success)["status"], "completed");
        assert_eq!(check_run_body(&success)["conclusion"], "success");
    }
}
