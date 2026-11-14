import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearJwksCache } from "../src/access";
import { getDashboardData } from "../src/dashboard/data";
import { renderDashboard } from "../src/dashboard/render";
import { route } from "../src/index";
import { DAY, NOW, newIp, post, resetDb, validReport } from "./helpers";

const TEAM = "example-team";
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const CERTS = `${ISSUER}/cdn-cgi/access/certs`;
const AUD = "test-aud-0123456789";
const accessEnv = { ...env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

const b64url = (data: ArrayBuffer | Uint8Array | string) => {
	const bytes =
		typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let keyPair: CryptoKeyPair;
let otherKeyPair: CryptoKeyPair;
let publicJwk: JsonWebKey;

async function makeKey() {
	return (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
}

async function signJwt(
	claims: Record<string, unknown>,
	opts: { key?: CryptoKey; kid?: string; alg?: string } = {},
) {
	const header = b64url(
		JSON.stringify({
			alg: opts.alg ?? "RS256",
			kid: opts.kid ?? "k1",
			typ: "JWT",
		}),
	);
	const payload = b64url(JSON.stringify(claims));
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		opts.key ?? keyPair.privateKey,
		new TextEncoder().encode(`${header}.${payload}`),
	);
	return `${header}.${payload}.${b64url(sig)}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const goodClaims = () => ({
	iss: ISSUER,
	aud: [AUD],
	sub: "user-id",
	iat: nowSec(),
	nbf: nowSec() - 5,
	exp: nowSec() + 600,
});

function getDashboard(token?: string, e: Partial<Cloudflare.Env> = accessEnv, query = "") {
	const headers: Record<string, string> = {};
	if (token !== undefined) headers["cf-access-jwt-assertion"] = token;
	return route(
		new Request(`https://relay.example/dashboard${query}`, { headers }),
		{ ...env, ...e },
		NOW,
	);
}

beforeAll(async () => {
	keyPair = await makeKey();
	otherKeyPair = await makeKey();
	publicJwk = {
		...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)),
		kid: "k1",
	} as JsonWebKey & { kid: string };
});

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
	await resetDb();
	clearJwksCache();
	fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === CERTS) return Response.json({ keys: [publicJwk] });
		return new Response("unexpected fetch", { status: 599 });
	});
});
afterEach(() => {
	fetchSpy.mockRestore();
});

describe("dashboard access control", () => {
	it("is 404 when Access is not configured", async () => {
		expect((await getDashboard(await signJwt(goodClaims()), {})).status).toBe(404);
		expect(
			(
				await getDashboard(await signJwt(goodClaims()), {
					ACCESS_TEAM_DOMAIN: TEAM,
					ACCESS_AUD: "",
				})
			).status,
		).toBe(404);
		expect(
			(
				await getDashboard(await signJwt(goodClaims()), {
					ACCESS_TEAM_DOMAIN: "",
					ACCESS_AUD: AUD,
				})
			).status,
		).toBe(404);
	});

	it("is 401 without a JWT", async () => {
		const res = await getDashboard();
		expect(res.status).toBe(401);
		expect(await res.text()).toBe("");
	});

	it("is 403 with a bad JWT", async () => {
		const c = goodClaims();
		const bad: [string, string][] = [
			["garbage", "not-a-jwt"],
			["wrong key", await signJwt(c, { key: otherKeyPair.privateKey })],
			["unknown kid", await signJwt(c, { kid: "nope" })],
			["alg none", await signJwt(c, { alg: "none" })],
			["wrong aud", await signJwt({ ...c, aud: ["other"] })],
			["wrong iss", await signJwt({ ...c, iss: "https://evil.cloudflareaccess.com" })],
			["expired", await signJwt({ ...c, exp: nowSec() - 3600 })],
			["missing exp", await signJwt({ ...c, exp: undefined })],
			["not yet valid", await signJwt({ ...c, nbf: nowSec() + 3600 })],
		];
		const good = await signJwt(c);
		const [h, p] = good.split(".");
		bad.push([
			"tampered payload",
			`${h}.${b64url(JSON.stringify({ ...c, sub: "x" }))}.${good.split(".")[2]}`,
		]);
		bad.push(["truncated", `${h}.${p}`]);
		for (const [name, token] of bad) {
			const res = await getDashboard(token);
			expect(res.status, name).toBe(403);
		}
	});

	it("is 403 when the JWKS cannot be fetched", async () => {
		fetchSpy.mockImplementation(async () => new Response("down", { status: 500 }));
		expect((await getDashboard(await signJwt(goodClaims()))).status).toBe(403);
	});

	it("is 200 with a valid JWT, and accepts aud as a string and a full team domain", async () => {
		const res = await getDashboard(await signJwt(goodClaims()));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(fetchSpy).toHaveBeenCalledWith(CERTS, expect.anything());

		const res2 = await getDashboard(await signJwt({ ...goodClaims(), aud: AUD }), {
			ACCESS_TEAM_DOMAIN: `${TEAM}.cloudflareaccess.com`,
			ACCESS_AUD: AUD,
		});
		expect(res2.status).toBe(200);
	});
});

