const supportedConfigPaths = [
	"renovate.json",
	"renovate.json5",
	".github/renovate.json",
	".github/renovate.json5",
	".gitlab/renovate.json",
	".gitlab/renovate.json5",
	".renovaterc",
	".renovaterc.json",
	".renovaterc.json5",
	"package.json",
];

const rootSupportedConfigPaths = new Set([
	"renovate.json",
	"renovate.json5",
	".renovaterc",
	".renovaterc.json",
	".renovaterc.json5",
]);

const nestedSupportedConfigPaths = new Map([
	[".github", new Set(["renovate.json", "renovate.json5"])],
	[".gitlab", new Set(["renovate.json", "renovate.json5"])],
]);

const hasPackageJsonRenovateConfig = ({ contentData } = {}) => {
	if (
		contentData?.type !== "file" ||
		typeof contentData?.content !== "string" ||
		contentData.content.length === 0
	) {
		return false;
	}

	try {
		const decodedContent = Buffer.from(
			contentData.content.replace(/\s+/g, ""),
			contentData.encoding ?? "base64",
		).toString("utf8");
		const packageJson = JSON.parse(decodedContent);

		return (
			packageJson !== null &&
			typeof packageJson === "object" &&
			!Array.isArray(packageJson) &&
			packageJson.renovate !== null &&
			typeof packageJson.renovate === "object" &&
			!Array.isArray(packageJson.renovate)
		);
	} catch {
		return false;
	}
};

const createEligibilityLookupError = (error) =>
	new Error(
		`Unable to determine repository eligibility (status: ${error?.status ?? "unknown"})`,
	);

const inspectRepositoryCandidate = ({ repository, owner } = {}) => {
	if (repository?.owner?.login !== owner) {
		return {
			candidate: false,
			reason: "repository owner does not match the workflow owner",
		};
	}

	if (repository?.archived) {
		return {
			candidate: false,
			reason: "repository is archived",
		};
	}

	if (repository?.disabled) {
		return {
			candidate: false,
			reason: "repository is disabled",
		};
	}

	return {
		candidate: true,
		reason: "repository is active for the workflow owner",
	};
};

const listRepositoryEntries = async ({
	github,
	repository,
	path = "",
} = {}) => {
	try {
		const { data } = await github.rest.repos.getContent({
			owner: repository.owner.login,
			repo: repository.name,
			path,
		});

		return Array.isArray(data) ? data : [data];
	} catch (error) {
		if (error?.status === 404) {
			return [];
		}

		throw createEligibilityLookupError(error);
	}
};

const getRepositoryContent = async ({ github, repository, path } = {}) => {
	try {
		const { data } = await github.rest.repos.getContent({
			owner: repository.owner.login,
			repo: repository.name,
			path,
		});

		return Array.isArray(data) ? null : data;
	} catch (error) {
		if (error?.status === 404) {
			return null;
		}

		throw createEligibilityLookupError(error);
	}
};

const filterCandidateRepositories = ({ repositories = [], owner } = {}) =>
	[
		...new Map(
			(Array.isArray(repositories) ? repositories : [])
				.filter(
					(repository) =>
						inspectRepositoryCandidate({
							repository,
							owner,
						}).candidate,
				)
				.map((repository) => [repository.full_name, repository]),
		).values(),
	].sort((left, right) => left.full_name.localeCompare(right.full_name));

const inspectSupportedRenovateConfig = async ({ github, repository } = {}) => {
	if (
		!github?.rest?.repos?.getContent ||
		!repository?.owner?.login ||
		!repository?.name
	) {
		throw new Error("A GitHub client and repository details are required");
	}

	const rootEntries = await listRepositoryEntries({
		github,
		repository,
	});
	const rootEntryNames = new Set(
		rootEntries
			.filter((entry) => typeof entry?.name === "string")
			.map((entry) => entry.name),
	);

	for (const path of rootSupportedConfigPaths) {
		if (rootEntryNames.has(path)) {
			return {
				eligible: true,
				configPath: path,
				reason: `supported Renovate config found at ${path}`,
			};
		}
	}

	if (rootEntryNames.has("package.json")) {
		const packageJsonContent = await getRepositoryContent({
			github,
			repository,
			path: "package.json",
		});

		if (hasPackageJsonRenovateConfig({ contentData: packageJsonContent })) {
			return {
				eligible: true,
				configPath: "package.json#renovate",
				reason: "supported Renovate config found in package.json#renovate",
			};
		}
	}

	for (const [directoryPath, supportedFiles] of nestedSupportedConfigPaths) {
		if (!rootEntryNames.has(directoryPath)) {
			continue;
		}

		const nestedEntries = await listRepositoryEntries({
			github,
			repository,
			path: directoryPath,
		});

		if (
			nestedEntries.some(
				(entry) =>
					typeof entry?.name === "string" && supportedFiles.has(entry.name),
			)
		) {
			const matchedEntry = nestedEntries.find(
				(entry) =>
					typeof entry?.name === "string" && supportedFiles.has(entry.name),
			);

			return {
				eligible: true,
				configPath: `${directoryPath}/${matchedEntry.name}`,
				reason: `supported Renovate config found at ${directoryPath}/${matchedEntry.name}`,
			};
		}
	}

	return {
		eligible: false,
		configPath: null,
		reason: "no supported Renovate config was found",
	};
};

