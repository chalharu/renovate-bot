export const CHECK_NAME = "custom-stability-days";
export const BUILTIN_CHECK_NAME = "renovate/stability-days";
export const DEFAULT_WAIT_DAYS_FALLBACK = 3;

const RENOVATE_BRANCH_PREFIX = "renovate/";
const SECURITY_LABEL = "security";
const WAIT_LABEL_PREFIX = "renovate-wait-";
const WAIT_LABEL_SUFFIX = "d";
const STATE_TOKEN_MARKER_PREFIX = "<!-- custom-stability-days-jwt:";
const STATE_TOKEN_MARKER_SUFFIX = " -->";
const QUEUE_ACTIONS = ["opened", "reopened", "synchronize"] as const;
const REEVALUATE_ACTIONS = ["labeled", "unlabeled"] as const;

export interface CheckRunTarget {
	repositoryFullName: string;
	prNumber: number;
	headSha: string;
}

export interface CheckRunPlan {
	repositoryFullName: string;
	prNumber: number;
	headSha: string;
	state: CheckState;
	waitDays: number | null;
	elapsedDays: number | null;
	summary: string;
	text: string | null;
}

export type CheckState = "queue" | "pending" | "success";
export type WaitState = "pending" | "success";

export interface WaitEvaluation {
	waitDays: number;
	elapsedDays: number;
	state: WaitState;
}

export interface DefaultWaitDays {
	days: number;
	usedFallback: boolean;
}

export type Decision =
	| { type: "queue"; target: CheckRunTarget }
	| { type: "reevaluate"; target: CheckRunTarget }
	| { type: "ignore"; reason: IgnoreReason };

export type IgnoreReason =
	| { type: "unsupportedAction"; action: string }
	| { type: "nonRenovateBranch"; branch: string };

export function parseDefaultWaitDays(
	rawValue: string | undefined,
): DefaultWaitDays {
	if (rawValue !== undefined) {
		const n = parseInt(rawValue.trim(), 10);
		if (Number.isFinite(n) && n >= 1) {
			return { days: n, usedFallback: false };
		}
	}
	return { days: DEFAULT_WAIT_DAYS_FALLBACK, usedFallback: true };
}

export function decideFromPayload(payload: unknown): Decision {
	if (!isRecord(payload)) {
		throw new Error("invalid pull_request payload: missing required fields");
	}

	const repository = payload.repository;
	const pullRequest = payload.pull_request;
	const head = isRecord(pullRequest) ? pullRequest.head : null;
	if (
		typeof payload.action !== "string" ||
		!isRecord(repository) ||
		typeof repository.full_name !== "string" ||
		!isRecord(pullRequest) ||
		typeof pullRequest.number !== "number" ||
		!isRecord(head) ||
		typeof head.ref !== "string" ||
		typeof head.sha !== "string"
	) {
		throw new Error("invalid pull_request payload: missing required fields");
	}

	const event = payload as {
		action: string;
		repository: { full_name: string };
		pull_request: { number: number; head: { ref: string; sha: string } };
	};

	const branchRef = event.pull_request.head.ref;
	if (!branchRef.startsWith(RENOVATE_BRANCH_PREFIX)) {
		return {
			type: "ignore",
			reason: { type: "nonRenovateBranch", branch: branchRef },
		};
	}

	const target: CheckRunTarget = {
		repositoryFullName: event.repository.full_name,
		prNumber: event.pull_request.number,
		headSha: event.pull_request.head.sha,
	};

	const action = event.action;
	if ((QUEUE_ACTIONS as readonly string[]).includes(action)) {
		return { type: "queue", target };
	}
	if ((REEVALUATE_ACTIONS as readonly string[]).includes(action)) {
		return { type: "reevaluate", target };
	}
	return { type: "ignore", reason: { type: "unsupportedAction", action } };
}

export function waitDaysForLabels(
	labels: string[],
	defaultWaitDays: number,
): number {
	let parsedWaitDays: number | null = null;
	for (const label of labels) {
		if (label === SECURITY_LABEL) return 0;
		if (parsedWaitDays === null) {
			parsedWaitDays = parseWaitLabel(label);
		}
	}
	return parsedWaitDays ?? defaultWaitDays;
}

export function parseWaitLabel(label: string): number | null {
	if (
		!label.startsWith(WAIT_LABEL_PREFIX) ||
		!label.endsWith(WAIT_LABEL_SUFFIX)
	) {
		return null;
	}
	const middle = label.slice(
		WAIT_LABEL_PREFIX.length,
		label.length - WAIT_LABEL_SUFFIX.length,
	);
	const days = parseInt(middle, 10);
	if (Number.isNaN(days) || days < 1 || String(days) !== middle) return null;
	return days;
}

