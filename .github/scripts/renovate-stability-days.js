const crypto = require("node:crypto");
const fs = require("node:fs");

const CUSTOM_CHECK_NAME = "custom-stability-days";
const BUILTIN_STABILITY_CHECK_NAME = "renovate/stability-days";
const SECURITY_LABEL = "security";
const WAIT_LABEL_PREFIX = "renovate-wait-";
const WAIT_LABEL_SUFFIX = "d";
const STATE_TOKEN_MARKER_PREFIX = "<!-- custom-stability-days-jwt:";
const STATE_TOKEN_MARKER_SUFFIX = " -->";
const INITIAL_QUEUE_SUMMARY =
	"Waiting for the Renovate follow-up workflow to resolve release metadata.";
const BUILTIN_CHECK_SUMMARY =
	"Renovate's built-in stability-days check exists on this commit.";
const BUILTIN_CHECK_PENDING_SUMMARY =
	"Renovate's built-in stability-days check has not passed on this commit yet.";

const normalizeSharedSecret = (secret = "") => {
	if (typeof secret !== "string") {
		return "";
	}

	const normalizedLineEndings = secret.replace(/\r\n/g, "\n");
	return normalizedLineEndings.includes("\\n") &&
		!normalizedLineEndings.includes("\n")
		? normalizedLineEndings.replace(/\\n/g, "\n")
		: normalizedLineEndings;
};

const parseJsonLine = (line) => {
	if (typeof line !== "string" || line.trim().length === 0) {
		return null;
	}

	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
};

const parseRenovateJsonLogs = (content = "") =>
	String(content).split(/\r?\n/).map(parseJsonLine).filter(Boolean);

const readRenovateJsonLogs = ({ logFile } = {}) => {
	if (typeof logFile !== "string" || logFile.trim().length === 0) {
		return [];
	}

	try {
		return parseRenovateJsonLogs(fs.readFileSync(logFile, "utf8"));
	} catch {
		return [];
	}
};

const fetchLabelNames = async ({ github, owner, repo, issueNumber } = {}) => {
	const labelsResponse = await github.request(
		"GET /repos/{owner}/{repo}/issues/{issue_number}/labels",
		{
			owner,
			repo,
			issue_number: issueNumber,
			per_page: 100,
			headers: {
				accept: "application/vnd.github+json",
			},
		},
	);
	return labelsResponse.data.map((label) => label.name);
};

const encodeBase64Url = (value) =>
	Buffer.from(
		typeof value === "string" ? value : JSON.stringify(value),
	).toString("base64url");

const decodeBase64Url = (value) =>
	Buffer.from(String(value), "base64url").toString("utf8");

const createPendingStateToken = ({
	secret,
	repositoryFullName,
	prNumber,
	headSha,
	versionCreatedAt,
	now = new Date(),
} = {}) => {
	const header = encodeBase64Url({ alg: "HS256", typ: "JWT" });
	const claims = encodeBase64Url({
		repository_full_name: repositoryFullName,
		pr_number: prNumber,
		head_sha: headSha,
		version_created_at: new Date(versionCreatedAt).toISOString(),
		iat: Math.floor(now.getTime() / 1000),
	});
	const signingInput = `${header}.${claims}`;
	const signature = crypto
		.createHmac("sha256", normalizeSharedSecret(secret))
		.update(signingInput)
		.digest("base64url");

	return `${signingInput}.${signature}`;
};

