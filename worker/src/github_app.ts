import { encodeBase64UrlBytes, encodeBase64UrlString } from "./base64url.js";

export async function createGithubAppJwt(
	issuer: string,
	privateKeyPem: string,
	now: Date,
): Promise<string> {
	const normalizedPem = normalizePem(privateKeyPem);
	const pkcs8Der = extractPkcs8Der(normalizedPem);

	const nowSecs = Math.floor(now.getTime() / 1000);
	const header = { alg: "RS256", typ: "JWT" };
	const claims = { iss: issuer, iat: nowSecs - 60, exp: nowSecs + 9 * 60 };

	const headerB64 = encodeBase64UrlString(JSON.stringify(header));
	const claimsB64 = encodeBase64UrlString(JSON.stringify(claims));
	const signingInput = `${headerB64}.${claimsB64}`;

	const key = await crypto.subtle.importKey(
		"pkcs8",
		pkcs8Der,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(signingInput),
	);

	return `${signingInput}.${encodeBase64UrlBytes(new Uint8Array(sig))}`;
}

function normalizePem(pem: string): string {
	const normalized = pem.replace(/\r\n/g, "\n");
	if (normalized.includes("\\n") && !normalized.includes("\n")) {
		return normalized.replace(/\\n/g, "\n");
	}
	return normalized;
}

function extractPkcs8Der(pem: string): ArrayBuffer {
	if (pem.includes("-----BEGIN PRIVATE KEY-----")) {
		return decodePemBlock(pem, "PRIVATE KEY");
	}
	if (pem.includes("-----BEGIN RSA PRIVATE KEY-----")) {
		return pkcs1ToPkcs8(new Uint8Array(decodePemBlock(pem, "RSA PRIVATE KEY")));
	}
	throw new Error("invalid GitHub App private key: unrecognised PEM label");
}

function decodePemBlock(pem: string, label: string): ArrayBuffer {
	const begin = `-----BEGIN ${label}-----`;
	const end = `-----END ${label}-----`;
	let body = "";
	let inBlock = false;
	for (const line of pem.split("\n").map((l) => l.trim())) {
		if (line === begin) {
			inBlock = true;
			continue;
		}
		if (line === end) break;
		if (inBlock) body += line;
	}
	if (!body) throw new Error("invalid GitHub App private key: empty PEM block");
	const binary = atob(body);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

/** Wrap a PKCS#1 RSA private key in a PKCS#8 PrivateKeyInfo envelope. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): ArrayBuffer {
	// rsaEncryption OID 1.2.840.113549.1.1.1
	const RSA_OID: number[] = [
		0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
	];
	const NULL: number[] = [0x05, 0x00];
	const VERSION_ZERO: number[] = [0x02, 0x01, 0x00];

	const algorithmId = derWrap(0x30, [...RSA_OID, ...NULL]);
	const privateKeyOctet = derWrap(0x04, Array.from(pkcs1));
	const privateKeyInfo = derWrap(0x30, [
		...VERSION_ZERO,
		...algorithmId,
		...privateKeyOctet,
	]);

	return new Uint8Array(privateKeyInfo).buffer;
}

function derWrap(tag: number, content: number[]): number[] {
	return [tag, ...derLen(content.length), ...content];
}

function derLen(len: number): number[] {
	if (len < 128) return [len];
	const bytes: number[] = [];
	let n = len;
	while (n > 0) {
		bytes.unshift(n & 0xff);
		n >>>= 8;
	}
	return [0x80 | bytes.length, ...bytes];
}