const hasSupportedRenovateConfig = async ({ github, repository } = {}) => {
	const inspection = await inspectSupportedRenovateConfig({
		github,
		repository,
	});

	return inspection.eligible;
};

const inspectRepositoryEligibility = async ({
	github,
	repository,
	owner,
} = {}) => {
	const candidateInspection = inspectRepositoryCandidate({
		repository,
		owner,
	});

	if (!candidateInspection.candidate) {
		return {
			candidate: false,
			eligible: false,
			configPath: null,
			reason: candidateInspection.reason,
		};
	}

	const configInspection = await inspectSupportedRenovateConfig({
		github,
		repository,
	});

	return {
		candidate: true,
		eligible: configInspection.eligible,
		configPath: configInspection.configPath,
		reason: configInspection.reason,
	};
};

const filterEligibleRepositories = async ({
	github,
	repositories = [],
	owner,
	maxConcurrency = 8,
	onInspect,
} = {}) => {
	const candidateRepositories = filterCandidateRepositories({
		repositories,
		owner,
	});
	const eligibleRepositories = [];
	const workerCount = Math.min(
		Math.max(1, maxConcurrency),
		Math.max(1, candidateRepositories.length),
	);
	let nextIndex = 0;

	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (true) {
				const repositoryIndex = nextIndex;
				nextIndex += 1;

				if (repositoryIndex >= candidateRepositories.length) {
					return;
				}

				const repository = candidateRepositories[repositoryIndex];
				const inspection = await inspectRepositoryEligibility({
					github,
					repository,
					owner,
				});

				if (typeof onInspect === "function") {
					await onInspect({ repository, inspection });
				}

				if (inspection.eligible) {
					eligibleRepositories[repositoryIndex] = repository;
				}
			}
		}),
	);

	return eligibleRepositories.filter(Boolean);
};

const resolveEligibleRepositorySelection = async ({
	github,
	repositories = [],
	owner,
	selectionMap = [],
	repository,
	repositoryIndex,
} = {}) => {
	const accessibleRepositories = filterCandidateRepositories({
		repositories,
		owner,
	});
	const selectedRepository = resolveRepositorySelection({
		repositories: accessibleRepositories.map(toEligibleRepository),
		selectionMap,
		repository,
		repositoryIndex,
	});
	const rawSelectedRepository = accessibleRepositories.find(
		(candidate) => candidate?.id === selectedRepository.id,
	);
	const repositoryName =
		typeof repository === "string" ? repository.trim() : "";

	if (
		!rawSelectedRepository ||
		!(await hasSupportedRenovateConfig({
			github,
			repository: rawSelectedRepository,
		}))
	) {
		if (repositoryName.length > 0) {
			throw new Error(`Public repository ${repositoryName} is unavailable`);
		}

		throw new Error(`Repository index ${repositoryIndex} is unavailable`);
	}

	return selectedRepository;
};

const formatPublicRepositoryEligibilityLog = ({
	repository,
	inspection,
} = {}) => {
	if (repository?.private || !repository?.full_name || !inspection) {
		return null;
	}

	if (inspection.eligible) {
		return `Including public repository ${repository.full_name} (supported Renovate config: ${inspection.configPath}).`;
	}

	return `Skipping public repository ${repository.full_name} (${inspection.reason}).`;
};

