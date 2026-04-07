const wait = (delayMs) =>
	new Promise((resolve) => {
		setTimeout(resolve, delayMs);
	});

const normalizeRestMergeableState = (mergeableState) => {
	const normalized =
		typeof mergeableState === "string" && mergeableState.trim().length > 0
			? mergeableState.trim().toLowerCase()
			: "unknown";

	switch (normalized) {
		case "clean":
			return {
				ready: true,
				reason: "Ready to merge",
				mergeable: "MERGEABLE",
				needsBranchRefresh: false,
				pending: false,
			};
		case "behind":
			return {
				ready: true,
				reason: "Pull request branch is behind the base branch",
				mergeable: "MERGEABLE",
				needsBranchRefresh: true,
				pending: false,
			};
		case "dirty":
			return {
				ready: false,
				reason: `Pull request branch needs refresh (${normalized})`,
				mergeable: "CONFLICTING",
				needsBranchRefresh: true,
				pending: false,
			};
		case "unknown":
			return {
				ready: false,
				reason: "Pull request mergeability is still being calculated",
				mergeable: "UNKNOWN",
				needsBranchRefresh: false,
				pending: true,
			};
		default:
			return {
				ready: false,
				reason: `Pull request is not mergeable yet (${normalized})`,
				mergeable: normalized.toUpperCase(),
				needsBranchRefresh: false,
				pending: false,
			};
	}
};

const resolveRestMergeability = async ({
	loadMergeableState,
	maxAttempts = 3,
	delayMs = 1000,
	sleep = wait,
}) => {
	if (typeof loadMergeableState !== "function") {
		throw new Error("loadMergeableState must be a function");
	}

	if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
		throw new Error("maxAttempts must be a positive integer");
	}

	if (!Number.isInteger(delayMs) || delayMs < 0) {
		throw new Error("delayMs must be a non-negative integer");
	}

	if (typeof sleep !== "function") {
		throw new Error("sleep must be a function");
	}

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const normalized = normalizeRestMergeableState(await loadMergeableState());
		if (!normalized.pending || attempt === maxAttempts) {
			return normalized;
		}

		if (delayMs > 0) {
			await sleep(delayMs);
		}
	}

	throw new Error("resolveRestMergeability exhausted unexpectedly");
};

module.exports = {
	normalizeRestMergeableState,
	resolveRestMergeability,
};
