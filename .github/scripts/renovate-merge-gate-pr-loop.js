const forEachPullRequestSafely = async ({
	pullRequests,
	processPullRequest,
	onPullRequestError,
}) => {
	if (!Array.isArray(pullRequests)) {
		throw new Error("pullRequests must be an array");
	}

	if (typeof processPullRequest !== "function") {
		throw new Error("processPullRequest must be a function");
	}

	if (typeof onPullRequestError !== "function") {
		throw new Error("onPullRequestError must be a function");
	}

	for (const pullRequest of pullRequests) {
		try {
			await processPullRequest(pullRequest);
		} catch (error) {
			await onPullRequestError(pullRequest, error);
		}
	}
};

module.exports = {
	forEachPullRequestSafely,
};
