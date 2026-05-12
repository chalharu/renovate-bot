const assert = require("node:assert/strict");
const test = require("node:test");

const {
	BUILTIN_STABILITY_CHECK_NAME,
	CUSTOM_CHECK_NAME,
	INITIAL_QUEUE_SUMMARY,
	NO_RELEASE_METADATA_SUMMARY,
	createPendingStateToken,
	decodePendingStateToken,
	extractStateTokenMarker,
	extractReusablePendingState,
	formatStateTokenMarker,
	parseRenovateJsonLogs,
	processPullRequest,
	processRepositoryRenovatePullRequests,
	selectLoggedBranchUpdate,
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

test("uses updated_at from Renovate logs when releaseTimestamp is missing", () => {
	const logEntries = parseRenovateJsonLogs(`
{"logContext":"octo-org/example","msg":"processBranch()","config":{"branchName":"renovate/example","upgrades":[{"depName":"ghcr.io/example/dependency","newVersion":"1.2.3","updated_at":"2026-04-28T12:00:00Z"}]}}
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
			if (
				route === "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline"
			) {
				return {
					data: [],
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
	assert.equal(
		calls.some(
			({ route }) =>
				route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
		),
		false,
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

test("uses PR updated_at fallback when JSON logs and check state are missing", async () => {
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
			if (
				route === "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline"
			) {
				return {
					data: [],
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
			body: "",
			created_at: "2026-04-01T12:00:00Z",
			updated_at: "2026-04-28T12:00:00Z",
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
			version: undefined,
			version_created_at: "2026-04-28T12:00:00.000Z",
			iat: 1777636800,
		},
	);
});

test("uses PR updated_at fallback when PR created_at is missing", async () => {
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
			if (
				route === "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline"
			) {
				return {
					data: [],
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
			body: "",
			updated_at: "2026-04-28T12:00:00Z",
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
	assert.deepEqual(
		decodePendingStateToken({
			secret: "secret",
			token: extractStateTokenMarker(calls.at(-1).params.output.text),
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

test("queues when logs, check state, and PR timestamps are missing", async () => {
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
			if (
				route === "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline"
			) {
				return {
					data: [],
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

	assert.equal(result.state, "queue");
	assert.equal(result.summary, NO_RELEASE_METADATA_SUMMARY);
	assert.equal(calls.at(-1).route, "POST /repos/{owner}/{repo}/check-runs");
	assert.equal(calls.at(-1).params.status, "queued");
	assert.ok(!("text" in calls.at(-1).params.output));
});

test("reuses an existing no-version check token when logs are missing", async () => {
	const calls = [];
	const token = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: "abc123",
		versionCreatedAt: "2026-05-01T12:00:00Z",
		now: new Date("2026-05-01T12:00:00Z"),
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
			if (
				route === "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline"
			) {
				return {
					data: [],
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
			updated_at: "2026-04-28T12:00:00Z",
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
			version: undefined,
			version_created_at: "2026-05-01T12:00:00.000Z",
			iat: 1777636800,
		},
	);
});

test("skips non-marker historical checks and reissues versioned historical state", async () => {
	const calls = [];
	const currentSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
	const nonMarkerSha = "cccccccccccccccccccccccccccccccccccccccc";
	const versionlessSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
	const staleVersionSha = "dddddddddddddddddddddddddddddddddddddddd";
	const historicalSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const currentToken = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: currentSha,
		versionCreatedAt: "2026-05-11T14:30:37Z",
		now: new Date("2026-05-11T14:30:37Z"),
	});
	const historicalToken = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: historicalSha,
		version: "1.2.3",
		versionCreatedAt: "2026-05-08T09:22:50Z",
		now: new Date("2026-05-08T09:22:50Z"),
	});
	const staleVersionToken = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: staleVersionSha,
		version: "9.9.9",
		versionCreatedAt: "2026-05-01T09:22:50Z",
		now: new Date("2026-05-01T09:22:50Z"),
	});
	const versionlessToken = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: versionlessSha,
		versionCreatedAt: "2026-05-01T09:22:50Z",
		now: new Date("2026-05-01T09:22:50Z"),
	});
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				if (params.ref === currentSha) {
					return {
						data: {
							check_runs: [
								{
									id: 7,
									name: CUSTOM_CHECK_NAME,
									head_sha: currentSha,
									status: "in_progress",
									conclusion: null,
									output: {
										summary: "current fallback",
										text: formatStateTokenMarker(currentToken),
									},
								},
							],
						},
					};
				}
				if (params.ref === nonMarkerSha) {
					return {
						data: {
							check_runs: [
								{
									id: 2,
									name: CUSTOM_CHECK_NAME,
									head_sha: nonMarkerSha,
									status: "in_progress",
									conclusion: null,
									output: {
										summary: "historical output without marker",
										text: "no signed state marker here",
									},
								},
							],
						},
					};
				}
				if (params.ref === versionlessSha) {
					return {
						data: {
							check_runs: [
								{
									id: 8,
									name: CUSTOM_CHECK_NAME,
									head_sha: versionlessSha,
									status: "completed",
									conclusion: "success",
									output: {
										summary: "versionless historical state",
										text: formatStateTokenMarker(versionlessToken),
									},
								},
							],
						},
					};
				}
				if (params.ref === staleVersionSha) {
					return {
						data: {
							check_runs: [
								{
									id: 9,
									name: CUSTOM_CHECK_NAME,
									head_sha: staleVersionSha,
									status: "completed",
									conclusion: "success",
									output: {
										summary: "stale version",
										text: formatStateTokenMarker(staleVersionToken),
									},
								},
							],
						},
					};
				}
				if (params.ref === historicalSha) {
					return {
						data: {
							check_runs: [
								{
									id: 4,
									name: CUSTOM_CHECK_NAME,
									head_sha: historicalSha,
									status: "in_progress",
									conclusion: null,
									output: {
										summary: "newer historical output without marker",
										text: "no signed state marker here",
									},
								},
								{
									id: 3,
									name: CUSTOM_CHECK_NAME,
									head_sha: historicalSha,
									status: "in_progress",
									conclusion: null,
									output: {
										summary: "historical fallback",
										text: formatStateTokenMarker(historicalToken),
									},
								},
							],
						},
					};
				}
			}
			if (
				route === "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline"
			) {
				return {
					data: [
						{
							event: "head_ref_force_pushed",
							commit_id: nonMarkerSha,
						},
						{
							event: "head_ref_force_pushed",
							commit_id: versionlessSha,
						},
						{
							event: "head_ref_force_pushed",
							commit_id: staleVersionSha,
						},
						{
							event: "head_ref_force_pushed",
							commit_id: historicalSha,
						},
						{
							event: "head_ref_force_pushed",
							commit_id: currentSha,
						},
					],
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
			updated_at: "2026-05-11T14:30:37Z",
			head: {
				ref: "renovate/example",
				sha: currentSha,
			},
		},
		secret: "secret",
		now: new Date("2026-05-11T09:22:50Z"),
	});

	assert.equal(result.state, "success");
	assert.match(
		result.summary,
		/Required wait of 3 full day\(s\) from release timestamp 2026-05-08T09:22:50.000Z has passed/,
	);
	assert.equal(
		calls.at(-1).route,
		"PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
	);
	assert.equal(calls.at(-1).params.status, "completed");
	assert.equal(calls.at(-1).params.conclusion, "success");
	const claims = decodePendingStateToken({
		secret: "secret",
		token: extractStateTokenMarker(calls.at(-1).params.output.text),
	});
	assert.equal(claims.head_sha, currentSha);
	assert.equal(claims.version, "1.2.3");
	assert.equal(claims.version_created_at, "2026-05-08T09:22:50.000Z");
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
	assert.match(result.summary, /built-in stability-days check\/status exists/);
	assert.equal(
		calls.at(-1).route,
		"PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
	);
	assert.equal(calls.at(-1).params.conclusion, "success");
	assert.ok(!("text" in calls.at(-1).params.output));
});

test("short-circuits to success when the built-in renovate status context succeeds", async () => {
	const calls = [];
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs: [
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
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/status") {
				return {
					data: {
						statuses: [
							{
								id: 20,
								context: BUILTIN_STABILITY_CHECK_NAME,
								state: "pending",
								description:
									"Updates have not met minimum release age requirement",
								updated_at: "2026-05-01T12:00:00Z",
							},
							{
								id: 21,
								context: BUILTIN_STABILITY_CHECK_NAME,
								state: "success",
								description: null,
								updated_at: "2026-05-02T12:00:00Z",
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
			statuses_url:
				"https://api.github.com/repos/octo-org/example/statuses/abc123",
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		now: new Date("2026-05-03T12:00:00Z"),
	});

	assert.equal(result.state, "success");
	assert.match(result.summary, /built-in stability-days check\/status exists/);
	assert.equal(
		calls.at(-1).route,
		"PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
	);
	assert.equal(calls.at(-1).params.conclusion, "success");
	assert.ok(!("text" in calls.at(-1).params.output));
});

test("prefers a built-in renovate check over a conflicting status context", async () => {
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
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/status") {
				return {
					data: {
						statuses: [
							{
								id: 20,
								context: BUILTIN_STABILITY_CHECK_NAME,
								state: "success",
								description: null,
								updated_at: "2026-05-02T12:00:00Z",
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
			statuses_url:
				"https://api.github.com/repos/octo-org/example/statuses/abc123",
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		now: new Date("2026-05-03T12:00:00Z"),
	});

	assert.equal(result.state, "pending");
	assert.equal(
		calls.at(-1).route,
		"PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
	);
	assert.equal(calls.at(-1).params.status, "in_progress");
	assert.ok(!("text" in calls.at(-1).params.output));
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
	assert.ok(!("text" in calls.at(-1).params.output));
});

test("keeps the custom check pending while the built-in renovate status context is still pending", async () => {
	const calls = [];
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
				return {
					data: {
						check_runs: [
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
			if (route === "GET /repos/{owner}/{repo}/commits/{ref}/status") {
				return {
					data: {
						statuses: [
							{
								id: 20,
								context: BUILTIN_STABILITY_CHECK_NAME,
								state: "pending",
								description: null,
								updated_at: "2026-05-02T12:00:00Z",
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
			statuses_url:
				"https://api.github.com/repos/octo-org/example/statuses/abc123",
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		now: new Date("2026-05-03T12:00:00Z"),
	});

	assert.equal(result.state, "pending");
	assert.equal(
		calls.at(-1).route,
		"PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
	);
	assert.equal(calls.at(-1).params.status, "in_progress");
	assert.ok(!("text" in calls.at(-1).params.output));
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
			if (
				route === "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline"
			) {
				return { data: [] };
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
			if (
				route === "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline"
			) {
				return { data: [] };
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
