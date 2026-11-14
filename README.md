# TM NDI metrics relay

A small Cloudflare Worker that receives anonymous usage reports from
TM NDI Display Manager, checks them, and stores them in Cloudflare D1.
It also serves a private dashboard of the totals.

Reporting is on by default in the app and users can turn it off.

## What is stored

Each accepted report becomes one row in `reports` and one row per display in
`displays` (with the screens of audience displays in `display_screens`):

- a random install ID made by the app (not linked to a person or machine)
- why the report was sent (`launch` or `change`)
- app version and release channel, OS, OS version, CPU architecture
- Tournament Manager and NDI runtime versions
- how many local and remote TM servers are configured
- for each display: type, screens, transparency, audio on/off, resolution,
  frame rate, whether it is running, and how long it ran since the app's
  previous report
- the UTC time the relay received it

The `installs` table keeps each install ID's first and last day seen.

## What is never stored

- IP addresses, in any form that can be reversed
- user agent, country, language, referrer or any other request header
- anything not listed above: the relay rejects reports with unknown fields

The Worker never logs request bodies or IPs. Workers Logs is turned off in
`wrangler.jsonc`. Responses have no body, so nothing sent is echoed back.

## How the IP is used

The client IP (`CF-Connecting-IP`) is only used for abuse limits:

1. The Worker computes HMAC-SHA-256 of the IP with a random salt for the
   current UTC day. The salt is stored in D1 (`ip_salts`).
2. Only that hash is stored, with two counters for the day (`ip_daily`):
   requests, and new install IDs.
3. A daily cron job (00:05 UTC) deletes all earlier salts and counters.
   After that, nobody can work out which IP produced an old hash.

The hash is never stored next to a report, so reports cannot be linked to
an IP even on the same day.

## Abuse limits

All limits are Worker vars (see below), so you can tighten them without
changing code.

- One `launch` report per install per UTC day is stored. Extra ones get
  `204` but are dropped.
- `change` reports per install per day are capped. Extra ones get `204` but
  are dropped.
- New install IDs first seen from one IP per day are capped. Over the cap the
  relay answers `429`.
- Requests per IP per day are capped (`429`).
- A short-burst limit per client uses the Workers Rate Limiting binding
  (keyed by the salted hash). It is set in `wrangler.jsonc` (30 per minute).

## Retention

The same daily cron job deletes reports older than `RETENTION_DAYS`
(default 400), with their displays, and installs not seen since then.

## The report format

All knowledge of the format is in [`src/schema.ts`](src/schema.ts): field
lists, allowed values, size limits and the `schema: 1` version check. To change
the format, edit that file. If a stored column changes, also add a migration in
`migrations/` and update `src/store.ts`.

The app sends `POST /v1/report` with `Content-Type: application/json`.
Bodies over 16 KB are rejected. Responses:

| Status | Meaning                                            |
| ------ | -------------------------------------------------- |
| 204    | Accepted (stored, or dropped by a per-install cap) |
| 400    | Invalid report, or app version not allowed         |
| 429    | Rate limited                                       |

Example:

```json
{
	"schema": 1,
	"install_id": "00000000-0000-4000-8000-000000000000",
	"reason": "launch",
	"app_version": "9.8.7",
	"channel": "release",
	"os": "windows",
	"os_version": "10.0.26200",
	"arch": "x86_64",
	"tm_version": "2026_27.1.3",
	"ndi_version": "6.1.1",
	"servers_local": 1,
	"servers_remote": 1,
	"display_count": 2,
	"running_count": 1,
	"displays": [
		{
			"type": "audience",
			"screens": ["intro", "rankings"],
			"transparency": "flatten",
			"audio": true,
			"resolution": "1280x720",
			"frame_rate": "59.94",
			"running": true,
			"run_seconds": 125
		},
		{
			"type": "pit",
			"screens": [],
			"transparency": "alpha",
			"audio": false,
			"resolution": "1920x1080",
			"frame_rate": "29.97",
			"running": false,
			"run_seconds": 0
		}
	]
}
```

Rules worth knowing (all in `src/schema.ts`):

- Every field is required. `tm_version` and `ndi_version` may be `null`.
- `channel` is `release`, `dev` or `e2e`. Only channels in
  `ACCEPTED_CHANNELS` (default `release`) are stored. Others get `204` and
  are dropped.
- `display_count` must equal the number of displays, and `running_count` the
  number with `running: true`.
- `screens` is non-empty for `audience` displays and `[]` for
  `field-queue` and `pit`.
- `frame_rate` is a string: `25`, `29.97`, `30`, `50`, `59.94` or `60`.
- `run_seconds` is time run since the app's previous report, at most 7 days.

## Settings

Vars (in `wrangler.jsonc`, all strings):

