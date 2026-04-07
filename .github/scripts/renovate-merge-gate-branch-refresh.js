const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
	evaluatePullRequestTargetLine,
} = require("./renovate-merge-gate-target-line");

const runGit = ({ cwd, args, env = {} }) => {
	const result = spawnSync("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			...env,
		},
		encoding: "utf8",
	});

	if (result.status === 0) {
		return result.stdout.trim();
	}

	const output = [result.stdout, result.stderr]
		.filter((value) => typeof value === "string" && value.trim().length > 0)
		.join("\n")
		.trim();
	throw new Error(`git ${args.join(" ")} failed${output ? `: ${output}` : ""}`);
};

const buildAuthenticatedRemoteUrl = ({ owner, repo, token }) => {
	if (
		typeof owner !== "string" ||
		owner.length === 0 ||
		typeof repo !== "string" ||
		repo.length === 0
	) {
		throw new Error(
			"owner and repo are required to build an authenticated URL",
		);
	}

	if (typeof token !== "string" || token.length === 0) {
		throw new Error("token is required to build an authenticated URL");
	}

	return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;
};

const refreshPullRequestBranch = ({
	remoteUrl,
	baseRef,
	headRef,
	headSha,
	tmpDirRoot = os.tmpdir(),
}) => {
	for (const [key, value] of Object.entries({
		remoteUrl,
		baseRef,
		headRef,
		headSha,
	})) {
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`${key} is required to refresh a pull request branch`);
		}
	}

	const worktree = fs.mkdtempSync(
		path.join(tmpDirRoot, "renovate-merge-gate-branch-refresh-"),
	);

	try {
		runGit({
			cwd: worktree,
			args: ["init", "--quiet"],
		});
		runGit({
			cwd: worktree,
			args: ["config", "user.name", "renovate-merge-gate"],
		});
		runGit({
			cwd: worktree,
			args: [
				"config",
				"user.email",
				"renovate-merge-gate@users.noreply.github.com",
			],
		});
		runGit({
			cwd: worktree,
			args: ["remote", "add", "origin", remoteUrl],
		});
		runGit({
			cwd: worktree,
			args: [
				"fetch",
				"--no-tags",
				"--depth=64",
				"origin",
				`+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`,
				`+refs/heads/${headRef}:refs/remotes/origin/${headRef}`,
			],
		});

		const remoteHeadSha = runGit({
			cwd: worktree,
			args: ["rev-parse", `refs/remotes/origin/${headRef}^{commit}`],
		});
		if (remoteHeadSha !== headSha) {
			throw new Error(
				`expected ${headRef} to point at ${headSha}, but fetched ${remoteHeadSha}`,
			);
		}

		const uniqueCommitCount = Number(
			runGit({
				cwd: worktree,
				args: [
					"rev-list",
					"--count",
					`refs/remotes/origin/${baseRef}..refs/remotes/origin/${headRef}`,
				],
			}),
		);
		if (uniqueCommitCount !== 1) {
			throw new Error(
				`branch refresh only supports pull request branches with exactly one commit ahead of ${baseRef}; found ${uniqueCommitCount}`,
			);
		}

		runGit({
			cwd: worktree,
			args: [
				"checkout",
				"--quiet",
				"-B",
				"refresh-target",
				`refs/remotes/origin/${baseRef}`,
			],
		});

		try {
			runGit({
				cwd: worktree,
				args: ["cherry-pick", "-X", "theirs", headSha],
			});
		} catch (error) {
			try {
				runGit({
					cwd: worktree,
					args: ["cherry-pick", "--abort"],
				});
			} catch {}

			throw new Error(
				`unable to replay ${headSha} onto ${baseRef}: ${error.message}`,
			);
		}

		const refreshedHeadSha = runGit({
			cwd: worktree,
			args: ["rev-parse", "HEAD"],
		});
		const targetLineEvaluation = evaluatePullRequestTargetLine({
			headRef,
			patches: [
				runGit({
					cwd: worktree,
					args: ["show", "--format=", "HEAD"],
				}),
			],
		});
		if (targetLineEvaluation.blocked) {
			return {
				refreshed: false,
				blocked: true,
				reason: targetLineEvaluation.reason,
			};
		}
		runGit({
			cwd: worktree,
			args: [
				"push",
				`--force-with-lease=refs/heads/${headRef}:${remoteHeadSha}`,
				"origin",
				`HEAD:refs/heads/${headRef}`,
			],
		});

		return {
			refreshed: true,
			refreshedHeadSha,
		};
	} finally {
		fs.rmSync(worktree, { force: true, recursive: true });
	}
};

module.exports = {
	buildAuthenticatedRemoteUrl,
	refreshPullRequestBranch,
};
