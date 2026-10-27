const API = "https://www.googleapis.com/youtube/v3";
const KEY_STORAGE = "yt-tracker-api-key";

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat();
const fmtCompact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const fmtDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const fmtDateTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

let apiKey = ""; // saved from Settings; shared by both tabs
let chart = null;
let allVideos = [];
let videos = []; // allVideos after the minimum-length filter
let loadedDays = 0;
let sort = { key: "publishedAt", dir: "desc" };

// ---------- YouTube API ----------

async function yt(path, params) {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", apiKey);
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason;
    const msg = body?.error?.message || res.statusText;
    if (reason === "quotaExceeded") throw new Error("YouTube API quota exceeded for this key. Try again tomorrow.");
    if (reason === "keyInvalid" || res.status === 400 && /API key/i.test(msg)) throw new Error("The API key is not valid.");
    throw new Error(`YouTube API error: ${msg}`);
  }
  return body;
}

// Accepts @handle, channel URLs (/@handle, /channel/UC…, /user/name, /c/name) or a raw channel ID.
function parseChannelInput(raw) {
  const s = raw.trim();
  let m;
  if ((m = s.match(/(?:^|\/channel\/)(UC[\w-]{22})(?:[/?#]|$)/))) return { id: m[1] };
  if ((m = s.match(/(?:^|\/)@([\w.\-]+)/))) return { handle: "@" + m[1] };
  if ((m = s.match(/\/user\/([\w.\-]+)/))) return { username: m[1] };
  if ((m = s.match(/\/c\/([^/?#]+)/))) return { search: decodeURIComponent(m[1]) };
  if (/^[\w.\-]+$/.test(s)) return { handle: "@" + s, search: s };
  return { search: s };
}

async function resolveChannel(input) {
  const q = parseChannelInput(input);
  const part = "snippet,contentDetails,statistics";
  const tries = [];
  if (q.id) tries.push({ id: q.id });
  if (q.handle) tries.push({ forHandle: q.handle });
  if (q.username) tries.push({ forUsername: q.username });
  for (const t of tries) {
    const r = await yt("channels", { part, ...t });
    if (r.items?.length) return r.items[0];
  }
  // Fallback: search (costs 100 quota units, so only used when direct lookups fail).
  const term = q.search || q.username || q.handle;
  if (term) {
    const s = await yt("search", { part: "snippet", type: "channel", q: term, maxResults: 1 });
    const id = s.items?.[0]?.snippet?.channelId;
    if (id) {
      const r = await yt("channels", { part, id });
      if (r.items?.length) return r.items[0];
    }
  }
  throw new Error(`No channel found for "${input}".`);
}

// Walks the channel's uploads playlist (newest first) until videos are older than the cutoff.
async function fetchRecentVideoIds(uploadsPlaylistId, cutoff) {
  const ids = [];
  let pageToken = "";
  for (let page = 0; page < 20; page++) {
    const r = await yt("playlistItems", {
      part: "contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      ...(pageToken && { pageToken }),
    });
    let anyRecent = false;
    for (const item of r.items || []) {
      const published = item.contentDetails.videoPublishedAt;
      if (!published) continue; // private / deleted
      if (new Date(published) >= cutoff) {
        ids.push(item.contentDetails.videoId);
        anyRecent = true;
      }
    }
    pageToken = r.nextPageToken;
    if (!pageToken || !anyRecent) break;
  }
  return ids;
}

const EXCLUDE_RECENT_MS = 24 * 3600_000;

// The period analysed: `days` days ending 24 hours ago. Videos newer than that are always left out,
// since they're still collecting their first views and would drag trends and averages down.
function periodFor(days) {
  const end = new Date(Date.now() - EXCLUDE_RECENT_MS);
  return { start: new Date(end - days * 86400_000), end, days };
}

const periodText = (days) => `the ${days} day${days === 1 ? "" : "s"} ending 24 hours ago`;

// All public videos the channel published within the period, with details.
async function fetchChannelVideos(channel, period) {
  const ids = await fetchRecentVideoIds(channel.contentDetails.relatedPlaylists.uploads, period.start);
  return (await fetchVideoDetails(ids)).filter((v) => v.publishedAt >= period.start && v.publishedAt <= period.end);
}

async function fetchVideoDetails(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await yt("videos", { part: "snippet,statistics,contentDetails", id: ids.slice(i, i + 50).join(",") });
    for (const v of r.items || []) {
      out.push({
        id: v.id,
        title: v.snippet.title,
        publishedAt: new Date(v.snippet.publishedAt),
        thumb: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
        duration: parseDuration(v.contentDetails.duration),
        views: Number(v.statistics.viewCount || 0),
        likes: v.statistics.likeCount != null ? Number(v.statistics.likeCount) : null,
        live: v.snippet.liveBroadcastContent,
        hashtags: extractHashtags(`${v.snippet.title}\n${v.snippet.description || ""}`),
        tags: v.snippet.tags || [],
      });
    }
  }
  return out;
}

// Unique hashtags in the text, lowercased. Tags with no letters (e.g. "#1") aren't hashtags on YouTube.
function extractHashtags(text) {
  const found = (text.match(/#[\p{L}\p{N}_]+/gu) || []).filter((t) => /\p{L}/u.test(t));
  return [...new Set(found.map((t) => t.toLowerCase()))];
}

function parseDuration(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  if (!m) return 0;
  const [, d, h, mi, s] = m.map((x) => Number(x || 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

function formatDuration(sec) {
  if (!sec) return "–";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ---------- UI ----------

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}

function readDays(id) {
  return Math.min(365, Math.max(1, Number($(id).value) || 30));
}

// Checks that an API key is saved; if not, reports through the given status setter and opens Settings.
function requireApiKey(report) {
  if (apiKey) return true;
  report("Add your YouTube Data API key in Settings (top right) first.", true);
  openSettings("Enter your API key to load videos.", true);
  return false;
}

async function load(e) {
  e.preventDefault();
  const channelInput = $("channel").value.trim();
  const days = readDays("days");
  if (!requireApiKey(setStatus) || !channelInput) return;

  $("submit").disabled = true;
  try {
    setStatus("Looking up channel…");
    const channel = await resolveChannel(channelInput);
    const period = periodFor(days);

    setStatus("Fetching uploads…");
    allVideos = await fetchChannelVideos(channel, period);
    renderChart.period = period;

    loadedDays = days;
    renderChannel(channel, days);
    $("results").hidden = false;
    applyFilter();
    if (!allVideos.length) setStatus(`This channel didn't upload any public videos in ${periodText(days)}.`);
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
  } finally {
    $("submit").disabled = false;
  }
}

// Length limit in minutes from a form field; blank, zero or invalid means no limit.
function lengthLimitMinutes(id) {
  const n = Number($(id).value);
  return $(id).value.trim() !== "" && Number.isFinite(n) && n > 0 ? n : 0;
}

// Describes the active length limits, e.g. " between 1 and 10 min long".
function lengthText(minMin, maxMin) {
  if (minMin && minMin === maxMin) return ` exactly ${fmt.format(minMin)} min long`;
  if (minMin && maxMin) return ` between ${fmt.format(minMin)} and ${fmt.format(maxMin)} min long`;
  if (minMin) return ` at least ${fmt.format(minMin)} min long`;
  if (maxMin) return ` at most ${fmt.format(maxMin)} min long`;
  return "";
}

// Live and upcoming videos have no length yet, so they only pass when neither limit is set.
function filterByLength(list, minMin, maxMin) {
  if (!minMin && !maxMin) return list;
  return list.filter((v) => v.duration >= minMin * 60 && (!maxMin || (v.duration > 0 && v.duration <= maxMin * 60)));
}

// Reads a min/max pair of length fields, flagging the max field when the range is impossible.
function readLengthRange(minId, maxId) {
  const minMin = lengthLimitMinutes(minId);
  const maxMin = lengthLimitMinutes(maxId);
  const conflict = Boolean(minMin && maxMin && minMin > maxMin);
  $(maxId).setCustomValidity(conflict ? "Max length must be at least the min length." : "");
  return { minMin, maxMin, conflict };
}

function applyFilter() {
  const { minMin, maxMin, conflict } = readLengthRange("min-length", "max-length");
  videos = filterByLength(allVideos, minMin, maxMin);
  if (allVideos.length) {
    const all = allVideos.length;
    if (conflict) {
      setStatus(`Min length (${fmt.format(minMin)} min) is more than max length (${fmt.format(maxMin)} min), so no videos match.`, true);
    } else {
      setStatus(`Showing ${fmt.format(videos.length)} of ${fmt.format(all)} video${all === 1 ? "" : "s"} from ${periodText(loadedDays)}${lengthText(minMin, maxMin)}.`);
    }
  }
  $("chart-empty").textContent = conflict
    ? "Min length is more than max length."
    : `No videos are${lengthText(minMin, maxMin)}.`;
  renderChart();
  renderHashtags();
  renderTable();
}

function renderChannel(ch, days) {
  $("ch-thumb").src = ch.snippet.thumbnails?.default?.url || "";
  $("ch-title").textContent = ch.snippet.title;
  const subs = ch.statistics.hiddenSubscriberCount ? "hidden" : fmtCompact.format(Number(ch.statistics.subscriberCount || 0));
  $("ch-meta").textContent = `${subs} subscribers · ${fmt.format(Number(ch.statistics.videoCount || 0))} videos total · showing ${periodText(days)}`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

Chart.defaults.font.family = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const DAY = 86400_000;
// Width of the trend's averaging window, shared by both tabs: wider for long periods so the line stays readable.
const trendDays = (periodDays) => (periodDays > 100 ? 5 : 2);
const TREND_STEP = DAY / 4; // spacing of the points that draw a trend curve

// Time-weighted average of views around t: uploads within about windowDays count most, falling off
// as a Gaussian. Unlike a "last N videos" average, it doesn't jump when videos land close together.
function smoothedViews(sorted, t, windowDays) {
  const h = (windowDays / 2) * DAY;
  let sum = 0, weight = 0;
  for (const v of sorted) {
    const w = Math.exp(-0.5 * ((t - v.publishedAt) / h) ** 2);
    sum += w * v.views;
    weight += w;
  }
  return weight > 1e-9 ? sum / weight : null;
}

// Smooth trend curve for videos sorted by publish time, spanning the first to the last upload.
function trendSeries(sorted, windowDays) {
  const trendAt = (t) => smoothedViews(sorted, t, windowDays);
  const start = sorted[0]?.publishedAt.getTime();
  const end = sorted[sorted.length - 1]?.publishedAt.getTime();
  const series = [];
  if (sorted.length) {
    for (let t = start; t < end; t += TREND_STEP) series.push({ x: t, y: trendAt(t) });
    series.push({ x: end, y: trendAt(end) });
  }
  return { trendAt, start, end, series };
}

// Draws a vertical guide at the hovered video and the dashed overall-average line with its label.
const referencePlugin = {
  id: "reference",
  beforeDatasetsDraw(c, _args, opts) {
    const { ctx, chartArea: area, scales } = c;
    const active = c.getActiveElements().find((el) => el.datasetIndex === 0);
    if (active) {
      ctx.save();
      ctx.strokeStyle = opts.guide;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(active.element.x, area.top);
      ctx.lineTo(active.element.x, area.bottom);
      ctx.stroke();
      ctx.restore();
    }
    if (opts.average == null) return;
    const y = scales.y.getPixelForValue(opts.average);
    ctx.save();
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(area.left, y);
    ctx.lineTo(area.right, y);
    ctx.stroke();
    ctx.restore();
  },
  afterDatasetsDraw(c, _args, opts) {
    const { ctx, chartArea: area, scales } = c;
    if (opts.average == null) return;
    // Label sits above the marks so a stem at the right edge can't cover it.
    const y = scales.y.getPixelForValue(opts.average);
    ctx.save();
    const label = `Avg ${fmtCompact.format(opts.average)}`;
    ctx.font = "600 12px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
    const w = ctx.measureText(label).width + 12;
    ctx.fillStyle = opts.surface;
    ctx.beginPath();
    ctx.roundRect(area.right - w, y - 21, w, 18, 4);
    ctx.fill();
    ctx.fillStyle = opts.color;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(label, area.right - 6, y - 12);
    ctx.restore();
  },
};

function renderChart() {
  const { start, end } = renderChart.period;
  const series = cssVar("--series");
  const trendColor = cssVar("--trend");
  const surface = cssVar("--surface");
  const grid = cssVar("--grid");
  const text2 = cssVar("--text-2");
  const muted = cssVar("--muted");
  const sorted = [...videos].sort((a, b) => a.publishedAt - b.publishedAt);
  const average = sorted.length ? sorted.reduce((a, v) => a + v.views, 0) / sorted.length : null;
  const windowDays = trendDays(loadedDays);
  const { trendAt, series: trendPts } = trendSeries(sorted, windowDays);
  $("legend-trend-days").textContent = windowDays;
  const showTrend = sorted.length >= 2;

  const pts = sorted.map((v) => ({ x: v.publishedAt, y: v.views, v, trend: trendAt(v.publishedAt.getTime()) }));
  const datasets = [
    { // dots (the hover target)
      type: "line", data: pts, showLine: false, order: 0,
      pointRadius: 5, pointHoverRadius: 7, pointBorderWidth: 2, pointHoverBorderWidth: 2,
      pointBackgroundColor: series, pointBorderColor: surface, pointHoverBorderColor: surface,
    },
    { // trend line
      type: "line", order: 1, hidden: !showTrend,
      data: trendPts,
      borderColor: trendColor, borderWidth: 2.5, cubicInterpolationMode: "monotone",
      pointRadius: 0, pointHoverRadius: 0, pointHitRadius: 0,
    },
    { // stems from the baseline, tinted so the dots and lines stay in front
      type: "bar", data: pts, order: 2, backgroundColor: series + "66", barThickness: 2,
      borderRadius: 0, grouped: false,
    },
  ];

  $("legend-avg").textContent = average == null ? "–" : fmtCompact.format(average);
  $("legend-trend").hidden = !showTrend;
  $("chart-empty").hidden = sorted.length > 0;
  $("chart-tip").hidden = true;

  if (chart) chart.destroy();
  chart = new Chart($("chart"), {
    type: "line",
    data: { datasets },
    plugins: [referencePlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 8, right: 4 } },
      interaction: { mode: "nearest", axis: "x", intersect: false },
      onHover: (e, els) => {
        e.native.target.style.cursor = els.some((el) => el.datasetIndex === 0) ? "pointer" : "default";
      },
      onClick: (_e, els) => {
        const el = els.find((x) => x.datasetIndex === 0);
        const v = el && pts[el.index].v;
        if (v) window.open(`https://www.youtube.com/watch?v=${v.id}`, "_blank", "noopener");
      },
      scales: {
        x: {
          type: "time",
          offset: false,
          min: start, max: end,
          time: { unit: "day", displayFormats: { day: "MMM d" } },
          grid: { display: false },
          border: { color: grid },
          ticks: { color: muted, maxRotation: 0, autoSkipPadding: 20, font: { size: 12 } },
        },
        y: {
          beginAtZero: true,
          grace: "8%",
          grid: { color: grid, drawTicks: false },
          border: { display: false },
          ticks: { color: muted, padding: 8, maxTicksLimit: 6, callback: (n) => fmtCompact.format(n), font: { size: 12 } },
        },
      },
      plugins: {
        legend: { display: false },
        reference: { average, color: text2, surface, guide: grid },
        tooltip: {
          enabled: false,
          filter: (item) => item.datasetIndex === 0,
          external: ({ chart: c, tooltip }) => showTooltip(c, tooltip, pts, average),
        },
      },
    },
  });
}

// "▲ +12%", "▼ -8%", or "±0%" when it rounds to zero.
function formatVsAvg(ratio) {
  const pct = Math.round(ratio * 100);
  return pct === 0 ? "±0%" : `${pct > 0 ? "▲ +" : "▼ "}${pct}%`;
}

function showTooltip(c, tooltip, pts, average) {
  const tip = $("chart-tip");
  const item = tooltip.dataPoints?.[0];
  if (!tooltip.opacity || !item) { tip.hidden = true; return; }
  const { v, trend } = pts[item.dataIndex];
  const vsAvg = average ? (v.views - average) / average : 0;
  const pct = formatVsAvg(vsAvg);

  const img = document.createElement("img");
  img.src = v.thumb || "";
  img.alt = "";
  const title = document.createElement("div");
  title.className = "tt-title";
  title.textContent = v.title;
  const meta = document.createElement("div");
  meta.className = "tt-meta";
  meta.textContent = `${fmtDateTime.format(v.publishedAt)} · ${formatDuration(v.duration)}`;
  const dl = document.createElement("dl");
  const row = (k, val, cls) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = val;
    if (cls) dd.className = cls;
    dl.append(dt, dd);
  };
  row("Views", fmt.format(v.views), "big");
  row("vs. average", pct);
  if (pts.length >= 2) row("Trend at this point", fmtCompact.format(trend));
  tip.replaceChildren(img, title, meta, dl);
  tip.hidden = false;

  // Keep the card inside the chart box, flipping to the left of the point near the right edge.
  const box = c.canvas.parentNode.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = tooltip.caretX + 14;
  if (left + w > box.width) left = tooltip.caretX - w - 14;
  const top = Math.min(Math.max(0, tooltip.caretY - h / 2), box.height - h);
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, top)}px`;
}

const HASHTAG_LIMIT = 10;

function hashtagLink(tag) {
  const a = document.createElement("a");
  a.href = `https://www.youtube.com/hashtag/${encodeURIComponent(tag.slice(1))}`;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = tag;
  return a;
}

// Hashtags of the most-viewed video, plus every hashtag ranked by the total views of the videos using it.
function renderHashtags() {
  const stats = new Map();
  for (const v of videos) {
    for (const tag of v.hashtags) {
      const s = stats.get(tag) || { tag, views: 0, count: 0 };
      s.views += v.views;
      s.count += 1;
      stats.set(tag, s);
    }
  }
  const ranked = [...stats.values()].sort((a, b) => b.views - a.views || b.count - a.count);
  const top = videos.reduce((a, v) => (!a || v.views > a.views ? v : a), null);
  const topTags = new Set(top ? top.hashtags : []);

  // Most-viewed video and its hashtags.
  const topBox = $("ht-top");
  if (!top) {
    topBox.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: "No videos to show." }));
  } else {
    const head = document.createElement("a");
    head.className = "ht-video";
    head.href = `https://www.youtube.com/watch?v=${top.id}`;
    head.target = "_blank";
    head.rel = "noopener";
    const img = Object.assign(document.createElement("img"), { src: top.thumb || "", alt: "" });
    const info = document.createElement("div");
    const title = Object.assign(document.createElement("div"), { className: "ht-title", textContent: top.title });
    const meta = Object.assign(document.createElement("div"), { className: "muted", textContent: `${fmt.format(top.views)} views · ${fmtDate.format(top.publishedAt)}` });
    info.append(title, meta);
    head.append(img, info);

    const chips = document.createElement("div");
    chips.className = "chips";
    if (top.hashtags.length) {
      for (const tag of top.hashtags) {
        const s = stats.get(tag);
        const chip = document.createElement("span");
        chip.className = "chip";
        const n = Object.assign(document.createElement("span"), { className: "chip-n", textContent: `${s.count} video${s.count === 1 ? "" : "s"}` });
        chip.append(hashtagLink(tag), n);
        chips.append(chip);
      }
    } else {
      const none = Object.assign(document.createElement("p"), { className: "muted ht-none", textContent: "This video has no hashtags in its title or description." });
      chips.append(none);
      if (top.tags.length) {
        const kw = Object.assign(document.createElement("p"), { className: "ht-none" });
        kw.append(Object.assign(document.createElement("span"), { className: "muted", textContent: "Its keyword tags: " }), top.tags.slice(0, 15).join(", "));
        chips.append(kw);
      }
    }
    topBox.replaceChildren(head, chips);
  }

  // Ranked list across all shown videos.
  const list = $("ht-rank");
  const shown = ranked.slice(0, HASHTAG_LIMIT);
  $("ht-rank-empty").hidden = shown.length > 0;
  const max = shown[0]?.views || 1;
  list.replaceChildren(...shown.map((s) => {
    const li = document.createElement("li");
    if (topTags.has(s.tag)) li.className = "in-top";
    const name = document.createElement("div");
    name.className = "ht-name";
    name.append(hashtagLink(s.tag));
    if (topTags.has(s.tag)) name.append(Object.assign(document.createElement("span"), { className: "badge", textContent: "Top video" }));
    const bar = document.createElement("div");
    bar.className = "ht-bar";
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(2, (s.views / max) * 100)}%`;
    bar.append(fill);
    const val = Object.assign(document.createElement("div"), { className: "ht-val", textContent: fmtCompact.format(s.views) });
    const cnt = Object.assign(document.createElement("div"), { className: "ht-cnt muted", textContent: `${s.count} video${s.count === 1 ? "" : "s"}` });
    li.title = `${s.tag}: ${fmt.format(s.views)} total views across ${s.count} video${s.count === 1 ? "" : "s"}`;
    li.append(name, bar, val, cnt);
    return li;
  }));
}

function renderTable() {
  const { key, dir } = sort;
  const rows = [...videos].sort((a, b) => {
    const x = a[key] ?? -1, y = b[key] ?? -1;
    const c = typeof x === "string" ? x.localeCompare(y) : x - y;
    return dir === "asc" ? c : -c;
  });
  const tbody = $("table").querySelector("tbody");
  tbody.replaceChildren(...rows.map((v) => {
    const tr = document.createElement("tr");
    const when = td(fmtDate.format(v.publishedAt), "when");
    const vid = document.createElement("td");
    const cell = document.createElement("div");
    cell.className = "vid";
    vid.append(cell);
    const img = document.createElement("img");
    img.src = v.thumb || "";
    img.alt = "";
    img.loading = "lazy";
    const a = document.createElement("a");
    a.href = `https://www.youtube.com/watch?v=${v.id}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = v.title;
    cell.append(img, a);
    tr.append(
      when, vid,
      td(v.live === "live" ? "Live" : v.live === "upcoming" ? "Upcoming" : formatDuration(v.duration), "num"),
      td(fmt.format(v.views), "num"),
      td(v.likes == null ? "hidden" : fmt.format(v.likes), "num"),
    );
    return tr;
  }));
  for (const th of $("table").querySelectorAll("th")) {
    th.classList.toggle("asc", th.dataset.sort === key && dir === "asc");
    th.classList.toggle("desc", th.dataset.sort === key && dir === "desc");
  }
}

function td(text, cls) {
  const el = document.createElement("td");
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

// ---------- wiring ----------

$("search-form").addEventListener("submit", load);

// Tabs: the selected one is kept in the URL hash so a reload stays on it.
function showTab(name) {
  for (const tab of document.querySelectorAll("[role=tab]")) {
    const on = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", on);
    tab.tabIndex = on ? 0 : -1;
    $(tab.getAttribute("aria-controls")).hidden = !on;
  }
  // Charts drawn while their panel was hidden need a resize once visible.
  for (const id of ["chart", "cmp-chart"]) Chart.getChart(id)?.resize();
}
document.querySelector(".tabs").addEventListener("click", (e) => {
  const name = e.target.closest("[role=tab]")?.dataset.tab;
  if (!name) return;
  history.replaceState(null, "", name === "channel" ? location.pathname + location.search : `#${name}`);
  showTab(name);
});
document.querySelector(".tabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const tabs = [...document.querySelectorAll("[role=tab]")];
  const i = tabs.indexOf(document.activeElement);
  const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
  next.focus();
  next.click();
});
showTab(location.hash === "#compare" ? "compare" : "channel");

// Changing the minimum length re-filters the loaded videos without calling the API again.
for (const id of ["min-length", "max-length"]) {
  $(id).addEventListener("input", () => { if (allVideos.length) applyFilter(); });
}

$("table").querySelector("thead").addEventListener("click", (e) => {
  const k = e.target.closest("th")?.dataset.sort;
  if (!k) return;
  sort = { key: k, dir: sort.key === k && sort.dir === "desc" ? "asc" : "desc" };
  renderTable();
});

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (chart) renderChart(); });

// ---------- settings dialog ----------

function setSettingsMsg(msg, isError = false) {
  $("settings-msg").textContent = msg;
  $("settings-msg").classList.toggle("error", isError);
}

// The Settings button shows "No API key" until one is saved.
function updateKeyState() {
  $("key-state").hidden = Boolean(apiKey);
  $("settings-btn").setAttribute("aria-label", apiKey ? "Settings" : "Settings: no API key set");
}

function openSettings(msg = "", isError = false) {
  $("api-key").value = apiKey;
  setKeyVisible(false);
  setSettingsMsg(msg, isError);
  $("settings").showModal();
  $("api-key").focus();
}

function setKeyVisible(show) {
  $("api-key").type = show ? "text" : "password";
  $("key-toggle").textContent = show ? "Hide" : "Show";
  $("key-toggle").setAttribute("aria-pressed", String(show));
}

$("settings-btn").addEventListener("click", () => openSettings());
$("settings-close").addEventListener("click", () => $("settings").close());
// A click on the backdrop lands on the dialog element itself.
$("settings").addEventListener("click", (e) => { if (e.target === $("settings")) $("settings").close(); });
$("key-toggle").addEventListener("click", () => setKeyVisible($("api-key").type === "password"));
$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = $("api-key").value.trim();
  if (!key) {
    setSettingsMsg("Enter a key, or use Clear key to remove the saved one.", true);
    return;
  }
  apiKey = key;
  try { localStorage.setItem(KEY_STORAGE, key); } catch {}
  updateKeyState();
  $("settings").close();
});
$("key-clear").addEventListener("click", () => {
  apiKey = "";
  $("api-key").value = "";
  try { localStorage.removeItem(KEY_STORAGE); } catch {}
  updateKeyState();
  setSettingsMsg("API key removed.");
});

try { apiKey = localStorage.getItem(KEY_STORAGE) || ""; } catch {}
updateKeyState();

const params = new URLSearchParams(location.search);
if (params.get("channel")) $("channel").value = params.get("channel");