| Name                              | Default            | Meaning                                                                                     |
| --------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `ALLOWED_APP_VERSIONS`            | `""` (accept none) | Comma-separated. Exact (`1.2.0`), prefix (`1.2.*`), or `*` for local testing only           |
| `ACCEPTED_CHANNELS`               | `release`          | Comma-separated channels to store (`release`, `dev`, `e2e`). Others get 204 and are dropped |
| `MAX_LAUNCH_PER_INSTALL_PER_DAY`  | `1`                | Stored launch reports per install per UTC day                                               |
| `MAX_CHANGE_PER_INSTALL_PER_DAY`  | `50`               | Stored change reports per install per UTC day                                               |
| `MAX_NEW_INSTALLS_PER_IP_PER_DAY` | `20`               | New install IDs per IP per UTC day                                                          |
| `MAX_REQUESTS_PER_IP_PER_DAY`     | `500`              | Requests per IP per UTC day                                                                 |
| `RETENTION_DAYS`                  | `400`              | Days to keep reports                                                                        |
| `ACCESS_TEAM_DOMAIN`              | `""`               | Your Access team domain, e.g. `myteam.cloudflareaccess.com`                                 |
| `ACCESS_AUD`                      | `""`               | The Access application's Audience (AUD) tag                                                 |

If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty, `/dashboard` returns 404.

The committed values are public defaults. To keep your real limits private,
delete the line from `vars` and set it as a secret instead
(`npx wrangler secret put MAX_NEW_INSTALLS_PER_IP_PER_DAY`). The Worker reads
both the same way. No secrets are required.

Bindings: `DB` (D1) and `RATE_LIMITER` (Workers Rate Limiting).

## Local development

Needs Node 22 or later. Everything runs offline.

```sh
npm install
npm test            # Vitest in the Workers runtime, with a local D1
npm run typecheck   # tsc --noEmit
npm run lint        # Biome (lint + format check); `npm run format` fixes
```

Run the Worker locally with a local D1:

```sh
cp .dev.vars.example .dev.vars     # allows any app version and the dev channel
npm run db:migrate:local
npm run dev                        # http://localhost:8787
```

Then `POST http://localhost:8787/v1/report`. The dashboard needs Cloudflare
Access, so locally it returns 404. The tests cover it with a local key.

## Deployment (owner steps)

You need a Cloudflare account. All of this works on the free plan.

1. Log in: `npx wrangler login`.
2. Create the database: `npx wrangler d1 create tm-ndi-metrics`.
   Copy the printed `database_id` into `wrangler.jsonc`.
3. Set `ALLOWED_APP_VERSIONS` to the app versions you ship (not `*`).
   Adjust the other limits if you like (see Settings).
4. Apply the migrations: `npm run db:migrate:remote`.
5. Deploy: `npx wrangler deploy`.
6. Optional: add a custom domain or route for the Worker in the Cloudflare
   dashboard (Workers & Pages > your Worker > Settings > Domains & Routes).
7. Set up Cloudflare Access for the dashboard (next section).
8. In the app, set `METRICS_URL` to `https://<your Worker host>/v1/report`.

The cron trigger is deployed with the Worker. To check it ran, look at
the `ip_salts` table: it should only hold today's (UTC) row.

### Cloudflare Access for the dashboard

Access is free for up to 50 users.

1. In the Cloudflare dashboard open **Zero Trust**. The first time, pick a
   team name and the Free plan. Your team domain is
   `<team>.cloudflareaccess.com`.
2. Go to **Access > Applications > Add an application > Self-hosted**.
3. Add a public hostname for the Worker's host with path `dashboard`.
   Do not protect `/v1/report`: the app must reach it without logging in.
   If you also use the `workers.dev` host, add it too, or turn
   `workers.dev` off for the Worker.
4. Add a policy: Action **Allow**, Include **Emails** with your address (or
   a group). Use the one-time PIN login method if you have no other.
5. Save. Open the application's **Overview** and copy the
   **Application Audience (AUD) Tag**.
6. Set the vars and deploy again:
   - `ACCESS_TEAM_DOMAIN` = `<team>.cloudflareaccess.com`
   - `ACCESS_AUD` = the AUD tag

The Worker checks the `Cf-Access-Jwt-Assertion` header on every dashboard
request: the signature against your team's public keys, the issuer, the
audience and the expiry. A request without the header gets 401. A bad token
gets 403.

## Layout

```
src/index.ts            routes, fetch and cron handlers
src/schema.ts           the report format and validation (edit here)
src/report.ts           POST /v1/report: limits, validation, storage
src/store.ts            D1 writes for reports
src/iphash.ts           daily salt, IP hashing, per-IP counters
src/scheduled.ts        salt rotation and retention
src/access.ts           Cloudflare Access JWT checks
src/dashboard/data.ts   dashboard queries
src/dashboard/render.ts dashboard HTML (inline CSS and SVG, no scripts)
migrations/             D1 schema
test/                   Vitest tests (Workers runtime, local D1)
```

## Licence

MIT. See [LICENSE](LICENSE).
