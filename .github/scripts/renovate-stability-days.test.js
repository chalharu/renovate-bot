const assert = require("node:assert/strict");
const test = require("node:test");

const {
	BUILTIN_STABILITY_CHECK_NAME,
	CUSTOM_CHECK_NAME,
	INITIAL_QUEUE_SUMMARY,
	NO_RELEASE_METADATA_SUMMARY,
	createPendingStateToken,
	decodePendingStateToken,
	extractPrBodyStateTokenMarker,
	extractStateTokenMarker,
	extractReusablePendingState,
	formatPrBodyStateTokenMarker,
	formatStateTokenMarker,
	parseRenovateJsonLogs,
	processPullRequest,
	processRepositoryRenovatePullRequests,
	selectLoggedBranchUpdate,
	upsertPrBodyStateTokenMarker,
	waitDaysForLabels,
} = require("./renovate-stability-days");

test("creates reusable pending state tokens with normalized shared secrets", () => {
	const token = createPendingStateToken({
		secret: "line-1\nline-2",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: "abc123",
		versionCreatedAt: "2026-04-28T12:00:00Z",
		now: new Date("2026-05-01T12:00:00Z"),
	});

	assert.deepEqual(
		decodePendingStateToken({
			secret: "line-1\\nline-2",
			token,
		}),
		{
			repository_full_name: "octo-org/example",
			pr_number: 42,
			head_sha: "abc123",
			version: undefined,
			version_created_at: "2026-04-28T12:00:00.000Z",
			iat: 1777636800,
		},
	);
});

test("selects branch release metadata from Renovate JSON logs", () => {
	const logEntries = parseRenovateJsonLogs(`
{"logContext":"octo-org/example","msg":"processBranch()","config":{"branchName":"renovate/example","upgrades":[{"depName":"ghcr.io/example/dependency","packageName":"ghcr.io/example/dependency","newVersion":"1.2.3","releaseTimestamp":"2026-04-28T12:00:00Z"}]}}
{"logContext":"octo-org/example","msg":"processBranch()","config":{"branchName":"renovate/other","upgrades":[{"depName":"ghcr.io/example/other","newVersion":"2.0.0","releaseTimestamp":"2026-04-29T12:00:00Z"}]}}
`);

	assert.deepEqual(
		selectLoggedBranchUpdate({
			logEntries,
			branchName: "renovate/example",
			expectedLogContext: "octo-org/example",
		}),
		{
			ok: true,
			version: "1.2.3",
			versionCreatedAt: "2026-04-28T12:00:00Z",
		},
	);
});

test("uses the most recent release timestamp for grouped renovate branches", () => {
	const logEntries = parseRenovateJsonLogs(`
{"logContext":"octo-org/example","msg":"processBranch()","config":{"branchName":"renovate/example","upgrades":[{"depName":"ghcr.io/example/dependency-a","newVersion":"1.2.3","releaseTimestamp":"2026-04-28T12:00:00Z"},{"depName":"ghcr.io/example/dependency-b","newVersion":"4.5.6","releaseTimestamp":"2026-04-30T12:00:00Z"},{"depName":"ghcr.io/example/dependency-c","releaseTimestamp":"2026-05-01T12:00:00Z"}]}}
`);

	assert.deepEqual(
		selectLoggedBranchUpdate({
			logEntries,
			branchName: "renovate/example",
			expectedLogContext: "octo-org/example",
		}),
		{
			ok: true,
			version: "4.5.6",
			versionCreatedAt: "2026-04-30T12:00:00Z",
		},
	);
});

test("formats and extracts signed PR body state token markers", () => {
	const marker = formatPrBodyStateTokenMarker("signed.jwt.token");

	assert.equal(
		marker,
		"<!-- custom-stability-days-pr-state-jwt:signed.jwt.token -->",
	);
	assert.equal(
		extractPrBodyStateTokenMarker(`Human body\n\n${marker}\n`),
		"signed.jwt.token",
	);
	assert.equal(extractPrBodyStateTokenMarker("no marker"), null);
});

