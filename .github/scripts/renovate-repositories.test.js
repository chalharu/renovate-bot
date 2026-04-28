const assert = require("node:assert/strict");
const test = require("node:test");

const {
	buildRepositoryMatrix,
	buildRepositorySelectionMap,
	filterCandidateRepositories,
	filterEligibleRepositories,
	hasPackageJsonRenovateConfig,
	hasSupportedRenovateConfig,
	maskPrivateRepositories,
	resolveEligibleRepositorySelection,
	resolveRepositorySelection,
	toEligibleRepository,
} = require("./renovate-repositories");

test("filters to non-archived repositories for the current owner and sorts them", () => {
	const filteredRepositories = filterCandidateRepositories({
		owner: "octo-org",
		repositories: [
			{
				id: 1,
				name: "zeta",
				full_name: "octo-org/zeta",
				owner: { login: "octo-org" },
				archived: false,
				disabled: false,
			},
			{
				id: 2,
				name: "beta",
				full_name: "octo-org/beta",
				owner: { login: "octo-org" },
				archived: false,
				disabled: false,
			},
			{
				id: 2,
				name: "beta",
				full_name: "octo-org/beta",
				owner: { login: "octo-org" },
				archived: false,
				disabled: false,
			},
			{
				id: 3,
				name: "archived",
				full_name: "octo-org/archived",
				owner: { login: "octo-org" },
				archived: true,
				disabled: false,
			},
			{
				id: 4,
				name: "external",
				full_name: "another-org/external",
				owner: { login: "another-org" },
				archived: false,
				disabled: false,
			},
		],
	});

	assert.deepEqual(
		filteredRepositories.map((repository) => repository.full_name),
		["octo-org/beta", "octo-org/zeta"],
	);
});

test("detects package.json-based renovate config", () => {
	assert.equal(
		hasPackageJsonRenovateConfig({
			contentData: {
				type: "file",
				encoding: "base64",
				content: Buffer.from(
					JSON.stringify({
						name: "example",
						renovate: {
							extends: ["config:recommended"],
						},
					}),
					"utf8",
				).toString("base64"),
			},
		}),
		true,
	);
});

test("ignores package.json files without a renovate section", () => {
	assert.equal(
		hasPackageJsonRenovateConfig({
			contentData: {
				type: "file",
				encoding: "base64",
				content: Buffer.from(
					JSON.stringify({
						name: "example",
						version: "1.0.0",
					}),
					"utf8",
				).toString("base64"),
			},
		}),
		false,
	);
});

test("detects supported renovate config files across supported paths", async () => {
	const requestedPaths = [];

	const result = await hasSupportedRenovateConfig({
		github: {
			rest: {
				repos: {
					async getContent({ path }) {
						requestedPaths.push(path);
						if (path === "") {
							return {
								data: [{ name: ".github", type: "dir" }],
							};
						}

						if (path === ".github") {
							return {
								data: [{ name: "renovate.json5", type: "file" }],
							};
						}

						const error = new Error("Not Found");
						error.status = 404;
						throw error;
					},
				},
			},
		},
		repository: {
			name: "example",
			full_name: "octo-org/example",
			owner: { login: "octo-org" },
		},
	});

	assert.equal(result, true);
	assert.deepEqual(requestedPaths, ["", ".github"]);
});

test("detects supported package.json renovate config", async () => {
	const result = await hasSupportedRenovateConfig({
		github: {
			rest: {
				repos: {
					async getContent({ path }) {
						if (path === "") {
							return {
								data: [{ name: "package.json", type: "file" }],
							};
						}

						if (path === "package.json") {
							return {
								data: {
									type: "file",
									encoding: "base64",
									content: Buffer.from(
										JSON.stringify({
											name: "example",
											renovate: {
												extends: ["config:recommended"],
											},
										}),
										"utf8",
									).toString("base64"),
								},
							};
						}

						const error = new Error("Not Found");
						error.status = 404;
						throw error;
					},
				},
			},
		},
		repository: {
			name: "example",
			full_name: "octo-org/example",
			owner: { login: "octo-org" },
		},
	});

	assert.equal(result, true);
});

test("does not leak repository names when eligibility lookup fails", async () => {
	await assert.rejects(
		hasSupportedRenovateConfig({
			github: {
				rest: {
					repos: {
						async getContent() {
							const error = new Error("Forbidden");
							error.status = 403;
							throw error;
						},
					},
				},
			},
			repository: {
				name: "private-repo",
				full_name: "octo-org/private-repo",
				owner: { login: "octo-org" },
			},
		}),
		/Unable to determine repository eligibility \(status: 403\)/,
	);
});