const decodePendingStateToken = ({ secret, token } = {}) => {
	const [headerSegment, claimsSegment, signatureSegment, ...rest] = String(
		token ?? "",
	).split(".");
	if (
		!headerSegment ||
		!claimsSegment ||
		!signatureSegment ||
		rest.length > 0
	) {
		throw new Error("invalid pending state token format");
	}

	const expectedSignature = crypto
		.createHmac("sha256", normalizeSharedSecret(secret))
		.update(`${headerSegment}.${claimsSegment}`)
		.digest();
	const actualSignature = Buffer.from(signatureSegment, "base64url");
	if (
		actualSignature.length !== expectedSignature.length ||
		!crypto.timingSafeEqual(actualSignature, expectedSignature)
	) {
		throw new Error("invalid pending state token signature");
	}

	const header = JSON.parse(decodeBase64Url(headerSegment));
	if (header?.alg !== "HS256" || header?.typ !== "JWT") {
		throw new Error("invalid pending state token header");
	}

	const claims = JSON.parse(decodeBase64Url(claimsSegment));
	const versionCreatedAt = new Date(claims?.version_created_at);
	if (
		typeof claims?.repository_full_name !== "string" ||
		!Number.isInteger(claims?.pr_number) ||
		typeof claims?.head_sha !== "string" ||
		Number.isNaN(versionCreatedAt.getTime())
	) {
		throw new Error("invalid pending state token claims");
	}

	return {
		repository_full_name: claims.repository_full_name,
		pr_number: claims.pr_number,
		head_sha: claims.head_sha,
		version_created_at: versionCreatedAt.toISOString(),
		iat: claims.iat,
	};
};

const formatStateTokenMarker = (token) =>
	`${STATE_TOKEN_MARKER_PREFIX}${token}${STATE_TOKEN_MARKER_SUFFIX}`;

const extractStateTokenMarker = (text = "") => {
	const startIndex = String(text).indexOf(STATE_TOKEN_MARKER_PREFIX);
	if (startIndex < 0) {
		return null;
	}
	const tokenStart = startIndex + STATE_TOKEN_MARKER_PREFIX.length;
	const tokenEnd = String(text).indexOf(STATE_TOKEN_MARKER_SUFFIX, tokenStart);
	return tokenEnd < 0 ? null : String(text).slice(tokenStart, tokenEnd);
};

const parseWaitLabel = (label) => {
	if (typeof label !== "string") {
		return null;
	}

	const numericPortion = label
		.replace(WAIT_LABEL_PREFIX, "")
		.replace(WAIT_LABEL_SUFFIX, "");
	return label.startsWith(WAIT_LABEL_PREFIX) &&
		label.endsWith(WAIT_LABEL_SUFFIX) &&
		/^[1-9]\d*$/.test(numericPortion)
		? Number.parseInt(numericPortion, 10)
		: null;
};

const waitDaysForLabels = ({ labels = [], defaultWaitDays = 3 } = {}) => {
	let waitDays = null;

	for (const label of Array.isArray(labels) ? labels : []) {
		if (label === SECURITY_LABEL) {
			return 0;
		}

		if (waitDays === null) {
			waitDays = parseWaitLabel(label);
		}
	}

	return waitDays ?? defaultWaitDays;
};

const elapsedDaysFloor = ({ versionCreatedAt, now = new Date() } = {}) => {
	const createdAt = new Date(versionCreatedAt);
	const elapsedSeconds = Math.max(
		0,
		Math.floor((now.getTime() - createdAt.getTime()) / 1000),
	);
	return Math.floor(elapsedSeconds / 86400);
};

const evaluateStability = ({
	labels = [],
	defaultWaitDays = 3,
	versionCreatedAt,
	now = new Date(),
} = {}) => {
	const waitDays = waitDaysForLabels({ labels, defaultWaitDays });
	const elapsedDays = elapsedDaysFloor({ versionCreatedAt, now });
	return {
		state: elapsedDays < waitDays ? "pending" : "success",
		waitDays,
		elapsedDays,
	};
};

const buildQueuePlan = ({
	pullRequest,
	summary = INITIAL_QUEUE_SUMMARY,
} = {}) => ({
	headSha: pullRequest.head.sha,
	state: "queue",
	summary,
	text: null,
});

const buildBuiltInSuccessPlan = ({ pullRequest } = {}) => ({
	headSha: pullRequest.head.sha,
	state: "success",
	summary: BUILTIN_CHECK_SUMMARY,
	text: null,
});

const buildBuiltInPendingPlan = ({ pullRequest } = {}) => ({
	headSha: pullRequest.head.sha,
	state: "pending",
	summary: BUILTIN_CHECK_PENDING_SUMMARY,
	text: null,
});

