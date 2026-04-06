const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const {
	refreshPullRequestBranch,
} = require("./renovate-merge-gate-branch-refresh");

const runGit = ({ cwd, args }) => {
	const result = spawnSync("git", args, {
		cwd,
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

const setupRemoteRepository = () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "renovate-merge-gate-branch-refresh-test-"),
	);
	const remoteDir = path.join(root, "remote.git");
	const workspace = path.join(root, "workspace");
	const hooksDir = path.join(root, "hooks");

	runGit({
		cwd: root,
		args: ["init", "--bare", "--initial-branch=main", remoteDir],
	});
	fs.mkdirSync(workspace);
	fs.mkdirSync(hooksDir);
	runGit({
		cwd: workspace,
		args: ["init", "--initial-branch=main"],
	});
	runGit({
		cwd: workspace,
		args: ["config", "user.name", "test-user"],
	});
	runGit({
		cwd: workspace,
		args: ["config", "user.email", "test-user@example.com"],
	});
	runGit({
		cwd: workspace,
		args: ["config", "core.hooksPath", hooksDir],
	});
	runGit({
		cwd: workspace,
		args: ["remote", "add", "origin", remoteDir],
	});

	return {
		root,
		remoteDir,
		workspace,
		cleanup: () => fs.rmSync(root, { force: true, recursive: true }),
	};
};

test("replays a preserved Renovate branch onto the latest base branch", () => {
	const repo = setupRemoteRepository();

	try {
		fs.writeFileSync(path.join(repo.workspace, "dependency.txt"), "version=1.0.0\n");
		runGit({
			cwd: repo.workspace,
			args: ["add", "dependency.txt"],
		});
		runGit({
			cwd: repo.workspace,
			args: ["commit", "-m", "base"],
		});
		runGit({
			cwd: repo.workspace,
			args: ["push", "-u", "origin", "main"],
		});

		runGit({
			cwd: repo.workspace,
			args: ["checkout", "-b", "renovate/test__v2.0.0"],
		});
		fs.writeFileSync(path.join(repo.workspace, "dependency.txt"), "version=2.0.0\n");
		runGit({
			cwd: repo.workspace,
			args: ["commit", "-am", "renovate update"],
		});
		const originalHeadSha = runGit({
			cwd: repo.workspace,
			args: ["rev-parse", "HEAD"],
		});
		runGit({
			cwd: repo.workspace,
			args: ["push", "-u", "origin", "renovate/test__v2.0.0"],
		});

		runGit({
			cwd: repo.workspace,
			args: ["checkout", "main"],
		});
		fs.writeFileSync(path.join(repo.workspace, "dependency.txt"), "version=1.0.1\n");
		runGit({
			cwd: repo.workspace,
			args: ["commit", "-am", "base advances"],
		});
		runGit({
			cwd: repo.workspace,
			args: ["push"],
		});

		const result = refreshPullRequestBranch({
			remoteUrl: repo.remoteDir,
			baseRef: "main",
			headRef: "renovate/test__v2.0.0",
			headSha: originalHeadSha,
			tmpDirRoot: repo.root,
		});

		assert.equal(result.refreshed, true);
		assert.notEqual(result.refreshedHeadSha, originalHeadSha);

		runGit({
			cwd: repo.workspace,
			args: ["fetch", "--quiet", "origin", "main", "renovate/test__v2.0.0"],
		});
		const refreshedValue = runGit({
			cwd: repo.workspace,
			args: ["show", "origin/renovate/test__v2.0.0:dependency.txt"],
		});
		assert.equal(refreshedValue, "version=2.0.0");
		assert.doesNotThrow(() =>
			runGit({
				cwd: repo.workspace,
				args: [
					"merge-base",
					"--is-ancestor",
					"origin/main",
					"origin/renovate/test__v2.0.0",
				],
			}),
		);
	} finally {
		repo.cleanup();
	}
});

test("refuses to refresh branches with more than one commit ahead of the base", () => {
	const repo = setupRemoteRepository();

	try {
		fs.writeFileSync(path.join(repo.workspace, "dependency.txt"), "version=1.0.0\n");
		runGit({
			cwd: repo.workspace,
			args: ["add", "dependency.txt"],
		});
		runGit({
			cwd: repo.workspace,
			args: ["commit", "-m", "base"],
		});
		runGit({
			cwd: repo.workspace,
			args: ["push", "-u", "origin", "main"],
		});

		runGit({
			cwd: repo.workspace,
			args: ["checkout", "-b", "renovate/test__v2.0.0"],
		});
		fs.writeFileSync(path.join(repo.workspace, "dependency.txt"), "version=2.0.0\n");
		runGit({
			cwd: repo.workspace,
			args: ["commit", "-am", "renovate update"],
		});
		fs.writeFileSync(path.join(repo.workspace, "extra.txt"), "manual follow-up\n");
		runGit({
			cwd: repo.workspace,
			args: ["add", "extra.txt"],
		});
		runGit({
			cwd: repo.workspace,
			args: ["commit", "-m", "unexpected extra commit"],
		});
		const headSha = runGit({
			cwd: repo.workspace,
			args: ["rev-parse", "HEAD"],
		});
		runGit({
			cwd: repo.workspace,
			args: ["push", "-u", "origin", "renovate/test__v2.0.0"],
		});

		assert.throws(
			() =>
				refreshPullRequestBranch({
					remoteUrl: repo.remoteDir,
					baseRef: "main",
					headRef: "renovate/test__v2.0.0",
					headSha,
					tmpDirRoot: repo.root,
				}),
			/exactly one commit ahead of main; found 2/,
		);
	} finally {
		repo.cleanup();
	}
});
