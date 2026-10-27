// "Compare channels" tab: up to CMP_MAX channels on one chart, each with a trend line and an average line.
// Reuses the API, filter and formatting helpers from app.js.

const CMP_MAX = 5;
const AVG_DASH = [5, 4];
// Colour alone can't separate five series, so every line is also labelled with its channel at the right edge.
const LABEL_FONT = "12px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const LABEL_FONT_BOLD = `600 ${LABEL_FONT}`;
const LABEL_GAP = 16; // min vertical px between labels

let cmpChannels = []; // { input, channel, all, videos, slot, hidden }
let cmpFailures = [];
let cmpDays = 0;
let cmpPeriod = null;
let cmpChart = null;

const cmpColor = (slot) => cssVar(`--c${slot + 1}`);

function setCmpStatus(msg, isError = false) {
  $("cmp-status").textContent = msg;
  $("cmp-status").classList.toggle("error", isError);
}

// ---------- channel input rows ----------

function addChannelRow(value = "") {
  const list = $("cmp-list");
  if (list.children.length >= CMP_MAX) return;
  const li = document.createElement("li");
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "cmp-input";
  input.placeholder = "@handle, channel URL or UC…";
  input.value = value;
  input.setAttribute("aria-label", "Channel");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-btn";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "Remove channel");
  remove.addEventListener("click", () => {
    li.remove();
    syncChannelRows();
  });
  li.append(swatch, input, remove);
  list.append(li);
  syncChannelRows();
  return input;
}

// Numbers rows, colours their swatches by position and enforces the 1–CMP_MAX row limits.
function syncChannelRows() {
  const rows = [...$("cmp-list").children];
  rows.forEach((li, i) => {
    li.querySelector(".swatch").replaceChildren(lineIcon(i));
    li.querySelector(".cmp-input").setAttribute("aria-label", `Channel ${i + 1}`);
    li.querySelector(".icon-btn").disabled = rows.length === 1;
  });
  $("cmp-add").disabled = rows.length >= CMP_MAX;
  $("cmp-add").textContent = rows.length >= CMP_MAX ? `Maximum ${CMP_MAX} channels` : "+ Add channel";
}

// Short SVG sample of a channel's line in its colour (dashed for the average line), for legends and rows.
function lineIcon(slot, dashed = false) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 20 6");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "6");
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS(ns, "line");
  line.setAttribute("x1", "0");
  line.setAttribute("y1", "3");
  line.setAttribute("x2", "20");
  line.setAttribute("y2", "3");
  line.setAttribute("stroke", `var(--c${slot + 1})`);
  line.setAttribute("stroke-width", dashed ? "2" : "3");
  line.setAttribute("stroke-linecap", dashed ? "butt" : "round");
  if (dashed) line.setAttribute("stroke-dasharray", AVG_DASH.join(" "));
  svg.append(line);
  return svg;
}

// ---------- loading ----------

async function loadComparison(e) {
  e.preventDefault();
  if (!requireApiKey(setCmpStatus)) return;
  const inputs = [...document.querySelectorAll(".cmp-input")].map((i) => i.value.trim()).filter(Boolean);
  if (!inputs.length) {
    setCmpStatus("Enter at least one channel to compare.", true);
    return;
  }
  const days = readDays("cmp-days");
  const period = periodFor(days);

  $("cmp-submit").disabled = true;
  setCmpStatus(`Loading ${inputs.length} channel${inputs.length === 1 ? "" : "s"}…`);
  try {
    const results = await Promise.allSettled(inputs.map(async (input) => {
      const channel = await resolveChannel(input);
      return { input, channel, all: await fetchChannelVideos(channel, period) };
    }));

    const seen = new Set();
    cmpChannels = [];
    cmpFailures = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        cmpFailures.push(`"${inputs[i]}": ${r.reason?.message || r.reason}`);
      } else if (seen.has(r.value.channel.id)) {
        cmpFailures.push(`"${inputs[i]}": same channel as an earlier entry`);
      } else {
        seen.add(r.value.channel.id);
        cmpChannels.push({ ...r.value, videos: [], slot: i, hidden: false });
      }
    });
    cmpDays = days;
    cmpPeriod = period;

    if (!cmpChannels.length) {
      $("cmp-results").hidden = true;
      setCmpStatus(`Couldn't load any channels. ${cmpFailures.join(" · ")}`, true);
      return;
    }
    $("cmp-results").hidden = false;
    applyCmpFilter();
  } finally {
    $("cmp-submit").disabled = false;
  }
}

