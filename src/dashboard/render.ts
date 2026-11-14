import { type Count, type DashboardData, type DayValue, RANGES } from "./data";

/** Escape text for HTML. Every value from stored reports passes through this. */
export function esc(v: unknown): string {
	return String(v)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const nf = new Intl.NumberFormat("en-US");
const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const fmt = (n: number) => nf.format(Math.round(n));
const pct = (n: number, total: number) => (total > 0 ? `${nf1.format((n / total) * 100)}%` : "0%");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDay(day: string): string {
	const [, m, d] = day.split("-");
	return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

/** A round axis maximum at or above `max`. */
function niceMax(max: number): number {
	if (max <= 0) return 1;
	const pow = 10 ** Math.floor(Math.log10(max));
	for (const step of [1, 2, 2.5, 5, 10]) if (step * pow >= max) return step * pow;
	return 10 * pow;
}

let chartSeq = 0;

/** Daily column chart (inline SVG) with a table fallback. */
function dailyChart(
	title: string,
	series: DayValue[],
	unit: string,
	format: (n: number) => string = fmt,
): string {
	const id = `c${++chartSeq}`;
	const W = 720;
	const H = 220;
	const left = 44;
	const right = 8;
	const top = 10;
	const bottom = 28;
	const plotW = W - left - right;
	const plotH = H - top - bottom;
	const max = niceMax(Math.max(0, ...series.map((s) => s.value)));
	const slot = plotW / Math.max(1, series.length);
	const gap = slot >= 6 ? 2 : 0;
	const barW = Math.max(1, slot - gap);
	const r = Math.min(4, barW / 2);
	const total = series.reduce((n, s) => n + s.value, 0);

	const grid = [0, 0.5, 1]
		.map((f) => {
			const y = top + plotH - f * plotH;
			return `<line x1="${left}" x2="${W - right}" y1="${y}" y2="${y}" class="grid"/>
<text x="${left - 6}" y="${y + 4}" class="axis" text-anchor="end">${esc(format(max * f))}</text>`;
		})
		.join("");

	const bars = series
		.map((s, i) => {
			const h = (s.value / max) * plotH;
			const x = left + i * slot + gap / 2;
			const y = top + plotH - h;
			const label = `${shortDay(s.day)}: ${format(s.value)} ${unit}`;
			// Rounded data end, square at the baseline.
			const shape =
				h <= 0
					? ""
					: h <= r
						? `<rect x="${x}" y="${y}" width="${barW}" height="${h}" class="bar"/>`
						: `<path d="M${x},${top + plotH}V${y + r}q0,-${r} ${r},-${r}h${barW - 2 * r}q${r},0 ${r},${r}V${top + plotH}Z" class="bar"/>`;
			// Full-height transparent hit target so short bars are easy to hover.
			return `<g><title>${esc(label)}</title><rect x="${left + i * slot}" y="${top}" width="${slot}" height="${plotH}" class="hit"/>${shape}</g>`;
		})
		.join("");

	const ticks =
		series.length === 0
			? []
			: series.length < 3
				? series.map((_, i) => i)
				: [0, Math.floor((series.length - 1) / 2), series.length - 1];
	const xLabels = ticks
		.map((i) => {
			const s = series[i];
			if (!s) return "";
			const x = left + i * slot + slot / 2;
			const anchor = i === 0 ? "start" : i === series.length - 1 ? "end" : "middle";
			const tx = anchor === "start" ? left : anchor === "end" ? W - right : x;
			return `<text x="${tx}" y="${H - 8}" class="axis" text-anchor="${anchor}">${esc(shortDay(s.day))}</text>`;
		})
		.join("");

	const rows = series
		.map((s) => `<tr><th scope="row">${esc(s.day)}</th><td>${esc(format(s.value))}</td></tr>`)
		.join("");

	return `<figure class="chart">
<figcaption id="${id}-t"><span class="ctitle">${esc(title)}</span> <span class="muted">Total over range: ${esc(format(total))} ${esc(unit)}</span></figcaption>
<div class="scroll"><svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${id}-t">${grid}${bars}<line x1="${left}" x2="${W - right}" y1="${top + plotH}" y2="${top + plotH}" class="baseline"/>${xLabels}</svg></div>
<details><summary>Show as table</summary>
<table class="data"><caption class="sr">${esc(title)}</caption><thead><tr><th scope="col">Day (UTC)</th><th scope="col">${esc(unit[0]?.toUpperCase() + unit.slice(1))}</th></tr></thead><tbody>${rows}</tbody></table>
</details>
</figure>`;
}

const MAX_ROWS = 12;

/**
 * Share table: the table is the chart. Each row has the real number, the
 * percentage and a bar. Long tails fold into "Other".
 */
function shareTable(
	title: string,
	counts: Count[],
	total: number,
	unit: string,
	note?: string,
	/** False when values overlap (a display shows several screens), so "Other" can't be summed. */
	foldOther = true,
) {
	let list = counts;
	if (foldOther && counts.length > MAX_ROWS) {
		const rest = counts.slice(MAX_ROWS - 1);
		list = [
			...counts.slice(0, MAX_ROWS - 1),
			{
				label: `Other (${rest.length})`,
				count: rest.reduce((n, c) => n + c.count, 0),
			},
		];
	}
	const max = Math.max(1, ...list.map((c) => c.count));
	const body =
		list.length === 0
			? `<tr><td colspan="3" class="muted">No data in this range.</td></tr>`
			: list
					.map(
						(
							c,
						) => `<tr><th scope="row">${esc(c.label)}</th><td class="num">${esc(fmt(c.count))}</td>
<td class="barcell"><span class="pct">${esc(pct(c.count, total))}</span><span class="track" aria-hidden="true"><span class="fill" style="width:${((c.count / max) * 100).toFixed(1)}%"></span></span></td></tr>`,
					)
					.join("");
	return `<section class="card">
<h3>${esc(title)}</h3>${note ? `<p class="muted small">${esc(note)}</p>` : ""}
<table class="share"><thead><tr><th scope="col">Value</th><th scope="col" class="num">${esc(unit)}</th><th scope="col">Share</th></tr></thead><tbody>${body}</tbody></table>
</section>`;
}

function stat(label: string, value: string, hint?: string): string {
	return `<div class="stat"><div class="slabel">${esc(label)}</div><div class="svalue">${esc(value)}</div>${hint ? `<div class="muted small">${esc(hint)}</div>` : ""}</div>`;
}

const CSS = `
:root{color-scheme:light;--bg:#f4f4f2;--surface:#fcfcfb;--text:#0b0b0b;--text2:#52514e;--line:#dddcd7;--grid:#e9e8e4;--series:#2a78d6;--track:#ecebe7;--focus:#1a5fb4}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111110;--surface:#1a1a19;--text:#f0efec;--text2:#c3c2b7;--line:#3a3a37;--grid:#2c2c2a;--series:#3987e5;--track:#2c2c2a;--focus:#8ab4f8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.15rem;margin:28px 0 10px}h3{font-size:1rem;margin:0 0 8px}
.muted{color:var(--text2)}.small{font-size:.85rem;margin:0 0 8px}
nav.range{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 4px}
nav.range a{padding:6px 12px;border:1px solid var(--line);border-radius:999px;color:var(--text);text-decoration:none;background:var(--surface)}
nav.range a[aria-current=page]{background:var(--text);color:var(--surface);border-color:var(--text)}
a:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.stat,.card,.chart{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.slabel{color:var(--text2);font-size:.85rem}.svalue{font-size:1.6rem;font-weight:650;font-variant-numeric:tabular-nums}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
.chart{margin:0 0 12px}.ctitle{font-weight:600}
.chart .scroll{overflow-x:auto;margin-top:8px}.chart svg{display:block;width:100%;height:auto}
.chart .grid{stroke:var(--grid);stroke-width:1}.chart .baseline{stroke:var(--text2);stroke-width:1}
.chart .axis{fill:var(--text2);font-size:13px}.chart .bar{fill:var(--series)}.chart .hit{fill:transparent}
.chart g:hover .bar{opacity:.75}
details{margin-top:8px}summary{cursor:pointer;color:var(--text2)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--grid);vertical-align:middle}
thead th{color:var(--text2);font-weight:500;font-size:.85rem}
th[scope=row]{font-weight:400;word-break:break-word}
.num{text-align:right;white-space:nowrap}
table.data{max-width:360px}
.barcell{width:45%}.pct{display:inline-block;min-width:3.6em;font-size:.85rem;color:var(--text2)}
.track{display:inline-block;vertical-align:middle;width:calc(100% - 4em);height:10px;background:var(--track);border-radius:0 4px 4px 0}
.fill{display:block;height:100%;background:var(--series);border-radius:0 4px 4px 0;min-width:2px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
footer{margin:28px 0 8px;font-size:.85rem}
@media (max-width:520px){.chart svg{min-width:560px}.svalue{font-size:1.35rem}.barcell{width:40%}}
`;

const hours = (n: number) => nf1.format(n);

export function renderDashboard(d: DashboardData): string {
	chartSeq = 0;
	const nav = RANGES.map(
		(n) => `<a href="?days=${n}"${n === d.days ? ' aria-current="page"' : ""}>Last ${n} days</a>`,
	).join("");
	const newInRange = d.newPerDay.reduce((n, x) => n + x.value, 0);
	const hoursInRange = d.displayHoursPerDay.reduce((n, x) => n + x.value, 0);
	const installs = d.latestInstalls;
	const latestNote = "Each install counted once, using its latest report in this range.";
	const displayNote = "Displays in each install's latest report in this range.";
	const dt = d.displays;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>TM NDI usage</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
<h1>TM NDI Display Manager usage</h1>
<p class="muted small">Anonymous reports from ${esc(d.from)} to ${esc(d.to)} (UTC).</p>
<nav class="range" aria-label="Date range">${nav}</nav>
</header>

<h2>Installs</h2>
<div class="stats">
${stat("Active, last 7 days", fmt(d.active7))}
${stat("Active, last 30 days", fmt(d.active30))}
${stat(`Active, last ${d.days} days`, fmt(d.activeInRange))}
${stat(`New, last ${d.days} days`, fmt(newInRange))}
${stat(`Display hours, last ${d.days} days`, hours(hoursInRange))}
</div>
<div style="height:12px"></div>
${dailyChart("Active installs per day", d.activePerDay, "installs")}
${dailyChart("New installs per day", d.newPerDay, "installs")}

<h2>Versions and platforms</h2>
<div class="grid2">
${shareTable("App version", d.appVersion, installs, "Installs", latestNote)}
${shareTable("Operating system", d.os, installs, "Installs", latestNote)}
${shareTable("OS version", d.osVersion, installs, "Installs", latestNote)}
${shareTable("CPU architecture", d.arch, installs, "Installs", latestNote)}
${shareTable("Tournament Manager version", d.tmVersion, installs, "Installs", latestNote)}
${shareTable("NDI runtime version", d.ndiVersion, installs, "Installs", latestNote)}
${shareTable("Release channel", d.channel, installs, "Installs", latestNote)}
</div>

<h2>Displays</h2>
<div class="stats">
${stat("Displays", fmt(dt.total), displayNote)}
${stat("Local servers", fmt(d.servers.localTotal), `${fmt(d.servers.installsWithLocal)} of ${fmt(installs)} installs use one`)}
${stat("Remote servers", fmt(d.servers.remoteTotal), `${fmt(d.servers.installsWithRemote)} of ${fmt(installs)} installs use one`)}
</div>
<div style="height:12px"></div>
<div class="grid2">
${shareTable("Display type", dt.byType, dt.total, "Displays", displayNote)}
${shareTable("Screens used", dt.screens, dt.audienceTotal, "Displays", "Audience displays showing each screen. Share is of all audience displays; a display can show several screens.", false)}
${shareTable("Transparency", dt.transparency, dt.total, "Displays", displayNote)}
${shareTable("Audio", dt.audio, dt.total, "Displays", displayNote)}
${shareTable("Resolution", dt.resolution, dt.total, "Displays", displayNote)}
${shareTable("Frame rate", dt.frameRate, dt.total, "Displays", displayNote)}
</div>
${dailyChart("Display hours run per day", d.displayHoursPerDay, "hours", hours)}

<footer class="muted">No IP addresses or other request details are stored. Days are UTC.</footer>
</main>
</body>
</html>`;
}
