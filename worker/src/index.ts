import {
	BUILTIN_CHECK_NAME,
	builtinSuccessPlan,
	CHECK_NAME,
	type CheckRunPlan,
	type CheckRunTarget,
	checkRunBody,
	checkRunUpdateBody,
	type Decision,
	decideFromPayload,
	evaluatedPlan,
	evaluateWaitPeriod,
	extractStateTokenMarker,
	type IgnoreReason,
	parseDefaultWaitDays,
	queuePlan,
	sentStatus,
} from "./decision.js";
import { createGithubAppJwt } from "./github_app.js";
import { verifyGithubWebhook } from "./signature.js";
import {
	decodeStateToken,
	type PendingStateTokenClaims,
} from "./state_token.js";

export interface Env {
	GITHUB_APP_WEBHOOK_SECRET?: string;
	GITHUB_APP_CLIENT_ID?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
	DEFAULT_WAIT_DAYS?: string;
}

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "custom-stability-days-worker";
const CHECK_RUNS_PAGE_SIZE = 100;
const INITIAL_QUEUE_SUMMARY =
	"Waiting for the Renovate follow-up workflow to resolve release metadata.";
const INVALID_METADATA_SUMMARY =
	"Pending state metadata could not be validated; waiting for the Renovate follow-up workflow to refresh it.";
const BUILTIN_CHECK_SUMMARY =
	"Renovate's built-in stability-days check/status exists on this commit.";
const BUILTIN_CHECK_PENDING_SUMMARY =
	"Renovate's built-in stability-days check/status has not passed on this commit yet.";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("method not allowed", { status: 405 });
		}

		const signatureHeader = request.headers.get("X-Hub-Signature-256");
		let body: Uint8Array;
		try {
			body = new Uint8Array(await request.arrayBuffer());
		} catch (error) {
			console.error("Failed to read webhook body:", error);
			return new Response("OK");
		}

		const webhookResult = await verifyGithubWebhook(
			env.GITHUB_APP_WEBHOOK_SECRET,
			body,
			signatureHeader,
		);
		if (!webhookResult.ok) {
			if (webhookResult.error === "missing_secret") {
				console.error("GITHUB_APP_WEBHOOK_SECRET is not configured.");
				return new Response("server misconfigured", { status: 500 });
			}
			console.error("Invalid or missing GitHub webhook signature.");
			return new Response("invalid webhook signature", { status: 401 });
		}

		const eventHeader = request.headers.get("X-GitHub-Event");
		if (eventHeader !== "pull_request") {
			console.log(
				`Ignoring webhook event ${JSON.stringify(eventHeader)}; only pull_request is supported.`,
			);
			return new Response("OK");
		}

		const defaultWait = parseDefaultWaitDays(env.DEFAULT_WAIT_DAYS);
		if (defaultWait.usedFallback) {
			console.log(
				`DEFAULT_WAIT_DAYS is missing or invalid; using safe fallback of ${defaultWait.days} days.`,
			);
		}

		let payload: unknown;
		try {
			payload = JSON.parse(new TextDecoder().decode(body));
		} catch (error) {
			console.error("Webhook payload could not be processed:", error);
			return new Response("OK");
		}

		let decision: Decision;
		try {
			decision = decideFromPayload(payload);
		} catch (error) {
			console.error("Webhook payload could not be processed:", error);
			return new Response("OK");
		}

		if (decision.type === "ignore") {
			logIgnored(decision.reason);
			return new Response("OK");
		}

		const target = decision.target;
		// Truncate to second precision to match the Rust implementation.
		const now = new Date(Math.floor(Date.now() / 1000) * 1000);

		const clientId = env.GITHUB_APP_CLIENT_ID;
		if (!clientId) {
			console.error("GITHUB_APP_CLIENT_ID is not configured");
			return new Response("OK");
		}
		const privateKey = env.GITHUB_APP_PRIVATE_KEY;
		if (!privateKey) {
			console.error("GITHUB_APP_PRIVATE_KEY is not configured");
			return new Response("OK");
		}

		let appJwt: string;
		try {
			appJwt = await createGithubAppJwt(clientId, privateKey, now);
		} catch (error) {
			console.error("Failed to create GitHub App JWT:", error);
			return new Response("OK");
		}

		let installation: { id: number };
		try {
			installation = await githubJsonRequest<{ id: number }>(
				"GET",
				`${GITHUB_API_BASE}/repos/${target.repositoryFullName}/installation`,
				appJwt,
			);
		} catch (error) {
			console.error(
				`Failed to resolve installation for repository=${target.repositoryFullName}:`,
				error,
			);
			return new Response("OK");
		}

		let installationToken: { token: string };
		try {
			installationToken = await githubJsonRequest<{ token: string }>(
				"POST",
				`${GITHUB_API_BASE}/app/installations/${installation.id}/access_tokens`,
				appJwt,
				{},
			);
		} catch (error) {
			console.error(
				`Failed to create installation token for repository=${target.repositoryFullName}:`,
				error,
			);
			return new Response("OK");
		}

		let plannedCheckRun: {
			plan: CheckRunPlan;
			existingCheckRun: CheckRun | null;
		};
		try {
			plannedCheckRun = await buildCheckRunPlan(
				decision,
				target,
				installationToken.token,
				privateKey,
				defaultWait.days,
				now,
			);
		} catch (error) {
			console.error(
				`Failed to build check-run repository=${target.repositoryFullName} pr=${target.prNumber}:`,
				error,
			);
			return new Response("OK");
		}

		try {
			await ensureCheckRun(
				plannedCheckRun.plan,
				plannedCheckRun.existingCheckRun,
				installationToken.token,
			);
		} catch (error) {
			console.error(
				`Failed to send check-run repository=${plannedCheckRun.plan.repositoryFullName} ` +
					`pr=${plannedCheckRun.plan.prNumber} ` +
					`status=${sentStatus(plannedCheckRun.plan.state)}:`,
				error,
			);
			return new Response("OK");
		}

		console.log(
			`Sent check-run repository=${plannedCheckRun.plan.repositoryFullName} ` +
				`pr=${plannedCheckRun.plan.prNumber} ` +
				`status=${sentStatus(plannedCheckRun.plan.state)}`,
		);
		return new Response("OK");
	},
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function logIgnored(reason: IgnoreReason): void {
	if (reason.type === "unsupportedAction") {
		console.log(`Ignoring unsupported pull_request action=${reason.action}`);
	} else {
		console.log(`Ignoring non-Renovate pull_request branch=${reason.branch}`);
	}
}

