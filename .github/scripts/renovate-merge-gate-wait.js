const WAIT_DETAILS_BY_SOURCE = Object.freeze({
	creation: {
		label: "pull request creation",
		detailPrefix: "The Renovate pull request was created at",
	},
	update: {
		label: "latest update",
		detailPrefix: "The latest Renovate head update was at",
	},
});

const resolveWaitAnchor = ({
	pullRequest,
	latestHeadUpdateAt,
	useCreationTime,
}) =>
	useCreationTime
		? {
				source: "creation",
				timestamp: pullRequest?.created_at,
			}
		: {
				source: "update",
				timestamp: latestHeadUpdateAt,
			};

const calculateWaitCheckState = ({
	pullRequest,
	latestHeadUpdateAt,
	isVulnerability,
	waitPolicy,
	useCreationTime,
	nowMs = Date.now(),
}) => {
	if (isVulnerability) {
		return {
			waitSatisfied: true,
			waitPeriodLabel: "Security update can merge after CI",
			waitPeriodDetails:
				"This Renovate PR addresses a vulnerability and can merge as soon as the repository CI passes.",
		};
	}

	if (
		!waitPolicy ||
		!Number.isInteger(waitPolicy.waitDays) ||
		!Number.isFinite(waitPolicy.waitWindowMs)
	) {
		throw new Error(
			"Wait policy is required for non-vulnerability Renovate pull requests",
		);
	}

	const waitAnchor = resolveWaitAnchor({
		pullRequest,
		latestHeadUpdateAt,
		useCreationTime,
	});
	const waitAnchorDetails = WAIT_DETAILS_BY_SOURCE[waitAnchor.source];
	const waitAnchorMs = Date.parse(waitAnchor.timestamp ?? "");

	if (Number.isNaN(waitAnchorMs)) {
		throw new Error(
			`Unable to calculate wait period from the Renovate ${waitAnchorDetails.label} timestamp`,
		);
	}

	const readyAtMs = waitAnchorMs + waitPolicy.waitWindowMs;
	const waitSatisfied = nowMs >= readyAtMs;

	return {
		waitSatisfied,
		waitPeriodLabel: waitSatisfied
			? `Wait period satisfied from ${waitAnchorDetails.label} (${waitPolicy.waitDays}d)`
			: `Waiting ${waitPolicy.waitDays} days from ${waitAnchorDetails.label}`,
		waitPeriodDetails: waitSatisfied
			? `${waitAnchorDetails.detailPrefix} ${waitAnchor.timestamp}. The configured wait period is ${waitPolicy.waitDays} day(s), so this PR can merge as soon as the repository CI passes.`
			: `${waitAnchorDetails.detailPrefix} ${waitAnchor.timestamp}. The configured wait period is ${waitPolicy.waitDays} day(s), so this Renovate PR stays pending until ${new Date(readyAtMs).toISOString()}.`,
	};
};

module.exports = {
	calculateWaitCheckState,
};
