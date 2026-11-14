/**
 * Everything the relay knows about the report format lives in this file.
 *
 * The app sends one JSON object per report to POST /v1/report. To change the
 * format, edit the constants and `parseReport` below, then update the
 * migration/storage code in `store.ts` if a stored column changes.
 *
 * Validation is strict on purpose: unknown fields, wrong types, values outside
 * the lists and over-long strings are all rejected.
 */

/** The only report schema version this relay accepts. */
export const SCHEMA_VERSION = 1;

/** Largest accepted request body, in bytes. */
export const MAX_BODY_BYTES = 16 * 1024;

/** Most displays one report may list. */
export const MAX_DISPLAYS = 64;

/** Most servers (local or remote) one report may list. */
export const MAX_SERVERS = 1000;

/** Longest accepted free-text version string (os_version, tm_version, ndi_version). */
export const MAX_VERSION_LENGTH = 64;

/** Largest accepted run_seconds (ten years). */
export const MAX_RUN_SECONDS = 10 * 365 * 24 * 3600;

export const REASONS = ["launch", "change"] as const;
export const OSES = ["windows", "macos", "linux"] as const;
export const ARCHES = ["x86_64", "aarch64"] as const;
export const DISPLAY_TYPES = ["audience", "field-queue", "pit"] as const;
export const TRANSPARENCY = ["alpha", "flatten"] as const;

/** Screen keys an audience display may show. */
export const SCREENS = [
	"intro",
	"in-match",
	"results",
	"rankings",
	"logo",
	"alliance-selection",
	"bracket",
	"skills-rankings",
	"award",
	"schedule",
	"inspection",
	"division-rankings",
	"all",
	"overlay",
] as const;

export type Reason = (typeof REASONS)[number];
export type Os = (typeof OSES)[number];
export type Arch = (typeof ARCHES)[number];
export type DisplayType = (typeof DISPLAY_TYPES)[number];
export type Transparency = (typeof TRANSPARENCY)[number];
export type Screen = (typeof SCREENS)[number];

export interface Display {
	type: DisplayType;
	/** Only present for audience displays. Sorted and de-duplicated. */
	screens: Screen[] | null;
	transparency: Transparency;
	audio: boolean;
	resolution: string;
	frame_rate: number;
	running: boolean;
	run_seconds: number;
}

export interface Report {
	schema: typeof SCHEMA_VERSION;
	install_id: string;
	reason: Reason;
	app_version: string;
	channel: string | null;
	os: Os;
	os_version: string;
	arch: Arch;
	tm_version: string | null;
	ndi_version: string | null;
	servers: { local: number; remote: number };
	displays: Display[];
}

