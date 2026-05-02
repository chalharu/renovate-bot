import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	builtinSuccessPlan,
	type CheckRunTarget,
	checkRunBody,
	checkRunUpdateBody,
	DEFAULT_WAIT_DAYS_FALLBACK,
	decideFromPayload,
	elapsedDaysFloor,
	evaluatedPlan,
	evaluateWaitPeriod,
	extractStateTokenMarker,
	formatStateTokenMarker,
	parseDefaultWaitDays,
	parseWaitLabel,
	queuePlan,
	waitDaysForLabels,
} from "./decision.js";

function makePayload(action: string, branch: string): unknown {
	return {
		action,
		repository: { full_name: "owner/repo" },
		pull_request: { number: 42, head: { ref: branch, sha: "abc123" } },
	};
}

const TARGET: CheckRunTarget = {
	repositoryFullName: "owner/repo",
	prNumber: 42,
	headSha: "abc123",
};

const NOW = new Date("2026-04-30T12:00:00.000Z");

describe("decideFromPayload", () => {
	it("queues supported open actions for renovate/* branches", () => {
		for (const action of ["opened", "reopened", "synchronize"]) {
			const decision = decideFromPayload(
				makePayload(action, "renovate/example"),
			);
			assert.equal(decision.type, "queue");
			if (decision.type === "queue") {
				assert.deepEqual(decision.target, TARGET);
			}
		}
	});

	it("reevaluates label actions for renovate/* branches", () => {
		for (const action of ["labeled", "unlabeled"]) {
			const decision = decideFromPayload(
				makePayload(action, "renovate/example"),
			);
			assert.equal(decision.type, "reevaluate");
		}
	});

	it("ignores non-renovate branches", () => {
		const decision = decideFromPayload(
			makePayload("opened", "feature/example"),
		);
		assert.equal(decision.type, "ignore");
		if (decision.type === "ignore") {
			assert.equal(decision.reason.type, "nonRenovateBranch");
			if (decision.reason.type === "nonRenovateBranch") {
				assert.equal(decision.reason.branch, "feature/example");
			}
		}
	});

	it("ignores unsupported actions", () => {
		const decision = decideFromPayload(
			makePayload("closed", "renovate/example"),
		);
		assert.equal(decision.type, "ignore");
		if (decision.type === "ignore") {
			assert.equal(decision.reason.type, "unsupportedAction");
			if (decision.reason.type === "unsupportedAction") {
				assert.equal(decision.reason.action, "closed");
			}
		}
	});

	it("throws on malformed payload", () => {
		assert.throws(
			() => decideFromPayload({ action: "opened" }),
			/invalid pull_request payload/,
		);
		assert.throws(
			() =>
				decideFromPayload({
					action: "opened",
					repository: { full_name: "owner/repo" },
					pull_request: null,
				}),
			/invalid pull_request payload/,
		);
	});
});

describe("parseDefaultWaitDays", () => {
	it("accepts valid positive integers", () => {
		assert.deepEqual(parseDefaultWaitDays("5"), {
			days: 5,
			usedFallback: false,
		});
	});

	it("falls back for zero, negative, or non-numeric values", () => {
		const fallback = { days: DEFAULT_WAIT_DAYS_FALLBACK, usedFallback: true };
		assert.deepEqual(parseDefaultWaitDays("0"), fallback);
		assert.deepEqual(parseDefaultWaitDays("not-a-number"), fallback);
		assert.deepEqual(parseDefaultWaitDays(undefined), fallback);
	});
});

describe("waitDaysForLabels / parseWaitLabel", () => {
	it("security label overrides wait label and returns 0", () => {
		assert.equal(waitDaysForLabels(["renovate-wait-10d", "security"], 3), 0);
	});

	it("parses valid wait labels", () => {
		assert.equal(parseWaitLabel("renovate-wait-7d"), 7);
	});

	it("rejects zero and non-numeric wait labels", () => {
		assert.equal(parseWaitLabel("renovate-wait-0d"), null);
		assert.equal(parseWaitLabel("renovate-wait-abcd"), null);
	});

	it("skips invalid labels and uses the first valid one", () => {
		assert.equal(
			waitDaysForLabels(["renovate-wait-0d", "renovate-wait-5d"], 3),
			5,
		);
	});

	it("uses default when no matching labels", () => {
		assert.equal(waitDaysForLabels([], 3), 3);
	});
});

describe("elapsedDaysFloor", () => {
	it("floors elapsed time to full days", () => {
		// 23h 59m 59s elapsed → 0 full days
		assert.equal(
			elapsedDaysFloor(new Date("2026-04-29T12:00:01.000Z"), NOW),
			0,
		);
		// exactly 86400s → 1 day
		assert.equal(
			elapsedDaysFloor(new Date("2026-04-29T12:00:00.000Z"), NOW),
			1,
		);
		// future timestamp → 0 days (clamped to 0)
		assert.equal(
			elapsedDaysFloor(new Date("2026-05-01T12:00:00.000Z"), NOW),
			0,
		);
	});
});

describe("evaluateWaitPeriod", () => {
	it("stays pending before the wait period elapses", () => {
		const result = evaluateWaitPeriod(
			["renovate-wait-3d"],
			1,
			new Date("2026-04-27T12:00:01.000Z"),
			NOW,
		);
		assert.equal(result.elapsedDays, 2);
		assert.equal(result.state, "pending");
	});

	it("succeeds exactly when the wait period has elapsed", () => {
		const result = evaluateWaitPeriod(
			["renovate-wait-3d"],
			1,
			new Date("2026-04-27T12:00:00.000Z"),
			NOW,
		);
		assert.equal(result.elapsedDays, 3);
		assert.equal(result.state, "success");
	});
});

describe("state token markers", () => {
	it("round-trips the marker in surrounding text", () => {
		const marker = formatStateTokenMarker("token-value");
		assert.equal(
			extractStateTokenMarker(`visible text ${marker} trailing text`),
			"token-value",
		);
	});

	it("returns null when marker is absent", () => {
		assert.equal(extractStateTokenMarker("no marker here"), null);
	});
});

describe("check run body shapes", () => {
	it("matches expected GitHub API shape for queue, pending, and success states", () => {
		const queue = queuePlan(
			TARGET,
			"Waiting for the Renovate follow-up workflow to resolve release metadata.",
		);
		const evaluation = evaluateWaitPeriod(
			["renovate-wait-3d"],
			1,
			new Date("2026-04-28T12:00:00.000Z"),
			NOW,
		);
		const pending = evaluatedPlan(
			TARGET,
			evaluation,
			new Date("2026-04-28T12:00:00.000Z"),
			"token",
		);
		const success = builtinSuccessPlan(
			TARGET,
			"Renovate's built-in stability-days check exists on this commit.",
		);

		assert.equal(checkRunBody(queue).status, "queued");
		assert.equal(checkRunBody(pending).status, "in_progress");
		assert.equal(
			(checkRunBody(pending).output as { text: string }).text,
			"<!-- custom-stability-days-jwt:token -->",
		);
		assert.equal(checkRunBody(success).status, "completed");
		assert.equal(checkRunBody(success).conclusion, "success");
		assert.equal(checkRunUpdateBody(success).conclusion, "success");
	});
});
