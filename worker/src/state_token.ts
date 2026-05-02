import {
	decodeBase64UrlBytes,
	decodeBase64UrlString,
	encodeBase64UrlBytes,
	encodeBase64UrlString,
} from "./base64url.js";

const HMAC_ALGO = { name: "HMAC", hash: "SHA-256" } as const;

/** Claims stored inside the HS256 pending-state JWT. */
export interface PendingStateTokenClaims {
	repository_full_name: string;
	pr_number: number;
	head_sha: string;
	/** ISO 8601 UTC string, e.g. "2026-04-28T12:00:00.000Z" */
	version_created_at: string;
	iat: number;
}

export class StateTokenError extends Error {
	constructor(
		public readonly code:
			| "invalid_format"
			| "invalid_header"
			| "invalid_signature"
			| "invalid_claims",
	) {
		super(code);
		this.name = "StateTokenError";
	}
}

export async function encodeStateToken(
	secret: string,
	claims: PendingStateTokenClaims,
): Promise<string> {
	const headerB64 = encodeBase64UrlString(
		JSON.stringify({ alg: "HS256", typ: "JWT" }),
	);
	const claimsB64 = encodeBase64UrlString(JSON.stringify(claims));
	const signingInput = `${headerB64}.${claimsB64}`;
	const signature = await hmacSign(normalizeSharedSecret(secret), signingInput);
	return `${signingInput}.${signature}`;
}

export async function decodeStateToken(
	secret: string,
	token: string,
): Promise<PendingStateTokenClaims> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new StateTokenError("invalid_format");
	const [headerB64, claimsB64, signatureB64] = parts as [
		string,
		string,
		string,
	];

	let header: unknown;
	try {
		header = JSON.parse(decodeBase64UrlString(headerB64));
	} catch {
		throw new StateTokenError("invalid_header");
	}
	if (
		typeof header !== "object" ||
		header === null ||
		(header as { alg?: unknown }).alg !== "HS256" ||
		(header as { typ?: unknown }).typ !== "JWT"
	) {
		throw new StateTokenError("invalid_header");
	}

	let signatureBytes: Uint8Array;
	try {
		signatureBytes = decodeBase64UrlBytes(signatureB64);
	} catch {
		throw new StateTokenError("invalid_signature");
	}

	const signingInput = `${headerB64}.${claimsB64}`;
	const valid = await hmacVerify(
		normalizeSharedSecret(secret),
		signingInput,
		signatureBytes,
	);
	if (!valid) throw new StateTokenError("invalid_signature");

	let claims: unknown;
	try {
		claims = JSON.parse(decodeBase64UrlString(claimsB64));
	} catch {
		throw new StateTokenError("invalid_claims");
	}
	if (!isValidClaims(claims)) throw new StateTokenError("invalid_claims");
	return claims;
}

/** Normalize shared secrets: CRLF → LF, and literal \n → newline when no real newlines present. */
export function normalizeSharedSecret(secret: string): string {
	const normalized = secret.replace(/\r\n/g, "\n");
	if (normalized.includes("\\n") && !normalized.includes("\n")) {
		return normalized.replace(/\\n/g, "\n");
	}
	return normalized;
}

function isValidClaims(value: unknown): value is PendingStateTokenClaims {
	if (typeof value !== "object" || value === null) return false;
	const c = value as Record<string, unknown>;
	return (
		typeof c.repository_full_name === "string" &&
		typeof c.pr_number === "number" &&
		typeof c.head_sha === "string" &&
		typeof c.version_created_at === "string" &&
		typeof c.iat === "number"
	);
}

async function hmacSign(secret: string, signingInput: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		HMAC_ALGO,
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(signingInput),
	);
	return encodeBase64UrlBytes(new Uint8Array(sig));
}

async function hmacVerify(
	secret: string,
	signingInput: string,
	signature: Uint8Array,
): Promise<boolean> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		HMAC_ALGO,
		false,
		["verify"],
	);
	return crypto.subtle.verify(
		"HMAC",
		key,
		signature,
		encoder.encode(signingInput),
	);
}
