import { type Env, limits, utcDay } from "./env";
import { claimNewInstall, countRequest, getDailySalt, hashIp } from "./iphash";
import { isAcceptedChannel, isAllowedAppVersion, MAX_BODY_BYTES, parseReport } from "./schema";
import { countReportsToday, installExists, storeReport } from "./store";

// Responses never carry a body, so nothing from the request is reflected back.
const empty = (status: number) => new Response(null, { status });

/** Read at most `max` bytes; null if the body is larger. */
async function readBody(request: Request, max: number): Promise<Uint8Array | null> {
	const declared = request.headers.get("content-length");
	if (declared !== null && !(Number(declared) <= max)) return null;
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

/**
 * POST /v1/report.
 * 204 accepted (stored, or silently dropped by a per-install cap),
 * 400 invalid, 429 rate limited.
 */
export async function handleReport(request: Request, env: Env, now: Date): Promise<Response> {
	const lim = limits(env);
	const day = utcDay(now);

	// The client IP is used only to build today's salted hash, then dropped.
	const ipHash = await hashIp(
		await getDailySalt(env.DB, day),
		request.headers.get("cf-connecting-ip") ?? "unknown",
	);

	if (env.RATE_LIMITER) {
		const { success } = await env.RATE_LIMITER.limit({ key: ipHash });
		if (!success) return empty(429);
	}
	if ((await countRequest(env.DB, day, ipHash)) > lim.requestsPerIpPerDay) return empty(429);

	const type = request.headers.get("content-type") ?? "";
	if (!/^application\/json\s*(;|$)/i.test(type)) return empty(400);

	const body = await readBody(request, MAX_BODY_BYTES);
	if (body === null) return empty(400);
	let json: unknown;
	try {
		json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
	} catch {
		return empty(400);
	}
	const report = parseReport(json);
	if (!report || !isAllowedAppVersion(report.app_version, env.ALLOWED_APP_VERSIONS)) {
		return empty(400);
	}

	// Valid reports from channels we don't keep (e.g. dev, e2e) are dropped quietly.
	if (!isAcceptedChannel(report.channel, env.ACCEPTED_CHANNELS)) return empty(204);

	// Per-install daily caps: extra reports are accepted but not stored, so a
	// misbehaving client gets no signal to retry.
	const cap = report.reason === "launch" ? lim.launchPerInstallPerDay : lim.changePerInstallPerDay;
	if ((await countReportsToday(env.DB, report.install_id, day, report.reason)) >= cap) {
		return empty(204);
	}

	// Cap on new install IDs first seen from one client per day.
	if (!(await installExists(env.DB, report.install_id))) {
		if (!(await claimNewInstall(env.DB, day, ipHash, lim.newInstallsPerIpPerDay))) {
			return empty(429);
		}
	}

	await storeReport(env.DB, report, now);
	return empty(204);
}