export function elapsedDaysFloor(versionCreatedAt: Date, now: Date): number {
	const elapsedSeconds = Math.max(
		0,
		Math.floor((now.getTime() - versionCreatedAt.getTime()) / 1000),
	);
	return Math.floor(elapsedSeconds / 86400);
}

export function evaluateWaitPeriod(
	labels: string[],
	defaultWaitDays: number,
	versionCreatedAt: Date,
	now: Date,
): WaitEvaluation {
	const waitDays = waitDaysForLabels(labels, defaultWaitDays);
	const elapsedDays = elapsedDaysFloor(versionCreatedAt, now);
	const state: WaitState = elapsedDays < waitDays ? "pending" : "success";
	return { waitDays, elapsedDays, state };
}

export function queuePlan(
	target: CheckRunTarget,
	summary: string,
): CheckRunPlan {
	return {
		repositoryFullName: target.repositoryFullName,
		prNumber: target.prNumber,
		headSha: target.headSha,
		state: "queue",
		waitDays: null,
		elapsedDays: null,
		summary,
		text: null,
	};
}

export function builtinSuccessPlan(
	target: CheckRunTarget,
	summary: string,
): CheckRunPlan {
	return {
		repositoryFullName: target.repositoryFullName,
		prNumber: target.prNumber,
		headSha: target.headSha,
		state: "success",
		waitDays: 0,
		elapsedDays: 0,
		summary,
		text: null,
	};
}

export function evaluatedPlan(
	target: CheckRunTarget,
	evaluation: WaitEvaluation,
	versionCreatedAt: Date,
	stateToken: string,
): CheckRunPlan {
	const versionCreatedAtText = versionCreatedAt.toISOString();
	let summary: string;
	if (evaluation.state === "pending") {
		summary = `Waiting ${evaluation.waitDays} full day(s) from release timestamp ${versionCreatedAtText}; ${evaluation.elapsedDays} day(s) elapsed.`;
	} else if (evaluation.waitDays === 0) {
		summary = `Current labels allow this Renovate PR to pass immediately (release timestamp ${versionCreatedAtText}).`;
	} else {
		summary = `Required wait of ${evaluation.waitDays} full day(s) from release timestamp ${versionCreatedAtText} has passed (${evaluation.elapsedDays} day(s) elapsed).`;
	}
	return {
		repositoryFullName: target.repositoryFullName,
		prNumber: target.prNumber,
		headSha: target.headSha,
		state: evaluation.state,
		waitDays: evaluation.waitDays,
		elapsedDays: evaluation.elapsedDays,
		summary,
		text: formatStateTokenMarker(stateToken),
	};
}

export function formatStateTokenMarker(stateToken: string): string {
	return `${STATE_TOKEN_MARKER_PREFIX}${stateToken}${STATE_TOKEN_MARKER_SUFFIX}`;
}

export function extractStateTokenMarker(text: string): string | null {
	const startIndex = text.indexOf(STATE_TOKEN_MARKER_PREFIX);
	if (startIndex === -1) return null;
	const afterPrefix = startIndex + STATE_TOKEN_MARKER_PREFIX.length;
	const endIndex = text.indexOf(STATE_TOKEN_MARKER_SUFFIX, afterPrefix);
	if (endIndex === -1) return null;
	return text.slice(afterPrefix, endIndex);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function checkRunTitle(state: CheckState): string {
	switch (state) {
		case "queue":
			return "Waiting for release metadata";
		case "pending":
			return "Stability waiting period";
		case "success":
			return "Stability waiting period passed";
	}
}

export function checkRunBody(plan: CheckRunPlan): Record<string, unknown> {
	const output = {
		title: checkRunTitle(plan.state),
		summary: plan.summary,
		text: plan.text,
	};
	switch (plan.state) {
		case "queue":
			return {
				name: CHECK_NAME,
				head_sha: plan.headSha,
				status: "queued",
				output,
			};
		case "pending":
			return {
				name: CHECK_NAME,
				head_sha: plan.headSha,
				status: "in_progress",
				output,
			};
		case "success":
			return {
				name: CHECK_NAME,
				head_sha: plan.headSha,
				status: "completed",
				conclusion: "success",
				output,
			};
	}
}

export function checkRunUpdateBody(
	plan: CheckRunPlan,
): Record<string, unknown> {
	const output = {
		title: checkRunTitle(plan.state),
		summary: plan.summary,
		text: plan.text,
	};
	switch (plan.state) {
		case "queue":
			return { status: "queued", output };
		case "pending":
			return { status: "in_progress", output };
		case "success":
			return { status: "completed", conclusion: "success", output };
	}
}

export function sentStatus(state: CheckState): string {
	switch (state) {
		case "queue":
			return "queued";
		case "pending":
			return "in_progress";
		case "success":
			return "completed/success";
	}
}