test("upserts signed PR body state token markers", () => {
	const existingBody = `Human body.

<!-- custom-stability-days-pr-state-jwt:old.token -->`;
	const malformedBody = `Human body.

<!-- custom-stability-days-pr-state-jwt:broken.token
Trailing Renovate content.`;
	const repairedBody = upsertPrBodyStateTokenMarker({
		body: malformedBody,
		token: "new.token",
	});

	assert.equal(
		upsertPrBodyStateTokenMarker({
			body: "Human body.",
			token: "new.token",
		}),
		`Human body.

<!-- custom-stability-days-pr-state-jwt:new.token -->`,
	);
	assert.equal(
		upsertPrBodyStateTokenMarker({
			body: existingBody,
			token: "new.token",
		}),
		`Human body.

<!-- custom-stability-days-pr-state-jwt:new.token -->`,
	);
	assert.equal(
		upsertPrBodyStateTokenMarker({
			body: "",
			token: "new.token",
		}),
		"<!-- custom-stability-days-pr-state-jwt:new.token -->",
	);
	assert.equal(
		repairedBody,
		`Human body.

<!-- custom-stability-days-pr-state-jwt:broken.token
Trailing Renovate content.

<!-- custom-stability-days-pr-state-jwt:new.token -->`,
	);
	assert.equal(extractPrBodyStateTokenMarker(repairedBody), "new.token");
});

test("reuses a valid pending state token from the current custom check", () => {
	const token = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: "abc123",
		versionCreatedAt: "2026-04-28T12:00:00Z",
	});
	const reusableState = extractReusablePendingState({
		checkRun: {
			output: {
				text: `visible ${formatStateTokenMarker(token)}`,
			},
		},
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: "abc123",
	});

	assert.deepEqual(reusableState, {
		token,
		version: undefined,
		versionCreatedAt: "2026-04-28T12:00:00.000Z",
	});
});

test("reuses an existing pending token when Renovate metadata matches it", async () => {
	const calls = [];
	const token = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: "abc123",
		version: "1.2.3",
		versionCreatedAt: "2026-04-28T12:00:00Z",
		now: new Date("2026-04-28T12:00:00Z"),
	});
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") {
				return {
					data: [{ name: "renovate-wait-3d" }],
				};
			}
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs: [
							{
								id: 7,
								name: CUSTOM_CHECK_NAME,
								status: "in_progress",
								conclusion: null,
								output: {
									summary: "pending",
									text: formatStateTokenMarker(token),
								},
							},
						],
					},
				};
			}
			if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
				return { data: {} };
			}
			if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") {
				return { data: {} };
			}

			throw new Error(`Unexpected route: ${route}`);
		},
	};

	const result = await processPullRequest({
		github,
		owner: "octo-org",
		repo: "example",
		pullRequest: {
			number: 42,
			title: "Update dependency example/dependency to v1.2.3",
			body: "",
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		renovateLogEntries: parseRenovateJsonLogs(`
{"logContext":"octo-org/example","msg":"processBranch()","config":{"branchName":"renovate/example","upgrades":[{"depName":"ghcr.io/example/dependency","newVersion":"1.2.3","releaseTimestamp":"2026-04-28T12:00:00Z"}]}}
`),
		expectedLogContext: "octo-org/example",
		now: new Date("2026-05-01T12:00:00Z"),
	});

	assert.equal(result.state, "success");
	assert.equal(
		calls.at(-1).route,
		"PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
	);
	assert.equal(calls.at(-1).params.status, "completed");
	assert.equal(calls.at(-1).params.conclusion, "success");
});

