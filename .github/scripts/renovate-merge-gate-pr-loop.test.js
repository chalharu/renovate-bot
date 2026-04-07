const assert = require("node:assert/strict");
const test = require("node:test");

const { forEachPullRequestSafely } = require("./renovate-merge-gate-pr-loop");

test("processes pull requests sequentially", async () => {
	const processed = [];

	await forEachPullRequestSafely({
		pullRequests: [{ number: 284 }, { number: 283 }],
		processPullRequest: async (pullRequest) => {
			processed.push(pullRequest.number);
		},
		onPullRequestError: async () => {
			throw new Error("unexpected error handler call");
		},
	});

	assert.deepEqual(processed, [284, 283]);
});

test("continues processing later pull requests after a failure", async () => {
	const processed = [];
	const failures = [];

	await forEachPullRequestSafely({
		pullRequests: [{ number: 284 }, { number: 283 }],
		processPullRequest: async (pullRequest) => {
			processed.push(pullRequest.number);
			if (pullRequest.number === 284) {
				throw new Error("push rejected");
			}
		},
		onPullRequestError: async (pullRequest, error) => {
			failures.push(`${pullRequest.number}:${error.message}`);
		},
	});

	assert.deepEqual(processed, [284, 283]);
	assert.deepEqual(failures, ["284:push rejected"]);
});