async function buildCheckRunPlan(
	decision: Decision,
	target: CheckRunTarget,
	installationToken: string,
	privateKey: string,
	defaultWaitDays: number,
	now: Date,
): Promise<{ plan: CheckRunPlan; existingCheckRun: CheckRun | null }> {
	if (decision.type === "queue") {
		const existingCheckRun = await latestCustomCheckRun(
			target.repositoryFullName,
			target.headSha,
			installationToken,
		);
		return { plan: queuePlan(target, INITIAL_QUEUE_SUMMARY), existingCheckRun };
	}

	if (decision.type === "reevaluate") {
		return reevaluateCheckRun(
			target,
			installationToken,
			privateKey,
			defaultWaitDays,
			now,
		);
	}

	throw new Error("ignored webhook decisions should not be executed");
}

async function reevaluateCheckRun(
	target: CheckRunTarget,
	installationToken: string,
	sharedSecret: string,
	defaultWaitDays: number,
	now: Date,
): Promise<{ plan: CheckRunPlan; existingCheckRun: CheckRun | null }> {
	const checkRuns = await listCheckRuns(
		target.repositoryFullName,
		target.headSha,
		installationToken,
	);
	const commitStatuses = await listCommitStatuses(
		target.repositoryFullName,
		target.headSha,
		installationToken,
	);

	const existingCheckRun = findLatestCheckRun(checkRuns, CHECK_NAME);

	// If the built-in Renovate stability-days check/status exists, mirror it.
	const builtInCheckRun = findLatestCheckRun(checkRuns, BUILTIN_CHECK_NAME);
	const builtInCommitStatus = findLatestCommitStatus(
		commitStatuses,
		BUILTIN_CHECK_NAME,
	);

	if (builtInCheckRun || builtInCommitStatus) {
		const plan = builtInStabilityStatusHasPassed(
			builtInCheckRun,
			builtInCommitStatus,
		)
			? builtinSuccessPlan(target, BUILTIN_CHECK_SUMMARY)
			: builtinPendingPlan(target);
		return { plan, existingCheckRun };
	}

	// Extract the pending-state token from the most recent custom check run.
	const extracted = await extractLatestPendingStateAsync(
		checkRuns,
		sharedSecret,
		target,
	);
	if (!extracted) {
		return {
			plan: queuePlan(target, INVALID_METADATA_SUMMARY),
			existingCheckRun,
		};
	}
	const { stateToken, claims } = extracted;

	const labels = await getIssueLabels(
		target.repositoryFullName,
		target.prNumber,
		installationToken,
	);
	const versionCreatedAt = new Date(claims.version_created_at);
	const evaluation = evaluateWaitPeriod(
		labels,
		defaultWaitDays,
		versionCreatedAt,
		now,
	);

	return {
		plan: evaluatedPlan(target, evaluation, versionCreatedAt, stateToken),
		existingCheckRun,
	};
}

