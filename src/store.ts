import type { Report } from "./schema";

/** How many reports with this reason are already stored for the install today. */
export async function countReportsToday(
	db: D1Database,
	installId: string,
	day: string,
	reason: Report["reason"],
): Promise<number> {
	const n = await db
		.prepare(
			"SELECT count(*) AS n FROM reports WHERE install_id = ? AND received_day = ? AND reason = ?",
		)
		.bind(installId, day, reason)
		.first<number>("n");
	return n ?? 0;
}

export async function installExists(db: D1Database, installId: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT 1 AS x FROM installs WHERE install_id = ?")
		.bind(installId)
		.first();
	return row !== null;
}

/**
 * Store one validated report and its displays atomically (D1 runs a batch
 * as a single transaction) using at most four statements. Only fields from
 * the report itself plus the receive time are written; no request metadata.
 */
export async function storeReport(db: D1Database, report: Report, now: Date): Promise<void> {
	const id = crypto.randomUUID();
	const receivedAt = now.toISOString();
	const day = receivedAt.slice(0, 10);

	const stmts: D1PreparedStatement[] = [
		db
			.prepare(
				`INSERT INTO installs (install_id, first_seen_day, last_seen_day) VALUES (?1, ?2, ?2)
				 ON CONFLICT (install_id) DO UPDATE SET last_seen_day = max(last_seen_day, excluded.last_seen_day)`,
			)
			.bind(report.install_id, day),
		db
			.prepare(
				`INSERT INTO reports (id, received_at, received_day, schema_version, install_id, reason,
					app_version, channel, os, os_version, arch, tm_version, ndi_version,
					servers_local, servers_remote)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				receivedAt,
				day,
				report.schema,
				report.install_id,
				report.reason,
				report.app_version,
				report.channel,
				report.os,
				report.os_version,
				report.arch,
				report.tm_version,
				report.ndi_version,
				report.servers_local,
				report.servers_remote,
			),
	];

	if (report.displays.length > 0) {
		// Insert all displays and screens with two statements (via json_each) so
		// a report costs a fixed number of D1 queries, however many displays it has.
		const displaysJson = JSON.stringify(
			report.displays.map((d) => ({
				type: d.type,
				transparency: d.transparency,
				audio: d.audio ? 1 : 0,
				resolution: d.resolution,
				frame_rate: Number(d.frame_rate),
				running: d.running ? 1 : 0,
				run_seconds: d.run_seconds,
				screens: d.screens,
			})),
		);
		stmts.push(
			db
				.prepare(
					`INSERT INTO displays (report_id, position, type, transparency, audio, resolution,
						frame_rate, running, run_seconds)
					 SELECT ?1, d.key, d.value ->> 'type', d.value ->> 'transparency', d.value ->> 'audio',
						d.value ->> 'resolution', d.value ->> 'frame_rate', d.value ->> 'running',
						d.value ->> 'run_seconds'
					 FROM json_each(?2) AS d`,
				)
				.bind(id, displaysJson),
			db
				.prepare(
					`INSERT INTO display_screens (report_id, position, screen)
					 SELECT ?1, d.key, s.value
					 FROM json_each(?2) AS d, json_each(d.value, '$.screens') AS s`,
				)
				.bind(id, displaysJson),
		);
	}

	await db.batch(stmts);
}