const probeDependabotAlertAccess = async ({ github, repository } = {}) => {
	if (!github?.request || !repository?.owner || !repository?.repository) {
		throw new Error("A GitHub client and repository details are required");
	}

	try {
		await github.request("GET /repos/{owner}/{repo}/dependabot/alerts", {
			owner: repository.owner,
			repo: repository.repository,
			per_page: 1,
			state: "open",
			headers: {
				accept: "application/vnd.github+json",
			},
		});

		return {
			ok: true,
			status: 200,
			reason:
				"Dependabot alerts are accessible with the current installation token",
		};
	} catch (error) {
		const errorMessage = String(error?.message ?? "").toLowerCase();

		if (error?.status === 403) {
			const isPermissionDenied =
				errorMessage.includes("resource not accessible by integration") ||
				errorMessage.includes("must have admin rights to repository");

			if (isPermissionDenied) {
				return {
					ok: false,
					status: 403,
					reason:
						"Dependabot alert access is denied for the current installation token",
				};
			}
		}

		if (error?.status === 404) {
			return {
				ok: false,
				status: 404,
				reason:
					"Dependabot alerts are unavailable or inaccessible for the current installation token",
			};
		}

		throw error;
	}
};

const toEligibleRepository = (repository) => ({
	id: repository.id,
	owner: repository.owner.login,
	repository: repository.name,
	full_name: repository.full_name,
	private: repository.private === true,
});

const maskPrivateRepositories = ({ core, repositories = [] } = {}) => {
	for (const repository of Array.isArray(repositories) ? repositories : []) {
		if (!repository?.private) {
			continue;
		}

		core.setSecret(repository.full_name);
		core.setSecret(repository.repository);
	}
};

const buildRepositoryMatrix = ({ repositories = [] } = {}) => ({
	include: (Array.isArray(repositories) ? repositories : []).map(
		(repository, repositoryIndex) =>
			repository?.private
				? { repository_index: repositoryIndex }
				: { repository: repository.repository },
	),
});

const buildRepositorySelectionMap = ({ repositories = [] } = {}) =>
	(Array.isArray(repositories) ? repositories : []).map(
		(repository, repositoryIndex) => ({
			repository_id: repository.id,
			...(repository?.private
				? { repository_index: repositoryIndex }
				: { repository: repository.repository }),
		}),
	);

const resolveRepositorySelection = ({
	repositories = [],
	selectionMap = [],
	repository,
	repositoryIndex,
} = {}) => {
	const normalizedRepositories = Array.isArray(repositories)
		? repositories
		: [];
	const normalizedSelectionMap = Array.isArray(selectionMap)
		? selectionMap
		: [];
	const repositoryName =
		typeof repository === "string" ? repository.trim() : "";

	if (repositoryName.length > 0) {
		const selection = normalizedSelectionMap.find(
			(candidate) => candidate?.repository === repositoryName,
		);

		if (!selection) {
			throw new Error(`Public repository ${repositoryName} is unavailable`);
		}

		const selectedRepository = normalizedRepositories.find(
			(candidate) =>
				!candidate?.private && candidate?.id === selection.repository_id,
		);

		if (!selectedRepository) {
			throw new Error(`Public repository ${repositoryName} is unavailable`);
		}

		return selectedRepository;
	}

	const parsedRepositoryIndex = Number.parseInt(
		String(repositoryIndex ?? ""),
		10,
	);

	if (!Number.isInteger(parsedRepositoryIndex) || parsedRepositoryIndex < 0) {
		throw new Error(
			"A valid repository or repository_index matrix value is required",
		);
	}

	const selection = normalizedSelectionMap.find(
		(candidate) => candidate?.repository_index === parsedRepositoryIndex,
	);

	if (!selection) {
		throw new Error(`Repository index ${repositoryIndex} is unavailable`);
	}

	const selectedRepository = normalizedRepositories.find(
		(candidate) => candidate?.id === selection.repository_id,
	);

	if (!selectedRepository) {
		throw new Error(`Repository index ${repositoryIndex} is unavailable`);
	}

	return selectedRepository;
};

module.exports = {
	buildRepositoryMatrix,
	buildRepositorySelectionMap,
	filterCandidateRepositories,
	filterEligibleRepositories,
	formatPublicRepositoryEligibilityLog,
	hasPackageJsonRenovateConfig,
	hasSupportedRenovateConfig,
	inspectRepositoryCandidate,
	inspectRepositoryEligibility,
	inspectSupportedRenovateConfig,
	maskPrivateRepositories,
	probeDependabotAlertAccess,
	resolveEligibleRepositorySelection,
	resolveRepositorySelection,
	supportedConfigPaths,
	toEligibleRepository,
};
