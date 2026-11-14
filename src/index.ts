import { accessConfig, verifyAccessJwt } from "./access";
import { getDashboardData, parseRange } from "./dashboard/data";
import { renderDashboard } from "./dashboard/render";
import type { Env } from "./env";
import { handleReport } from "./report";
import { runScheduled } from "./scheduled";

const DASHBOARD_HEADERS = {
	"content-type": "text/html; charset=utf-8",
	"cache-control": "no-store",
	"x-robots-tag": "noindex, nofollow",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"content-security-policy":
		"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

const empty = (status: number, headers?: HeadersInit) => new Response(null, { status, headers });

export async function handleDashboard(request: Request, env: Env, now: Date): Promise<Response> {
	const config = accessConfig(env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
	// Without Access configured the dashboard does not exist.
	if (!config) return empty(404);
	const result = await verifyAccessJwt(request.headers.get("cf-access-jwt-assertion"), config);
	if (result === "missing") return empty(401);
	if (result !== "ok") return empty(403);

	const days = parseRange(new URL(request.url).searchParams.get("days"));
	const data = await getDashboardData(env.DB, days, now);
	return new Response(renderDashboard(data), { headers: DASHBOARD_HEADERS });
}

export async function route(request: Request, env: Env, now: Date): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === "/v1/report") {
		if (request.method !== "POST") return empty(405, { allow: "POST" });
		return handleReport(request, env, now);
	}
	if (pathname === "/dashboard" || pathname === "/dashboard/") {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return empty(405, { allow: "GET, HEAD" });
		}
		return handleDashboard(request, env, now);
	}
	return empty(404);
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await route(request, env, new Date());
		} catch {
			// Deliberately no details: errors could contain request data.
			console.error("request failed");
			return empty(500);
		}
	},
	async scheduled(_controller, env): Promise<void> {
		await runScheduled(env, new Date());
	},
} satisfies ExportedHandler<Env>;
