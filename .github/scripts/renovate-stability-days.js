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
	hasBuiltInCheck = false,
} = {}) => {
	if (hasBuiltInCheck) {
		return {
			state: "success",
			waitDays: 0,
			elapsedDays: 0,
		};
	}

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

const buildCreateCheckPayload = ({ plan } = {}) => {
	const output = {
		title:
			plan.state === "queue"
				? "Waiting for release metadata"
				: plan.state === "pending"
					? "Stability waiting period"
					: "Stability waiting period passed",
		summary: plan.summary,
		text: plan.text,
	};

	return plan.state === "success"
		? {
				name: CUSTOM_CHECK_NAME,
				head_sha: plan.headSha,
				status: "completed",
				conclusion: "success",
				output,
			}
		: {
				name: CUSTOM_CHECK_NAME,
				head_sha: plan.headSha,
				status: plan.state === "queue" ? "queued" : "in_progress",
				output,
			};
};

const buildUpdateCheckPayload = ({ plan } = {}) => {
	const createPayload = buildCreateCheckPayload({ plan });
	delete createPayload.name;
	delete createPayload.head_sha;
	return createPayload;
};

const extractRenovateVersion = (title = "") => {
	const match = String(title)
		.trim()
		.match(/\bto\s+([^\s)]+)\s*$/i);
	return match ? match[1] : null;
};

const decodeReleaseTag = (tag) =>
	decodeURIComponent(String(tag).replace(/\+/g, "%20"));

const extractGitHubReleaseLinks = (body = "") => {
	const matches = String(body).matchAll(
		/https:\/\/github\.com\/([^/\s)]+)\/([^/\s)]+)\/releases\/tag\/([^\s)#]+)/g,
	);

	return [
		...new Map(
			[...matches].map((match) => {
				const owner = match[1];
				const repo = match[2];
				const tag = decodeReleaseTag(match[3]);
				const htmlUrl = `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(
					tag,
				).replace(/%2F/g, "/")}`;

				return [`${owner}/${repo}#${tag}`, { owner, repo, tag, htmlUrl }];
			}),
		).values(),
	];
};

const normalizeVersion = (value) =>
	typeof value === "string" ? value.replace(/^v/i, "").trim() : "";

const selectReleaseLink = ({ title, body } = {}) => {
	const links = extractGitHubReleaseLinks(body);
	if (links.length === 0) {
		return {
			ok: false,
			reason: "No GitHub release link was found in the Renovate PR body.",
		};
	}

	const version = extractRenovateVersion(title);
	if (!version && links.length === 1) {
		return { ok: true, release: links[0] };
	}

	const matchingLinks = links.filter(
		(link) =>
			normalizeVersion(link.tag) === normalizeVersion(version) ||
			normalizeVersion(link.tag).endsWith(normalizeVersion(version)),
	);
	if (matchingLinks.length === 1) {
		return { ok: true, release: matchingLinks[0] };
	}

	if (links.length === 1) {
		return { ok: true, release: links[0] };
	}

	return {
		ok: false,
		reason:
			"Unable to resolve release metadata unambiguously from the Renovate PR body and title.",
	};
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
		...new Map(
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
						(typeof upgrade?.newVersion === "string" ||
							typeof upgrade?.newValue === "string"),
				)
				.map((upgrade) => {
					const target = upgrade.packageName ?? upgrade.depName ?? null;
					const version = upgrade.newVersion ?? upgrade.newValue ?? null;

					return [
						[
							String(target ?? ""),
							String(version ?? ""),
							String(upgrade.releaseTimestamp),
						].join("\u0000"),
						{
							target,
							version,
							versionCreatedAt: upgrade.releaseTimestamp,
						},
					];
				}),
		).values(),
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

	if (updates.length > 1) {
		return {
			ok: false,
			reason:
				"Renovate JSON logs reported multiple releaseTimestamp candidates for this branch.",
		};
	}

	return {
		ok: true,
		...updates[0],
	};
};