test("filters repositories to supported renovate configs while preserving candidate rules", async () => {
	const directoryEntries = new Map([
		["octo-org/alpha:", [{ name: ".renovaterc", type: "file" }]],
		["octo-org/private-repo:", [{ name: "renovate.json", type: "file" }]],
		["octo-org/missing-config:", []],
	]);

	const filteredRepositories = await filterEligibleRepositories({
		github: {
			rest: {
				repos: {
					async getContent({ owner, repo, path }) {
						if (path === "") {
							await new Promise((resolve) =>
								setTimeout(resolve, repo === "alpha" ? 10 : 0),
							);
						}

						const entryKey = `${owner}/${repo}:${path}`;
						if (directoryEntries.has(entryKey)) {
							return { data: directoryEntries.get(entryKey) };
						}

						const error = new Error("Not Found");
						error.status = 404;
						throw error;
					},
				},
			},
		},
		owner: "octo-org",
		repositories: [
			{
				id: 3,
				name: "private-repo",
				full_name: "octo-org/private-repo",
				owner: { login: "octo-org" },
				private: true,
				archived: false,
				disabled: false,
			},
			{
				id: 1,
				name: "alpha",
				full_name: "octo-org/alpha",
				owner: { login: "octo-org" },
				private: false,
				archived: false,
				disabled: false,
			},
			{
				id: 2,
				name: "missing-config",
				full_name: "octo-org/missing-config",
				owner: { login: "octo-org" },
				private: false,
				archived: false,
				disabled: false,
			},
			{
				id: 4,
				name: "archived-with-config",
				full_name: "octo-org/archived-with-config",
				owner: { login: "octo-org" },
				private: false,
				archived: true,
				disabled: false,
			},
			{
				id: 5,
				name: "external",
				full_name: "another-org/external",
				owner: { login: "another-org" },
				private: false,
				archived: false,
				disabled: false,
			},
			{
				id: 1,
				name: "alpha",
				full_name: "octo-org/alpha",
				owner: { login: "octo-org" },
				private: false,
				archived: false,
				disabled: false,
			},
		],
	});

	assert.deepEqual(
		filteredRepositories.map((repository) => repository.full_name),
		["octo-org/alpha", "octo-org/private-repo"],
	);
});

test("builds a mixed repository matrix without exposing private repository names", () => {
	const matrix = buildRepositoryMatrix({
		repositories: [
			{
				id: 1,
				owner: "octo-org",
				repository: "public-repo",
				full_name: "octo-org/public-repo",
				private: false,
			},
			{
				id: 2,
				owner: "octo-org",
				repository: "private-repo",
				full_name: "octo-org/private-repo",
				private: true,
			},
		],
	});

	assert.deepEqual(matrix, {
		include: [{ repository: "public-repo" }, { repository_index: 1 }],
	});
});

test("masks only private repository identifiers", () => {
	const secrets = [];

	maskPrivateRepositories({
		core: {
			setSecret(value) {
				secrets.push(value);
			},
		},
		repositories: [
			{
				id: 1,
				owner: "octo-org",
				repository: "public-repo",
				full_name: "octo-org/public-repo",
				private: false,
			},
			{
				id: 2,
				owner: "octo-org",
				repository: "private-repo",
				full_name: "octo-org/private-repo",
				private: true,
			},
		],
	});

	assert.deepEqual(secrets, ["octo-org/private-repo", "private-repo"]);
});

test("builds a stable selection map for public names and private indexes", () => {
	const selectionMap = buildRepositorySelectionMap({
		repositories: [
			{
				id: 1,
				owner: "octo-org",
				repository: "public-repo",
				full_name: "octo-org/public-repo",
				private: false,
			},
			{
				id: 2,
				owner: "octo-org",
				repository: "private-repo",
				full_name: "octo-org/private-repo",
				private: true,
			},
		],
	});

	assert.deepEqual(selectionMap, [
		{ repository: "public-repo", repository_id: 1 },
		{ repository_index: 1, repository_id: 2 },
	]);
});

