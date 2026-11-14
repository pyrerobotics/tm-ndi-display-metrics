import { daysAgo, type Env, limits, utcDay } from "./env";
import { getDailySalt } from "./iphash";

/** Rows deleted per statement, to keep each D1 query small. */
const DELETE_CHUNK = 5000;
/** Upper bound on delete rounds per cron run; the next run continues. */
const MAX_DELETE_ROUNDS = 40;

/**
 * Drop every salt and per-IP counter from before today, then make sure
 * today's salt exists. Once yesterday's salt is gone its hashes cannot be
 * recomputed from an IP.
 */
export async function rotateIpSalt(env: Env, now: Date): Promise<void> {
	const today = utcDay(now);
	await env.DB.batch([
		env.DB.prepare("DELETE FROM ip_salts WHERE day < ?").bind(today),
		env.DB.prepare("DELETE FROM ip_daily WHERE day < ?").bind(today),
	]);
	await getDailySalt(env.DB, today);
}

/**
 * Delete reports (and, by cascade, their displays and screens) received
 * more than RETENTION_DAYS ago, and installs not seen since then.
 * Returns the number of reports deleted.
 */
export async function applyRetention(env: Env, now: Date): Promise<number> {
	const cutoff = daysAgo(now, limits(env).retentionDays);
	const countOld = async () =>
		(await env.DB.prepare("SELECT count(*) AS n FROM reports WHERE received_day < ?")
			.bind(cutoff)
			.first<number>("n")) ?? 0;
	const before = await countOld();
	let remaining = before;
	// meta.changes also counts cascaded display rows, so re-count instead.
	for (let round = 0; round < MAX_DELETE_ROUNDS && remaining > 0; round++) {
		await env.DB.prepare(
			`DELETE FROM reports WHERE id IN
			 (SELECT id FROM reports WHERE received_day < ? LIMIT ${DELETE_CHUNK})`,
		)
			.bind(cutoff)
			.run();
		remaining = await countOld();
	}
	await env.DB.prepare("DELETE FROM installs WHERE last_seen_day < ?").bind(cutoff).run();
	return before - remaining;
}

export async function runScheduled(env: Env, now: Date): Promise<void> {
	await rotateIpSalt(env, now);
	await applyRetention(env, now);
}