async function extractLatestPendingStateAsync(
	checkRuns: CheckRun[],
	sharedSecret: string,
	target: CheckRunTarget,
): Promise<{ stateToken: string; claims: PendingStateTokenClaims } | null> {
	const checkRun = findLatestCheckRun(checkRuns, CHECK_NAME);
	if (!checkRun?.output?.text) return null;

	const stateToken = extractStateTokenMarker(checkRun.output.text);
	if (!stateToken) return null;

	let claims: PendingStateTokenClaims;
	try {
		claims = await decodeStateToken(sharedSecret, stateToken);
	} catch (error) {
		console.log(
			`Ignoring invalid pending state token ` +
				`repository=${target.repositoryFullName} pr=${target.prNumber}: ${error}`,
		);
		return null;
	}

	if (
		claims.repository_full_name !== target.repositoryFullName ||
		claims.pr_number !== target.prNumber ||
		claims.head_sha !== target.headSha
	) {
		console.log(
			`Ignoring mismatched pending state token ` +
				`repository=${target.repositoryFullName} pr=${target.prNumber}`,
		);
		return null;
	}

	return { stateToken, claims };
}

async function ensureCheckRun(
	plan: CheckRunPlan,
	existingCheckRun: CheckRun | null,
	installationToken: string,
): Promise<void> {
	if (existingCheckRun?.status === "completed" && plan.state !== "success") {
		await postCheckRun(plan, installationToken);
		return;
	}
	if (existingCheckRun && checkRunMatchesPlan(existingCheckRun, plan)) {
		return; // No-op: already up to date.
	}
	if (existingCheckRun) {
		await patchCheckRun(
			plan.repositoryFullName,
			existingCheckRun.id,
			plan,
			installationToken,
		);
		return;
	}
	await postCheckRun(plan, installationToken);
}

function checkRunMatchesPlan(checkRun: CheckRun, plan: CheckRunPlan): boolean {
	const expectedStatus =
		plan.state === "queue"
			? "queued"
			: plan.state === "pending"
				? "in_progress"
				: "completed";
	const expectedConclusion = plan.state === "success" ? "success" : null;
	if (!checkRun.output) return false;
	return (
		checkRun.status === expectedStatus &&
		(checkRun.conclusion ?? null) === expectedConclusion &&
		checkRun.output.summary === plan.summary &&
		(checkRun.output.text ?? null) === plan.text
	);
}

function checkRunHasPassingConclusion(checkRun: CheckRun): boolean {
	return (
		checkRun.status === "completed" &&
		["success", "neutral", "skipped"].includes(
			String(checkRun.conclusion ?? "").toLowerCase(),
		)
	);
}

function commitStatusHasPassingState(status: CommitStatus): boolean {
	return status.state.toLowerCase() === "success";
}

function builtInStabilityStatusHasPassed(
	checkRun: CheckRun | null,
	commitStatus: CommitStatus | null,
): boolean {
	return Boolean(
		(checkRun && checkRunHasPassingConclusion(checkRun)) ||
			(commitStatus && commitStatusHasPassingState(commitStatus)),
	);
}

function builtinPendingPlan(target: CheckRunTarget): CheckRunPlan {
	return {
		repositoryFullName: target.repositoryFullName,
		prNumber: target.prNumber,
		headSha: target.headSha,
		state: "pending",
		waitDays: null,
		elapsedDays: null,
		summary: BUILTIN_CHECK_PENDING_SUMMARY,
		text: null,
	};
}