const buildEvaluationPlan = ({
	pullRequest,
	evaluation,
	versionCreatedAt,
	token,
} = {}) => ({
	headSha: pullRequest.head.sha,
	state: evaluation.state,
	summary:
		evaluation.state === "pending"
			? `Waiting ${evaluation.waitDays} full day(s) from release timestamp ${new Date(
					versionCreatedAt,
				).toISOString()}; ${evaluation.elapsedDays} day(s) elapsed.`
			: evaluation.waitDays === 0
				? `Current labels allow this Renovate PR to pass immediately (release timestamp ${new Date(
						versionCreatedAt,
					).toISOString()}).`
				: `Required wait of ${evaluation.waitDays} full day(s) from release timestamp ${new Date(
						versionCreatedAt,
					).toISOString()} has passed (${evaluation.elapsedDays} day(s) elapsed).`,
	text: formatStateTokenMarker(token),
});

const buildCheckOutput = ({ plan } = {}) => ({
	title:
		plan.state === "queue"
			? "Waiting for release metadata"
			: plan.state === "pending"
				? "Stability waiting period"
				: "Stability waiting period passed",
	summary: plan.summary,
	text: plan.text,
});

const buildCreateCheckPayload = ({ plan } = {}) =>
	plan.state === "success"
		? {
				name: CUSTOM_CHECK_NAME,
				head_sha: plan.headSha,
				status: "completed",
				conclusion: "success",
				output: buildCheckOutput({ plan }),
			}
		: {
				name: CUSTOM_CHECK_NAME,
				head_sha: plan.headSha,
				status: plan.state === "queue" ? "queued" : "in_progress",
				output: buildCheckOutput({ plan }),
			};

const buildUpdateCheckPayload = ({ plan } = {}) =>
	plan.state === "success"
		? {
				status: "completed",
				conclusion: "success",
				output: buildCheckOutput({ plan }),
			}
		: {
				status: plan.state === "queue" ? "queued" : "in_progress",
				output: buildCheckOutput({ plan }),
			};

const collectLoggedBranchUpdates = ({
	logEntries = [],
	branchName,
	expectedLogContext,
} = {}) => {
	const normalizedBranchName = String(branchName ?? "").trim();
	if (normalizedBranchName.length === 0) {
		return [];
	}

	return [
		...new Set(
			(Array.isArray(logEntries) ? logEntries : [])
				.filter(
					(entry) =>
						entry?.msg === "processBranch()" &&
						entry?.config?.branchName === normalizedBranchName &&
						Array.isArray(entry?.config?.upgrades) &&
						(!expectedLogContext || entry?.logContext === expectedLogContext),
				)
				.flatMap((entry) => entry.config.upgrades)
				.filter(
					(upgrade) =>
						typeof upgrade?.releaseTimestamp === "string" &&
						upgrade.releaseTimestamp.trim().length > 0 &&
						!Number.isNaN(new Date(upgrade.releaseTimestamp).getTime()) &&
						(typeof upgrade?.newVersion === "string" ||
							typeof upgrade?.newValue === "string"),
				)
				.map((upgrade) => upgrade.releaseTimestamp),
		),
	];
};

const selectLoggedBranchUpdate = ({
	logEntries = [],
	branchName,
	expectedLogContext,
} = {}) => {
	const updates = collectLoggedBranchUpdates({
		logEntries,
		branchName,
		expectedLogContext,
	});

	if (updates.length === 0) {
		return {
			ok: false,
			reason:
				"No releaseTimestamp metadata for this branch was found in the Renovate JSON logs.",
		};
	}

	return {
		ok: true,
		versionCreatedAt: [...updates].sort(
			(left, right) => new Date(right).getTime() - new Date(left).getTime(),
		)[0],
	};
};

const findLatestCheckRun = ({ checkRuns = [], name } = {}) =>
	[...(Array.isArray(checkRuns) ? checkRuns : [])]
		.filter((checkRun) => checkRun?.name === name)
		.sort((left, right) => Number(right?.id ?? 0) - Number(left?.id ?? 0))[0] ??
	null;

const checkRunHasPassingConclusion = (checkRun) =>
	checkRun?.status === "completed" &&
	["success", "neutral", "skipped"].includes(
		String(checkRun?.conclusion ?? "").toLowerCase(),
	);

const validateTokenClaims = ({
	claims,
	repositoryFullName,
	prNumber,
	headSha,
} = {}) =>
	claims?.repository_full_name === repositoryFullName &&
	claims?.pr_number === prNumber &&
	claims?.head_sha === headSha;

