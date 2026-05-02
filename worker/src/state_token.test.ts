import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	decodeStateToken,
	encodeStateToken,
	normalizeSharedSecret,
	type PendingStateTokenClaims,
	StateTokenError,
} from "./state_token.js";

const HELPER_COMPAT_TOKEN =
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyZXBvc2l0b3J5X2Z1bGxfbmFtZSI6Im93bmVyL3JlcG8iLCJwcl9udW1iZXIiOjQyLCJoZWFkX3NoYSI6ImFiYzEyMyIsInZlcnNpb25fY3JlYXRlZF9hdCI6IjIwMjYtMDQtMjhUMTI6MDA6MDAuMDAwWiIsImlhdCI6MTc3Nzc3Nzc3N30.EM0SpNI8IsqSwRLk6UK5p028QpZkT6uEU6lJmJsbab0";
const RUST_STYLE_TIMESTAMP_TOKEN =
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyZXBvc2l0b3J5X2Z1bGxfbmFtZSI6Im93bmVyL3JlcG8iLCJwcl9udW1iZXIiOjQyLCJoZWFkX3NoYSI6ImFiYzEyMyIsInZlcnNpb25fY3JlYXRlZF9hdCI6IjIwMjYtMDQtMjhUMTI6MDA6MDBaIiwiaWF0IjoxNzc3Nzc3Nzc3fQ.F7n7KLckDauUzO246smOUo9_1jM-R0NQCph9KZHUTpY";

function makeClaims(): PendingStateTokenClaims {
	return {
		repository_full_name: "owner/repo",
		pr_number: 42,
		head_sha: "abc123",
		version_created_at: "2026-04-28T12:00:00.000Z",
		iat: 1_777_777_777,
	};
}

describe("encodeStateToken / decodeStateToken", () => {
	it("round-trips a pending state token", async () => {
		const token = await encodeStateToken("secret", makeClaims());
		const decoded = await decodeStateToken("secret", token);
		assert.deepEqual(decoded, makeClaims());
	});

	it("rejects a tampered token (appended character)", async () => {
		const token = await encodeStateToken("secret", makeClaims());
		await assert.rejects(
			() => decodeStateToken("secret", token + "x"),
			(err: unknown) =>
				err instanceof StateTokenError && err.code === "invalid_signature",
		);
	});

	it("rejects a token with a bad signature segment", async () => {
		const [header, claims] = (
			await encodeStateToken("secret", makeClaims())
		).split(".");
		await assert.rejects(
			() => decodeStateToken("secret", `${header}.${claims}.badsig`),
			(err: unknown) =>
				err instanceof StateTokenError && err.code === "invalid_signature",
		);
	});

	it("rejects a token with wrong number of segments", async () => {
		await assert.rejects(
			() => decodeStateToken("secret", "only.two"),
			(err: unknown) =>
				err instanceof StateTokenError && err.code === "invalid_format",
		);
		await assert.rejects(
			() => decodeStateToken("secret", "a.b.c.d"),
			(err: unknown) =>
				err instanceof StateTokenError && err.code === "invalid_format",
		);
	});

	it("is cross-compatible with tokens produced by the JavaScript helper script", async () => {
		const decoded = await decodeStateToken("secret", HELPER_COMPAT_TOKEN);
		assert.deepEqual(decoded, makeClaims());
	});

	it("accepts Rust-style version_created_at timestamps without milliseconds", async () => {
		const decoded = await decodeStateToken(
			"secret",
			RUST_STYLE_TIMESTAMP_TOKEN,
		);
		assert.equal(decoded.version_created_at, "2026-04-28T12:00:00Z");
		assert.equal(
			new Date(decoded.version_created_at).toISOString(),
			"2026-04-28T12:00:00.000Z",
		);
	});
});

describe("normalizeSharedSecret", () => {
	it("replaces literal \\n with newlines when no real newlines are present", () => {
		assert.equal(normalizeSharedSecret("line-1\\nline-2"), "line-1\nline-2");
	});

	it("leaves secrets with real newlines unchanged", () => {
		assert.equal(normalizeSharedSecret("line-1\nline-2"), "line-1\nline-2");
	});

	it("normalizes CRLF to LF", () => {
		assert.equal(normalizeSharedSecret("line-1\r\nline-2"), "line-1\nline-2");
	});

	it("decodes tokens encoded with a normalized multi-line secret", async () => {
		const token = await encodeStateToken("line-1\nline-2", makeClaims());
		const decoded = await decodeStateToken("line-1\\nline-2", token);
		assert.deepEqual(decoded, makeClaims());
	});
});
