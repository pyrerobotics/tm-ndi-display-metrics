import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations("./migrations");
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					// Test-only values; override the safe defaults from wrangler.jsonc.
					bindings: {
						TEST_MIGRATIONS: migrations,
						ALLOWED_APP_VERSIONS: "1.0.0, 1.1.*",
						MAX_LAUNCH_PER_INSTALL_PER_DAY: "1",
						MAX_CHANGE_PER_INSTALL_PER_DAY: "3",
						MAX_NEW_INSTALLS_PER_IP_PER_DAY: "2",
						MAX_REQUESTS_PER_IP_PER_DAY: "1000",
						RETENTION_DAYS: "400",
					},
				},
			}),
		],
		test: {
			setupFiles: ["./test/setup.ts"],
		},
	};
});
