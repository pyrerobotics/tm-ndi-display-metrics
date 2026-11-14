import { describe, expect, it } from "vitest";
import { isAllowedAppVersion, MAX_DISPLAYS, parseReport } from "../src/schema";
import { validReport } from "./helpers";

function withDisplay(patch: Record<string, unknown>, drop: string[] = []) {
	const r = validReport();
	const d = { ...(r.displays as Record<string, unknown>[])[0], ...patch };
	for (const k of drop) delete d[k];
	r.displays = [d];
	return r;
}

function without(key: string) {
	const r = validReport();
	delete r[key];
	return r;
}

describe("parseReport", () => {
	it("accepts a valid report and normalises it", () => {
		const r = validReport({
			install_id: "0F8FAD5B-D9CB-469F-A165-70867728950E",
		});
		const p = parseReport(r);
		expect(p).not.toBeNull();
		expect(p?.install_id).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
		expect(p?.displays[0]?.screens).toEqual(["in-match", "intro", "results"]);
		expect(p?.displays[1]?.screens).toBeNull();
	});

	it("accepts optional channel missing or null, and null tm/ndi versions", () => {
		expect(parseReport(without("channel"))?.channel).toBeNull();
		expect(parseReport(validReport({ channel: null }))?.channel).toBeNull();
		const p = parseReport(validReport({ tm_version: null, ndi_version: null }));
		expect(p?.tm_version).toBeNull();
		expect(p?.ndi_version).toBeNull();
	});

	it("accepts prerelease semver and zero displays", () => {
		expect(parseReport(validReport({ app_version: "1.1.0-beta.2+build.7" }))).not.toBeNull();
		expect(parseReport(validReport({ displays: [] }))).not.toBeNull();
	});

	const invalid: [string, unknown][] = [
		["not an object", [1, 2]],
		["null", null],
		["string", "hello"],
		["unknown top-level field", validReport({ extra: 1 })],
		["unknown display field", withDisplay({ colour: "red" })],
		["unknown servers field", validReport({ servers: { local: 1, remote: 0, other: 1 } })],
		["wrong schema version", validReport({ schema: 2 })],
		["schema as string", validReport({ schema: "1" })],
		["missing install_id", without("install_id")],
		["missing displays", without("displays")],
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
		["channel bad characters", validReport({ channel: "Release Channel!" })],
		["servers negative", validReport({ servers: { local: -1, remote: 0 } })],
		["servers float", validReport({ servers: { local: 1.5, remote: 0 } })],
		["servers missing key", validReport({ servers: { local: 1 } })],
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
		["screens on a non-audience display", withDisplay({ type: "pit" })],
		["screen outside enum", withDisplay({ screens: ["intro", "secret"] })],
		["duplicate screen", withDisplay({ screens: ["intro", "intro"] })],
		["screens null", withDisplay({ screens: null })],
		["transparency outside enum", withDisplay({ transparency: "opaque" })],
		["audio not boolean", withDisplay({ audio: 1 })],
		["running not boolean", withDisplay({ running: "yes" })],
		["resolution bad format", withDisplay({ resolution: "1080p" })],
		["resolution too large", withDisplay({ resolution: "99999x1080" })],
		["frame_rate zero", withDisplay({ frame_rate: 0 })],
		["frame_rate string", withDisplay({ frame_rate: "60" })],
		["run_seconds negative", withDisplay({ run_seconds: -5 })],
		["run_seconds float", withDisplay({ run_seconds: 1.5 })],
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
