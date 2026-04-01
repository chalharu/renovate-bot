const parseNumericVersion = (version) => {
	if (typeof version !== "string") {
		return null;
	}

	const normalized = version.startsWith("v") ? version.slice(1) : version;
	const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);

	if (!match) {
		return null;
	}

	return {
		raw: version,
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
};

const compareParsedVersions = (left, right) => {
	for (const key of ["major", "minor", "patch"]) {
		if (left[key] !== right[key]) {
			return left[key] - right[key];
		}
	}

	return 0;
};

const inferInactiveBranchMetadata = (branchName, depStates = new Map()) => {
	if (typeof branchName !== "string") {
		return null;
	}

	const normalized = branchName.startsWith("renovate/")
		? branchName.slice("renovate/".length)
		: branchName;
	const legacyFormatMatch = normalized.match(
		/^(?<dep>.+?)__(?<updateType>major|minor|patch|pin|digest|pinDigest)(?:__v(?<version>.+?))?(?:__d(?<digest>[0-9a-f]+))?$/,
	);

	if (legacyFormatMatch?.groups) {
		return {
			depKey: legacyFormatMatch.groups.dep ?? null,
			updateType: legacyFormatMatch.groups.updateType ?? null,
			targetVersion: legacyFormatMatch.groups.version ?? null,
			targetDigestShort: legacyFormatMatch.groups.digest ?? null,
		};
	}

	if (normalized.includes("__v") || normalized.includes("__d")) {
		const currentFormatMatch = normalized.match(
			/^(?<dep>.+?)(?:__v(?<version>.+?))?(?:__d(?<digest>[0-9a-f]+))?$/,
		);

		if (currentFormatMatch?.groups) {
			return {
				depKey: currentFormatMatch.groups.dep ?? null,
				updateType: null,
				targetVersion: currentFormatMatch.groups.version ?? null,
				targetDigestShort: currentFormatMatch.groups.digest ?? null,
			};
		}
	}

	const depCandidates = Array.from(depStates.keys())
		.filter(
			(depKey) =>
				normalized === depKey ||
				normalized.startsWith(`${depKey}-`) ||
				normalized.startsWith(`${depKey}__`),
		)
		.sort((left, right) => right.length - left.length);
	const depKey = depCandidates[0] ?? null;
	const suffix = depKey ? normalized.slice(depKey.length) : normalized;
	const versionMatch = suffix.match(
		/-(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*)$/,
	);
	const digestMatch = suffix.match(/-([0-9a-f]{7,})$/);

	return {
		depKey,
		updateType: null,
		targetVersion: versionMatch ? versionMatch[1] : null,
		targetDigestShort: digestMatch ? digestMatch[1] : null,
	};
};

const evaluateInactiveBranch = async ({
	pullRequest,
	depStates,
	tagExistsForVersion = async () => null,
}) => {
	const inferred = inferInactiveBranchMetadata(
		pullRequest?.head?.ref,
		depStates,
	);

	if (!inferred?.depKey || !inferred.targetVersion) {
		return {
			keep: false,
			reason: "the branch is no longer active in the latest Renovate run",
		};
	}

	const depState = depStates.get(inferred.depKey);
	if (!depState || typeof depState.currentVersion !== "string") {
		return {
			keep: false,
			reason: "the dependency no longer has active Renovate updates",
		};
	}

	const currentVersion = parseNumericVersion(depState.currentVersion);
	const targetVersion = parseNumericVersion(inferred.targetVersion);

	if (!currentVersion || !targetVersion) {
		return {
			keep: false,
			reason: "the branch is no longer active in the latest Renovate run",
		};
	}

	if (compareParsedVersions(targetVersion, currentVersion) <= 0) {
		return {
			keep: false,
			reason: `the target version ${inferred.targetVersion} is no longer newer than the current version ${depState.currentVersion}`,
		};
	}

	const isPatchLine =
		targetVersion.major === currentVersion.major &&
		targetVersion.minor === currentVersion.minor;

	if (!isPatchLine) {
		return {
			keep: false,
			reason: "the branch is no longer active in the latest Renovate run",
		};
	}

	const activeBranches = Array.isArray(depState.branches)
		? depState.branches
		: [];
	const hasActivePatchOnSameLine = activeBranches.some((branchUpdate) => {
		if (
			branchUpdate.updateType !== "patch" ||
			typeof branchUpdate.newVersion !== "string"
		) {
			return false;
		}

		const activeTargetVersion = parseNumericVersion(branchUpdate.newVersion);
		return (
			!!activeTargetVersion &&
			activeTargetVersion.major === currentVersion.major &&
			activeTargetVersion.minor === currentVersion.minor
		);
	});

	if (!hasActivePatchOnSameLine) {
		return {
			keep: false,
			reason: "no active patch update remains for this dependency line",
		};
	}

	const tagExists = await tagExistsForVersion(
		depState.sourceUrl,
		inferred.targetVersion,
	);
	if (tagExists === false) {
		return {
			keep: false,
			reason: `the target release ${inferred.targetVersion} is no longer available upstream`,
		};
	}

	return {
		keep: true,
		reason: `custom separateMultiplePatch keeps ${inferred.targetVersion} open while newer patch updates remain available`,
	};
};

module.exports = {
	evaluateInactiveBranch,
	inferInactiveBranchMetadata,
};
