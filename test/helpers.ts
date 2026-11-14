import { env } from "cloudflare:test";
import { route } from "../src/index";

export const DAY = 86_400_000;
export const NOW = new Date("2026-11-14T12:00:00Z");

let seq = 0;
/** A fresh random-looking UUID v4 (deterministic per test run is not needed). */
export function newInstallId(): string {
	return crypto.randomUUID();
}

/** A unique documentation-range IP per call, so tests don't share counters. */
export function newIp(): string {
	seq++;
	return `198.51.${Math.floor(seq / 250) % 250}.${(seq % 250) + 1}`;
}

export function validReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: 1,
		install_id: newInstallId(),
		reason: "launch",
		app_version: "1.0.0",
		channel: "release",
		os: "windows",
		os_version: "10.0.26200",
		arch: "x86_64",
		tm_version: "4.3.1",
		ndi_version: "6.1.1",
		servers: { local: 1, remote: 0 },
		displays: [
			{
				type: "audience",
				screens: ["in-match", "intro", "results"],
				transparency: "flatten",
				audio: true,
				resolution: "1920x1080",
				frame_rate: 59.94,
				running: true,
				run_seconds: 3600,
			},
			{
				type: "field-queue",
				transparency: "alpha",
				audio: false,
				resolution: "1280x720",
				frame_rate: 30,
				running: false,
				run_seconds: 0,
			},
		],
		...overrides,
	};
}

export interface PostOptions {
	ip?: string;
	now?: Date;
	headers?: Record<string, string>;
	rawBody?: BodyInit;
	envOverride?: Partial<Cloudflare.Env>;
}

export async function post(body: unknown, opts: PostOptions = {}): Promise<Response> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"cf-connecting-ip": opts.ip ?? newIp(),
		...opts.headers,
	};
	const request = new Request("https://relay.example/v1/report", {
		method: "POST",
		headers,
		body: opts.rawBody ?? JSON.stringify(body),
	});
	return route(request, { ...env, ...opts.envOverride }, opts.now ?? NOW);
}

export const TABLES = [
	"display_screens",
	"displays",
	"reports",
	"installs",
	"ip_daily",
	"ip_salts",
] as const;

export async function resetDb(): Promise<void> {
	await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

export async function count(table: (typeof TABLES)[number]): Promise<number> {
	return (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n")) ?? 0;
}
