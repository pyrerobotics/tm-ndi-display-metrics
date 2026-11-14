import { createScheduledController, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { getDailySalt } from "../src/iphash";
import { applyRetention, rotateIpSalt } from "../src/scheduled";
import { count, DAY, NOW, newIp, post, resetDb, validReport } from "./helpers";

beforeEach(resetDb);

const at = (days: number) => new Date(NOW.getTime() + days * DAY);

describe("salt rotation", () => {
	it("deletes old salts and per-IP counters and makes a fresh salt", async () => {
		const ip = newIp();
		await post(validReport(), { ip, now: NOW });
		const oldSalt = await getDailySalt(env.DB, "2026-11-14");
		const oldHash = await env.DB.prepare("SELECT ip_hash FROM ip_daily").first<string>("ip_hash");
		expect(await count("ip_daily")).toBe(1);

		// Cron just after midnight UTC on the next day.
		const tomorrow = new Date("2026-11-15T00:05:00Z");
		await rotateIpSalt(env, tomorrow);

		const salts = await env.DB.prepare("SELECT day, salt FROM ip_salts").all<{
			day: string;
			salt: string;
		}>();
		expect(salts.results).toHaveLength(1);
		expect(salts.results[0]?.day).toBe("2026-11-15");
		expect(salts.results[0]?.salt).not.toBe(oldSalt);
		expect(salts.results[0]?.salt).toMatch(/^[0-9a-f]{64}$/);
		expect(await count("ip_daily")).toBe(0);

		// The same IP now hashes to something unrelated to yesterday's hash.
		await post(validReport(), { ip, now: tomorrow });
		const newHash = await env.DB.prepare("SELECT ip_hash FROM ip_daily").first<string>("ip_hash");
		expect(newHash).toMatch(/^[0-9a-f]{64}$/);
		expect(newHash).not.toBe(oldHash);
	});

	it("keeps today's counters when run twice on the same day", async () => {
		await post(validReport(), { now: NOW });
		await rotateIpSalt(env, NOW);
		expect(await count("ip_daily")).toBe(1);
		expect(await count("ip_salts")).toBe(1);
	});
});

describe("retention", () => {
	it("deletes reports older than RETENTION_DAYS with their displays and screens", async () => {
		const old = validReport();
		const recent = validReport();
		await post(old, { now: at(-401) });
		await post(recent, { now: at(-399) });
		await post({ ...recent, reason: "change" }, { now: NOW });
		expect(await count("reports")).toBe(3);
		expect(await count("displays")).toBe(6);

		const deleted = await applyRetention(env, NOW);
		expect(deleted).toBe(1);
		expect(await count("reports")).toBe(2);
		expect(await count("displays")).toBe(4);
		expect(await count("display_screens")).toBe(6);
		const installs = await env.DB.prepare("SELECT install_id FROM installs").all();
		expect(installs.results).toEqual([{ install_id: recent.install_id }]);
	});

	it("honours a configured retention period", async () => {
		await post(validReport(), { now: at(-31) });
		await post(validReport(), { now: at(-29) });
		await applyRetention({ ...env, RETENTION_DAYS: "30" }, NOW);
		expect(await count("reports")).toBe(1);
	});

	it("runs from the Worker's scheduled handler", async () => {
		await post(validReport(), { now: new Date(Date.now() - 500 * DAY) });
		await env.DB.prepare(
			"INSERT INTO ip_daily (day, ip_hash, requests) VALUES ('2000-01-01', 'x', 1)",
		).run();
		await worker.scheduled(
			createScheduledController({ cron: "5 0 * * *", scheduledTime: Date.now() }),
			env,
		);
		expect(await count("reports")).toBe(0);
		expect(await count("ip_daily")).toBe(0);
		expect(await count("ip_salts")).toBe(1);
	});
});
