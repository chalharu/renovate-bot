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

module.exports = {
	computeCutoffDate,
	filterRunsToDelete,
	normalizeKeepDays,
};
