import { daysAgo, utcDay } from "../env";

export const RANGES = [7, 30, 90, 365] as const;
export type RangeDays = (typeof RANGES)[number];

export interface Count {
	label: string;
	count: number;
}

export interface DayValue {
	day: string;
	value: number;
}

export interface DashboardData {
	days: RangeDays;
	from: string;
	to: string;
	/** Distinct installs reporting each day. */
	activePerDay: DayValue[];
	/** Installs first seen each day. */
	newPerDay: DayValue[];
	/** Sum of run_seconds per day, in hours. */
	displayHoursPerDay: DayValue[];
	active7: number;
	active30: number;
	activeInRange: number;
	/** Installs counted in the "latest report" breakdowns (same as activeInRange). */
	latestInstalls: number;
	appVersion: Count[];
	os: Count[];
	osVersion: Count[];
	arch: Count[];
	channel: Count[];
	tmVersion: Count[];
	ndiVersion: Count[];
	displays: {
		total: number;
		byType: Count[];
		screens: Count[];
		/** Audience displays, the denominator for `screens`. */
		audienceTotal: number;
		transparency: Count[];
		audio: Count[];
		resolution: Count[];
		frameRate: Count[];
	};
	servers: {
		localTotal: number;
		remoteTotal: number;
		installsWithLocal: number;
		installsWithRemote: number;
	};
}

/** Latest report per install among reports received on/after ?1. */
const LATEST = `WITH latest AS (
	SELECT * FROM (
		SELECT r.*, ROW_NUMBER() OVER (
			PARTITION BY r.install_id ORDER BY r.received_at DESC, r.id DESC
		) AS rn
		FROM reports r WHERE r.received_day >= ?1
	) WHERE rn = 1
)`;

const OS_NAMES: Record<string, string> = {
	windows: "Windows",
	macos: "macOS",
	linux: "Linux",
};
const NONE = "Not reported";

function share(expr: string): string {
	return `${LATEST} SELECT ${expr} AS label, count(*) AS count FROM latest
		GROUP BY 1 ORDER BY count DESC, label`;
}

function displayShare(expr: string): string {
	return `${LATEST} SELECT ${expr} AS label, count(*) AS count
		FROM latest l JOIN displays d ON d.report_id = l.id
		GROUP BY 1 ORDER BY count DESC, label`;
}

export function parseRange(v: string | null): RangeDays {
	const n = Number(v);
	return (RANGES as readonly number[]).includes(n) ? (n as RangeDays) : 30;
}

function fillDays(from: string, to: string, rows: { day: string; value: number }[]): DayValue[] {
	const map = new Map(rows.map((r) => [r.day, r.value]));
	const out: DayValue[] = [];
	for (let t = Date.parse(`${from}T00:00:00Z`); ; t += 86_400_000) {
		const day = utcDay(new Date(t));
		out.push({ day, value: map.get(day) ?? 0 });
		if (day >= to) break;
	}
	return out;
}

