const assert = require("node:assert/strict");
const test = require("node:test");

const {
	evaluatePullRequestTargetLine,
} = require("./renovate-merge-gate-target-line");

test("allows same-line patch downgrades after the wait gate", () => {
	assert.deepEqual(
		evaluatePullRequestTargetLine({
			headRef: "renovate/actions-checkout__vv4.3.1",
			patches: [
				["@@ -1 +1 @@", "-version: 4.3.5", "+version: 4.3.1"].join("\n"),
			],
		}),
		{
			blocked: false,
		},
	);
});

test("blocks merges when the live base already moved to a newer minor line", () => {
	assert.deepEqual(
		evaluatePullRequestTargetLine({
			headRef: "renovate/actions-checkout__vv4.3.0",
			patches: [
				["@@ -1 +1 @@", "-version: 4.4.2", "+version: 4.3.0"].join("\n"),
			],
		}),
		{
			blocked: true,
			currentVersion: "4.4.2",
			targetVersion: "v4.3.0",
			reason:
				"the current base already moved to newer line 4.4.2 than the target version v4.3.0",
		},
	);
});

test("matches only the changed target line inside a larger diff block", () => {
	assert.deepEqual(
		evaluatePullRequestTargetLine({
			headRef: "renovate/actions-checkout__vv4.3.1",
			patches: [
				[
					"@@ -1,2 +1,2 @@",
					"-compat-version: 9.0.0",
					"-dependency-version: 4.3.5",
					"+compat-version: 10.0.0",
					"+dependency-version: 4.3.1",
				].join("\n"),
			],
		}),
		{
			blocked: false,
		},
	);
});

test("matches repeated normalized lines by occurrence order", () => {
	assert.deepEqual(
		evaluatePullRequestTargetLine({
			headRef: "renovate/actions-checkout__vv4.3.1",
			patches: [
				[
					"@@ -1,2 +1,2 @@",
					"-tag: 5.0.0",
					"-tag: 4.3.5",
					"+tag: 5.1.0",
					"+tag: 4.3.1",
				].join("\n"),
			],
		}),
		{
			blocked: false,
		},
	);
});

test("matches reordered repeated normalized lines to the closest target version", () => {
	assert.deepEqual(
		evaluatePullRequestTargetLine({
			headRef: "renovate/actions-checkout__vv4.3.0",
			patches: [
				[
					"@@ -1,2 +1,2 @@",
					"-tag: 4.4.2",
					"-tag: 1.0.0",
					"+tag: 1.1.0",
					"+tag: 4.3.0",
				].join("\n"),
			],
		}),
		{
			blocked: true,
			currentVersion: "4.4.2",
			targetVersion: "v4.3.0",
			reason:
				"the current base already moved to newer line 4.4.2 than the target version v4.3.0",
		},
	);
});

test("matches lines even when trailing comments changed on the same line", () => {
	assert.deepEqual(
		evaluatePullRequestTargetLine({
			headRef: "renovate/actions-checkout__vv4.3.0",
			patches: [
				[
					"@@ -1 +1 @@",
					"-uses: actions/checkout@v4.4.2 # pinned",
					"+uses: actions/checkout@v4.3.0",
				].join("\n"),
			],
		}),
		{
			blocked: true,
			currentVersion: "v4.4.2",
			targetVersion: "v4.3.0",
			reason:
				"the current base already moved to newer line v4.4.2 than the target version v4.3.0",
		},
	);
});

test("matches punctuation-delimited context when the version order changes", () => {
	assert.deepEqual(
		evaluatePullRequestTargetLine({
			headRef: "renovate/actions-checkout__vv4.3.0",
			patches: [
				[
					"@@ -1 +1 @@",
					'-{"dep":"4.4.2","compat":"4.2.0"}',
					'+{"compat":"4.2.0","dep":"4.3.0"}',
				].join("\n"),
			],
		}),
		{
			blocked: true,
			currentVersion: "4.4.2",
			targetVersion: "v4.3.0",
			reason:
				"the current base already moved to newer line 4.4.2 than the target version v4.3.0",
		},
	);
});

test("matches only the target-version token when a line contains multiple semvers", () => {
	assert.deepEqual(
		evaluatePullRequestTargetLine({
			headRef: "renovate/actions-checkout__vv4.3.1",
			patches: [
				[
					"@@ -1 +1 @@",
					"-combo: compat 10.0.0 dep 4.3.5",
					"+combo: compat 10.0.0 dep 4.3.1",
				].join("\n"),
			],
		}),
		{
			blocked: false,
		},
	);
});

test("ignores semvers that only appear inside trailing hash comments", () => {
	assert.deepEqual(
		evaluatePullRequestTargetLine({
			headRef: "renovate/actions-checkout__vv4.3.1",
			patches: [
				[
					"@@ -1 +1 @@",
					"-version: 4.3.5 # note 5.0.0",
					"+version: 4.3.1 # note 5.0.0",
				].join("\n"),
			],
		}),
		{
			blocked: false,
		},
	);
});

test("checks every target-version token that appears on the matched line", () => {
	assert.deepEqual(
		evaluatePullRequestTargetLine({
			headRef: "renovate/actions-checkout__vv4.3.0",
			patches: [
				[
					"@@ -1 +1 @@",
					"-combo: compat 4.3.0 dep 4.4.0",
					"+combo: compat 4.3.0 dep 4.3.0",
				].join("\n"),
			],
		}),
		{
			blocked: true,
			currentVersion: "4.4.0",
			targetVersion: "v4.3.0",
			reason:
				"the current base already moved to newer line 4.4.0 than the target version v4.3.0",
		},
	);
});

test("treats lines beginning with repeated diff markers as actual content", () => {
	assert.deepEqual(
		evaluatePullRequestTargetLine({
			headRef: "renovate/actions-checkout__vv4.3.0",
			patches: [
				["@@ -1 +1 @@", "---version: 4.4.2", "+--version: 4.3.0"].join("\n"),
			],
		}),
		{
			blocked: true,
			currentVersion: "4.4.2",
			targetVersion: "v4.3.0",
			reason:
				"the current base already moved to newer line 4.4.2 than the target version v4.3.0",
		},
	);
});

test("matches prerelease targets by exact version text instead of numeric core only", () => {
	assert.deepEqual(
		evaluatePullRequestTargetLine({
			headRef: "renovate/actions-checkout__vv4.3.1-beta.1",
			patches: [
				[
					"@@ -1 +1 @@",
					"-combo: compat 10.0.0 dep 4.4.0",
					"+combo: compat 10.0.0 dep 4.3.1",
				].join("\n"),
			],
		}),
		{
			blocked: false,
		},
	);
});

test("ignores hunks that do not add the pull request target version", () => {
	assert.deepEqual(
		evaluatePullRequestTargetLine({
			headRef: "renovate/actions-checkout__vv4.3.0",
			patches: [
				["@@ -1 +1 @@", "-version: 5.0.0", "+version: 6.0.0"].join("\n"),
			],
		}),
		{
			blocked: false,
		},
	);
});