const REPORT_KEYS = new Set([
	"schema",
	"install_id",
	"reason",
	"app_version",
	"channel",
	"os",
	"os_version",
	"arch",
	"tm_version",
	"ndi_version",
	"servers",
	"displays",
]);
const OPTIONAL_REPORT_KEYS = new Set(["channel"]);
const SERVER_KEYS = new Set(["local", "remote"]);
const DISPLAY_KEYS = new Set([
	"type",
	"screens",
	"transparency",
	"audio",
	"resolution",
	"frame_rate",
	"running",
	"run_seconds",
]);
const OPTIONAL_DISPLAY_KEYS = new Set(["screens"]);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Semantic Versioning 2.0.0 (https://semver.org), length-capped separately.
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const MAX_APP_VERSION_LENGTH = 64;
const CHANNEL = /^[a-z0-9][a-z0-9._-]{0,31}$/;
// Printable ASCII, no leading/trailing space.
const VERSION_TEXT = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
const RESOLUTION = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/;
const MAX_DIMENSION = 16384;
const MAX_FRAME_RATE = 1000;

/** Thrown internally on any invalid input. Never shown to the client. */
class Invalid extends Error {}

function fail(): never {
	throw new Invalid();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkKeys(
	obj: Record<string, unknown>,
	allowed: Set<string>,
	optional: Set<string>,
): void {
	for (const k of Object.keys(obj)) if (!allowed.has(k)) fail();
	for (const k of allowed) if (!optional.has(k) && !(k in obj)) fail();
}

function oneOf<T extends string>(v: unknown, list: readonly T[]): T {
	if (typeof v !== "string" || !(list as readonly string[]).includes(v)) fail();
	return v as T;
}

function int(v: unknown, min: number, max: number): number {
	if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) fail();
	return v;
}

function bool(v: unknown): boolean {
	if (typeof v !== "boolean") fail();
	return v;
}

function versionText(v: unknown): string {
	if (typeof v !== "string" || v.length > MAX_VERSION_LENGTH || !VERSION_TEXT.test(v)) fail();
	return v;
}

function nullableVersionText(v: unknown): string | null {
	return v === null ? null : versionText(v);
}

function parseDisplay(v: unknown): Display {
	if (!isPlainObject(v)) fail();
	checkKeys(v, DISPLAY_KEYS, OPTIONAL_DISPLAY_KEYS);
	const type = oneOf(v.type, DISPLAY_TYPES);

	let screens: Screen[] | null = null;
	if ("screens" in v) {
		if (type !== "audience" || !Array.isArray(v.screens)) fail();
		if (v.screens.length > SCREENS.length) fail();
		const set = new Set<Screen>();
		for (const s of v.screens) {
			const screen = oneOf(s, SCREENS);
			if (set.has(screen)) fail();
			set.add(screen);
		}
		screens = [...set].sort();
	}

	if (typeof v.resolution !== "string") fail();
	const m = RESOLUTION.exec(v.resolution);
	if (!m || Number(m[1]) > MAX_DIMENSION || Number(m[2]) > MAX_DIMENSION) fail();

	const frameRate = v.frame_rate;
	if (
		typeof frameRate !== "number" ||
		!Number.isFinite(frameRate) ||
		frameRate <= 0 ||
		frameRate > MAX_FRAME_RATE
	)
		fail();

	return {
		type,
		screens,
		transparency: oneOf(v.transparency, TRANSPARENCY),
		audio: bool(v.audio),
		resolution: v.resolution,
		frame_rate: frameRate,
		running: bool(v.running),
		run_seconds: int(v.run_seconds, 0, MAX_RUN_SECONDS),
	};
}

/**
 * Validate an already-JSON-parsed value. Returns the normalised report, or
 * null if anything about it is wrong. Never throws.
 */
export function parseReport(input: unknown): Report | null {
	try {
		if (!isPlainObject(input)) fail();
		checkKeys(input, REPORT_KEYS, OPTIONAL_REPORT_KEYS);
		if (input.schema !== SCHEMA_VERSION) fail();

		if (typeof input.install_id !== "string") fail();
		const installId = input.install_id.toLowerCase();
		if (!UUID_V4.test(installId)) fail();

		const appVersion = input.app_version;
		if (
			typeof appVersion !== "string" ||
			appVersion.length > MAX_APP_VERSION_LENGTH ||
			!SEMVER.test(appVersion)
		)
			fail();

		let channel: string | null = null;
		if ("channel" in input && input.channel !== null) {
			if (typeof input.channel !== "string" || !CHANNEL.test(input.channel)) fail();
			channel = input.channel;
		}

		const servers = input.servers;
		if (!isPlainObject(servers)) fail();
		checkKeys(servers, SERVER_KEYS, new Set());

		const displays = input.displays;
		if (!Array.isArray(displays) || displays.length > MAX_DISPLAYS) fail();

		return {
			schema: SCHEMA_VERSION,
			install_id: installId,
			reason: oneOf(input.reason, REASONS),
			app_version: appVersion,
			channel,
			os: oneOf(input.os, OSES),
			os_version: versionText(input.os_version),
			arch: oneOf(input.arch, ARCHES),
			tm_version: nullableVersionText(input.tm_version),
			ndi_version: nullableVersionText(input.ndi_version),
			servers: {
				local: int(servers.local, 0, MAX_SERVERS),
				remote: int(servers.remote, 0, MAX_SERVERS),
			},
			displays: displays.map(parseDisplay),
		};
	} catch (e) {
		if (e instanceof Invalid) return null;
		throw e;
	}
}

/**
 * True if `version` is allowed by a comma-separated allowlist.
 * Entries: exact ("1.2.0"), prefix ("1.2.*") or "*" (any; for local testing).
 */
export function isAllowedAppVersion(version: string, allowlist: string | undefined): boolean {
	if (!allowlist) return false;
	for (const raw of allowlist.split(",")) {
		const entry = raw.trim();
		if (!entry) continue;
		if (entry === "*") return true;
		if (entry.endsWith("*")) {
			if (version.startsWith(entry.slice(0, -1))) return true;
		} else if (version === entry) {
			return true;
		}
	}
	return false;
}
