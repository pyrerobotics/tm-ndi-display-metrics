import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../src/schema";
import { count, DAY, NOW, newIp, post, resetDb, TABLES, validReport } from "./helpers";

beforeEach(resetDb);

async function expectEmpty(res: Response, status: number) {
	expect(res.status).toBe(status);
	expect(await res.text()).toBe("");
}

describe("POST /v1/report", () => {
	it("stores a valid report with its displays and screens", async () => {
		const r = validReport();
		await expectEmpty(await post(r), 204);

		const row = await env.DB.prepare("SELECT * FROM reports").first<Record<string, unknown>>();
		expect(row).toMatchObject({
			install_id: r.install_id,
			reason: "launch",
			app_version: "1.0.0",
			channel: "release",
			os: "windows",
			os_version: "10.0.26200",
			arch: "x86_64",
			tm_version: "4.3.1",
			ndi_version: "6.1.1",
			servers_local: 1,
			servers_remote: 0,
			received_day: "2026-11-14",
			received_at: NOW.toISOString(),
			schema_version: 1,
		});
		const displays = await env.DB.prepare(
			"SELECT position, type, transparency, audio, resolution, frame_rate, running, run_seconds FROM displays ORDER BY position",
		).all();
		expect(displays.results).toEqual([
			{
				position: 0,
				type: "audience",
				transparency: "flatten",
				audio: 1,
				resolution: "1920x1080",
				frame_rate: 59.94,
				running: 1,
				run_seconds: 3600,
			},
			{
				position: 1,
				type: "field-queue",
				transparency: "alpha",
				audio: 0,
				resolution: "1280x720",
				frame_rate: 30,
				running: 0,
				run_seconds: 0,
			},
		]);
		const screens = await env.DB.prepare(
			"SELECT position, screen FROM display_screens ORDER BY screen",
		).all();
		expect(screens.results).toEqual([
			{ position: 0, screen: "in-match" },
			{ position: 0, screen: "intro" },
			{ position: 0, screen: "results" },
		]);
		expect(await count("installs")).toBe(1);
	});

	it("stores a report with the maximum number of displays", async () => {
		const audience = (validReport().displays as unknown[])[0];
		const r = validReport({
			displays: Array.from({ length: 64 }, () => audience),
		});
		await expectEmpty(await post(r), 204);
		expect(await count("displays")).toBe(64);
		expect(await count("display_screens")).toBe(64 * 3);
	});

	it("works through the Worker's default export", async () => {
		const res = await exports.default.fetch("https://relay.example/v1/report", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-connecting-ip": newIp(),
			},
			body: JSON.stringify(validReport()),
		});
		await expectEmpty(res, 204);
		expect(await count("reports")).toBe(1);
	});

	it("rejects invalid reports with an empty 400 and stores nothing", async () => {
		await expectEmpty(await post(validReport({ extra: "x" })), 400);
		await expectEmpty(await post(validReport({ os: "<script>" })), 400);
		await expectEmpty(await post(validReport({ schema: 2 })), 400);
		expect(await count("reports")).toBe(0);
	});

	it("rejects app versions outside the allowlist", async () => {
		await expectEmpty(await post(validReport({ app_version: "1.2.0" })), 400);
		await expectEmpty(await post(validReport({ app_version: "1.1.3" })), 204);
		await expectEmpty(
			await post(validReport({ app_version: "1.0.0" }), {
				envOverride: { ALLOWED_APP_VERSIONS: "" },
			}),
			400,
		);
		await expectEmpty(
			await post(validReport({ app_version: "7.7.7" }), {
				envOverride: { ALLOWED_APP_VERSIONS: "*" },
			}),
			204,
		);
		expect(await count("reports")).toBe(2);
	});

	it("rejects malformed JSON, wrong content type and bad UTF-8", async () => {
		await expectEmpty(await post(null, { rawBody: "{not json" }), 400);
		await expectEmpty(await post(null, { rawBody: "" }), 400);
		await expectEmpty(
			await post(validReport(), { headers: { "content-type": "text/plain" } }),
			400,
		);
		await expectEmpty(await post(null, { rawBody: new Uint8Array([0x7b, 0xff, 0x7d]) }), 400);
		expect(await count("reports")).toBe(0);
	});

	it("rejects oversize bodies", async () => {
		const big = JSON.stringify({
			...validReport(),
			pad: "x".repeat(MAX_BODY_BYTES),
		});
		await expectEmpty(await post(null, { rawBody: big }), 400);
		// Same, but streamed without a content-length header.
		const stream = new Blob([big]).stream();
		await expectEmpty(await post(null, { rawBody: stream }), 400);
		expect(await count("reports")).toBe(0);
	});

	it("only allows POST", async () => {
		const res = await exports.default.fetch("https://relay.example/v1/report");
		await expectEmpty(res, 405);
	});

	it("returns 404 for unknown paths", async () => {
		await expectEmpty(await exports.default.fetch("https://relay.example/"), 404);
	});
});

