const assert = require("node:assert/strict");
const test = require("node:test");

const {
	buildRepositoryMatrix,
	buildRepositorySelectionMap,
	filterCandidateRepositories,
	maskPrivateRepositories,
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