export async function getDashboardData(
	db: D1Database,
	days: RangeDays,
	now: Date,
): Promise<DashboardData> {
	const to = utcDay(now);
	const from = daysAgo(now, days - 1);
	const from7 = daysAgo(now, 6);
	const from30 = daysAgo(now, 29);

	const q = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args);
	const results = await db.batch([
		/* 0 */ q(
			`SELECT received_day AS day, count(DISTINCT install_id) AS value FROM reports
			 WHERE received_day >= ?1 GROUP BY received_day`,
			from,
		),
		/* 1 */ q(
			`SELECT first_seen_day AS day, count(*) AS value FROM installs
			 WHERE first_seen_day >= ?1 GROUP BY first_seen_day`,
			from,
		),
		/* 2 */ q(
			`SELECT r.received_day AS day, sum(d.run_seconds) / 3600.0 AS value
			 FROM reports r JOIN displays d ON d.report_id = r.id
			 WHERE r.received_day >= ?1 GROUP BY r.received_day`,
			from,
		),
		/* 3 */ q(
			`SELECT
				count(DISTINCT CASE WHEN received_day >= ?1 THEN install_id END) AS a7,
				count(DISTINCT CASE WHEN received_day >= ?2 THEN install_id END) AS a30,
				count(DISTINCT CASE WHEN received_day >= ?3 THEN install_id END) AS ar
			 FROM reports WHERE received_day >= min(?1, ?2, ?3)`,
			from7,
			from30,
			from,
		),
		/* 4 */ q(share("app_version"), from),
		/* 5 */ q(share("os"), from),
		/* 6 */ q(share("os || ' ' || os_version"), from),
		/* 7 */ q(share("arch"), from),
		/* 8 */ q(share("channel"), from),
		/* 9 */ q(share("tm_version"), from),
		/* 10 */ q(share("ndi_version"), from),
		/* 11 */ q(displayShare("d.type"), from),
		/* 12 */ q(
			`${LATEST} SELECT s.screen AS label, count(*) AS count
			 FROM latest l JOIN display_screens s ON s.report_id = l.id
			 GROUP BY 1 ORDER BY count DESC, label`,
			from,
		),
		/* 13 */ q(displayShare("d.transparency"), from),
		/* 14 */ q(displayShare("CASE WHEN d.audio THEN 'On' ELSE 'Off' END"), from),
		/* 15 */ q(displayShare("d.resolution"), from),
		/* 16 */ q(displayShare("d.frame_rate"), from),
		/* 17 */ q(
			`${LATEST} SELECT
				coalesce(sum(servers_local), 0) AS local_total,
				coalesce(sum(servers_remote), 0) AS remote_total,
				count(CASE WHEN servers_local > 0 THEN 1 END) AS with_local,
				count(CASE WHEN servers_remote > 0 THEN 1 END) AS with_remote,
				count(*) AS installs
			 FROM latest`,
			from,
		),
	]);

	const rows = <T>(i: number) => (results[i]?.results ?? []) as T[];
	const counts = (i: number, fmt: (label: string) => string = (l) => l): Count[] =>
		rows<{ label: string | number | null; count: number }>(i).map((r) => ({
			label: r.label === null ? NONE : fmt(String(r.label)),
			count: r.count,
		}));

	const totals = rows<{ a7: number; a30: number; ar: number }>(3)[0];
	const srv = rows<{
		local_total: number;
		remote_total: number;
		with_local: number;
		with_remote: number;
		installs: number;
	}>(17)[0];

	const byType = counts(11);
	const osName = (l: string) => {
		const [os = "", ...rest] = l.split(" ");
		return [OS_NAMES[os] ?? os, ...rest].join(" ");
	};

	return {
		days,
		from,
		to,
		activePerDay: fillDays(from, to, rows(0)),
		newPerDay: fillDays(from, to, rows(1)),
		displayHoursPerDay: fillDays(from, to, rows(2)),
		active7: totals?.a7 ?? 0,
		active30: totals?.a30 ?? 0,
		activeInRange: totals?.ar ?? 0,
		latestInstalls: srv?.installs ?? 0,
		appVersion: counts(4),
		os: counts(5, osName),
		osVersion: counts(6, osName),
		arch: counts(7),
		channel: counts(8),
		tmVersion: counts(9),
		ndiVersion: counts(10),
		displays: {
			total: byType.reduce((n, c) => n + c.count, 0),
			byType,
			screens: counts(12),
			audienceTotal: byType.find((c) => c.label === "audience")?.count ?? 0,
			transparency: counts(13),
			audio: counts(14),
			resolution: counts(15),
			frameRate: counts(16, (l) => `${Number(l)} fps`),
		},
		servers: {
			localTotal: srv?.local_total ?? 0,
			remoteTotal: srv?.remote_total ?? 0,
			installsWithLocal: srv?.with_local ?? 0,
			installsWithRemote: srv?.with_remote ?? 0,
		},
	};
}