const resolveVersionCreatedAt = async ({
	github,
	pullRequest,
	renovateLogEntries = [],
	expectedLogContext,
} = {}) => {
	const loggedUpdate = selectLoggedBranchUpdate({
		logEntries: renovateLogEntries,
		branchName: pullRequest?.head?.ref,
		expectedLogContext,
	});
	if (loggedUpdate.ok) {
		return {
			ok: true,
			versionCreatedAt: loggedUpdate.versionCreatedAt,
			target: loggedUpdate.target,
			version: loggedUpdate.version,
			source: "renovate-log",
		};
	}

	const selectedRelease = selectReleaseLink({
		title: pullRequest?.title,
		body: pullRequest?.body,
	});
	if (!selectedRelease.ok) {
		return selectedRelease;
	}

	try {
		const response = await github.request(
			"GET /repos/{owner}/{repo}/releases/tags/{tag}",
			{
				owner: selectedRelease.release.owner,
				repo: selectedRelease.release.repo,
				tag: selectedRelease.release.tag,
				headers: {
					accept: "application/vnd.github+json",
				},
			},
		);
		const versionCreatedAt =
			response?.data?.published_at ?? response?.data?.created_at ?? null;
		if (!versionCreatedAt) {
			return {
				ok: false,
				reason:
					"The selected GitHub release does not expose published_at or created_at metadata.",
			};
		}

		return {
			ok: true,
			versionCreatedAt,
			target: null,
			version: extractRenovateVersion(pullRequest?.title),
			htmlUrl: selectedRelease.release.htmlUrl,
			source: "release-link",
		};
	} catch (error) {
		return {
			ok: false,
			reason: `${loggedUpdate.reason} Failed to fetch release metadata (status: ${error?.status ?? "unknown"}).`,
		};
	}
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
} = {}) => {
	const [labelsResponse, checkRuns] = await Promise.all([
		github.request("GET /repos/{owner}/{repo}/issues/{issue_number}/labels", {
			owner,
			repo,
			issue_number: pullRequest.number,
			per_page: 100,
			headers: {
				accept: "application/vnd.github+json",
			},
		}),
		(async () => {
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
		})(),
	]);
	const labelNames = labelsResponse.data.map((label) => label.name);
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
			} catch {
				pendingState = null;
			}
		}

		if (!pendingState) {
			const resolvedMetadata = await resolveVersionCreatedAt({
				github,
				pullRequest,
				renovateLogEntries,
				expectedLogContext,
			});
			if (!resolvedMetadata.ok) {
				plan = buildQueuePlan({
					pullRequest,
					summary: resolvedMetadata.reason,
				});
			} else {
				pendingState = {
					token: createPendingStateToken({
						secret,
						repositoryFullName: `${owner}/${repo}`,
						prNumber: pullRequest.number,
						headSha: pullRequest.head.sha,
						versionCreatedAt: resolvedMetadata.versionCreatedAt,
						now,
					}),
					versionCreatedAt: resolvedMetadata.versionCreatedAt,
				};
			}
		}

		if (!plan) {
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
	logger = { info() {} },
} = {}) => {
	const renovateLogEntries = readRenovateJsonLogs({
		logFile: renovateLogFile,
	});
	if (renovateLogEntries.length > 0) {
		logger.info(
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
		});
		logger.info(
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
	extractGitHubReleaseLinks,
	extractRenovateVersion,
	extractStateTokenMarker,
	extractReusablePendingState,
	findLatestCheckRun,
	formatStateTokenMarker,
	normalizeSharedSecret,
	parseRenovateJsonLogs,
	parseWaitLabel,
	processPullRequest,
	processRepositoryRenovatePullRequests,
	readRenovateJsonLogs,
	resolveVersionCreatedAt,
	selectReleaseLink,
	selectLoggedBranchUpdate,
	waitDaysForLabels,
};
