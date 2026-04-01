const assert = require("node:assert/strict");
const test = require("node:test");

const {
	evaluateInactiveBranch,
	inferInactiveBranchMetadata,
} = require("./renovate-merge-gate-inactive-branch");

const buildDepStates = ({
	currentVersion = "v4.3.0",
	sourceUrl = "https://github.com/actions/checkout",
	branches = [
		{
			updateType: "patch",
			newVersion: "v4.3.2",
		},
	],
} = {}) =>
	new Map([
		[
			"actions-checkout",
			{
				currentVersion,
				sourceUrl,
				branches,
			},
		],
	]);

test("parses the current branch topic format without an update type segment", () => {
	const metadata = inferInactiveBranchMetadata(
		"renovate/actions-checkout__vv4.3.1",
	);

	assert.deepEqual(metadata, {
		depKey: "actions-checkout",
		updateType: null,
		targetVersion: "v4.3.1",
		targetDigestShort: null,
	});
});

test("keeps legacy branch topics parseable for backward compatibility", () => {
	const metadata = inferInactiveBranchMetadata(
		"renovate/actions-checkout__patch__vv4.3.1",
	);

	assert.deepEqual(metadata, {
		depKey: "actions-checkout",
		updateType: "patch",
		targetVersion: "v4.3.1",
		targetDigestShort: null,
	});
});

test("keeps superseded patch PRs open for the current branch topic format", async () => {
	const decision = await evaluateInactiveBranch({
		pullRequest: {
			head: {
				ref: "renovate/actions-checkout__vv4.3.1",
			},
		},
		depStates: buildDepStates(),
		tagExistsForVersion: async () => true,
	});

	assert.deepEqual(decision, {
		keep: true,
		reason:
			"custom separateMultiplePatch keeps v4.3.1 open while newer patch updates remain available",
	});
});

test("autocloses branches that do not encode a target version", async () => {
	const decision = await evaluateInactiveBranch({
		pullRequest: {
			head: {
				ref: "renovate/actions-checkout",
			},
		},
		depStates: buildDepStates(),
	});

	assert.deepEqual(decision, {
		keep: false,
		reason: "the branch is no longer active in the latest Renovate run",
	});
});

test("autocloses branches when the current version already caught up", async () => {
	const decision = await evaluateInactiveBranch({
		pullRequest: {
			head: {
				ref: "renovate/actions-checkout__vv4.3.1",
			},
		},
		depStates: buildDepStates({
			currentVersion: "v4.3.1",
		}),
	});

	assert.deepEqual(decision, {
		keep: false,
		reason:
			"the target version v4.3.1 is no longer newer than the current version v4.3.1",
	});
});

test("autocloses branches that moved off the current patch line", async () => {
	const decision = await evaluateInactiveBranch({
		pullRequest: {
			head: {
				ref: "renovate/actions-checkout__vv4.4.1",
			},
		},
		depStates: buildDepStates(),
	});

	assert.deepEqual(decision, {
		keep: false,
		reason: "the branch is no longer active in the latest Renovate run",
	});
});

test("autocloses branches when no active patch remains on the same line", async () => {
	const decision = await evaluateInactiveBranch({
		pullRequest: {
			head: {
				ref: "renovate/actions-checkout__vv4.3.1",
			},
		},
		depStates: buildDepStates({
			branches: [
				{
					updateType: "minor",
					newVersion: "v4.4.0",
				},
			],
		}),
	});

	assert.deepEqual(decision, {
		keep: false,
		reason: "no active patch update remains for this dependency line",
	});
});

test("autocloses branches when the upstream release disappeared", async () => {
	const decision = await evaluateInactiveBranch({
		pullRequest: {
			head: {
				ref: "renovate/actions-checkout__vv4.3.1",
			},
		},
		depStates: buildDepStates(),
		tagExistsForVersion: async () => false,
	});

	assert.deepEqual(decision, {
		keep: false,
		reason: "the target release v4.3.1 is no longer available upstream",
	});
});
