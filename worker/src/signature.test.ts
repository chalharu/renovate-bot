import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { verifyGithubSignature, verifyGithubWebhook } from "./signature.js";

// sha256=HMAC-SHA256("secret", "payload") — same test vector used in the Rust tests.
const VALID_SIGNATURE =
	"sha256=b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4";
const PAYLOAD = new TextEncoder().encode("payload");

describe("verifyGithubSignature", () => {
	it("accepts a correct signature", async () => {
		assert.equal(
			await verifyGithubSignature("secret", PAYLOAD, VALID_SIGNATURE),
			true,
		);
	});

	it("rejects a wrong signature", async () => {
		assert.equal(
			await verifyGithubSignature(
				"secret",
				PAYLOAD,
				"sha256=0000000000000000000000000000000000000000000000000000000000000000",
			),
			false,
		);
	});

	it("rejects a missing signature header", async () => {
		assert.equal(await verifyGithubSignature("secret", PAYLOAD, null), false);
		assert.equal(
			await verifyGithubSignature("secret", PAYLOAD, undefined),
			false,
		);
	});

	it("rejects a sha1-prefixed signature", async () => {
		assert.equal(
			await verifyGithubSignature("secret", PAYLOAD, "sha1=abc"),
			false,
		);
	});

	it("rejects a non-hex signature", async () => {
		assert.equal(
			await verifyGithubSignature("secret", PAYLOAD, "sha256=not-hex"),
			false,
		);
	});
});

describe("verifyGithubWebhook", () => {
	it("returns missing_secret when secret is absent", async () => {
		const result = await verifyGithubWebhook(
			undefined,
			PAYLOAD,
			VALID_SIGNATURE,
		);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error, "missing_secret");
	});

	it("returns ok for a valid secret and matching signature", async () => {
		const result = await verifyGithubWebhook(
			"secret",
			PAYLOAD,
			VALID_SIGNATURE,
		);
		assert.equal(result.ok, true);
	});

	it("returns invalid_signature for a mismatched signature", async () => {
		const result = await verifyGithubWebhook("secret", PAYLOAD, "sha256=0000");
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error, "invalid_signature");
	});
});