function applyCmpFilter() {
  const { minMin, maxMin, conflict } = readLengthRange("cmp-min-length", "cmp-max-length");
  for (const c of cmpChannels) c.videos = filterByLength(c.all, minMin, maxMin);

  const shown = cmpChannels.reduce((a, c) => a + c.videos.length, 0);
  const n = cmpChannels.length;
  const failed = cmpFailures.length ? ` Couldn't load ${cmpFailures.join(" · ")}` : "";
  if (conflict) {
    setCmpStatus(`Min length (${fmt.format(minMin)} min) is more than max length (${fmt.format(maxMin)} min), so no videos match.${failed}`, true);
  } else {
    setCmpStatus(`Showing ${fmt.format(shown)} video${shown === 1 ? "" : "s"} across ${n} channel${n === 1 ? "" : "s"} from ${periodText(cmpDays)}${lengthText(minMin, maxMin)}.${failed}`, Boolean(failed));
  }
  $("cmp-empty").textContent = conflict ? "Min length is more than max length." : `No videos are${lengthText(minMin, maxMin)}.`;

  renderCmpLegend();
  renderCmpChart();
  renderCmpTable();
}

// ---------- chart ----------

function channelStats(c) {
  const total = c.videos.reduce((a, v) => a + v.views, 0);
  const sorted = [...c.videos].sort((a, b) => a.publishedAt - b.publishedAt);
  const top = c.videos.reduce((a, v) => (!a || v.views > a.views ? v : a), null);
  const { trendAt, start, end, series } = trendSeries(sorted, trendDays(cmpDays));
  return {
    total, avg: c.videos.length ? total / c.videos.length : 0, sorted, top,
    trendAt, start, end, series, last: series.length ? series[series.length - 1].y : null,
  };
}

function renderCmpLegend() {
  $("cmp-legend").replaceChildren(...cmpChannels.map((c) => {
    const { avg } = channelStats(c);
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "legend-btn";
    btn.setAttribute("aria-pressed", String(!c.hidden));
    btn.title = c.hidden ? "Show this channel" : "Hide this channel";
    const name = Object.assign(document.createElement("strong"), { textContent: c.channel.snippet.title });
    const meta = Object.assign(document.createElement("span"), {
      className: "muted",
      textContent: `${c.videos.length} video${c.videos.length === 1 ? "" : "s"} · avg ${fmtCompact.format(avg)}`,
    });
    btn.append(lineIcon(c.slot), name, meta);
    btn.addEventListener("click", () => {
      c.hidden = !c.hidden;
      renderCmpLegend();
      renderCmpChart();
    });
    li.append(btn);
    return li;
  }));
}