const extractReusablePendingState = ({
	checkRun,
	secret,
	repositoryFullName,
	prNumber,
	headSha,
} = {}) => {
	const token = extractStateTokenMarker(checkRun?.output?.text);
	if (!token) {
		return null;
	}

	const claims = decodePendingStateToken({ secret, token });
	if (
		!validateTokenClaims({
			claims,
			repositoryFullName,
			prNumber,
			headSha,
		})
	) {
		throw new Error(
			"pending state token does not match the current pull request",
		);
	}

	return {
		token,
		versionCreatedAt: claims.version_created_at,
	};
};

const checkRunMatchesPlan = ({ checkRun, plan } = {}) => {
	const expectedStatus =
		plan.state === "queue"
			? "queued"
			: plan.state === "pending"
				? "in_progress"
				: "completed";
	const expectedConclusion = plan.state === "success" ? "success" : null;

	return (
		checkRun?.status === expectedStatus &&
		(checkRun?.conclusion ?? null) === expectedConclusion &&
		(checkRun?.output?.summary ?? "") === plan.summary &&
		(checkRun?.output?.text ?? null) === plan.text
	);
};

const applyCheckPlan = async ({ github, owner, repo, checkRun, plan } = {}) => {
	if (checkRun?.status === "completed" && plan.state !== "success") {
		await github.request("POST /repos/{owner}/{repo}/check-runs", {
			owner,
			repo,
			...buildCreateCheckPayload({ plan }),
		});
		return "created";
	}

	if (checkRunMatchesPlan({ checkRun, plan })) {
		return "unchanged";
	}

	if (checkRun) {
		await github.request(
			"PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
			{
				owner,
				repo,
				check_run_id: checkRun.id,
				...buildUpdateCheckPayload({ plan }),
			},
		);
		return "updated";
	}

	await github.request("POST /repos/{owner}/{repo}/check-runs", {
		owner,
		repo,
		...buildCreateCheckPayload({ plan }),
	});
	return "created";
};

const processPullRequest = async ({
	github,
	owner,
	repo,
	pullRequest,
	secret,
	renovateLogEntries = [],
	expectedLogContext,
	defaultWaitDays = 3,
	now = new Date(),
	logger = { warn() {} },
} = {}) => {
	let labelsPromise;
	const loadLabelNames = () => {
		labelsPromise ??= fetchLabelNames({
			github,
			owner,
			repo,
			issueNumber: pullRequest.number,
		});
		return labelsPromise;
	};
	const checkRuns = await (async () => {
		const results = [];
		for (let page = 1; ; page += 1) {
			const { data } = await github.request(
				"GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
				{
					owner,
					repo,
					ref: pullRequest.head.sha,
					per_page: 100,
					page,
					headers: {
						accept: "application/vnd.github+json",
					},
				},
			);
			const pageCheckRuns = data?.check_runs ?? [];
			results.push(...pageCheckRuns);
			if (pageCheckRuns.length < 100) {
				break;
			}
		}
		return results;
	})();
	const customCheckRun = findLatestCheckRun({
		checkRuns,
		name: CUSTOM_CHECK_NAME,
	});
	const builtInCheckRun = findLatestCheckRun({
		checkRuns,
		name: BUILTIN_STABILITY_CHECK_NAME,
	});

	let plan;
	if (builtInCheckRun) {
		plan = checkRunHasPassingConclusion(builtInCheckRun)
			? buildBuiltInSuccessPlan({ pullRequest })
			: buildBuiltInPendingPlan({ pullRequest });
	} else {
		let pendingState;

		if (customCheckRun) {
			try {
				pendingState = extractReusablePendingState({
					checkRun: customCheckRun,
					secret,
					repositoryFullName: `${owner}/${repo}`,
					prNumber: pullRequest.number,
					headSha: pullRequest.head.sha,
				});
				loadLabelNames();
			} catch (error) {
				logger.warn?.(
					`Ignoring reusable pending state for Renovate PR #${pullRequest.number}: ${error?.message ?? error}`,
				);
				pendingState = null;
			}
		}

		if (!pendingState) {
			const loggedUpdate = selectLoggedBranchUpdate({
				logEntries: renovateLogEntries,
				branchName: pullRequest?.head?.ref,
				expectedLogContext,
			});
			if (!loggedUpdate.ok) {
				logger.warn?.(
					`Keeping Renovate PR #${pullRequest.number} queued: ${loggedUpdate.reason}`,
				);
				plan = buildQueuePlan({
					pullRequest,
					summary: loggedUpdate.reason,
				});
			} else {
				pendingState = {
					token: createPendingStateToken({
						secret,
						repositoryFullName: `${owner}/${repo}`,
						prNumber: pullRequest.number,
						headSha: pullRequest.head.sha,
						versionCreatedAt: loggedUpdate.versionCreatedAt,
						now,
					}),
					versionCreatedAt: loggedUpdate.versionCreatedAt,
				};
				loadLabelNames();
			}
		}

		if (!plan) {
			const labelNames = await loadLabelNames();
			plan = buildEvaluationPlan({
				pullRequest,
				evaluation: evaluateStability({
					labels: labelNames,
					defaultWaitDays,
					versionCreatedAt: pendingState.versionCreatedAt,
					now,
				}),
				versionCreatedAt: pendingState.versionCreatedAt,
				token: pendingState.token,
			});
		}
	}

	const action = await applyCheckPlan({
		github,
		owner,
		repo,
		checkRun: customCheckRun,
		plan,
	});

	return {
		action,
		number: pullRequest.number,
		state: plan.state,
		summary: plan.summary,
	};
};

