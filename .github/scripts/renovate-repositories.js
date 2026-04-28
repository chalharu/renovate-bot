const filterCandidateRepositories = ({ repositories = [], owner } = {}) =>
	[
		...new Map(
			(Array.isArray(repositories) ? repositories : [])
				.filter(
					(repository) =>
						repository?.owner?.login === owner &&
						!repository.archived &&
						!repository.disabled,
				)
				.map((repository) => [repository.full_name, repository]),
		).values(),
	].sort((left, right) => left.full_name.localeCompare(right.full_name));

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
	maskPrivateRepositories,
	resolveRepositorySelection,
	toEligibleRepository,
};
