const assert = require("node:assert/strict");
const test = require("node:test");

const {
	buildCreatedBeforeFilter,
	computeRemainingTargetedRunBudget,
	computeCutoffDate,
	describeWorkflowRun,
	filterRunsToDelete,
	normalizeKeepDays,
	normalizeTargetedRunCount,
	summarizeRunsByWorkflow,
} = require("./workflow-run-cleanup");

test("normalizes keep_days inputs to a positive integer", () => {
	assert.equal(normalizeKeepDays("7"), 7);
	assert.equal(normalizeKeepDays(3), 3);
	assert.equal(normalizeKeepDays("0"), 1);
	assert.equal(normalizeKeepDays("-1"), 1);
	assert.equal(normalizeKeepDays("abc"), 1);
	assert.equal(normalizeKeepDays(undefined, { fallback: 5 }), 5);
});

test("rejects keep_days values that exceed the supported maximum", () => {
	assert.throws(
		() => normalizeKeepDays("401"),
		/keep_days must be between 1 and 400/,
	);
});

test("normalizes targeted run counts to a non-negative integer", () => {
	assert.equal(normalizeTargetedRunCount("2500"), 2500);
	assert.equal(normalizeTargetedRunCount(25), 25);
	assert.equal(normalizeTargetedRunCount("0"), 0);
	assert.equal(normalizeTargetedRunCount("-1"), 0);
	assert.equal(normalizeTargetedRunCount("abc"), 0);
	assert.equal(normalizeTargetedRunCount(undefined, { fallback: 75 }), 75);
});

test("rejects targeted run counts that exceed the supported maximum", () => {
	assert.throws(
		() => normalizeTargetedRunCount("3001"),
		/targeted run count must be between 0 and 3000/,
	);
});

test("computes the cutoff exactly 24 hours before now for keep_days=1", () => {
	const cutoff = computeCutoffDate({
		now: new Date("2026-04-01T21:34:19.436Z"),
		keepDays: 1,
	});

	assert.equal(cutoff.toISOString(), "2026-03-31T21:34:19.436Z");
});

test("extends the cutoff backward by keep_days * 24 hours", () => {
	const cutoff = computeCutoffDate({
		now: new Date("2026-04-01T21:34:19.436Z"),
		keepDays: 3,
	});

	assert.equal(cutoff.toISOString(), "2026-03-29T21:34:19.436Z");
});

test("filters only completed runs older than the cutoff", () => {
	const runs = [
		{
			id: 1,
			status: "completed",
			updated_at: "2026-03-31T23:59:59Z",
		},
		{
			id: 2,
			status: "completed",
			updated_at: "2026-04-01T00:00:00Z",
		},
		{
			id: 3,
			status: "in_progress",
			updated_at: "2026-03-29T12:00:00Z",
		},
		{
			id: 4,
			status: "completed",
			updated_at: "not-a-date",
		},
		{
			id: 5,
			status: "completed",
			updated_at: "2026-03-25T00:00:00Z",
		},
	];

	const deletableRuns = filterRunsToDelete({
		runs,
		cutoff: new Date("2026-04-01T00:00:00Z"),
	});

	assert.deepEqual(
		deletableRuns.map((run) => run.id),
		[5, 1],
	);
});

test("retains completed runs updated exactly at the cutoff time", () => {
	const deletableRuns = filterRunsToDelete({
		runs: [
			{
				id: 1,
				status: "completed",
				updated_at: "2026-03-31T21:34:19.435Z",
			},
			{
				id: 2,
				status: "completed",
				updated_at: "2026-03-31T21:34:19.436Z",
			},
			{
				id: 3,
				status: "completed",
				updated_at: "2026-03-31T21:34:19.437Z",
			},
		],
		cutoff: new Date("2026-03-31T21:34:19.436Z"),
	});

	assert.deepEqual(
		deletableRuns.map((run) => run.id),
		[1],
	);
});

test("ignores completed runs that do not have a numeric run id", () => {
	const deletableRuns = filterRunsToDelete({
		runs: [
			{
				status: "completed",
				updated_at: "2026-03-31T23:59:59Z",
			},
			{
				id: "2",
				status: "completed",
				updated_at: "2026-03-30T00:00:00Z",
			},
			{
				id: 3,
				status: "completed",
				updated_at: "2026-03-29T00:00:00Z",
			},
		],
		cutoff: new Date("2026-04-01T00:00:00Z"),
	});

	assert.deepEqual(
		deletableRuns.map((run) => run.id),
		[3],
	);
});

test("throws a clear error when keep_days would produce an invalid cutoff", () => {
	assert.throws(
		() =>
			computeCutoffDate({
				now: new Date("2026-04-01T21:34:19.436Z"),
				keepDays: "999999999999",
			}),
		/keep_days must be between 1 and 400/,
	);
});

test("builds a created filter from the cleanup cutoff", () => {
	assert.equal(
		buildCreatedBeforeFilter({
			cutoff: new Date("2026-04-02T12:34:56.789Z"),
		}),
		"<2026-04-02T12:34:56.789Z",
	);
});

test("rejects invalid created-filter cutoffs", () => {
	assert.throws(
		() =>
			buildCreatedBeforeFilter({
				cutoff: "not-a-date",
			}),
		/A valid cutoff date is required to build a created filter/,
	);
});

test("computes the remaining targeted-run budget for a cleanup chain", () => {
	assert.equal(
		computeRemainingTargetedRunBudget({
			targetLimit: 3000,
			targetedRuns: 2500,
		}),
		500,
	);
	assert.equal(
		computeRemainingTargetedRunBudget({
			targetLimit: 3000,
			targetedRuns: 3000,
		}),
		0,
	);
});

test("rejects invalid per-run target limits", () => {
	assert.throws(
		() =>
			computeRemainingTargetedRunBudget({
				targetLimit: 0,
				targetedRuns: 0,
			}),
		/targetLimit must be a positive integer/,
	);
});

test("describes workflow runs by path, then name, then workflow id", () => {
	assert.equal(
		describeWorkflowRun({
			path: ".github/workflows/renovate.yaml",
			name: "Renovate",
			workflow_id: 1,
		}),
		".github/workflows/renovate.yaml",
	);
	assert.equal(
		describeWorkflowRun({
			name: "Renovate config CI",
			workflow_id: 2,
		}),
		"Renovate config CI",
	);
	assert.equal(
		describeWorkflowRun({
			workflow_id: 3,
		}),
		"workflow:3",
	);
});

test("summarizes run counts by workflow descriptor", () => {
	const summary = summarizeRunsByWorkflow({
		runs: [
			{
				id: 1,
				path: ".github/workflows/renovate.yaml",
			},
			{
				id: 2,
				path: ".github/workflows/renovate.yaml",
			},
			{
				id: 3,
				name: "Renovate merge gate",
			},
		],
	});

	assert.deepEqual(summary, {
		workflowCount: 2,
		topWorkflows: [
			{
				workflow: ".github/workflows/renovate.yaml",
				count: 2,
			},
			{
				workflow: "Renovate merge gate",
				count: 1,
			},
		],
	});
});
