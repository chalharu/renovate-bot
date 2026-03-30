const assert = require("node:assert/strict");
const test = require("node:test");

const { calculateWaitCheckState } = require("./renovate-merge-gate-wait");

const THREE_DAY_WAIT = {
	waitDays: 3,
	waitWindowMs: 3 * 24 * 60 * 60 * 1000,
};

test("uses pull request creation time when rebases must not reset the gate", () => {
	const state = calculateWaitCheckState({
		pullRequest: {
			created_at: "2026-03-01T00:00:00Z",
		},
		latestHeadUpdateAt: "2026-03-03T00:00:00Z",
		isVulnerability: false,
		waitPolicy: THREE_DAY_WAIT,
		useCreationTime: true,
		nowMs: Date.parse("2026-03-04T00:00:00Z"),
	});

	assert.equal(state.waitSatisfied, true);
	assert.equal(
		state.waitPeriodLabel,
		"Wait period satisfied from pull request creation (3d)",
	);
	assert.match(state.waitPeriodDetails, /created at 2026-03-01T00:00:00Z/);
});

test("keeps the wait window anchored to pull request creation while still pending", () => {
	const state = calculateWaitCheckState({
		pullRequest: {
			created_at: "2026-03-01T00:00:00Z",
		},
		latestHeadUpdateAt: "2026-03-03T00:00:00Z",
		isVulnerability: false,
		waitPolicy: THREE_DAY_WAIT,
		useCreationTime: true,
		nowMs: Date.parse("2026-03-02T00:00:00Z"),
	});

	assert.equal(state.waitSatisfied, false);
	assert.equal(
		state.waitPeriodLabel,
		"Waiting 3 days from pull request creation",
	);
	assert.match(state.waitPeriodDetails, /created at 2026-03-01T00:00:00Z/);
	assert.match(state.waitPeriodDetails, /2026-03-04T00:00:00.000Z/);
});

test("can still calculate from the latest update when needed", () => {
	const state = calculateWaitCheckState({
		pullRequest: {
			created_at: "2026-03-01T00:00:00Z",
		},
		latestHeadUpdateAt: "2026-03-03T00:00:00Z",
		isVulnerability: false,
		waitPolicy: THREE_DAY_WAIT,
		useCreationTime: false,
		nowMs: Date.parse("2026-03-04T00:00:00Z"),
	});

	assert.equal(state.waitSatisfied, false);
	assert.equal(state.waitPeriodLabel, "Waiting 3 days from latest update");
	assert.match(
		state.waitPeriodDetails,
		/latest Renovate head update was at 2026-03-03T00:00:00Z/,
	);
	assert.match(state.waitPeriodDetails, /2026-03-06T00:00:00.000Z/);
});

test("keeps vulnerability updates mergeable after CI", () => {
	const state = calculateWaitCheckState({
		isVulnerability: true,
		useCreationTime: true,
	});

	assert.equal(state.waitSatisfied, true);
	assert.equal(state.waitPeriodLabel, "Security update can merge after CI");
	assert.match(state.waitPeriodDetails, /addresses a vulnerability/);
});
