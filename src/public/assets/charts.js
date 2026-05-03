// SPDX-License-Identifier: Apache-2.0
//
// Minimal SVG chart kit. No dependencies — every chart returns an SVG
// element that's already styled by style.css. Each chart has a small
// hover affordance (highlight + tooltip) where it adds clarity.

import { formatDuration } from "./util.js";

const SVG = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    el.setAttribute(k, String(v));
  }
  return el;
}

let tooltipEl = null;
function getTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.className = "tooltip";
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}
function showTooltip(html, x, y) {
  const t = getTooltip();
  t.innerHTML = html;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
  t.classList.add("is-visible");
}
function hideTooltip() {
  const t = tooltipEl;
  if (t) t.classList.remove("is-visible");
}

// — Area + line chart —
// data: [{ x: Date, y: number }]
export function lineChart({ data, height = 220, yLabel = "" }) {
  const wrap = document.createElement("div");
  wrap.style.width = "100%";
  if (data.length === 0) {
    wrap.innerHTML = `<div class="empty"><div class="empty__title">No samples in range</div></div>`;
    return wrap;
  }

  const W = 1000, H = height;
  const PAD_L = 36, PAD_R = 16, PAD_T = 18, PAD_B = 28;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const xs = data.map(d => d.x.getTime());
  const ys = data.map(d => d.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMax = Math.max(1, ...ys);
  const xScale = (x) => PAD_L + ((x - xMin) / Math.max(1, xMax - xMin)) * innerW;
  const yScale = (y) => PAD_T + innerH - (y / yMax) * innerH;

  const svg = s("svg", {
    class: "svg-chart",
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: "none",
  });

  // gradient
  const defs = s("defs");
  const grad = s("linearGradient", { id: "cyan-gradient", x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.appendChild(s("stop", { offset: "0%", "stop-color": "#22d3ee", "stop-opacity": 0.55 }));
  grad.appendChild(s("stop", { offset: "100%", "stop-color": "#06b6d4", "stop-opacity": 0 }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  // grid
  const grid = s("g", { class: "grid" });
  for (let i = 0; i <= 4; i++) {
    const y = PAD_T + (innerH / 4) * i;
    grid.appendChild(s("line", { x1: PAD_L, y1: y, x2: W - PAD_R, y2: y }));
  }
  svg.appendChild(grid);

  // axis labels (y)
  const axis = s("g", { class: "axis" });
  for (let i = 0; i <= 4; i++) {
    const y = PAD_T + (innerH / 4) * i;
    const v = yMax - (yMax / 4) * i;
    const t = s("text", { x: 4, y: y + 3 });
    t.textContent = formatDuration(v, { compact: true });
    axis.appendChild(t);
  }
  // axis labels (x) — 5 evenly spaced ticks
  for (let i = 0; i < 5; i++) {
    const ts = xMin + ((xMax - xMin) / 4) * i;
    const x = PAD_L + (innerW / 4) * i;
    const date = new Date(ts);
    const label = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const t = s("text", { x, y: H - 8, "text-anchor": "middle" });
    t.textContent = label;
    axis.appendChild(t);
  }
  svg.appendChild(axis);

  // area path
  if (data.length >= 2) {
    let d = `M ${xScale(xs[0])} ${PAD_T + innerH} `;
    for (const pt of data) d += `L ${xScale(pt.x.getTime())} ${yScale(pt.y)} `;
    d += `L ${xScale(xs[xs.length - 1])} ${PAD_T + innerH} Z`;
    svg.appendChild(s("path", { class: "area", d }));

    let line = `M ${xScale(xs[0])} ${yScale(ys[0])} `;
    for (let i = 1; i < data.length; i++) line += `L ${xScale(xs[i])} ${yScale(ys[i])} `;
    svg.appendChild(s("path", { class: "line", d: line }));
  }

  // points + hover targets
  for (let i = 0; i < data.length; i++) {
    const cx = xScale(xs[i]);
    const cy = yScale(ys[i]);
    const target = s("rect", {
      x: cx - 18, y: PAD_T,
      width: 36, height: innerH,
      fill: "transparent", style: "cursor: crosshair;",
    });
    const point = s("circle", { class: "point", cx, cy, r: 0 });
    target.addEventListener("mouseenter", (ev) => {
      point.setAttribute("r", "3");
      const date = data[i].x;
      showTooltip(
        `<span class="lbl">${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span><strong>${formatDuration(data[i].y, { compact: true })}</strong>`,
        ev.clientX, ev.clientY,
      );
    });
    target.addEventListener("mousemove", (ev) => {
      const t = getTooltip();
      t.style.left = `${ev.clientX}px`;
      t.style.top = `${ev.clientY}px`;
    });
    target.addEventListener("mouseleave", () => {
      point.setAttribute("r", "0");
      hideTooltip();
    });
    svg.appendChild(point);
    svg.appendChild(target);
  }

  wrap.appendChild(svg);
  return wrap;
}

// — Donut / percentage ring —
// segments: [{ label, value, color }]
export function donutChart({ segments, size = 200, thickness = 22, label = "" }) {
  const total = segments.reduce((acc, s) => acc + s.value, 0);
  const wrap = document.createElement("div");
  wrap.className = "donut-wrap";

  const svg = s("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size });
  const r = (size - thickness) / 2;
  const cx = size / 2, cy = size / 2;
  // background ring
  svg.appendChild(s("circle", {
    cx, cy, r,
    fill: "none", stroke: "rgba(255,255,255,0.05)",
    "stroke-width": thickness,
  }));

  if (total > 0) {
    const circumference = 2 * Math.PI * r;
    let offset = 0;
    for (const seg of segments) {
      if (seg.value <= 0) continue;
      const len = (seg.value / total) * circumference;
      const arc = s("circle", {
        cx, cy, r,
        fill: "none",
        stroke: seg.color,
        "stroke-width": thickness,
        "stroke-dasharray": `${len} ${circumference - len}`,
        "stroke-dashoffset": -offset,
        transform: `rotate(-90 ${cx} ${cy})`,
        "stroke-linecap": "butt",
      });
      arc.style.transition = "stroke 200ms";
      arc.addEventListener("mouseenter", (ev) => {
        showTooltip(
          `<span class="lbl">${seg.label}</span><strong>${formatDuration(seg.value, { compact: true })}</strong> · ${((seg.value/total)*100).toFixed(1)}%`,
          ev.clientX, ev.clientY,
        );
      });
      arc.addEventListener("mousemove", (ev) => {
        const t = getTooltip();
        t.style.left = `${ev.clientX}px`;
        t.style.top = `${ev.clientY}px`;
      });
      arc.addEventListener("mouseleave", hideTooltip);
      svg.appendChild(arc);
      offset += len;
    }
  }

  // center label
  const center = document.createElement("div");
  center.className = "donut-center";
  center.innerHTML = `
    <div class="donut-center__val">${formatDuration(total, { compact: true })}</div>
    <div class="donut-center__lbl">${label}</div>
  `;

  const svgWrap = document.createElement("div");
  svgWrap.style.position = "relative";
  svgWrap.style.width = `${size}px`;
  svgWrap.style.height = `${size}px`;
  svgWrap.appendChild(svg);
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;";
  overlay.appendChild(center);
  svgWrap.appendChild(overlay);

  wrap.appendChild(svgWrap);

  // legend
  const legend = document.createElement("div");
  legend.style.cssText = "display:flex;flex-direction:column;gap:8px;min-width:0;";
  for (const seg of segments.slice().sort((a, b) => b.value - a.value)) {
    if (seg.value <= 0) continue;
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:14px 1fr auto auto;gap:10px;align-items:center;font-size:12px;padding:4px 0;border-bottom:1px solid var(--hairline);";
    const swatch = document.createElement("span");
    swatch.style.cssText = `width:10px;height:10px;border-radius:3px;background:${seg.color};box-shadow:inset 0 0 0 1px rgba(0,0,0,0.4);`;
    const name = document.createElement("span");
    name.textContent = seg.label;
    name.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-secondary);";
    const pct = document.createElement("span");
    pct.style.cssText = "font-variant-numeric:tabular-nums;color:var(--text-tertiary);font-size:11px;";
    pct.textContent = total > 0 ? `${((seg.value/total)*100).toFixed(1)}%` : "0%";
    const dur = document.createElement("span");
    dur.style.cssText = "font-variant-numeric:tabular-nums;color:var(--text-primary);font-size:12px;text-align:right;";
    dur.textContent = formatDuration(seg.value, { compact: true });
    row.append(swatch, name, pct, dur);
    legend.appendChild(row);
  }
  if (segments.length === 0 || total === 0) {
    legend.innerHTML = `<div class="empty"><div class="empty__title">No data</div></div>`;
  }
  wrap.appendChild(legend);

  return wrap;
}

// — Bar chart (vertical, daily totals) —
export function barChart({ data, height = 180 }) {
  const wrap = document.createElement("div");
  wrap.style.width = "100%";
  if (data.length === 0) {
    wrap.innerHTML = `<div class="empty"><div class="empty__title">No samples</div></div>`;
    return wrap;
  }
  const W = 1000, H = height;
  const PAD_L = 36, PAD_R = 16, PAD_T = 14, PAD_B = 24;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const yMax = Math.max(1, ...data.map(d => d.y));
  const barW = (innerW / data.length) * 0.62;
  const stride = innerW / data.length;

  const svg = s("svg", { class: "svg-chart", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });

  const grid = s("g", { class: "grid" });
  for (let i = 0; i <= 3; i++) {
    const y = PAD_T + (innerH / 3) * i;
    grid.appendChild(s("line", { x1: PAD_L, y1: y, x2: W - PAD_R, y2: y }));
  }
  svg.appendChild(grid);

  const axis = s("g", { class: "axis" });
  for (let i = 0; i <= 3; i++) {
    const y = PAD_T + (innerH / 3) * i;
    const v = yMax - (yMax / 3) * i;
    const t = s("text", { x: 4, y: y + 3 });
    t.textContent = formatDuration(v, { compact: true });
    axis.appendChild(t);
  }
  // x ticks every ~6
  const tickEvery = Math.max(1, Math.ceil(data.length / 6));
  for (let i = 0; i < data.length; i += tickEvery) {
    const x = PAD_L + stride * i + stride / 2;
    const t = s("text", { x, y: H - 6, "text-anchor": "middle" });
    t.textContent = data[i].label;
    axis.appendChild(t);
  }
  svg.appendChild(axis);

  for (let i = 0; i < data.length; i++) {
    const x = PAD_L + stride * i + (stride - barW) / 2;
    const h = (data[i].y / yMax) * innerH;
    const y = PAD_T + innerH - h;
    const bar = s("rect", {
      class: "bar",
      x, y,
      width: barW, height: Math.max(1, h),
      rx: 2,
    });
    bar.addEventListener("mouseenter", (ev) => {
      showTooltip(
        `<span class="lbl">${data[i].full ?? data[i].label}</span><strong>${formatDuration(data[i].y, { compact: true })}</strong>`,
        ev.clientX, ev.clientY,
      );
    });
    bar.addEventListener("mousemove", (ev) => {
      const t = getTooltip();
      t.style.left = `${ev.clientX}px`;
      t.style.top = `${ev.clientY}px`;
    });
    bar.addEventListener("mouseleave", hideTooltip);
    svg.appendChild(bar);
  }

  wrap.appendChild(svg);
  return wrap;
}

// — Hourly heatmap (7 days × 24 hours) —
export function heatmap({ data, days = 7 }) {
  // data: 2D array [day][hour] = seconds
  const wrap = document.createElement("div");
  wrap.className = "heatmap-wrap";
  const grid = document.createElement("div");
  grid.className = "heatmap";

  // compute thresholds (quartiles)
  const flat = data.flat().filter(v => v > 0);
  flat.sort((a, b) => a - b);
  const q = (p) => flat.length ? flat[Math.min(flat.length - 1, Math.floor(flat.length * p))] : 0;
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);

  const todayKey = new Date(); todayKey.setHours(0,0,0,0);
  for (let d = 0; d < days; d++) {
    const row = document.createElement("div");
    row.className = "heatmap-row";
    const date = new Date(todayKey); date.setDate(todayKey.getDate() - (days - 1 - d));
    const lbl = document.createElement("div");
    lbl.className = "heatmap-row__label";
    lbl.textContent = date.toLocaleDateString(undefined, { weekday: "short" });
    row.appendChild(lbl);
    for (let h = 0; h < 24; h++) {
      const v = data[d]?.[h] ?? 0;
      const cell = document.createElement("div");
      cell.className = "heatmap-cell";
      let level = 0;
      if (v > t3) level = 4;
      else if (v > t2) level = 3;
      else if (v > t1) level = 2;
      else if (v > 0) level = 1;
      cell.dataset.l = String(level);
      cell.title = `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${String(h).padStart(2, "0")}:00 · ${formatDuration(v, { compact: true })}`;
      cell.addEventListener("mouseenter", (ev) => {
        showTooltip(
          `<span class="lbl">${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${String(h).padStart(2, "0")}:00</span><strong>${formatDuration(v, { compact: true })}</strong>`,
          ev.clientX, ev.clientY,
        );
      });
      cell.addEventListener("mouseleave", hideTooltip);
      row.appendChild(cell);
    }
    grid.appendChild(row);
  }

  wrap.appendChild(grid);

  const axis = document.createElement("div");
  axis.className = "heatmap-axis";
  axis.appendChild(document.createElement("div"));
  for (let h = 0; h < 24; h++) {
    const cell = document.createElement("div");
    cell.textContent = (h % 4 === 0) ? String(h).padStart(2, "0") : "";
    axis.appendChild(cell);
  }
  wrap.appendChild(axis);

  return wrap;
}