test("refreshes the pending token when Renovate metadata resolves to a different version", async () => {
	const calls = [];
	const token = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: "abc123",
		version: "1.2.3",
		versionCreatedAt: "2026-04-28T12:00:00Z",
		now: new Date("2026-04-28T12:00:00Z"),
	});
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") {
				return {
					data: [{ name: "renovate-wait-3d" }],
				};
			}
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs: [
							{
								id: 7,
								name: CUSTOM_CHECK_NAME,
								status: "in_progress",
								conclusion: null,
								output: {
									summary: "pending",
									text: formatStateTokenMarker(token),
								},
							},
						],
					},
				};
			}
			if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
				return { data: {} };
			}
			if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") {
				return { data: {} };
			}

			throw new Error(`Unexpected route: ${route}`);
		},
	};

	const result = await processPullRequest({
		github,
		owner: "octo-org",
		repo: "example",
		pullRequest: {
			number: 42,
			title: "Update dependency example/dependency to v4.5.6",
			body: "",
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		renovateLogEntries: parseRenovateJsonLogs(`
{"logContext":"octo-org/example","msg":"processBranch()","config":{"branchName":"renovate/example","upgrades":[{"depName":"ghcr.io/example/dependency","newVersion":"4.5.6","releaseTimestamp":"2026-04-30T12:00:00Z"}]}}
`),
		expectedLogContext: "octo-org/example",
		now: new Date("2026-05-01T12:00:00Z"),
	});

	assert.equal(result.state, "pending");
	assert.equal(
		calls.at(-1).route,
		"PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
	);
	assert.notEqual(
		calls.at(-1).params.output.text,
		formatStateTokenMarker(token),
	);
	assert.equal(
		decodePendingStateToken({
			secret: "secret",
			token: extractStateTokenMarker(calls.at(-1).params.output.text),
		}).version,
		"4.5.6",
	);
});

test("creates a fresh pending check from Renovate JSON logs on the first pass", async () => {
	const calls = [];
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs: [],
					},
				};
			}
			if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") {
				return {
					data: [{ name: "renovate-wait-3d" }],
				};
			}
			if (route === "POST /repos/{owner}/{repo}/check-runs") {
				return { data: {} };
			}
			if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") {
				return { data: {} };
			}

			throw new Error(`Unexpected route: ${route}`);
		},
	};

	const result = await processPullRequest({
		github,
		owner: "octo-org",
		repo: "example",
		pullRequest: {
			number: 42,
			title: "Update dependency example/dependency to v1.2.3",
			body: "",
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		renovateLogEntries: parseRenovateJsonLogs(`
{"logContext":"octo-org/example","msg":"processBranch()","config":{"branchName":"renovate/example","upgrades":[{"depName":"ghcr.io/example/dependency","newVersion":"1.2.3","releaseTimestamp":"2026-04-30T12:00:00Z"}]}}
`),
		expectedLogContext: "octo-org/example",
		now: new Date("2026-05-01T12:00:00Z"),
	});

	assert.equal(result.state, "pending");
	const prBodyPatch = calls.find(
		({ route }) => route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
	);
	assert.ok(prBodyPatch);
	assert.match(
		prBodyPatch.params.body,
		/<!-- custom-stability-days-pr-state-jwt:/,
	);
	assert.deepEqual(
		decodePendingStateToken({
			secret: "secret",
			token: extractPrBodyStateTokenMarker(prBodyPatch.params.body),
		}),
		{
			repository_full_name: "octo-org/example",
			pr_number: 42,
			head_sha: "abc123",
			version: "1.2.3",
			version_created_at: "2026-04-30T12:00:00.000Z",
			iat: 1777636800,
		},
	);
	assert.equal(calls.at(-1).route, "POST /repos/{owner}/{repo}/check-runs");
	assert.equal(calls.at(-1).params.status, "in_progress");
	assert.match(
		calls.at(-1).params.output.text,
		/<!-- custom-stability-days-jwt:/,
	);
	assert.deepEqual(
		decodePendingStateToken({
			secret: "secret",
			token: extractStateTokenMarker(calls.at(-1).params.output.text),
		}),
		{
			repository_full_name: "octo-org/example",
			pr_number: 42,
			head_sha: "abc123",
			version: "1.2.3",
			version_created_at: "2026-04-30T12:00:00.000Z",
			iat: 1777636800,
		},
	);
});

