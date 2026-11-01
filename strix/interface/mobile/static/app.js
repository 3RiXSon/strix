"use strict";
/* Strix Mobile PWA — vanilla JS, no build step: the phone may be the only
   machine, so the app that controls scans must not need npm to exist. */
const view = document.getElementById("view");
const conn = document.getElementById("conn");
let tab = "scans";
let pollTimer = null;
let detailRun = null;
let wakeLock = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function api(path, options) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setConn(ok, label) {
  conn.className = "conn " + (ok ? "ok" : "bad");
  conn.textContent = label;
}

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch { /* unsupported / denied: polling still resumes on visibilitychange */ }
}

function nav(next) {
  tab = next; detailRun = null;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  render();
}
document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => nav(b.dataset.tab)));

function startPoll(fn, ms) {
  stopPoll(); fn();
  pollTimer = setInterval(() => { if (!document.hidden) fn(); }, ms);
}
function stopPoll() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
document.addEventListener("visibilitychange", () => { if (!document.hidden && pollTimer) render(); });

function render() {
  stopPoll();
  if (detailRun) return renderDetail(detailRun);
  if (tab === "scans") return renderScans();
  if (tab === "new") return renderNew();
  if (tab === "status") return renderStatus();
  return renderSettings();
}

/* ---------- Scans ---------- */
async function renderScans() {
  view.innerHTML = `<h1>Scans</h1><p class="dim">Loading…</p>`;
  const draw = async () => {
    try {
      const { jobs } = await api("/api/scans");
      setConn(true, "connected");
      if (!jobs.length) {
        view.innerHTML = `<h1>Scans</h1><div class="card"><p>No scans yet.</p><p class="dim">Start one from “New scan”. Scans keep running if you close this page — reopen Strix Mobile to check back.</p></div>`;
        return;
      }
      view.innerHTML = `<h1>Scans</h1>` + jobs.map((j) => `
        <div class="card" data-run="${esc(j.run_name || "")}" data-job="${esc(j.id)}">
          <div class="row"><strong>${esc(j.run_name || "starting…")}</strong><span class="status-${esc(j.status)}">${esc(j.status)}</span></div>
          <div class="dim small">${esc((j.targets || []).join(", ") || j.kind)} · ${esc(j.scan_mode)} · ${new Date(j.created_at * 1000).toLocaleString()}</div>
          ${j.run_name ? `<button class="ghost" data-open="${esc(j.run_name)}">Open</button>` : ""}
        </div>`).join("");
      view.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => { detailRun = b.dataset.open; render(); }));
    } catch (e) { setConn(false, "offline"); view.innerHTML = `<h1>Scans</h1><div class="err">${esc(e.message)}</div>`; }
  };
  startPoll(draw, 3000);
}

/* ---------- Detail ---------- */
async function renderDetail(name) {
  keepAwake();
  view.innerHTML = `<h1>${esc(name)}</h1><p class="dim">Loading…</p>`;
  const draw = async () => {
    try {
      const d = await api(`/api/scans/${encodeURIComponent(name)}`);
      setConn(true, "connected");
      const s = d.summary || {};
      const job = d.job || {};
      const c = d.severity_counts || {};
      const running = ["starting", "running"].includes(job.status) && !s.finished;
      view.innerHTML = `
        <button class="ghost" id="back">← All scans</button>
        <h1>${esc(name)}</h1>
        <div class="card">
          <div class="row"><span class="dim">Status</span><strong class="status-${esc(s.finished ? (s.status || "completed") : (job.status || "running"))}">${esc(s.finished ? (s.status || "completed") : (job.status || "running"))}</strong></div>
          <div class="row"><span class="dim">Mode</span><span>${esc(s.scan_mode || job.scan_mode || "")}</span></div>
          <div class="row"><span class="dim">Findings</span><span>
            <span class="chip critical">${c.critical || 0} crit</span> <span class="chip high">${c.high || 0} high</span>
            <span class="chip medium">${c.medium || 0} med</span> <span class="chip low">${c.low || 0} low</span></span></div>
          ${running ? `<button class="ghost danger" id="stop">Stop scan</button>` : `<button class="ghost" id="resume">Resume scan</button>`}
        </div>
        <h2>Findings (${(d.vulnerabilities || []).length})</h2>
        ${(d.vulnerabilities || []).map((v) => `<div class="card"><div class="row"><strong>${esc(v.title || v.name || "Finding")}</strong><span class="chip ${esc(String(v.severity || "low").toLowerCase())}">${esc(v.severity || "")}</span></div><div class="dim small">${esc(v.target || v.endpoint || "")}</div></div>`).join("") || `<p class="dim">None yet.</p>`}
        <h2>Report</h2>
        ${d.report_markdown ? `<pre>${esc(d.report_markdown)}</pre>` : `<p class="dim">Report appears when the scan finishes.</p>`}
        <h2>Log</h2><pre id="log">…</pre>`;
      document.getElementById("back").addEventListener("click", () => { detailRun = null; render(); });
      const stop = document.getElementById("stop");
      if (stop) stop.addEventListener("click", async () => { await api(`/api/scans/${encodeURIComponent(name)}/stop`, { method: "POST", body: "{}" }); draw(); });
      const resume = document.getElementById("resume");
      if (resume) resume.addEventListener("click", async () => { await api(`/api/scans/${encodeURIComponent(name)}/resume`, { method: "POST", body: "{}" }); draw(); });
      const log = await api(`/api/scans/${encodeURIComponent(name)}/log`).catch(() => ({ log: "" }));
      const el = document.getElementById("log"); if (el) el.textContent = log.log || "(no log)";
    } catch (e) { setConn(false, "offline"); }
  };
  startPoll(draw, 3000);
}

