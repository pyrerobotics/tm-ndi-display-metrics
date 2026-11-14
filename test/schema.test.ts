import { describe, expect, it } from "vitest";
import {
	isAcceptedChannel,
	isAllowedAppVersion,
	MAX_DISPLAYS,
	MAX_RUN_SECONDS,
	parseReport,
} from "../src/schema";
import { APP_EXAMPLE, validReport, withCounts } from "./helpers";

/** Replace the displays with one patched audience display; counts follow. */
function withDisplay(patch: Record<string, unknown>, drop: string[] = []) {
	const r = validReport();
	const d = { ...(r.displays as Record<string, unknown>[])[0], ...patch };
	for (const k of drop) delete d[k];
	return withCounts({ ...r, displays: [d] });
}

function without(key: string) {
	const r = validReport();
	delete r[key];
	return r;
}

describe("parseReport", () => {
	it("accepts the app's example report", () => {
		const p = parseReport(APP_EXAMPLE);
		expect(p).not.toBeNull();
		expect(p?.channel).toBe("dev");
		expect(p?.servers_local).toBe(1);
		expect(p?.servers_remote).toBe(1);
		expect(p?.display_count).toBe(4);
		expect(p?.running_count).toBe(1);
		expect(p?.displays.map((d) => d.frame_rate)).toEqual(["59.94", "29.97", "29.97", "29.97"]);
		expect(p?.displays[1]?.screens).toEqual(["intro", "rankings"]);
		expect(p?.displays[3]?.screens).toEqual([]);
	});

	it("accepts a valid report and normalises it", () => {
		const r = validReport({ install_id: "0F8FAD5B-D9CB-469F-A165-70867728950E" });
		const p = parseReport(r);
		expect(p).not.toBeNull();
		expect(p?.install_id).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
		expect(p?.displays[0]?.screens).toEqual(["in-match", "intro", "results"]);
		expect(p?.displays[1]?.screens).toEqual([]);
	});

	it("accepts every channel and frame rate the app sends, and null tm/ndi versions", () => {
		for (const channel of ["release", "dev", "e2e"]) {
			expect(parseReport(validReport({ channel }))?.channel).toBe(channel);
		}
		for (const frame_rate of ["25", "29.97", "30", "50", "59.94", "60"]) {
			expect(parseReport(withDisplay({ frame_rate }))?.displays[0]?.frame_rate).toBe(frame_rate);
		}
		const p = parseReport(validReport({ tm_version: null, ndi_version: null }));
		expect(p?.tm_version).toBeNull();
		expect(p?.ndi_version).toBeNull();
	});

	it("accepts prerelease semver, zero displays and the maximum run_seconds", () => {
		expect(parseReport(validReport({ app_version: "1.1.0-beta.2+build.7" }))).not.toBeNull();
		expect(parseReport(validReport({ displays: [] }))).not.toBeNull();
		expect(parseReport(withDisplay({ run_seconds: MAX_RUN_SECONDS }))).not.toBeNull();
	});

	const invalid: [string, unknown][] = [
		["not an object", [1, 2]],
		["null", null],
		["string", "hello"],
		["unknown top-level field", validReport({ extra: 1 })],
		["old nested servers object", validReport({ servers: { local: 1, remote: 0 } })],
		["unknown display field", withDisplay({ colour: "red" })],
		["wrong schema version", validReport({ schema: 2 })],
		["schema as string", validReport({ schema: "1" })],
		["missing install_id", without("install_id")],
		["missing displays", without("displays")],
		["missing channel", without("channel")],
		["missing servers_local", without("servers_local")],
		["missing display_count", without("display_count")],
		["missing running_count", without("running_count")],
		["missing tm_version (must be present, may be null)", without("tm_version")],
		["install_id not a uuid", validReport({ install_id: "abc" })],
		["install_id uuid v1", validReport({ install_id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" })],
		["reason outside enum", validReport({ reason: "crash" })],
		["app_version not semver", validReport({ app_version: "1.0" })],
		["app_version too long", validReport({ app_version: `1.0.0-${"a".repeat(80)}` })],
		["os outside enum", validReport({ os: "freebsd" })],
		["arch outside enum", validReport({ arch: "i686" })],
		["os_version wrong type", validReport({ os_version: 10 })],
		["os_version empty", validReport({ os_version: "" })],
		["os_version too long", validReport({ os_version: "1".repeat(65) })],
		["os_version with control characters", validReport({ os_version: "10\n0" })],
		["tm_version non-ascii", validReport({ tm_version: "4.3é" })],
		["channel outside enum", validReport({ channel: "beta" })],
		["channel null", validReport({ channel: null })],
		["servers_local negative", validReport({ servers_local: -1 })],
		["servers_remote float", validReport({ servers_remote: 1.5 })],
		["servers_local string", validReport({ servers_local: "1" })],
		["display_count does not match displays", validReport({ display_count: 3 })],
		["running_count does not match displays", validReport({ running_count: 2 })],
		["running_count negative", validReport({ running_count: -1 })],
		["display_count float", validReport({ display_count: 2.0001 })],
		["displays not an array", validReport({ displays: {} })],
		[
			"too many displays",
			validReport({
				displays: Array.from(
					{ length: MAX_DISPLAYS + 1 },
					() => (validReport().displays as unknown[])[1],
				),
			}),
		],
		["display type outside enum", withDisplay({ type: "scoreboard" })],
		["screens on a pit display", withDisplay({ type: "pit" })],
		["screens on a field-queue display", withDisplay({ type: "field-queue" })],
		["audience display with no screens", withDisplay({ screens: [] })],
		["screens missing", withDisplay({}, ["screens"])],
		["screen outside enum", withDisplay({ screens: ["intro", "secret"] })],
		["duplicate screen", withDisplay({ screens: ["intro", "intro"] })],
		["screens null", withDisplay({ screens: null })],
		["transparency outside enum", withDisplay({ transparency: "opaque" })],
		["audio not boolean", withDisplay({ audio: 1 })],
		["running not boolean", withDisplay({ running: "yes" })],
		["resolution bad format", withDisplay({ resolution: "1080p" })],
		["resolution too large", withDisplay({ resolution: "99999x1080" })],
		["frame_rate as number", withDisplay({ frame_rate: 60 })],
		["frame_rate outside list", withDisplay({ frame_rate: "120" })],
		["frame_rate padded", withDisplay({ frame_rate: "60.0" })],
		["run_seconds negative", withDisplay({ run_seconds: -5 })],
		["run_seconds float", withDisplay({ run_seconds: 1.5 })],
		["run_seconds over seven days", withDisplay({ run_seconds: MAX_RUN_SECONDS + 1 })],
		["missing display field", withDisplay({}, ["transparency"])],
	];

	for (const [name, input] of invalid) {
		it(`rejects: ${name}`, () => {
			expect(parseReport(input)).toBeNull();
		});
	}
});

describe("isAllowedAppVersion", () => {
	it("matches exact, prefix and wildcard entries", () => {
		expect(isAllowedAppVersion("1.0.0", "1.0.0, 1.1.*")).toBe(true);
		expect(isAllowedAppVersion("1.1.4", "1.0.0, 1.1.*")).toBe(true);
		expect(isAllowedAppVersion("1.2.0", "1.0.0, 1.1.*")).toBe(false);
		expect(isAllowedAppVersion("9.9.9", "*")).toBe(true);
	});

	it("rejects everything when the list is empty or unset", () => {
		expect(isAllowedAppVersion("1.0.0", "")).toBe(false);
		expect(isAllowedAppVersion("1.0.0", undefined)).toBe(false);
		expect(isAllowedAppVersion("1.0.0", " , ")).toBe(false);
	});
});

describe("isAcceptedChannel", () => {
	it("defaults to release only", () => {
		expect(isAcceptedChannel("release", undefined)).toBe(true);
		expect(isAcceptedChannel("release", "")).toBe(true);
		expect(isAcceptedChannel("dev", undefined)).toBe(false);
		expect(isAcceptedChannel("e2e", "")).toBe(false);
	});

	it("follows a configured list", () => {
		expect(isAcceptedChannel("dev", "release, dev")).toBe(true);
		expect(isAcceptedChannel("e2e", "release, dev")).toBe(false);
		expect(isAcceptedChannel("release", "dev")).toBe(false);
	});
});