const truncate = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// Draws each channel's dashed average line and the right-edge labels, and runs the hover date cursor.
const cmpLinesPlugin = {
  id: "cmpLines",
  beforeDatasetsDraw(ch, _args, { items }) {
    const { ctx, chartArea: area, scales } = ch;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.setLineDash(AVG_DASH);
    for (const it of items) {
      if (!(it.avg > 0)) continue;
      const y = scales.y.getPixelForValue(it.avg);
      if (y < area.top || y > area.bottom) continue;
      ctx.strokeStyle = it.color;
      ctx.beginPath();
      ctx.moveTo(area.left, y);
      ctx.lineTo(area.right, y);
      ctx.stroke();
    }
    ctx.restore();

    // Date cursor behind the lines.
    if (ch.$hoverT != null) {
      const x = scales.x.getPixelForValue(ch.$hoverT);
      ctx.save();
      ctx.strokeStyle = cssVar("--text-2");
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.stroke();
      ctx.restore();
    }
  },
  afterDatasetsDraw(ch, _args, { items, text, text2, surface }) {
    const { ctx, chartArea: area, scales } = ch;

    // Markers where the cursor crosses each line.
    if (ch.$hoverT != null) {
      const x = scales.x.getPixelForValue(ch.$hoverT);
      for (const it of items) {
        if (ch.$hoverT < it.start || ch.$hoverT > it.end) continue;
        const val = it.trendAt(ch.$hoverT);
        if (!(val > 0)) continue;
        ctx.save();
        ctx.fillStyle = it.color;
        ctx.strokeStyle = surface;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, scales.y.getPixelForValue(val), 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    const labels = [];
    for (const it of items) {
      if (it.last > 0) labels.push({ y: scales.y.getPixelForValue(it.last), text: it.name, color: it.color, avg: false });
      if (it.avg > 0) labels.push({ y: scales.y.getPixelForValue(it.avg), text: `Avg ${fmtCompact.format(it.avg)}`, color: it.color, avg: true });
    }
    // Spread labels so none overlap, keeping them inside the plot's height.
    labels.sort((a, b) => a.y - b.y);
    labels.forEach((l, i) => { l.y = Math.max(l.y, area.top + 6, i ? labels[i - 1].y + LABEL_GAP : -Infinity); });
    for (let i = labels.length - 1; i >= 0; i--) {
      labels[i].y = Math.min(labels[i].y, area.bottom - 6, i < labels.length - 1 ? labels[i + 1].y - LABEL_GAP : Infinity);
    }
    const x = area.right + 10;
    ctx.save();
    ctx.textBaseline = "middle";
    for (const l of labels) {
      ctx.strokeStyle = l.color;
      ctx.lineWidth = l.avg ? 2 : 3;
      ctx.lineCap = l.avg ? "butt" : "round";
      ctx.setLineDash(l.avg ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(x, l.y);
      ctx.lineTo(x + 14, l.y);
      ctx.stroke();
      ctx.font = l.avg ? LABEL_FONT : LABEL_FONT_BOLD;
      ctx.fillStyle = l.avg ? text2 : text;
      ctx.fillText(l.text, x + 20, l.y);
    }
    ctx.restore();
  },
  afterEvent(ch, args, { items }) {
    const e = args.event;
    const area = ch.chartArea;
    let t = null;
    if (e.type === "mousemove" && e.x >= area.left && e.x <= area.right && e.y >= area.top && e.y <= area.bottom) {
      t = ch.scales.x.getValueForPixel(e.x);
    }
    if (t === ch.$hoverT) return;
    ch.$hoverT = t;
    args.changed = true;
    showCmpTooltip(ch, items, t, e.x, e.y);
  },
};

function renderCmpChart() {
  $("cmp-trend-days").textContent = trendDays(cmpDays);
  const grid = cssVar("--grid");
  const muted = cssVar("--muted");
  const log = $("cmp-log").checked;

  const datasets = [];
  const items = []; // per visible channel: what the labels and hover cursor need
  for (const c of cmpChannels) {
    const { series, avg, trendAt, start, end, last } = channelStats(c);
    const color = cmpColor(c.slot);
    datasets.push({
      label: c.channel.snippet.title,
      type: "line", hidden: c.hidden, data: series,
      borderColor: color, borderWidth: 2.5, cubicInterpolationMode: "monotone",
      pointRadius: series.length < 2 ? 3 : 0, pointHoverRadius: 0, pointBackgroundColor: color,
    });
    if (!c.hidden && series.length) {
      items.push({ c, name: truncate(c.channel.snippet.title, 22), color, avg, last, trendAt, start, end });
    }
  }

  // Reserve a right-hand gutter wide enough for the longest label.
  const measure = document.createElement("canvas").getContext("2d");
  const widths = items.flatMap((it) => {
    measure.font = LABEL_FONT_BOLD;
    const name = measure.measureText(it.name).width;
    measure.font = LABEL_FONT;
    return [name, measure.measureText(`Avg ${fmtCompact.format(it.avg)}`).width];
  });
  const gutter = items.length ? Math.ceil(Math.max(...widths)) + 34 : 4;

  $("cmp-empty").hidden = items.length > 0 || !cmpChannels.length;
  if (cmpChannels.length && cmpChannels.every((c) => c.hidden)) {
    $("cmp-empty").textContent = "All channels are hidden. Click one in the legend to show it.";
  }
  $("cmp-tip").hidden = true;

  if (cmpChart) cmpChart.destroy();
  cmpChart = new Chart($("cmp-chart"), {
    type: "line",
    data: { datasets },
    plugins: [cmpLinesPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      events: ["mousemove", "mouseout"],
      layout: { padding: { top: 8, right: gutter } },
      scales: {
        x: {
          type: "time",
          offset: false,
          min: cmpPeriod.start, max: cmpPeriod.end,
          time: { unit: "day", displayFormats: { day: "MMM d" } },
          grid: { display: false },
          border: { color: grid },
          ticks: { color: muted, maxRotation: 0, autoSkipPadding: 20 },
        },
        y: {
          type: log ? "logarithmic" : "linear",
          beginAtZero: !log,
          grace: log ? 0 : "8%",
          grid: { color: grid, drawTicks: false },
          border: { display: false },
          // A log axis would otherwise put a gridline at every 2, 3, 4… step; keep 1, 2 and 5 of each power of ten.
          afterBuildTicks: (axis) => {
            if (log) axis.ticks = axis.ticks.filter((t) => [1, 2, 5].includes(Number(t.value.toExponential()[0])));
          },
          ticks: { color: muted, padding: 8, maxTicksLimit: log ? 12 : 6, callback: (n) => fmtCompact.format(n) },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        cmpLines: { items, text: cssVar("--text"), text2: cssVar("--text-2"), surface: cssVar("--surface") },
      },
    },
  });
}

// Card listing every visible channel's trend on the hovered date, highest first.
function showCmpTooltip(ch, items, t, px, py) {
  const tip = $("cmp-tip");
  const rows = t == null ? [] : items
    .filter((it) => t >= it.start && t <= it.end)
    .map((it) => ({ it, val: it.trendAt(t) }))
    .filter((r) => r.val > 0)
    .sort((a, b) => b.val - a.val);
  if (!rows.length) { tip.hidden = true; return; }

  const head = Object.assign(document.createElement("div"), { className: "tt-date", textContent: fmtDate.format(new Date(t)) });
  const list = document.createElement("div");
  list.className = "tt-rows";
  for (const { it, val } of rows) {
    const name = document.createElement("span");
    name.className = "tt-name";
    name.append(lineIcon(it.c.slot), Object.assign(document.createElement("span"), { textContent: it.c.channel.snippet.title }));
    list.append(
      name,
      Object.assign(document.createElement("span"), { className: "tt-val", textContent: fmtCompact.format(val) }),
      Object.assign(document.createElement("span"), { className: "tt-vs", textContent: formatVsAvg(it.avg ? (val - it.avg) / it.avg : 0) }),
    );
  }
  const foot = Object.assign(document.createElement("div"), { className: "tt-meta", textContent: `${trendDays(cmpDays)}-day average views per video · vs. channel average` });
  tip.replaceChildren(head, list, foot);
  tip.hidden = false;

  const box = ch.canvas.parentNode.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = px + 16;
  if (left + w > box.width) left = px - w - 16;
  const top = Math.min(Math.max(0, py - h / 2), box.height - h);
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, top)}px`;
}

// ---------- summary table ----------

function renderCmpTable() {
  const tbody = $("cmp-table").querySelector("tbody");
  tbody.replaceChildren(...cmpChannels.map((c) => {
    const { total, avg, last, top } = channelStats(c);
    const subs = c.channel.statistics.hiddenSubscriberCount ? "hidden" : fmtCompact.format(Number(c.channel.statistics.subscriberCount || 0));
    const tr = document.createElement("tr");
    if (c.hidden) tr.className = "dim";

    const name = document.createElement("td");
    const cell = document.createElement("div");
    cell.className = "cmp-name";
    const link = Object.assign(document.createElement("a"), {
      href: `https://www.youtube.com/channel/${c.channel.id}`, target: "_blank", rel: "noopener",
      textContent: c.channel.snippet.title,
    });
    cell.append(lineIcon(c.slot), link);
    name.append(cell);

    const topCell = document.createElement("td");
    topCell.className = "cmp-top";
    if (top) {
      topCell.append(Object.assign(document.createElement("a"), {
        href: `https://www.youtube.com/watch?v=${top.id}`, target: "_blank", rel: "noopener", textContent: top.title, title: top.title,
      }), Object.assign(document.createElement("span"), { className: "muted", textContent: ` ${fmtCompact.format(top.views)}` }));
    } else {
      topCell.textContent = "–";
    }

    tr.append(
      name,
      td(subs, "num"),
      td(fmt.format(c.videos.length), "num"),
      td(fmt.format(total), "num"),
      td(c.videos.length ? fmt.format(Math.round(avg)) : "–", "num"),
      td(last != null ? fmtCompact.format(last) : "–", "num"),
      topCell,
    );
    return tr;
  }));
}

// ---------- wiring ----------

$("cmp-form").addEventListener("submit", loadComparison);
$("cmp-add").addEventListener("click", () => addChannelRow()?.focus());
for (const id of ["cmp-min-length", "cmp-max-length"]) {
  $(id).addEventListener("input", () => { if (cmpChannels.length) applyCmpFilter(); });
}
$("cmp-log").addEventListener("change", () => { if (cmpChannels.length) renderCmpChart(); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (cmpChart) renderCmpChart(); });

// Start with two empty rows, or the channels given as ?compare=@a,@b in the URL.
const preset = (new URLSearchParams(location.search).get("compare") || "").split(",").map((s) => s.trim()).filter(Boolean);
(preset.length ? preset.slice(0, CMP_MAX) : ["", ""]).forEach((v) => addChannelRow(v));