/* ---------- New scan ---------- */
function renderNew() {
  let mode = "quick";
  view.innerHTML = `
    <h1>New scan</h1>
    <div class="notice">Only scan targets you are authorized to test.</div>
    <label for="targets">Targets — one per line (URL, domain, IP, repo, or local path on the scan host)</label>
    <textarea id="targets" placeholder="https://example.com" autocomplete="off"></textarea>
    <label>Scan mode</label>
    <div class="seg" id="mode">
      <button data-m="quick" class="active">Quick</button><button data-m="standard">Standard</button><button data-m="deep">Deep</button>
    </div>
    <label for="instructions">Instructions (optional)</label>
    <textarea id="instructions" placeholder="Focus on authentication and IDOR"></textarea>
    <label for="budget">Max budget USD (optional)</label>
    <input id="budget" type="number" min="0" step="0.5" inputmode="decimal" placeholder="10">
    <div id="formerr"></div>
    <button class="primary" id="start">Start scan</button>`;
  view.querySelectorAll("#mode button").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.m; view.querySelectorAll("#mode button").forEach((x) => x.classList.toggle("active", x === b));
  }));
  document.getElementById("start").addEventListener("click", async () => {
    const payload = {
      targets: document.getElementById("targets").value,
      scan_mode: mode,
      instructions: document.getElementById("instructions").value || null,
      max_budget_usd: document.getElementById("budget").value ? Number(document.getElementById("budget").value) : null,
    };
    try {
      const { job } = await api("/api/scans", { method: "POST", body: JSON.stringify(payload) });
      detailRun = job.run_name || null;
      if (!detailRun) nav("scans"); else render();
    } catch (e) { document.getElementById("formerr").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  });
}

/* ---------- Device / status ---------- */
async function renderStatus() {
  view.innerHTML = `<h1>Device</h1><p class="dim">Loading…</p>`;
  try {
    const s = await api("/api/status");
    setConn(true, "connected");
    view.innerHTML = `
      <h1>Device</h1>
      <div class="card">
        <div class="row"><span class="dim">Backend</span><strong>${esc(s.backend_resolved)}</strong></div>
        <div class="row"><span class="dim">Docker daemon</span><span>${s.docker.daemon ? "available" : "not available"}</span></div>
        <div class="row"><span class="dim">Platform</span><span>${esc(s.platform)}${s.is_termux ? " · Termux" : ""}</span></div>
        <div class="row"><span class="dim">Python</span><span>${esc(s.python)}</span></div>
        <div class="row"><span class="dim">LLM model</span><span>${esc(s.llm.model || "not set")}</span></div>
      </div>
      ${s.backend_resolved === "local" ? `<div class="notice">Local mode: agent commands run directly on this device (no container isolation) and the Caido proxy tools are unavailable. Shell tools below are what the agent can use.</div>` : ""}
      <h2>Tools on this device</h2>
      <div class="grid">${Object.entries(s.tools).map(([n, p]) => `<div class="tool ${p ? "" : "missing"}">${p ? "✓" : "✗"} ${esc(n)}</div>`).join("")}</div>`;
  } catch (e) { setConn(false, "offline"); view.innerHTML = `<h1>Device</h1><div class="err">${esc(e.message)}</div>`; }
}

/* ---------- Settings ---------- */
async function renderSettings() {
  view.innerHTML = `<h1>Settings</h1><p class="dim">Loading…</p>`;
  try {
    const c = await api("/api/config");
    view.innerHTML = `
      <h1>Settings</h1>
      <label for="model">Model (STRIX_LLM)</label>
      <input id="model" value="${esc(c.model)}" placeholder="openai/gpt-5.4" autocomplete="off">
      <label for="key">LLM API key ${c.api_key_set ? "(saved — leave blank to keep)" : ""}</label>
      <input id="key" type="password" placeholder="${c.api_key_set ? "••••••••" : "sk-…"}">
      <label for="base">API base URL (optional — local models)</label>
      <input id="base" value="${esc(c.api_base)}" placeholder="http://localhost:11434" autocomplete="off">
      <label for="backend">Runtime backend</label>
      <select id="backend">
        ${["auto", "docker", "local"].map((b) => `<option ${b === c.backend ? "selected" : ""}>${b}</option>`).join("")}
      </select>
      <p class="dim small">auto = Docker when a daemon answers, otherwise run tools directly on this device (Termux-friendly, no isolation). The key is stored on the scan host only (0600), never shown back.</p>
      <div id="saved"></div>
      <button class="primary" id="save">Save</button>`;
    document.getElementById("save").addEventListener("click", async () => {
      await api("/api/config", { method: "POST", body: JSON.stringify({
        model: document.getElementById("model").value,
        api_key: document.getElementById("key").value,
        api_base: document.getElementById("base").value,
        backend: document.getElementById("backend").value,
      })});
      document.getElementById("saved").innerHTML = `<div class="notice">Saved.</div>`;
    });
  } catch (e) { view.innerHTML = `<h1>Settings</h1><div class="err">${esc(e.message)}</div>`; }
}

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
render();