test("uses signed PR body state when JSON logs are missing", async () => {
	const calls = [];
	const token = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: "abc123",
		version: "1.2.3",
		versionCreatedAt: "2026-04-28T12:00:00Z",
		now: new Date("2026-04-28T12:00:00Z"),
	});
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs: [],
					},
				};
			}
			if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") {
				return {
					data: [{ name: "renovate-wait-3d" }],
				};
			}
			if (route === "POST /repos/{owner}/{repo}/check-runs") {
				return { data: {} };
			}

			throw new Error(`Unexpected route: ${route}`);
		},
	};

	const result = await processPullRequest({
		github,
		owner: "octo-org",
		repo: "example",
		pullRequest: {
			number: 42,
			title: "Update dependency example/dependency to v1.2.3",
			body: formatPrBodyStateTokenMarker(token),
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		now: new Date("2026-05-01T12:00:00Z"),
	});

	assert.equal(result.state, "success");
	assert.match(
		result.summary,
		/Required wait of 3 full day\(s\) from release timestamp 2026-04-28T12:00:00.000Z has passed/,
	);
	assert.equal(calls.at(-1).route, "POST /repos/{owner}/{repo}/check-runs");
	assert.equal(calls.at(-1).params.status, "completed");
	assert.equal(calls.at(-1).params.conclusion, "success");
	assert.equal(calls.at(-1).params.output.text, formatStateTokenMarker(token));
	assert.deepEqual(
		decodePendingStateToken({
			secret: "secret",
			token: extractStateTokenMarker(calls.at(-1).params.output.text),
		}),
		{
			repository_full_name: "octo-org/example",
			pr_number: 42,
			head_sha: "abc123",
			version: "1.2.3",
			version_created_at: "2026-04-28T12:00:00.000Z",
			iat: 1777377600,
		},
	);
});

test("ignores tampered signed PR body state and queues without other metadata", async () => {
	const calls = [];
	const warnings = [];
	const token = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: "abc123",
		version: "1.2.3",
		versionCreatedAt: "2026-04-28T12:00:00Z",
		now: new Date("2026-04-28T12:00:00Z"),
	});
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs: [],
					},
				};
			}
			if (route === "POST /repos/{owner}/{repo}/check-runs") {
				return { data: {} };
			}

			throw new Error(`Unexpected route: ${route}`);
		},
	};

	const result = await processPullRequest({
		github,
		owner: "octo-org",
		repo: "example",
		pullRequest: {
			number: 42,
			title: "Update dependency example/dependency",
			body: formatPrBodyStateTokenMarker(`${token}tampered`),
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		logger: {
			warn(message) {
				warnings.push(message);
			},
		},
		now: new Date("2026-05-01T12:00:00Z"),
	});

	assert.equal(result.state, "queue");
	assert.equal(result.summary, NO_RELEASE_METADATA_SUMMARY);
	assert.equal(calls.at(-1).route, "POST /repos/{owner}/{repo}/check-runs");
	assert.equal(calls.at(-1).params.status, "queued");
	assert.equal(calls.at(-1).params.output.text, null);
	assert.equal(warnings.length, 2);
	assert.match(warnings[0], /Ignoring signed PR body state/);
	assert.match(warnings[1], /Keeping Renovate PR #42 queued/);
});

test("queues when logs, signed PR body state, and versioned tokens are missing", async () => {
	const calls = [];
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs: [],
					},
				};
			}
			if (route === "POST /repos/{owner}/{repo}/check-runs") {
				return { data: {} };
			}

			throw new Error(`Unexpected route: ${route}`);
		},
	};

	const result = await processPullRequest({
		github,
		owner: "octo-org",
		repo: "example",
		pullRequest: {
			number: 42,
			title: "Update dependency example/dependency",
			body: "",
			created_at: "2026-04-28T12:00:00Z",
			updated_at: "2026-05-01T12:00:00Z",
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		now: new Date("2026-05-01T12:00:00Z"),
	});

	assert.equal(result.state, "queue");
	assert.equal(result.summary, NO_RELEASE_METADATA_SUMMARY);
	assert.equal(calls.at(-1).route, "POST /repos/{owner}/{repo}/check-runs");
	assert.equal(calls.at(-1).params.status, "queued");
	assert.equal(calls.at(-1).params.output.text, null);
});

