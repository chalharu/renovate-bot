const assert = require("node:assert/strict");
const test = require("node:test");

const { ensureRebaseRetryRequested } = require("./renovate-merge-gate-rebase");

test("checks the plain GitHub rebase/retry checkbox", () => {
	const result = ensureRebaseRetryRequested(`---

 - [ ] If you want to rebase/retry this PR, check this box

---`);

	assert.deepEqual(result, {
		body: `---

 - [x] If you want to rebase/retry this PR, check this box

---`,
		changed: true,
		supported: true,
	});
});

test("checks the commented rebase/retry checkbox variant", () => {
	const result = ensureRebaseRetryRequested(`---

 - [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box

---`);

	assert.deepEqual(result, {
		body: `---

 - [x] <!-- rebase-check -->If you want to rebase/retry this PR, check this box

---`,
		changed: true,
		supported: true,
	});
});

test("does not rewrite an already checked rebase/retry checkbox", () => {
	const body = `---

 - [x] <!-- rebase-check -->If you want to rebase/retry this PR, check this box

---`;
	const result = ensureRebaseRetryRequested(body);

	assert.deepEqual(result, {
		body,
		changed: false,
		supported: true,
	});
});

test("reports unsupported bodies when no rebase/retry checkbox is present", () => {
	const body = "This PR body does not include Renovate controls.";
	const result = ensureRebaseRetryRequested(body);

	assert.deepEqual(result, {
		body,
		changed: false,
		supported: false,
	});
});
