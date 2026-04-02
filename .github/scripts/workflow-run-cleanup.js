const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const normalizeKeepDays = (value, { fallback = 1, maximum = 400 } = {}) => {
	const parsed = Number.parseInt(String(value ?? ""), 10);

	if (!Number.isInteger(parsed) || parsed < 1) {
		return fallback;
	}

	if (parsed > maximum) {
		throw new Error(`keep_days must be between 1 and ${maximum}`);
	}

	return parsed;
};

const normalizeBatchSize = (value, { fallback = 500, maximum = 1000 } = {}) => {
	const parsed = Number.parseInt(String(value ?? ""), 10);

	if (!Number.isInteger(parsed) || parsed < 1) {
		return fallback;
	}

	if (parsed > maximum) {
		throw new Error(`batch_size must be between 1 and ${maximum}`);
	}

	return parsed;
};

const normalizeTargetedRunCount = (
	value,
	{ fallback = 0, maximum = 3000 } = {},
) => {
	const parsed = Number.parseInt(String(value ?? ""), 10);

	if (!Number.isInteger(parsed) || parsed < 0) {
		return fallback;
	}

	if (parsed > maximum) {
		throw new Error(`targeted_runs_so_far must be between 0 and ${maximum}`);
	}

	return parsed;
};

const computeCutoffDate = ({ now = new Date(), keepDays = 1 } = {}) => {
	const normalizedKeepDays = normalizeKeepDays(keepDays);
	const startOfCurrentUtcDay = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate(),
	);

	const cutoff = new Date(
		startOfCurrentUtcDay - (normalizedKeepDays - 1) * MILLISECONDS_PER_DAY,
	);

	if (!Number.isFinite(cutoff.getTime())) {
		throw new Error("Unable to calculate a valid cleanup cutoff date");
	}

	return cutoff;
};

const filterRunsToDelete = ({ runs = [], cutoff }) => {
	const cutoffMs =
		cutoff instanceof Date ? cutoff.getTime() : Date.parse(cutoff ?? "");

	if (!Number.isFinite(cutoffMs)) {
		throw new Error("A valid cutoff date is required to filter workflow runs");
	}

	return (Array.isArray(runs) ? runs : [])
		.filter((run) => {
			if (
				run?.status !== "completed" ||
				typeof run?.updated_at !== "string" ||
				!Number.isInteger(run?.id)
			) {
				return false;
			}

			const updatedAtMs = Date.parse(run.updated_at);
			return Number.isFinite(updatedAtMs) && updatedAtMs < cutoffMs;
		})
		.sort(
			(left, right) =>
				Date.parse(left.updated_at) - Date.parse(right.updated_at),
		);
};

const describeWorkflowRun = (run) => {
	if (typeof run?.path === "string" && run.path.trim().length > 0) {
		return run.path.trim();
	}

	if (typeof run?.name === "string" && run.name.trim().length > 0) {
		return run.name.trim();
	}

	if (Number.isInteger(run?.workflow_id)) {
		return `workflow:${run.workflow_id}`;
	}

	return "unknown workflow";
};

const buildCreatedBeforeFilter = ({ cutoff }) => {
	const cutoffMs =
		cutoff instanceof Date ? cutoff.getTime() : Date.parse(cutoff ?? "");

	if (!Number.isFinite(cutoffMs)) {
		throw new Error(
			"A valid cutoff date is required to build a created filter",
		);
	}

	return `<${new Date(cutoffMs).toISOString()}`;
};

const computeRemainingTargetedRunBudget = ({
	targetLimit = 3000,
	targetedRuns = 0,
} = {}) => {
	if (!Number.isInteger(targetLimit) || targetLimit < 1) {
		throw new Error("targetLimit must be a positive integer");
	}

	const normalizedTargetedRuns = normalizeTargetedRunCount(targetedRuns, {
		fallback: 0,
		maximum: targetLimit,
	});

	return targetLimit - normalizedTargetedRuns;
};

const summarizeRunsByWorkflow = ({ runs = [], limit = 10 } = {}) => {
	const counts = new Map();

	for (const run of Array.isArray(runs) ? runs : []) {
		const workflow = describeWorkflowRun(run);
		counts.set(workflow, (counts.get(workflow) ?? 0) + 1);
	}

	const topWorkflows = [...counts.entries()]
		.sort(
			(left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
		)
		.slice(0, Math.max(0, limit))
		.map(([workflow, count]) => ({ workflow, count }));

	return {
		workflowCount: counts.size,
		topWorkflows,
	};
};

const shouldContinueCleanup = ({
	dryRun = false,
	deletedRuns = 0,
	batchSize = 0,
	oldRunTotalCount = 0,
	remainingTargetBudget = Number.POSITIVE_INFINITY,
	scannedRuns = 0,
} = {}) => {
	if (dryRun || deletedRuns < 1) {
		return false;
	}

	if (Number.isFinite(remainingTargetBudget) && remainingTargetBudget < 1) {
		return false;
	}

	if (oldRunTotalCount > scannedRuns) {
		return true;
	}

	return (
		Number.isInteger(batchSize) && batchSize > 0 && deletedRuns >= batchSize
	);
};

module.exports = {
	buildCreatedBeforeFilter,
	computeRemainingTargetedRunBudget,
	computeCutoffDate,
	describeWorkflowRun,
	filterRunsToDelete,
	normalizeBatchSize,
	normalizeKeepDays,
	normalizeTargetedRunCount,
	shouldContinueCleanup,
	summarizeRunsByWorkflow,
};
