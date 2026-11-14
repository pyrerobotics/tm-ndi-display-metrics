/** Bindings and vars. All vars are strings; see `limits()` for parsing. */
export interface Env {
	DB: D1Database;
	/** Optional Workers Rate Limiting binding (short-burst per-client limit). */
	RATE_LIMITER?: RateLimit;
	ALLOWED_APP_VERSIONS?: string;
	/** Comma-separated channels to store; others get 204 and are dropped. Default "release". */
	ACCEPTED_CHANNELS?: string;
	MAX_LAUNCH_PER_INSTALL_PER_DAY?: string;
	MAX_CHANGE_PER_INSTALL_PER_DAY?: string;
	MAX_NEW_INSTALLS_PER_IP_PER_DAY?: string;
	MAX_REQUESTS_PER_IP_PER_DAY?: string;
	RETENTION_DAYS?: string;
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
}

export interface Limits {
	launchPerInstallPerDay: number;
	changePerInstallPerDay: number;
	newInstallsPerIpPerDay: number;
	requestsPerIpPerDay: number;
	retentionDays: number;
}

/** Defaults used when a var is missing or not a whole number >= 0. */
export const DEFAULT_LIMITS: Limits = {
	launchPerInstallPerDay: 1,
	changePerInstallPerDay: 50,
	newInstallsPerIpPerDay: 20,
	requestsPerIpPerDay: 500,
	retentionDays: 400,
};

function num(v: string | undefined, fallback: number): number {
	if (v === undefined || v.trim() === "") return fallback;
	const n = Number(v);
	return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function limits(env: Env): Limits {
	return {
		launchPerInstallPerDay: num(
			env.MAX_LAUNCH_PER_INSTALL_PER_DAY,
			DEFAULT_LIMITS.launchPerInstallPerDay,
		),
		changePerInstallPerDay: num(
			env.MAX_CHANGE_PER_INSTALL_PER_DAY,
			DEFAULT_LIMITS.changePerInstallPerDay,
		),
		newInstallsPerIpPerDay: num(
			env.MAX_NEW_INSTALLS_PER_IP_PER_DAY,
			DEFAULT_LIMITS.newInstallsPerIpPerDay,
		),
		requestsPerIpPerDay: num(env.MAX_REQUESTS_PER_IP_PER_DAY, DEFAULT_LIMITS.requestsPerIpPerDay),
		retentionDays: Math.max(1, num(env.RETENTION_DAYS, DEFAULT_LIMITS.retentionDays)),
	};
}

/** UTC day 'YYYY-MM-DD' for a date. */
export function utcDay(d: Date): string {
	return d.toISOString().slice(0, 10);
}

/** UTC day `n` days before `d`. */
export function daysAgo(d: Date, n: number): string {
	return utcDay(new Date(d.getTime() - n * 86_400_000));
}