test("refreshes an existing no-version legacy token from signed PR body state", async () => {
	const calls = [];
	const token = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: "abc123",
		versionCreatedAt: "2026-05-01T12:00:00Z",
		now: new Date("2026-05-01T12:00:00Z"),
	});
	const prBodyToken = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: "abc123",
		version: "1.2.3",
		versionCreatedAt: "2026-04-28T12:00:00Z",
		now: new Date("2026-04-28T12:00:00Z"),
	});
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs: [
							{
								id: 7,
								name: CUSTOM_CHECK_NAME,
								status: "in_progress",
								conclusion: null,
								output: {
									summary: "pending",
									text: formatStateTokenMarker(token),
								},
							},
						],
					},
				};
			}
			if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") {
				return {
					data: [{ name: "renovate-wait-3d" }],
				};
			}
			if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
				return { data: {} };
			}

			throw new Error(`Unexpected route: ${route}`);
		},
	};

	const result = await processPullRequest({
		github,
		owner: "octo-org",
		repo: "example",
		pullRequest: {
			number: 42,
			title: "Update dependency example/dependency to v1.2.3",
			body: formatPrBodyStateTokenMarker(prBodyToken),
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		now: new Date("2026-05-01T12:00:00Z"),
	});

	assert.equal(result.state, "success");
	assert.equal(
		calls.at(-1).route,
		"PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
	);
	assert.equal(calls.at(-1).params.status, "completed");
	assert.equal(calls.at(-1).params.conclusion, "success");
	assert.notEqual(
		calls.at(-1).params.output.text,
		formatStateTokenMarker(token),
	);
	assert.equal(
		calls.at(-1).params.output.text,
		formatStateTokenMarker(prBodyToken),
	);
	assert.deepEqual(
		decodePendingStateToken({
			secret: "secret",
			token: extractStateTokenMarker(calls.at(-1).params.output.text),
		}),
		{
			repository_full_name: "octo-org/example",
			pr_number: 42,
			head_sha: "abc123",
			version: "1.2.3",
			version_created_at: "2026-04-28T12:00:00.000Z",
			iat: 1777377600,
		},
	);
});

test("reuses a versioned token when Renovate logs are missing", async () => {
	const calls = [];
	const token = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: "abc123",
		version: "1.2.3",
		versionCreatedAt: "2026-04-30T12:00:00Z",
		now: new Date("2026-04-30T12:00:00Z"),
	});
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs: [
							{
								id: 7,
								name: CUSTOM_CHECK_NAME,
								status: "in_progress",
								conclusion: null,
								output: {
									summary: "pending",
									text: formatStateTokenMarker(token),
								},
							},
						],
					},
				};
			}
			if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") {
				return {
					data: [{ name: "renovate-wait-3d" }],
				};
			}
			if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
				return { data: {} };
			}

			throw new Error(`Unexpected route: ${route}`);
		},
	};

	const result = await processPullRequest({
		github,
		owner: "octo-org",
		repo: "example",
		pullRequest: {
			number: 42,
			title: "Update dependency example/dependency to v1.2.3",
			body: "",
			created_at: "2026-04-26T12:00:00Z",
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		now: new Date("2026-05-01T12:00:00Z"),
	});

	assert.equal(result.state, "pending");
	assert.equal(
		calls.at(-1).route,
		"PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
	);
	assert.equal(calls.at(-1).params.status, "in_progress");
	assert.equal(calls.at(-1).params.output.text, formatStateTokenMarker(token));
	assert.deepEqual(
		decodePendingStateToken({
			secret: "secret",
			token: extractStateTokenMarker(calls.at(-1).params.output.text),
		}),
		{
			repository_full_name: "octo-org/example",
			pr_number: 42,
			head_sha: "abc123",
			version: "1.2.3",
			version_created_at: "2026-04-30T12:00:00.000Z",
			iat: 1777550400,
		},
	);
});

