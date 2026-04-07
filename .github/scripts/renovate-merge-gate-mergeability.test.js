const assert = require("node:assert/strict");
const test = require("node:test");

const {
	normalizeRestMergeableState,
	resolveRestMergeability,
} = require("./renovate-merge-gate-mergeability");

test("treats dirty mergeable state as a refresh candidate", () => {
	assert.deepEqual(normalizeRestMergeableState("dirty"), {
		ready: false,
		reason: "Pull request branch needs refresh (dirty)",
		mergeable: "CONFLICTING",
		needsBranchRefresh: true,
		pending: false,
	});
});

test("treats behind mergeable state as mergeable but refreshable", () => {
	assert.deepEqual(normalizeRestMergeableState("behind"), {
		ready: true,
		reason: "Pull request branch is behind the base branch",
		mergeable: "MERGEABLE",
		needsBranchRefresh: true,
		pending: false,
	});
});

test("treats clean mergeable state as ready", () => {
	assert.deepEqual(normalizeRestMergeableState("clean"), {
		ready: true,
		reason: "Ready to merge",
		mergeable: "MERGEABLE",
		needsBranchRefresh: false,
		pending: false,
	});
});

test("retries unknown mergeable states until a definitive state appears", async () => {
	const seenDelays = [];
	let attempts = 0;

	const result = await resolveRestMergeability({
		loadMergeableState: async () => {
			attempts += 1;
			return attempts < 3 ? "unknown" : "dirty";
		},
		maxAttempts: 4,
		delayMs: 25,
		sleep: async (delayMs) => {
			seenDelays.push(delayMs);
		},
	});

	assert.equal(attempts, 3);
	assert.deepEqual(seenDelays, [25, 25]);
	assert.deepEqual(result, {
		ready: false,
		reason: "Pull request branch needs refresh (dirty)",
		mergeable: "CONFLICTING",
		needsBranchRefresh: true,
		pending: false,
	});
});

test("returns unknown after exhausting retries", async () => {
	let attempts = 0;

	const result = await resolveRestMergeability({
		loadMergeableState: async () => {
			attempts += 1;
			return null;
		},
		maxAttempts: 2,
		delayMs: 0,
	});

	assert.equal(attempts, 2);
	assert.deepEqual(result, {
		ready: false,
		reason: "Pull request mergeability is still being calculated",
		mergeable: "UNKNOWN",
		needsBranchRefresh: false,
		pending: true,
	});
});