describe("dashboard data", () => {
	const at = (days: number, hour = 12) =>
		new Date(Date.parse("2026-11-14T00:00:00Z") + days * DAY + hour * 3600_000);

	async function seed() {
		const ip = () => newIp();
		const a = validReport();
		const b = validReport({
			os: "macos",
			os_version: "15.1",
			arch: "aarch64",
			app_version: "1.1.0",
			tm_version: null,
			ndi_version: "6.0.0",
			servers_local: 0,
			servers_remote: 2,
			displays: [
				{
					type: "pit",
					screens: [],
					transparency: "flatten",
					audio: false,
					resolution: "3840x2160",
					frame_rate: "60",
					running: true,
					run_seconds: 1800,
				},
			],
		});
		const c = validReport({ displays: [] });
		const old = validReport({ app_version: "1.1.9" });

		// A: launches today and 2 days ago; earlier report used older app version.
		await post({ ...a, app_version: "1.0.0" }, { ip: ip(), now: at(-2) });
		await post({ ...a, app_version: "1.1.2", reason: "change" }, { ip: ip(), now: at(0, 9) });
		// B: two days ago only.
		await post(b, { ip: ip(), now: at(-2, 15) });
		// A dev-channel install: accepted but never stored, so never counted.
		await post(validReport({ channel: "dev" }), { ip: ip(), now: at(0, 11) });
		// C: today.
		await post(c, { ip: ip(), now: at(0, 10) });
		// Old: 20 days ago (outside 7-day range, inside 30).
		await post(old, { ip: ip(), now: at(-20) });
		return { a, b, c, old };
	}

	it("computes active, new, shares and display aggregates", async () => {
		await seed();
		const d = await getDashboardData(env.DB, 7, NOW);

		expect(d.from).toBe("2026-11-08");
		expect(d.to).toBe("2026-11-14");
		expect(d.activePerDay).toHaveLength(7);
		expect(d.activePerDay.find((x) => x.day === "2026-11-12")?.value).toBe(2);
		expect(d.activePerDay.find((x) => x.day === "2026-11-14")?.value).toBe(2);
		expect(d.activePerDay.find((x) => x.day === "2026-11-13")?.value).toBe(0);
		expect(d.newPerDay.find((x) => x.day === "2026-11-12")?.value).toBe(2);
		expect(d.newPerDay.find((x) => x.day === "2026-11-14")?.value).toBe(1);
		expect(d.active7).toBe(3);
		expect(d.active30).toBe(4);
		expect(d.activeInRange).toBe(3);
		expect(d.latestInstalls).toBe(3);

		// Latest report per install: A is 1.1.2 (not 1.0.0).
		expect(d.appVersion).toEqual([
			{ label: "1.0.0", count: 1 },
			{ label: "1.1.0", count: 1 },
			{ label: "1.1.2", count: 1 },
		]);
		expect(d.channel).toEqual([{ label: "release", count: 3 }]);
		expect(d.os).toEqual([
			{ label: "Windows", count: 2 },
			{ label: "macOS", count: 1 },
		]);
		expect(d.osVersion).toEqual([
			{ label: "Windows 10.0.26200", count: 2 },
			{ label: "macOS 15.1", count: 1 },
		]);
		expect(d.arch).toEqual([
			{ label: "x86_64", count: 2 },
			{ label: "aarch64", count: 1 },
		]);
		expect(d.tmVersion).toEqual([
			{ label: "2026_27.1.3", count: 2 },
			{ label: "Not reported", count: 1 },
		]);
		expect(d.ndiVersion).toEqual([
			{ label: "6.1.1", count: 2 },
			{ label: "6.0.0", count: 1 },
		]);

		// Displays from latest reports: A has audience + field-queue, B has pit, C none.
		expect(d.displays.total).toBe(3);
		expect(d.displays.byType).toEqual([
			{ label: "audience", count: 1 },
			{ label: "field-queue", count: 1 },
			{ label: "pit", count: 1 },
		]);
		expect(d.displays.audienceTotal).toBe(1);
		expect(d.displays.screens).toEqual([
			{ label: "in-match", count: 1 },
			{ label: "intro", count: 1 },
			{ label: "results", count: 1 },
		]);
		expect(d.displays.transparency).toEqual([
			{ label: "flatten", count: 2 },
			{ label: "alpha", count: 1 },
		]);
		expect(d.displays.audio).toEqual([
			{ label: "Off", count: 2 },
			{ label: "On", count: 1 },
		]);
		expect(d.displays.frameRate).toEqual([
			{ label: "30 fps", count: 1 },
			{ label: "59.94 fps", count: 1 },
			{ label: "60 fps", count: 1 },
		]);
		expect(d.displays.resolution.map((r) => r.label).sort()).toEqual([
			"1280x720",
			"1920x1080",
			"3840x2160",
		]);
		expect(d.servers).toEqual({
			localTotal: 2,
			remoteTotal: 2,
			installsWithLocal: 2,
			installsWithRemote: 1,
		});

		// Display hours: day -2 has A (3600 s) + B (1800 s); today A (3600 s).
		expect(d.displayHoursPerDay.find((x) => x.day === "2026-11-12")?.value).toBe(1.5);
		expect(d.displayHoursPerDay.find((x) => x.day === "2026-11-14")?.value).toBe(1);
	});

	it("widens with the range", async () => {
		await seed();
		const d = await getDashboardData(env.DB, 30, NOW);
		expect(d.activePerDay).toHaveLength(30);
		expect(d.activeInRange).toBe(4);
		expect(d.appVersion.find((v) => v.label === "1.1.9")?.count).toBe(1);
	});

	it("renders a self-contained page with no external resources", async () => {
		await seed();
		// Hostile strings in free-text fields must be escaped.
		await post(validReport({ os_version: '"><img src=x onerror=alert(1)>' }), {
			ip: newIp(),
			now: NOW,
		});
		const res = await getDashboard(await signJwt(goodClaims()), accessEnv, "?days=90");
		expect(res.status).toBe(200);
		const html = await res.text();

		expect(html).toContain("Last 90 days");
		expect(html).toMatch(/<a href="\?days=90" aria-current="page">/);
		expect(html).toContain("Active installs per day");
		expect(html).toContain("<svg");
		expect(html).toContain("<table");
		expect(html).toContain("prefers-color-scheme:dark");

		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/<link/i);
		expect(html).not.toMatch(/@import/i);
		expect(html).not.toMatch(/url\(/i);
		expect(html).not.toMatch(/<(img|iframe|video|audio|source|embed|object)\b/i);
		expect(html).not.toMatch(/(?:src|href)=["']?(?:https?:)?\/\//i);
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});

	it("renders an empty database without errors", async () => {
		const html = renderDashboard(await getDashboardData(env.DB, 365, NOW));
		expect(html).toContain("No data in this range.");
	});
});