async function latestCustomCheckRun(
	repositoryFullName: string,
	headSha: string,
	installationToken: string,
): Promise<CheckRun | null> {
	const checkRuns = await listCheckRuns(
		repositoryFullName,
		headSha,
		installationToken,
	);
	return findLatestCheckRun(checkRuns, CHECK_NAME);
}

function findLatestCheckRun(
	checkRuns: CheckRun[],
	name: string,
): CheckRun | null {
	let latest: CheckRun | null = null;
	for (const checkRun of checkRuns) {
		if (checkRun.name !== name) continue;
		if (!latest || checkRun.id > latest.id) {
			latest = checkRun;
		}
	}
	return latest;
}

function findLatestCommitStatus(
	statuses: CommitStatus[],
	context: string,
): CommitStatus | null {
	let latest: CommitStatus | null = null;
	for (const status of statuses) {
		if (status.context !== context) continue;
		if (
			!latest ||
			new Date(status.updated_at ?? status.created_at).getTime() >
				new Date(latest.updated_at ?? latest.created_at).getTime()
		) {
			latest = status;
		}
	}
	return latest;
}

async function listCheckRuns(
	repositoryFullName: string,
	headSha: string,
	installationToken: string,
): Promise<CheckRun[]> {
	const all: CheckRun[] = [];
	for (let page = 1; ; page++) {
		const url =
			`${GITHUB_API_BASE}/repos/${repositoryFullName}/commits/${headSha}/check-runs` +
			`?per_page=${CHECK_RUNS_PAGE_SIZE}&page=${page}`;
		const response = await githubJsonRequest<{ check_runs: CheckRun[] }>(
			"GET",
			url,
			installationToken,
		);
		const pageRuns = response.check_runs ?? [];
		all.push(...pageRuns);
		if (pageRuns.length < CHECK_RUNS_PAGE_SIZE) break;
	}
	return all;
}

async function listCommitStatuses(
	repositoryFullName: string,
	headSha: string,
	installationToken: string,
): Promise<CommitStatus[]> {
	const all: CommitStatus[] = [];
	for (let page = 1; ; page++) {
		const url =
			`${GITHUB_API_BASE}/repos/${repositoryFullName}/commits/${headSha}/statuses` +
			`?per_page=${CHECK_RUNS_PAGE_SIZE}&page=${page}`;
		const pageStatuses =
			(await githubJsonRequest<CommitStatus[]>(
				"GET",
				url,
				installationToken,
			)) ?? [];
		all.push(...pageStatuses);
		if (pageStatuses.length < CHECK_RUNS_PAGE_SIZE) break;
	}
	return all;
}

async function getIssueLabels(
	repositoryFullName: string,
	issueNumber: number,
	installationToken: string,
): Promise<string[]> {
	const issue = await githubJsonRequest<{ labels: { name: string }[] }>(
		"GET",
		`${GITHUB_API_BASE}/repos/${repositoryFullName}/issues/${issueNumber}`,
		installationToken,
	);
	return (issue.labels ?? []).map((l) => l.name);
}

async function postCheckRun(
	plan: CheckRunPlan,
	installationToken: string,
): Promise<void> {
	await githubJsonRequest(
		"POST",
		`${GITHUB_API_BASE}/repos/${plan.repositoryFullName}/check-runs`,
		installationToken,
		checkRunBody(plan),
	);
}

async function patchCheckRun(
	repositoryFullName: string,
	checkRunId: number,
	plan: CheckRunPlan,
	installationToken: string,
): Promise<void> {
	await githubJsonRequest(
		"PATCH",
		`${GITHUB_API_BASE}/repos/${repositoryFullName}/check-runs/${checkRunId}`,
		installationToken,
		checkRunUpdateBody(plan),
	);
}

async function githubJsonRequest<T = unknown>(
	method: string,
	url: string,
	bearerToken: string,
	body?: unknown,
): Promise<T> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${bearerToken}`,
		Accept: "application/vnd.github+json",
		"Content-Type": "application/json",
		"User-Agent": USER_AGENT,
	};

	const response = await fetch(url, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`GitHub API returned HTTP ${response.status}: ${text}`);
	}
	return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// GitHub API response shapes
// ---------------------------------------------------------------------------

interface CheckRun {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	output: { summary: string; text?: string | null } | null;
}

interface CommitStatus {
	context: string;
	state: string;
	created_at: string;
	updated_at?: string;
}
