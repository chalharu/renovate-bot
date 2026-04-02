const assert = require("node:assert/strict");
const test = require("node:test");

const {
	buildCreatedBeforeFilter,
	computeCutoffDate,
	describeWorkflowRun,
	filterRunsToDelete,
	normalizeBatchSize,
	normalizeKeepDays,
	shouldContinueCleanup,
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

test("normalizes batch_size inputs to a positive integer", () => {
	assert.equal(normalizeBatchSize("250"), 250);
	assert.equal(normalizeBatchSize(75), 75);
	assert.equal(normalizeBatchSize("0"), 500);
	assert.equal(normalizeBatchSize("-1"), 500);
	assert.equal(normalizeBatchSize("abc"), 500);
	assert.equal(normalizeBatchSize(undefined, { fallback: 25 }), 25);
});

test("rejects batch_size values that exceed the supported maximum", () => {
	assert.throws(
		() => normalizeBatchSize("1001"),
		/batch_size must be between 1 and 1000/,
	);
});

test("computes the cutoff from the start of the current UTC day", () => {
	const cutoff = computeCutoffDate({
		now: new Date("2026-04-01T21:34:19.436Z"),
		keepDays: 1,
	});

	assert.equal(cutoff.toISOString(), "2026-04-01T00:00:00.000Z");
});

test("extends the cutoff backward when keeping multiple UTC days", () => {
	const cutoff = computeCutoffDate({
		now: new Date("2026-04-01T21:34:19.436Z"),
		keepDays: 3,
	});

	assert.equal(cutoff.toISOString(), "2026-03-30T00:00:00.000Z");
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
			cutoff: new Date("2026-04-02T00:00:00.000Z"),
		}),
		"<2026-04-02T00:00:00.000Z",
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

test("continues cleanup only when another pass can make progress", () => {
	assert.equal(
		shouldContinueCleanup({
			dryRun: true,
			deletedRuns: 10,
			batchSize: 100,
			oldRunTotalCount: 500,
			scannedRuns: 100,
		}),
		false,
	);
	assert.equal(
		shouldContinueCleanup({
			dryRun: false,
			deletedRuns: 0,
			batchSize: 100,
			oldRunTotalCount: 500,
			scannedRuns: 100,
		}),
		false,
	);
	assert.equal(
		shouldContinueCleanup({
			dryRun: false,
			deletedRuns: 50,
			batchSize: 100,
			oldRunTotalCount: 500,
			scannedRuns: 100,
		}),
		true,
	);
	assert.equal(
		shouldContinueCleanup({
			dryRun: false,
			deletedRuns: 100,
			batchSize: 100,
			oldRunTotalCount: 100,
			scannedRuns: 100,
		}),
		true,
	);
	assert.equal(
		shouldContinueCleanup({
			dryRun: false,
			deletedRuns: 25,
			batchSize: 100,
			oldRunTotalCount: 25,
			scannedRuns: 25,
		}),
		false,
	);
});