describe("per-install daily caps", () => {
	it("stores at most one launch per install per UTC day", async () => {
		const r = validReport();
		const ip = newIp();
		await expectEmpty(await post(r, { ip }), 204);
		await expectEmpty(await post(r, { ip }), 204);
		await expectEmpty(await post(r, { ip, now: new Date(NOW.getTime() + 3 * 3600_000) }), 204);
		expect(await count("reports")).toBe(1);

		// Next UTC day: stored again.
		await expectEmpty(await post(r, { ip, now: new Date(NOW.getTime() + DAY) }), 204);
		expect(await count("reports")).toBe(2);
	});

	it("caps change reports per install per day (cap 3 in tests)", async () => {
		const r = validReport({ reason: "change" });
		const ip = newIp();
		for (let i = 0; i < 5; i++) await expectEmpty(await post(r, { ip }), 204);
		expect(await count("reports")).toBe(3);
		// A launch is counted separately.
		await expectEmpty(await post({ ...r, reason: "launch" }, { ip }), 204);
		expect(await count("reports")).toBe(4);
	});
});

describe("per-IP limits", () => {
	it("caps new install IDs first seen from one IP per day (cap 2 in tests)", async () => {
		const ip = newIp();
		const a = validReport();
		const b = validReport();
		await expectEmpty(await post(a, { ip }), 204);
		await expectEmpty(await post(b, { ip }), 204);
		await expectEmpty(await post(validReport(), { ip }), 429);
		expect(await count("installs")).toBe(2);

		// Known installs from the same IP are still accepted.
		await expectEmpty(await post({ ...a, reason: "change" }, { ip }), 204);
		expect(await count("reports")).toBe(3);

		// A different IP may add new installs.
		await expectEmpty(await post(validReport(), { ip: newIp() }), 204);

		// A new UTC day resets the cap.
		await expectEmpty(await post(validReport(), { ip, now: new Date(NOW.getTime() + DAY) }), 204);
	});

	it("caps total requests per IP per day", async () => {
		const ip = newIp();
		const envOverride = { MAX_REQUESTS_PER_IP_PER_DAY: "3" };
		for (let i = 0; i < 3; i++) {
			await expectEmpty(await post(validReport({ extra: 1 }), { ip, envOverride }), 400);
		}
		await expectEmpty(await post(validReport(), { ip, envOverride }), 429);
		expect(await count("reports")).toBe(0);
	});

	it("applies the Workers Rate Limiting binding per client", async () => {
		expect(env.RATE_LIMITER).toBeDefined();
		const ip = newIp();
		const statuses: number[] = [];
		// The binding allows 30 requests per 60 s in wrangler.jsonc.
		for (let i = 0; i < 40; i++) {
			statuses.push((await post(validReport({ reason: "change" }), { ip })).status);
		}
		expect(statuses.slice(0, 30).every((s) => s === 204 || s === 429)).toBe(true);
		expect(statuses).toContain(429);
		expect(statuses.filter((s) => s === 204).length).toBeLessThanOrEqual(30);
		// A different client is unaffected.
		expect((await post(validReport(), { ip: newIp() })).status).toBe(204);
	});
});

describe("privacy", () => {
	it("never stores the client IP or other request metadata in any table", async () => {
		const ips = ["203.0.113.77", "2001:db8::abcd:1234"];
		const userAgent = "UA-SENTINEL-9f2c";
		for (const ip of ips) {
			const headers = {
				"user-agent": userAgent,
				"cf-ipcountry": "XQ",
				referer: "https://ref.example/x",
			};
			const known = validReport();
			await post(known, { ip, headers });
			await post({ ...known, reason: "change" }, { ip, headers });
			await post(validReport({ extra: 1 }), { ip, headers });
		}
		expect(await count("reports")).toBe(4);
		expect(await count("ip_daily")).toBe(2);

		const tables = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
		).all<{ name: string }>();
		const names = tables.results.map((t) => t.name);
		for (const t of TABLES) expect(names).toContain(t);

		let dump = "";
		for (const name of names) {
			const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
			dump += JSON.stringify(rows.results);
		}
		for (const ip of ips) expect(dump).not.toContain(ip);
		expect(dump).not.toContain("abcd:1234");
		expect(dump).not.toContain(userAgent);
		expect(dump).not.toContain("ref.example");
		expect(dump).not.toContain('"XQ"');
	});
});
