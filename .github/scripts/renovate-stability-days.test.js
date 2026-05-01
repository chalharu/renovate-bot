const assert = require("node:assert/strict");
const test = require("node:test");

const {
	BUILTIN_STABILITY_CHECK_NAME,
	CUSTOM_CHECK_NAME,
	INITIAL_QUEUE_SUMMARY,
	createPendingStateToken,
	decodePendingStateToken,
	extractGitHubReleaseLinks,
	extractReusablePendingState,
	formatStateTokenMarker,
	parseRenovateJsonLogs,
	processPullRequest,
	processRepositoryRenovatePullRequests,
	resolveVersionCreatedAt,
	selectReleaseLink,
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
			version_created_at: "2026-04-28T12:00:00.000Z",
			iat: 1777636800,
		},
	);
});

test("extracts GitHub release links and uses the title to disambiguate", () => {
	const body = [
		"- [Release Notes](https://github.com/example/dependency/releases/tag/v1.2.3)",
		"- [Release Notes](https://github.com/example/dependency/releases/tag/v1.2.2)",
	].join("\n");

	assert.deepEqual(extractGitHubReleaseLinks(body), [
		{
			owner: "example",
			repo: "dependency",
			tag: "v1.2.3",
			htmlUrl: "https://github.com/example/dependency/releases/tag/v1.2.3",
		},
		{
			owner: "example",
			repo: "dependency",
			tag: "v1.2.2",
			htmlUrl: "https://github.com/example/dependency/releases/tag/v1.2.2",
		},
	]);
	assert.deepEqual(
		selectReleaseLink({
			title: "Update dependency example/dependency to v1.2.3",
			body,
		}),
		{
			ok: true,
			release: {
				owner: "example",
				repo: "dependency",
				tag: "v1.2.3",
				htmlUrl: "https://github.com/example/dependency/releases/tag/v1.2.3",
			},
		},
	);
	assert.deepEqual(
		selectReleaseLink({
			title: "Update dependency example/dependency",
			body,
		}),
		{
			ok: false,
			reason:
				"Unable to resolve release metadata unambiguously from the Renovate PR body and title.",
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
			target: "ghcr.io/example/dependency",
			version: "1.2.3",
			versionCreatedAt: "2026-04-28T12:00:00Z",
		},
	);
});

test("prefers Renovate JSON logs over release-link lookup", async () => {
	const result = await resolveVersionCreatedAt({
		github: {
			async request() {
				throw new Error("release lookup should not be needed");
			},
		},
		pullRequest: {
			title: "Update dependency ghcr.io/example/dependency to v1.2.3",
			body: "",
			head: {
				ref: "renovate/example",
			},
		},
		renovateLogEntries: parseRenovateJsonLogs(`
{"logContext":"octo-org/example","msg":"processBranch()","config":{"branchName":"renovate/example","upgrades":[{"depName":"ghcr.io/example/dependency","packageName":"ghcr.io/example/dependency","newVersion":"1.2.3","releaseTimestamp":"2026-04-28T12:00:00Z"}]}}
`),
		expectedLogContext: "octo-org/example",
	});

	assert.deepEqual(result, {
		ok: true,
		source: "renovate-log",
		target: "ghcr.io/example/dependency",
		version: "1.2.3",
		versionCreatedAt: "2026-04-28T12:00:00Z",
	});
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
		versionCreatedAt: "2026-04-28T12:00:00.000Z",
	});
});

test("moves an existing pending custom check to success without refetching release metadata", async () => {
	const calls = [];
	const token = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: "abc123",
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
		now: new Date("2026-05-01T12:00:00Z"),
	});

	assert.equal(result.state, "success");
	assert.equal(
		calls.some(
			({ route }) => route === "GET /repos/{owner}/{repo}/releases/tags/{tag}",
		),
		false,
	);
	assert.equal(
		calls.at(-1).route,
		"PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
	);
	assert.equal(calls.at(-1).params.status, "completed");
	assert.equal(calls.at(-1).params.conclusion, "success");
});

test("keeps the custom check queued when release metadata cannot be resolved", async () => {
	const calls = [];
	const github = {
		async request(route, params) {
			calls.push({ route, params });
			if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") {
				return {
					data: [{ name: "renovate" }],
				};
			}
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
			head: {
				ref: "renovate/example",
				sha: "abc123",
			},
		},
		secret: "secret",
		now: new Date("2026-05-01T12:00:00Z"),
	});

	assert.equal(result.state, "queue");
	assert.match(result.summary, /No GitHub release link was found/);
	assert.equal(calls.at(-1).route, "POST /repos/{owner}/{repo}/check-runs");
	assert.equal(calls.at(-1).params.status, "queued");
});

test("creates a fresh pending check when a completed success must be downgraded after label changes", async () => {
	const calls = [];
	const token = createPendingStateToken({
		secret: "secret",
		repositoryFullName: "octo-org/example",
		prNumber: 42,
		headSha: "abc123",
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
			if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/labels") {
				return {
					data: [{ name: "renovate-wait-3d" }],
				};
			}
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