const processRepositoryRenovatePullRequests = async ({
	github,
	owner,
	repo,
	secret,
	renovateLogFile,
	expectedLogContext,
	defaultWaitDays = 3,
	now = new Date(),
	logger = { info() {}, warn() {} },
} = {}) => {
	const effectiveLogger = {
		info() {},
		warn() {},
		...logger,
	};
	const renovateLogEntries = readRenovateJsonLogs({
		logFile: renovateLogFile,
	});
	if (renovateLogEntries.length > 0) {
		effectiveLogger.info(
			`Loaded ${renovateLogEntries.length} Renovate JSON log entr${renovateLogEntries.length === 1 ? "y" : "ies"} from ${renovateLogFile}.`,
		);
	}

	const pullRequests = await github.paginate(
		"GET /repos/{owner}/{repo}/pulls",
		{
			owner,
			repo,
			state: "open",
			per_page: 100,
		},
	);
	const renovatePullRequests = pullRequests.filter((pullRequest) =>
		String(pullRequest?.head?.ref ?? "").startsWith("renovate/"),
	);
	const results = [];

	for (const pullRequest of renovatePullRequests) {
		const result = await processPullRequest({
			github,
			owner,
			repo,
			pullRequest,
			secret,
			renovateLogEntries,
			expectedLogContext,
			defaultWaitDays,
			now,
			logger: effectiveLogger,
		});
		effectiveLogger.info(
			`Processed Renovate PR #${result.number}: ${result.state} (${result.action}). ${result.summary}`,
		);
		results.push(result);
	}

	return results;
};

module.exports = {
	BUILTIN_STABILITY_CHECK_NAME,
	BUILTIN_CHECK_PENDING_SUMMARY,
	CUSTOM_CHECK_NAME,
	INITIAL_QUEUE_SUMMARY,
	applyCheckPlan,
	buildCheckOutput,
	buildCreateCheckPayload,
	buildEvaluationPlan,
	buildBuiltInPendingPlan,
	buildQueuePlan,
	checkRunHasPassingConclusion,
	collectLoggedBranchUpdates,
	createPendingStateToken,
	decodePendingStateToken,
	elapsedDaysFloor,
	evaluateStability,
	extractStateTokenMarker,
	extractReusablePendingState,
	findLatestCheckRun,
	fetchLabelNames,
	formatStateTokenMarker,
	normalizeSharedSecret,
	parseRenovateJsonLogs,
	parseWaitLabel,
	processPullRequest,
	processRepositoryRenovatePullRequests,
	readRenovateJsonLogs,
	selectLoggedBranchUpdate,
	waitDaysForLabels,
};
