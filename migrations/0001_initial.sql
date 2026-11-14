-- Initial schema for the TM NDI Display Manager metrics relay.
-- No table holds an IP address, user agent, country or any request header.
-- All dates are UTC. Days are 'YYYY-MM-DD'; timestamps are ISO 8601 with 'Z'.

-- One row per stored report.
CREATE TABLE reports (
	id TEXT PRIMARY KEY,               -- random UUID made by the relay
	received_at TEXT NOT NULL,         -- when the relay stored it
	received_day TEXT NOT NULL,        -- UTC day of received_at
	schema_version INTEGER NOT NULL,
	install_id TEXT NOT NULL,          -- random UUID v4 made by the app
	reason TEXT NOT NULL,              -- 'launch' | 'change'
	app_version TEXT NOT NULL,
	channel TEXT,
	os TEXT NOT NULL,
	os_version TEXT NOT NULL,
	arch TEXT NOT NULL,
	tm_version TEXT,
	ndi_version TEXT,
	servers_local INTEGER NOT NULL,
	servers_remote INTEGER NOT NULL
);

-- Daily series and range filters.
CREATE INDEX reports_day_install ON reports (received_day, install_id);
-- Per-install daily caps and "latest report per install".
CREATE INDEX reports_install_day_reason ON reports (install_id, received_day, reason);
CREATE INDEX reports_install_received ON reports (install_id, received_at);

-- One row per display per report.
CREATE TABLE displays (
	report_id TEXT NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
	position INTEGER NOT NULL,         -- index in the report's displays array
	type TEXT NOT NULL,                -- 'audience' | 'field-queue' | 'pit'
	transparency TEXT NOT NULL,        -- 'alpha' | 'flatten'
	audio INTEGER NOT NULL,            -- 0 | 1
	resolution TEXT NOT NULL,          -- e.g. '1920x1080'
	frame_rate REAL NOT NULL,
	running INTEGER NOT NULL,          -- 0 | 1
	run_seconds INTEGER NOT NULL,
	PRIMARY KEY (report_id, position)
) WITHOUT ROWID;

CREATE INDEX displays_type ON displays (type);

-- Screens shown by an audience display, one row per screen.
CREATE TABLE display_screens (
	report_id TEXT NOT NULL,
	position INTEGER NOT NULL,
	screen TEXT NOT NULL,
	PRIMARY KEY (report_id, position, screen),
	FOREIGN KEY (report_id, position) REFERENCES displays (report_id, position) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX display_screens_screen ON display_screens (screen);

-- First and last day each install was seen. Used for "new installs" and the
-- new-installs-per-IP cap. Removed by retention with its reports.
CREATE TABLE installs (
	install_id TEXT PRIMARY KEY,
	first_seen_day TEXT NOT NULL,
	last_seen_day TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX installs_first_seen ON installs (first_seen_day);
CREATE INDEX installs_last_seen ON installs (last_seen_day);

-- Random salt for hashing client IPs. Only the current UTC day's salt is kept;
-- the daily cron deletes older ones, so old hashes cannot be recomputed.
CREATE TABLE ip_salts (
	day TEXT PRIMARY KEY,
	salt TEXT NOT NULL
) WITHOUT ROWID;

-- Per-client counters for the current day, keyed by HMAC-SHA-256(salt, IP).
-- The raw IP is never written. The daily cron deletes previous days' rows.
CREATE TABLE ip_daily (
	day TEXT NOT NULL,
	ip_hash TEXT NOT NULL,
	requests INTEGER NOT NULL DEFAULT 0,
	new_installs INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (day, ip_hash)
) WITHOUT ROWID;
