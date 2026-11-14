/**
 * Cloudflare Access JWT verification for the dashboard.
 *
 * Access puts a signed JWT in the `Cf-Access-Jwt-Assertion` header of every
 * request it lets through. We check the RS256 signature against the team's
 * public keys, plus `iss`, `aud`, `exp` and `nbf`. This guards against
 * requests that reach the Worker without passing through Access (for example
 * via a workers.dev URL).
 */

export interface AccessConfig {
	/** e.g. "https://myteam.cloudflareaccess.com" */
	issuer: string;
	certsUrl: string;
	aud: string;
}

export type AccessResult = "ok" | "missing" | "invalid";

const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_MS = 10 * 60 * 1000;

/** Build config from vars; null (dashboard disabled) if either is unset. */
export function accessConfig(teamDomain: string | undefined, aud: string | undefined) {
	const team = teamDomain
		?.trim()
		.replace(/^https?:\/\//, "")
		.replace(/\/+$/, "");
	const audience = aud?.trim();
	if (!team || !audience) return null;
	const host = team.includes(".") ? team : `${team}.cloudflareaccess.com`;
	if (!/^[a-z0-9.-]+$/i.test(host)) return null;
	const issuer = `https://${host}`;
	return {
		issuer,
		certsUrl: `${issuer}/cdn-cgi/access/certs`,
		aud: audience,
	} as AccessConfig;
}

interface Jwk extends JsonWebKey {
	kid?: string;
}

let jwksCache: { url: string; at: number; keys: Jwk[] } | null = null;

/** For tests. */
export function clearJwksCache(): void {
	jwksCache = null;
}

async function getKeys(certsUrl: string, forceRefresh: boolean): Promise<Jwk[]> {
	const now = Date.now();
	if (!forceRefresh && jwksCache?.url === certsUrl && now - jwksCache.at < JWKS_TTL_MS) {
		return jwksCache.keys;
	}
	const res = await fetch(certsUrl, {
		headers: { accept: "application/json" },
	});
	if (!res.ok) throw new Error("jwks fetch failed");
	const body = (await res.json()) as { keys?: Jwk[] };
	const keys = Array.isArray(body.keys) ? body.keys : [];
	jwksCache = { url: certsUrl, at: now, keys };
	return keys;
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function decodeJson(part: string): Record<string, unknown> {
	const v = JSON.parse(new TextDecoder().decode(b64urlDecode(part)));
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("bad json");
	return v as Record<string, unknown>;
}

export async function verifyAccessJwt(
	token: string | null,
	config: AccessConfig,
	nowMs: number = Date.now(),
): Promise<AccessResult> {
	if (!token) return "missing";
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return "invalid";
		const [h, p, s] = parts as [string, string, string];
		const header = decodeJson(h);
		const payload = decodeJson(p);
		if (header.alg !== "RS256" || typeof header.kid !== "string") return "invalid";

		let keys = await getKeys(config.certsUrl, false);
		let jwk = keys.find((k) => k.kid === header.kid);
		if (!jwk) {
			// Keys rotate; refetch once before giving up.
			keys = await getKeys(config.certsUrl, true);
			jwk = keys.find((k) => k.kid === header.kid);
		}
		if (jwk?.kty !== "RSA") return "invalid";

		const key = await crypto.subtle.importKey(
			"jwk",
			{ kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		const ok = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			b64urlDecode(s),
			new TextEncoder().encode(`${h}.${p}`),
		);
		if (!ok) return "invalid";

		const now = Math.floor(nowMs / 1000);
		if (payload.iss !== config.issuer) return "invalid";
		const aud = payload.aud;
		const auds = Array.isArray(aud) ? aud : [aud];
		if (!auds.includes(config.aud)) return "invalid";
		if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS < now) {
			return "invalid";
		}
		if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_SECONDS > now) {
			return "invalid";
		}
		return "ok";
	} catch {
		return "invalid";
	}
}
