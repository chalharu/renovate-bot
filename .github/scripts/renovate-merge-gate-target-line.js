const {
	inferInactiveBranchMetadata,
	parseNumericVersion,
} = require("./renovate-merge-gate-inactive-branch");

const VERSION_PATTERN = /v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*/g;
const stripTrailingHashComment = (line) =>
	typeof line === "string" ? line.replace(/\s+#.*$/, "") : line;

const extractVersionOccurrences = (line) => {
	if (typeof line !== "string") {
		return [];
	}

	const uncommentedLine = stripTrailingHashComment(line);
	return [...uncommentedLine.matchAll(VERSION_PATTERN)].map((match) => {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		const before = uncommentedLine.slice(0, start);
		const after = uncommentedLine.slice(end);
		return {
			raw: match[0],
			parsed: parseNumericVersion(match[0]),
			beforeWord:
				before.match(/([A-Za-z0-9_.-]+)[^A-Za-z0-9_.-]*$/)?.[1] ?? null,
			afterWord:
				after.match(/^(?:[^A-Za-z0-9_.-]*)([A-Za-z0-9_.-]+)/)?.[1] ?? null,
		};
	});
};

const isNewerTargetLine = (candidate, target) =>
	candidate.major > target.major ||
	(candidate.major === target.major && candidate.minor > target.minor);

const normalizeVersionText = (version) =>
	typeof version === "string" && version.startsWith("v")
		? version.slice(1)
		: version;

const normalizeVersionTokens = (line) => line.replace(VERSION_PATTERN, "<version>");
const normalizeLineStructure = (line) =>
	normalizeVersionTokens(stripTrailingHashComment(line))
		.replace(/\s+/g, " ")
		.trim();

const getVersionDistanceScore = (candidate, target) =>
	Math.abs(candidate.major - target.major) * 1_000_000 +
	Math.abs(candidate.minor - target.minor) * 1_000 +
	Math.abs(candidate.patch - target.patch);

const matchVersionOccurrences = ({
	addedOccurrences,
	removedOccurrences,
	parsedTargetVersion,
}) => {
	const unusedRemovedOccurrences = removedOccurrences.map(
		(removedOccurrence, removedOccurrenceIndex) => ({
			...removedOccurrence,
			removedOccurrenceIndex,
		}),
	);
	const matchedRemovedOccurrences = [];
	let totalContextScore = 0;
	let totalDistanceScore = 0;

	for (const addedOccurrence of addedOccurrences) {
		let bestMatch = null;

		for (const removedOccurrence of unusedRemovedOccurrences) {
			if (!removedOccurrence.parsed) {
				continue;
			}

			const contextScore =
				(addedOccurrence.beforeWord &&
				removedOccurrence.beforeWord &&
				addedOccurrence.beforeWord === removedOccurrence.beforeWord
					? 2
					: 0) +
				(addedOccurrence.afterWord &&
				removedOccurrence.afterWord &&
				addedOccurrence.afterWord === removedOccurrence.afterWord
					? 1
					: 0);
			const distanceScore = getVersionDistanceScore(
				removedOccurrence.parsed,
				parsedTargetVersion,
			);
			if (
				!bestMatch ||
				contextScore > bestMatch.contextScore ||
				(contextScore === bestMatch.contextScore &&
					distanceScore < bestMatch.distanceScore)
			) {
				bestMatch = {
					removedOccurrence,
					contextScore,
					distanceScore,
				};
			}
		}

		if (!bestMatch) {
			return null;
		}

		totalContextScore += bestMatch.contextScore;
		totalDistanceScore += bestMatch.distanceScore;
		matchedRemovedOccurrences.push(bestMatch.removedOccurrence);
		unusedRemovedOccurrences.splice(
			unusedRemovedOccurrences.findIndex(
				(candidate) =>
					candidate.removedOccurrenceIndex ===
					bestMatch.removedOccurrence.removedOccurrenceIndex,
			),
			1,
		);
	}

	return {
		matchedRemovedOccurrences,
		totalContextScore,
		totalDistanceScore,
	};
};

const evaluateChangedLineBlock = ({
	addedLines,
	removedLines,
	inferredTargetVersion,
	parsedTargetVersion,
}) => {
	const removedLineCandidates = removedLines.map((removedLine) => ({
		line: removedLine,
		normalizedLine: normalizeLineStructure(removedLine),
		occurrences: extractVersionOccurrences(removedLine),
	}));

	for (const addedLine of addedLines) {
		const normalizedAddedLine = normalizeLineStructure(addedLine);
		const targetOccurrences = extractVersionOccurrences(addedLine).filter(
			(occurrence) =>
				normalizeVersionText(occurrence.raw) ===
				normalizeVersionText(inferredTargetVersion),
		);
		if (targetOccurrences.length === 0) {
			continue;
		}

		const preferredCandidates = removedLineCandidates
			.map((candidate, candidateIndex) => ({
				...candidate,
				candidateIndex,
			}))
			.filter((candidate) => candidate.normalizedLine === normalizedAddedLine);
		const candidatePool =
			preferredCandidates.length > 0
				? preferredCandidates
				: removedLineCandidates.map((candidate, candidateIndex) => ({
						...candidate,
						candidateIndex,
					}));
		let bestMatch = null;

		for (const candidate of candidatePool) {
			const occurrenceMatch = matchVersionOccurrences({
				addedOccurrences: targetOccurrences,
				removedOccurrences: candidate.occurrences,
				parsedTargetVersion,
			});
			if (!occurrenceMatch) {
				continue;
			}

			if (
				!bestMatch ||
				occurrenceMatch.totalContextScore > bestMatch.totalContextScore ||
				(occurrenceMatch.totalContextScore === bestMatch.totalContextScore &&
					occurrenceMatch.totalDistanceScore < bestMatch.totalDistanceScore)
			) {
				bestMatch = {
					candidateIndex: candidate.candidateIndex,
					totalContextScore: occurrenceMatch.totalContextScore,
					totalDistanceScore: occurrenceMatch.totalDistanceScore,
					matchedRemovedOccurrences: occurrenceMatch.matchedRemovedOccurrences,
				};
			}
		}

		if (!bestMatch) {
			continue;
		}

		removedLineCandidates.splice(bestMatch.candidateIndex, 1);
		for (const removedOccurrence of bestMatch.matchedRemovedOccurrences) {
			if (isNewerTargetLine(removedOccurrence.parsed, parsedTargetVersion)) {
				return {
					blocked: true,
					currentVersion: removedOccurrence.raw,
					targetVersion: inferredTargetVersion,
					reason: `the current base already moved to newer line ${removedOccurrence.raw} than the target version ${inferredTargetVersion}`,
				};
			}
		}
	}

	return {
		blocked: false,
	};
};

const evaluatePullRequestTargetLine = ({ headRef, patches }) => {
	const inferred = inferInactiveBranchMetadata(headRef);
	const parsedTargetVersion = parseNumericVersion(inferred?.targetVersion);
	if (!parsedTargetVersion) {
		return {
			blocked: false,
		};
	}

	for (const patch of Array.isArray(patches) ? patches : []) {
		if (typeof patch !== "string" || patch.trim().length === 0) {
			continue;
		}

		let removedLines = [];
		let addedLines = [];

		const evaluateBlock = () => {
			const evaluation = evaluateChangedLineBlock({
				addedLines,
				removedLines,
				inferredTargetVersion: inferred.targetVersion,
				parsedTargetVersion,
			});
			removedLines = [];
			addedLines = [];
			return evaluation;
		};

		for (const line of patch.split("\n")) {
			if (
				line.startsWith("@@") ||
				line.startsWith("diff --git ") ||
				line.startsWith("index ") ||
				line.startsWith("--- ") ||
				line.startsWith("+++ ") ||
				line.startsWith(" ") ||
				line.startsWith("\\")
			) {
				const evaluation = evaluateBlock();
				if (evaluation.blocked) {
					return evaluation;
				}
				continue;
			}

			if (line.startsWith("-")) {
				removedLines.push(line.slice(1));
				continue;
			}

			if (line.startsWith("+")) {
				addedLines.push(line.slice(1));
			}
		}

		const evaluation = evaluateBlock();
		if (evaluation.blocked) {
			return evaluation;
		}
	}

	return {
		blocked: false,
	};
};

module.exports = {
	evaluatePullRequestTargetLine,
};