test("creates a fresh pending check when a completed success must be downgraded after label changes", async () => {
	const calls = [];
	const token = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: "abc123",
		version: "1.2.3",
		versionCreatedAt: "2026-04-30T12:00:00Z",
	});
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") {
				return {
					data: [{ name: "renovate-wait-3d" }],
				};
			}
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs: [
							{
								id: 7,
								name: CUSTOM_CHECK_NAME,
								status: "completed",
								conclusion: "success",
								output: {
									summary: "success",
									text: formatStateTokenMarker(token),
								},
							},
						],
					},
				};
			}
			if (route === "POST /repos/{owner}/{repo}/check-runs") {
				return { data: {} };
			}

			throw new Error(`Unexpected route: ${route}`);
		},
	};

	const result = await processPullRequest({
		github,
		owner: "octo-org",
		repo: "example",
		pullRequest: {
			number: 42,
			title: "Update dependency example/dependency to v1.2.3",
			body: "",
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		now: new Date("2026-05-01T11:59:59Z"),
	});

	assert.equal(result.state, "pending");
	assert.equal(calls.at(-1).route, "POST /repos/{owner}/{repo}/check-runs");
	assert.equal(calls.at(-1).params.status, "in_progress");
});

test("short-circuits to success when the built-in renovate check exists", async () => {
	const calls = [];
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs: [
							{
								id: 11,
								name: BUILTIN_STABILITY_CHECK_NAME,
								status: "completed",
								conclusion: "success",
								output: {
									summary: "builtin",
									text: null,
								},
							},
							{
								id: 10,
								name: CUSTOM_CHECK_NAME,
								status: "queued",
								conclusion: null,
								output: {
									summary: INITIAL_QUEUE_SUMMARY,
									text: null,
								},
							},
						],
					},
				};
			}
			if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
				return { data: {} };
			}

			throw new Error(`Unexpected route: ${route}`);
		},
	};

	const result = await processPullRequest({
		github,
		owner: "octo-org",
		repo: "example",
		pullRequest: {
			number: 42,
			title: "Update dependency example/dependency to v1.2.3",
			body: "",
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		now: new Date("2026-05-01T12:00:00Z"),
	});

	assert.equal(result.state, "success");
	assert.match(result.summary, /built-in stability-days check exists/);
	assert.equal(
		calls.at(-1).route,
		"PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
	);
	assert.equal(calls.at(-1).params.conclusion, "success");
});

test("keeps the custom check pending while the built-in renovate check is still pending", async () => {
	const calls = [];
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs: [
							{
								id: 11,
								name: BUILTIN_STABILITY_CHECK_NAME,
								status: "in_progress",
								conclusion: null,
								output: {
									summary: "builtin pending",
									text: null,
								},
							},
							{
								id: 10,
								name: CUSTOM_CHECK_NAME,
								status: "queued",
								conclusion: null,
								output: {
									summary: INITIAL_QUEUE_SUMMARY,
									text: null,
								},
							},
						],
					},
				};
			}
			if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
				return { data: {} };
			}

			throw new Error(`Unexpected route: ${route}`);
		},
	};

	const result = await processPullRequest({
		github,
		owner: "octo-org",
		repo: "example",
		pullRequest: {
			number: 42,
			title: "Update dependency example/dependency to v1.2.3",
			body: "",
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		now: new Date("2026-05-01T12:00:00Z"),
	});

	assert.equal(result.state, "pending");
	assert.equal(
		calls.at(-1).route,
		"PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
	);
	assert.equal(calls.at(-1).params.status, "in_progress");
});

