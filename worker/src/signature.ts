const GITHUB_SHA256_PREFIX = "sha256=";

export type SignatureVerificationResult =
	| { ok: true }
	| { ok: false; error: "missing_secret" | "invalid_signature" };

export async function verifyGithubWebhook(
	secret: string | undefined,
	body: Uint8Array,
	signatureHeader: string | null | undefined,
): Promise<SignatureVerificationResult> {
	if (!secret) {
		return { ok: false, error: "missing_secret" };
	}
	const valid = await verifyGithubSignature(secret, body, signatureHeader);
	return valid ? { ok: true } : { ok: false, error: "invalid_signature" };
}

export async function verifyGithubSignature(
	secret: string,
	body: Uint8Array,
	signatureHeader: string | null | undefined,
): Promise<boolean> {
	if (!signatureHeader?.startsWith(GITHUB_SHA256_PREFIX)) {
		return false;
	}
	const signatureHex = signatureHeader.slice(GITHUB_SHA256_PREFIX.length);
	let signatureBytes: Uint8Array;
	try {
		signatureBytes = hexToBytes(signatureHex);
	} catch {
		return false;
	}

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify("HMAC", key, signatureBytes, body);
}

function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error("odd-length hex string");
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		const byte = parseInt(hex.slice(i, i + 2), 16);
		if (Number.isNaN(byte)) throw new Error("invalid hex string");
		bytes[i / 2] = byte;
	}
	return bytes;
}
