/**
 * Client-IP handling. The raw IP only ever exists in memory for the length of
 * one request. What is stored is HMAC-SHA-256(daily salt, IP). The salt is
 * random, kept in D1 for the current UTC day only, and deleted by the daily
 * cron together with the previous day's counters, after which old hashes
 * cannot be linked back to an IP.
 */

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSalt(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return toHex(bytes.buffer);
}

/** Get today's salt, creating it if this is the first request of the day. */
export async function getDailySalt(db: D1Database, day: string): Promise<string> {
	const existing = await db
		.prepare("SELECT salt FROM ip_salts WHERE day = ?")
		.bind(day)
		.first<string>("salt");
	if (existing) return existing;
	// INSERT OR IGNORE then re-read, so concurrent first requests agree on one salt.
	await db
		.prepare("INSERT OR IGNORE INTO ip_salts (day, salt) VALUES (?, ?)")
		.bind(day, randomSalt())
		.run();
	const salt = await db
		.prepare("SELECT salt FROM ip_salts WHERE day = ?")
		.bind(day)
		.first<string>("salt");
	if (!salt) throw new Error("salt unavailable");
	return salt;
}

export async function hashIp(salt: string, ip: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(salt),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(ip)));
}

/** Count one request from this client today; returns the new total. */
export async function countRequest(db: D1Database, day: string, ipHash: string): Promise<number> {
	const n = await db
		.prepare(
			`INSERT INTO ip_daily (day, ip_hash, requests) VALUES (?, ?, 1)
			 ON CONFLICT (day, ip_hash) DO UPDATE SET requests = requests + 1
			 RETURNING requests`,
		)
		.bind(day, ipHash)
		.first<number>("requests");
	return n ?? 0;
}

/**
 * Claim one "new install" slot for this client today. Returns false (and
 * changes nothing) if the client already reached `cap`.
 */
export async function claimNewInstall(
	db: D1Database,
	day: string,
	ipHash: string,
	cap: number,
): Promise<boolean> {
	const row = await db
		.prepare(
			`UPDATE ip_daily SET new_installs = new_installs + 1
			 WHERE day = ? AND ip_hash = ? AND new_installs < ?
			 RETURNING new_installs`,
		)
		.bind(day, ipHash, cap)
		.first();
	return row !== null;
}