test("resolves public repositories from the matrix repository name", () => {
	const selectionMap = buildRepositorySelectionMap({
		repositories: [
			{
				id: 1,
				owner: "octo-org",
				repository: "public-repo",
				full_name: "octo-org/public-repo",
				private: false,
			},
			{
				id: 2,
				owner: "octo-org",
				repository: "private-repo",
				full_name: "octo-org/private-repo",
				private: true,
			},
		],
	});

	const repository = resolveRepositorySelection({
		repositories: [
			{
				id: 3,
				owner: "octo-org",
				repository: "another-public-repo",
				full_name: "octo-org/another-public-repo",
				private: false,
			},
			{
				id: 1,
				owner: "octo-org",
				repository: "public-repo",
				full_name: "octo-org/public-repo",
				private: false,
			},
			{
				id: 2,
				owner: "octo-org",
				repository: "private-repo",
				full_name: "octo-org/private-repo",
				private: true,
			},
		],
		selectionMap,
		repository: "public-repo",
	});

	assert.deepEqual(repository, {
		id: 1,
		owner: "octo-org",
		repository: "public-repo",
		full_name: "octo-org/public-repo",
		private: false,
	});
});

test("resolves private repositories from the selection map even if indexes shift", () => {
	const selectionMap = buildRepositorySelectionMap({
		repositories: [
			{
				id: 1,
				owner: "octo-org",
				repository: "public-repo",
				full_name: "octo-org/public-repo",
				private: false,
			},
			{
				id: 2,
				owner: "octo-org",
				repository: "private-repo",
				full_name: "octo-org/private-repo",
				private: true,
			},
		],
	});

	const repository = resolveRepositorySelection({
		repositories: [
			{
				id: 3,
				owner: "octo-org",
				repository: "aaa-new-private-repo",
				full_name: "octo-org/aaa-new-private-repo",
				private: true,
			},
			{
				id: 1,
				owner: "octo-org",
				repository: "public-repo",
				full_name: "octo-org/public-repo",
				private: false,
			},
			{
				id: 2,
				owner: "octo-org",
				repository: "private-repo",
				full_name: "octo-org/private-repo",
				private: true,
			},
		],
		selectionMap,
		repositoryIndex: "1",
	});

	assert.deepEqual(repository, {
		id: 2,
		owner: "octo-org",
		repository: "private-repo",
		full_name: "octo-org/private-repo",
		private: true,
	});
});

test("rejects a selected repository when its supported renovate config is missing", async () => {
	await assert.rejects(
		resolveEligibleRepositorySelection({
			github: {
				rest: {
					repos: {
						async getContent() {
							const error = new Error("Not Found");
							error.status = 404;
							throw error;
						},
					},
				},
			},
			owner: "octo-org",
			repositories: [
				{
					id: 1,
					name: "public-repo",
					full_name: "octo-org/public-repo",
					owner: { login: "octo-org" },
					private: false,
					archived: false,
					disabled: false,
				},
			],
			selectionMap: [{ repository: "public-repo", repository_id: 1 }],
			repository: "public-repo",
		}),
		/Public repository public-repo is unavailable/,
	);
});

test("rejects a selected private repository index when its supported renovate config is missing", async () => {
	await assert.rejects(
		resolveEligibleRepositorySelection({
			github: {
				rest: {
					repos: {
						async getContent({ path }) {
							if (path === "") {
								return { data: [] };
							}

							const error = new Error("Not Found");
							error.status = 404;
							throw error;
						},
					},
				},
			},
			owner: "octo-org",
			repositories: [
				{
					id: 2,
					name: "private-repo",
					full_name: "octo-org/private-repo",
					owner: { login: "octo-org" },
					private: true,
					archived: false,
					disabled: false,
				},
			],
			selectionMap: [{ repository_index: 0, repository_id: 2 }],
			repositoryIndex: "0",
		}),
		/Repository index 0 is unavailable/,
	);
});

test("rejects attempts to resolve a private repository by name", () => {
	assert.throws(
		() =>
			resolveRepositorySelection({
				repositories: [
					{
						id: 1,
						owner: "octo-org",
						repository: "private-repo",
						full_name: "octo-org/private-repo",
						private: true,
					},
				],
				selectionMap: [{ repository_index: 0, repository_id: 1 }],
				repository: "private-repo",
			}),
		/Public repository private-repo is unavailable/,
	);
});

test("converts GitHub API repositories into the persisted workflow format", () => {
	assert.deepEqual(
		toEligibleRepository({
			id: 42,
			name: "example",
			full_name: "octo-org/example",
			private: true,
			owner: { login: "octo-org" },
		}),
		{
			id: 42,
			owner: "octo-org",
			repository: "example",
			full_name: "octo-org/example",
			private: true,
		},
	);
});