test("paginates check-run lookups until it finds relevant built-in checks", async () => {
	const calls = [];
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs:
							params.page === 1
								? Array.from({ length: 100 }, (_, index) => ({
										id: index + 1,
										name: `other-${index + 1}`,
										status: "completed",
										conclusion: "success",
										output: {
											summary: "other",
											text: null,
										},
									}))
								: [
										{
											id: 101,
											name: BUILTIN_STABILITY_CHECK_NAME,
											status: "completed",
											conclusion: "success",
											output: {
												summary: "builtin",
												text: null,
											},
										},
									],
					},
				};
			}
			if (route === "POST /repos/{owner}/{repo}/check-runs") {
				return { data: {} };
			}

			throw new Error(`Unexpected route: ${route}`);
		},
	};

	const result = await processPullRequest({
		github,
		owner: "octo-org",
		repo: "example",
		pullRequest: {
			number: 42,
			title: "Update dependency example/dependency",
			body: "",
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		now: new Date("2026-05-01T12:00:00Z"),
	});

	assert.equal(result.state, "success");
	assert.equal(
		calls.filter(
			({ route }) =>
				route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
		).length,
		2,
	);
	assert.equal(calls.at(-1).route, "POST /repos/{owner}/{repo}/check-runs");
	assert.equal(calls.at(-1).params.conclusion, "success");
});

test("processes only renovate pull requests when scanning a repository", async () => {
	const messages = [];
	const token = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 1,
		headSha: "abc123",
		versionCreatedAt: "2026-04-28T12:00:00Z",
	});
	const github = {
		async paginate() {
			return [
				{
					number: 1,
					title: "Update dependency example/dependency to v1.2.3",
					body: "",
					head: {
						ref: "renovate/example",
						sha: "abc123",
					},
				},
				{
					number: 2,
					title: "Feature branch",
					body: "",
					head: {
						ref: "feature/example",
						sha: "def456",
					},
				},
			];
		},
		async request(route) {
			if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") {
				return { data: [{ name: "renovate-wait-3d" }] };
			}
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs: [
							{
								id: 7,
								name: CUSTOM_CHECK_NAME,
								status: "in_progress",
								conclusion: null,
								output: {
									summary: "pending",
									text: formatStateTokenMarker(token),
								},
							},
						],
					},
				};
			}
			if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
				return { data: {} };
			}

			throw new Error(`Unexpected route: ${route}`);
		},
	};

	const results = await processRepositoryRenovatePullRequests({
		github,
		owner: "octo-org",
		repo: "example",
		secret: "secret",
		now: new Date("2026-05-01T12:00:00Z"),
		logger: {
			info(message) {
				messages.push(message);
			},
		},
	});

	assert.equal(results.length, 1);
	assert.equal(messages.length, 1);
	assert.equal(
		waitDaysForLabels({ labels: ["renovate", "renovate-wait-5d"] }),
		5,
	);
});

test("warns when a reusable pending token can no longer be decoded", async () => {
	const warnings = [];
	const github = {
		async request(route) {
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs: [
							{
								id: 7,
								name: CUSTOM_CHECK_NAME,
								status: "in_progress",
								conclusion: null,
								output: {
									summary: "pending",
									text: formatStateTokenMarker("not-a-valid-token"),
								},
							},
						],
					},
				};
			}
			if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
				return { data: {} };
			}

			throw new Error(`Unexpected route: ${route}`);
		},
	};

	const result = await processPullRequest({
		github,
		owner: "octo-org",
		repo: "example",
		pullRequest: {
			number: 42,
			title: "Update dependency example/dependency",
			body: "",
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		logger: {
			warn(message) {
				warnings.push(message);
			},
		},
		now: new Date("2026-05-01T12:00:00Z"),
	});

	assert.equal(result.state, "queue");
	assert.equal(warnings.length, 2);
	assert.match(warnings[0], /Ignoring reusable pending state/);
	assert.match(warnings[1], /Keeping Renovate PR #42 queued/);
});
