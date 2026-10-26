const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1H", "4H", "1D", "1W", "1M"];
const images = []; // { mediaType, data, url, timeframe }

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelectorAll("#themes button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
  try { localStorage.setItem("xau_theme", t); } catch {}
}
let savedTheme = "tv";
try { savedTheme = localStorage.getItem("xau_theme") || "tv"; } catch {}
setTheme(savedTheme);
document.querySelectorAll("#themes button").forEach((b) => (b.onclick = () => setTheme(b.dataset.t)));

// Any 401 from the API means the admin session expired.
async function api(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) { location.href = "/login.html"; throw new Error("Sessiya tugadi"); }
  return res;
}

api("/api/status").then((r) => r.json()).then((st) => {
  $("serverStatus").innerHTML = st.hasKey
    ? `<span class="dot ok"></span> Claude API ulangan · model: <b>${esc(st.model)}</b>`
    : `<span class="dot bad"></span> Serverda <b>ANTHROPIC_API_KEY</b> o'rnatilmagan (Render → Environment)`;
  $("logout").classList.toggle("hidden", !st.protected);
}).catch(() => {});
$("logout").onclick = async () => { await fetch("/api/logout", { method: "POST" }); location.href = "/login.html"; };

// Guess the timeframe from the file name (e.g. "XAUUSD_4H.png") or pick the next unused one.
function guessTimeframe(name) {
  const m = (name || "").match(/(?:^|[^a-z0-9])(1|5|15|30)m(?:in)?(?![a-z0-9])|(?:^|[^a-z0-9])(1|4)h(?![a-z0-9])|(?:^|[^a-z0-9])1?(d|w)(?![a-z0-9])/i);
  if (m) {
    if (m[1]) return m[1] + "m";
    if (m[2]) return m[2] + "H";
    if (m[3]) return "1" + m[3].toUpperCase();
  }
  const order = ["1D", "4H", "1H", "15m", "5m", "1W", "30m", "1m", "1M"];
  return order.find((tf) => !images.some((i) => i.timeframe === tf)) || "1H";
}

function addFile(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return;
  if (images.length >= 10) return alertMsg("Ko'pi bilan 10 ta rasm.");
  const reader = new FileReader();
  reader.onload = () => {
    const url = reader.result;
    images.push({ mediaType: file.type, data: url.split(",")[1], url, timeframe: guessTimeframe(file.name) });
    render();
  };
  reader.readAsDataURL(file);
}

function render() {
  $("thumbs").innerHTML = images.map((img, i) => `
    <div class="thumb">
      <img src="${img.url}" alt="Grafik ${i + 1}">
      <button class="del" data-i="${i}" title="O'chirish">✕</button>
      <select data-i="${i}">${TIMEFRAMES.map((tf) => `<option ${tf === img.timeframe ? "selected" : ""}>${tf}</option>`).join("")}</select>
    </div>`).join("");
  $("thumbs").querySelectorAll(".del").forEach((b) => (b.onclick = () => { images.splice(+b.dataset.i, 1); render(); }));
  $("thumbs").querySelectorAll("select").forEach((s) => (s.onchange = () => (images[+s.dataset.i].timeframe = s.value)));
  $("analyze").disabled = images.length === 0;
}

function showResultCard() {
  $("resultCard").classList.remove("hidden");
  $("emptyState").classList.add("hidden");
}

document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x === t));
  $("page-analyze").classList.toggle("hidden", t.dataset.tab !== "analyze");
  $("page-journal").classList.toggle("hidden", t.dataset.tab !== "journal");
  $("page-chat").classList.toggle("hidden", t.dataset.tab !== "chat");
  $("page-brief").classList.toggle("hidden", t.dataset.tab !== "brief");
  if (t.dataset.tab === "chat") { updateCtxState(); $("chatText").focus(); }
}));

function alertMsg(msg) {
  showResultCard();
  $("result").innerHTML = `<p class="error">${esc(msg)}</p>`;
}

let strategyLabels = {};
api("/api/strategies").then((r) => r.json()).then((list) => {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("xau_strategies")); } catch {}
  list.forEach((s) => (strategyLabels[s.id] = s.label));
  $("strategies").innerHTML = list.map((s) => `
    <label title="${esc(s.rules.map((r, i) => `${i + 1}. ${r}`).join("\n"))}"><input type="checkbox" value="${esc(s.id)}" ${!saved || saved.includes(s.id) ? "checked" : ""}>
      <span>${esc(s.label)}<small class="rules-count">${s.rules.length} ta qoida tekshiriladi</small></span></label>`).join("");
  $("strategies").onchange = saveStrategies;
});
const selectedStrategies = () => [...$("strategies").querySelectorAll("input:checked")].map((i) => i.value);
function saveStrategies() { try { localStorage.setItem("xau_strategies", JSON.stringify(selectedStrategies())); } catch {} }
$("toggleAll").onclick = () => {
  const boxes = [...$("strategies").querySelectorAll("input")];
  const allOn = boxes.every((b) => b.checked);
  boxes.forEach((b) => (b.checked = !allOn));
  saveStrategies();
};

const drop = $("drop");
$("pick").onclick = () => $("file").click();
$("file").onchange = (e) => { [...e.target.files].forEach(addFile); e.target.value = ""; };
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); [...e.dataTransfer.files].forEach(addFile); };
document.addEventListener("paste", (e) => {
  const onChat = !$("page-chat").classList.contains("hidden");
  [...(e.clipboardData?.items || [])].filter((it) => it.kind === "file")
    .forEach((it) => (onChat ? addChatFile : addFile)(it.getAsFile()));
});

$("analyze").onclick = async () => {
  const strategies = selectedStrategies();
  if (strategies.length === 0) return alertMsg("Kamida bitta strategiyani tanlang.");
  // Send higher timeframes first so Claude reads them top-down.
  const sorted = [...images].sort((a, b) => TIMEFRAMES.indexOf(b.timeframe) - TIMEFRAMES.indexOf(a.timeframe));
  const useNews = $("useNews").checked;
  $("analyze").disabled = true;
  showResultCard();
  $("result").innerHTML = `<p><span class="spinner"></span>Claude ${sorted.length} ta grafikni ${strategies.length} ta strategiya bo'yicha tahlil qilmoqda${useNews ? ", kun yangiliklarini qidirmoqda" : ""}... (1–4 daqiqa)</p>`;
  try {
    const res = await api("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        note: $("note").value.trim(),
        strategies,
        useNews,
        images: sorted.map(({ mediaType, data, timeframe }) => ({ mediaType, data, timeframe })),
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Xato ${res.status}`);
    lastAnalysis = body.analysis;
    showResult(body.analysis, body, sorted);
  } catch (err) {
    alertMsg(err.message);
  } finally {
    $("analyze").disabled = images.length === 0;
  }
};

const LABELS = { BULLISH: "Ko'tarilish", BEARISH: "Tushish", NEUTRAL: "Neytral", RANGE: "Flet", BUY: "BUY", SELL: "SELL", WAIT: "KUTISH",
  LOW: "Past", MEDIUM: "O'rta", HIGH: "Yuqori" };
const badge = (v) => `<span class="badge ${esc(v)}">${esc(LABELS[v] || v)}</span>`;

const COLORS = { green: "#2ea043", red: "#f85149", gold: "#d4a72c", blue: "#388bfd", white: "#e6edf3" };
const clamp01 = (v) => Math.max(0, Math.min(1, +v || 0));

// Draws Claude's annotations (coordinates are 0..1 fractions of the image) onto a canvas.
function drawChart(canvas, img, drawings, plan) {
  const w = img.naturalWidth, h = img.naturalHeight;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const lw = Math.max(2, Math.round(w / 500));
  const fs = Math.max(13, Math.round(w / 70));
  ctx.font = `bold ${fs}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  const tag = (text, x, y, color) => {
    if (!text) return;
    const pad = fs * 0.35, tw = ctx.measureText(text).width;
    x = Math.min(Math.max(0, x), w - tw - pad * 2);
    y = Math.min(Math.max(fs * 0.7, y), h - fs * 0.7);
    ctx.fillStyle = color; ctx.fillRect(x, y - fs * 0.7, tw + pad * 2, fs * 1.4);
    ctx.fillStyle = "#000"; ctx.fillText(text, x + pad, y);
  };
  for (const d of drawings) {
    const c = COLORS[d.color] || COLORS.gold;
    const x1 = clamp01(d.x1) * w, y1 = clamp01(d.y1) * h, x2 = clamp01(d.x2) * w, y2 = clamp01(d.y2) * h;
    ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.setLineDash([]);
    if (d.kind === "hline") {
      const xa = Math.min(x1, x2), xb = Math.max(x1, x2) > xa + 10 ? Math.max(x1, x2) : w;
      ctx.setLineDash([lw * 5, lw * 3]);
      ctx.beginPath(); ctx.moveTo(xa, y1); ctx.lineTo(xb, y1); ctx.stroke();
      tag(d.label, xb - ctx.measureText(d.label).width - fs, y1, c);
    } else if (d.kind === "zone") {
      ctx.fillStyle = c + "33";
      ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      tag(d.label, Math.min(x1, x2) + 4, Math.min(y1, y2) + fs * 0.8, c);
    } else if (d.kind === "arrow") {
      ctx.lineWidth = lw * 1.5;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      const ang = Math.atan2(y2 - y1, x2 - x1), hl = fs * 1.1;
      ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - hl * Math.cos(ang - 0.4), y2 - hl * Math.sin(ang - 0.4));
      ctx.lineTo(x2 - hl * Math.cos(ang + 0.4), y2 - hl * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();
      tag(d.label, x2 + 6, y2, c);
    } else {
      tag(d.label, x1, y1, c);
    }
  }
  if (plan) drawPosition(ctx, w, h, lw, fs, tag, plan);
}

// TradingView-style position box: green from entry to TP, red from entry to SL, with prices and distances.
function drawPosition(ctx, w, h, lw, fs, tag, plan) {
  const pos = plan.position;
  const pr = plan.prices;
  if (!pos || !(pos.y_entry > 0) || !(pos.y_sl > 0) || !(pos.y_tp1 > 0)) return;
  const xa = clamp01(pos.x1) * w;
  const xb = Math.max(xa + w * 0.08, clamp01(pos.x2 || 1) * w);
  const yE = clamp01(pos.y_entry) * h, yS = clamp01(pos.y_sl) * h, yT1 = clamp01(pos.y_tp1) * h;
  const yT = pos.y_tp2 > 0 ? clamp01(pos.y_tp2) * h : yT1;
  const box = (y1, y2, fill, stroke) => {
    ctx.fillStyle = fill; ctx.fillRect(xa, Math.min(y1, y2), xb - xa, Math.abs(y2 - y1));
    ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.setLineDash([]);
    ctx.strokeRect(xa, Math.min(y1, y2), xb - xa, Math.abs(y2 - y1));
  };
  box(yE, yT, "rgba(8,153,129,.28)", "#089981");
  box(yE, yS, "rgba(242,54,69,.28)", "#f23645");
  const line = (y, color, dash) => {
    ctx.strokeStyle = color; ctx.lineWidth = lw * (dash ? 1 : 1.6); ctx.setLineDash(dash ? [lw * 4, lw * 3] : []);
    ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke(); ctx.setLineDash([]);
  };
  if (yT !== yT1) line(yT1, "#089981", true);
  line(yE, "#e6edf3", false);
  const num = (v) => (v > 0 ? (+v).toFixed(2).replace(/\.?0+$/, "") : "");
  const diff = (v) => (v > 0 && pr.entry > 0 ? ` (${v > pr.entry ? "+" : "−"}${Math.abs(v - pr.entry).toFixed(2)})` : "");
  const right = (text, y, color) => tag(text, xb - ctx.measureText(text).width - fs * 0.9, y, color);
  const dir = plan.direction === "SELL" ? "SHORT" : plan.direction === "BUY" ? "LONG" : "LIMIT";
  right(`Entry ${num(pr.entry)} · ${dir}`, yE, "#e6edf3");
  right(`SL ${num(pr.sl)}${diff(pr.sl)}`, yS + (yS > yE ? -fs * 0.8 : fs * 0.8), "#f23645");
  right(`TP1 ${num(pr.tp1)}${diff(pr.tp1)}`, yT1 + (yT1 < yE ? fs * 0.8 : -fs * 0.8), "#089981");
  if (yT !== yT1) right(`TP2 ${num(pr.tp2)}${diff(pr.tp2)}`, yT + (yT < yE ? fs * 0.8 : -fs * 0.8), "#089981");
  if (plan.name) tag(plan.name, xa + 4, Math.min(yT, yS, yE) - fs * 1.1, "#2962ff");
}

// One "plan" = the final plan or one strategy's plan: its own drawings, position box and prices.
function plansOf(a) {
  const p = a.trade_plan;
  const plans = [{
    key: "final", name: "Yakuniy reja", direction: p.direction, timeframe: a.recommended_entry_timeframe,
    drawings: a.drawings || [], position: p.position,
    prices: { entry: p.entry_price, sl: p.stop_loss_price, tp1: p.take_profit_1_price, tp2: p.take_profit_2_price },
  }];
  [...a.strategies].sort((x, y) => y.score - x.score).forEach((st, i) => plans.push({
    key: "s" + i, name: st.strategy, direction: st.signal, timeframe: st.timeframe, score: st.score,
    drawings: st.drawings || [], position: st.position,
    prices: { entry: st.entry_price, sl: st.stop_loss_price, tp1: st.take_profit_1_price, tp2: st.take_profit_2_price },
  }));
  return plans;
}

function renderPlanPicker(a, sent) {
  const plans = plansOf(a);
  $("planPick").innerHTML = plans.map((pl) => `
    <button data-k="${pl.key}" class="${pl.key === "final" ? "on" : ""}">${pl.key === "final" ? "⭐ " : ""}${esc(pl.name.split(" (")[0].split(":")[0])}
      ${pl.key === "final" ? "" : badge(pl.direction)}</button>`).join("");
  $("planPick").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    $("planPick").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    renderCharts(plans.find((pl) => pl.key === b.dataset.k), sent, a);
  }));
  renderCharts(plans[0], sent, a);
}
// Renders every plan onto its main image off-screen and downloads one PNG per plan.
async function downloadAllPlans(a, sent) {
  const load = (url) => new Promise((ok) => { const im = new Image(); im.onload = () => ok(im); im.src = url; });
  let n = 0;
  for (const plan of plansOf(a)) {
    const pos = plan.position || {};
    let idx = pos.image_index > 0 && pos.y_entry > 0 ? pos.image_index : 0;
    if (!idx) idx = (plan.drawings[0] || {}).image_index || 0;
    const img = sent[idx - 1];
    if (!img) continue;
    const canvas = document.createElement("canvas");
    drawChart(canvas, await load(img.url), plan.drawings.filter((d) => d.image_index === idx), pos.image_index === idx ? plan : null);
    const a2 = document.createElement("a");
    a2.download = `${String(++n).padStart(2, "0")}_XAUUSD_${img.timeframe}_${plan.name.split(/[ (:]/)[0]}.png`.replace(/[^\w.\-]/g, "_");
    a2.href = canvas.toDataURL("image/png");
    document.body.appendChild(a2); a2.click(); a2.remove();
    await new Promise((r) => setTimeout(r, 350));
  }
  return n;
}

function showPlan(key) {
  const b = $("planPick").querySelector(`button[data-k="${key}"]`);
  if (b) { b.click(); $("planPick").scrollIntoView({ behavior: "smooth", block: "start" }); }
}

function renderCharts(plan, sent, a) {
  const box = $("charts");
  const pos = plan.position || {};
  const byImage = sent.map((img, i) => ({
    img, i,
    drawings: plan.drawings.filter((d) => d.image_index === i + 1),
    hasPos: pos.image_index === i + 1 && pos.y_entry > 0,
  })).filter((x) => x.drawings.length || x.hasPos);
  // Images with the position box first, then the plan's own timeframe.
  byImage.sort((x, y) => (y.hasPos - x.hasPos) || ((y.img.timeframe === plan.timeframe) - (x.img.timeframe === plan.timeframe)));
  const pr = plan.prices;
  const head = pr.entry > 0
    ? `<div class="plan mini"><div><small>Kirish</small>${pr.entry}</div><div><small>Stop Loss</small><span class="neg">${pr.sl || "—"}</span></div>
       <div><small>TP1</small><span class="pos">${pr.tp1 || "—"}</span></div><div><small>TP2</small><span class="pos">${pr.tp2 || "—"}</span></div>
       <div><small>R:R (TP1)</small>${pr.sl && pr.tp1 && pr.entry !== pr.sl ? "1 : " + (Math.abs(pr.tp1 - pr.entry) / Math.abs(pr.entry - pr.sl)).toFixed(2) : "—"}</div></div>`
    : `<p class="hint">${esc(plan.name)}: hozircha bu strategiya bo'yicha setup yo'q — kirish nuqtasi berilmagan.</p>`;
  if (!byImage.length) { box.innerHTML = head + `<p class="hint">Bu reja uchun chizma qaytarilmadi.</p>`; return; }
  box.innerHTML = head;
  for (const { img, i, drawings, hasPos } of byImage) {
    const fig = document.createElement("div");
    fig.className = "chart";
    const fname = `XAUUSD_${img.timeframe}_${plan.name.split(" ")[0]}.png`.replace(/[^\w.\-]/g, "_");
    fig.innerHTML = `<figure><figcaption><span>${esc(img.timeframe)} — Rasm ${i + 1}</span><a href="#" download="${esc(fname)}">PNG yuklab olish</a></figcaption><canvas></canvas></figure>`;
    box.appendChild(fig);
    const el = new Image();
    el.onload = () => {
      const canvas = fig.querySelector("canvas");
      drawChart(canvas, el, drawings, hasPos ? plan : null);
      fig.querySelector("a").href = canvas.toDataURL("image/png");
    };
    el.src = img.url;
  }
}

function showResult(a, body, sent) {
  const p = a.trade_plan;
  const news = body.news;
  $("result").innerHTML = `
    <div class="verdict">Umumiy yo'nalish: ${badge(a.overall_bias)} · Savdo: ${badge(p.direction)} · Ishonch: ${badge(a.confidence)}</div>
    <p>${esc(a.summary)}</p>
    <div class="entry-tf">
      <small>Kirish uchun tavsiya etilgan timeframe</small>
      <div class="tf">${esc(a.recommended_entry_timeframe)}</div>
      <p>${esc(a.entry_timeframe_reason)}</p>
    </div>
    <h3>Grafikda chizilgan reja</h3>
    <p class="hint">Strategiyani tanlang — uning zonalari, kirish nuqtasi va TP/SL qayerdan qayergacha ekani rasmingiz ustida ko'rsatiladi. Chiziqlar narx shkalasiga qarab taxminan joylashadi, aniq narxlar yuqorida.</p>
    <div id="planPick" class="plan-pick"></div>
    <button id="dlAll" class="secondary" style="margin-bottom:10px">📥 Barcha strategiyalar chizmalarini yuklab olish</button>
    <div id="charts" class="charts"></div>
    <h3>Bozor nima uchun shunday harakatlanmoqda</h3>
    <p>${esc(a.market_reason)}</p>
    <h3>Yangiliklar ta'siri</h3>
    <p>${esc(a.news_impact)}</p>
    ${body.newsError ? `<p class="error">${esc(body.newsError)}</p>` : ""}
    ${news ? `<details><summary>Forex Factory: bugungi yangiliklar</summary><div class="news">${esc(news.text)}</div>
      ${news.sources.length ? `<p class="sources">Manbalar: ${news.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join(" · ")}</p>` : ""}</details>` : ""}
    <h3>Strategiyalar sinovi</h3>
    <p>Ishlagan strategiya: <b>${esc(a.best_strategy)}</b> — ${esc(a.best_strategy_reason)}</p>
    ${a.supporting_strategies.length ? `<p>Qo'llab-quvvatlaydi: ${a.supporting_strategies.map(esc).join(", ")}</p>` : ""}
    <p class="hint">Har bir strategiya qoidama-qoida tekshirildi. Qatorni bosib, qaysi qoida bajarilgani va grafikda nimaga asoslanganini ko'ring.</p>
    <div class="strat-list">
      ${[...a.strategies].sort((x, y) => y.score - x.score).map((st) => {
        const met = (st.checks || []).filter((c) => c.met).length, total = (st.checks || []).length;
        return `<details class="strat ${st.strategy === a.best_strategy ? "best" : ""}">
          <summary>
            <b>${esc(st.strategy)}</b> ${badge(st.signal)} <span class="muted">${esc(st.timeframe)}</span>
            <span class="score"><span class="bar"><i style="width:${Math.max(0, Math.min(100, +st.score || 0))}%"></i></span>${esc(st.score)}</span>
            <span class="muted">${met}/${total} qoida</span>
          </summary>
          <p>${esc(st.reasoning)}</p>
          ${+st.entry_price > 0 ? `<p class="strat-prices">Kirish <b>${st.entry_price}</b> · SL <b class="neg">${st.stop_loss_price}</b> · TP1 <b class="pos">${st.take_profit_1_price}</b>${+st.take_profit_2_price > 0 ? ` · TP2 <b class="pos">${st.take_profit_2_price}</b>` : ""}</p>` : ""}
          <button class="secondary show-plan" data-name="${esc(st.strategy)}">🖼 Rasmda ko'rish</button>
          <ul class="checks">${(st.checks || []).map((c) => `<li class="${c.met ? "ok" : "no"}"><span>${c.met ? "✓" : "✗"}</span><div><b>${esc(c.rule)}</b><br><small>${esc(c.evidence)}</small></div></li>`).join("")}</ul>
        </details>`;
      }).join("")}
    </div>
    <h3>Savdo rejasi</h3>
    <div class="plan">
      <div><small>Kirish</small>${esc(p.entry)}</div>
      <div><small>Stop Loss</small>${esc(p.stop_loss)}</div>
      <div><small>Take Profit 1</small>${esc(p.take_profit_1)}</div>
      <div><small>Take Profit 2</small>${esc(p.take_profit_2)}</div>
      <div><small>Risk / Reward</small>${esc(p.risk_reward)}</div>
      <div><small>Tasdiqlovchi signal</small>${esc(p.confirmation)}</div>
      <div><small>Reja bekor bo'ladi, agar</small>${esc(p.invalidation)}</div>
    </div>
    <h3>🧮 Lot va risk kalkulyatori</h3>
    <div class="calc" id="calc">
      <label><span>Kirish</span><input data-k="entry" type="number" step="any" value="${+p.entry_price || ""}"></label>
      <label><span>Stop Loss</span><input data-k="sl" type="number" step="any" value="${+p.stop_loss_price || ""}"></label>
      <label><span>Take Profit 1</span><input data-k="tp1" type="number" step="any" value="${+p.take_profit_1_price || ""}"></label>
      <label><span>Take Profit 2</span><input data-k="tp2" type="number" step="any" value="${+p.take_profit_2_price || ""}"></label>
    </div>
    <div id="calcOut" class="plan"></div>
    <h3>Timeframe'lar bo'yicha</h3>
    <div class="tfwrap"><table class="tfs">
      <tr><th>TF</th><th>Trend</th><th>Asosiy darajalar</th><th>Izoh</th></tr>
      ${a.timeframes.map((t) => `<tr><td><b>${esc(t.timeframe)}</b></td><td>${badge(t.trend)}</td><td>${esc(t.key_levels)}</td><td>${esc(t.notes)}</td></tr>`).join("")}
    </table></div>
    <h3>Risklar</h3>
    <ul>${a.risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`;
  renderPlanPicker(a, sent);
  $("dlAll").onclick = async () => {
    $("dlAll").disabled = true;
    const n = await downloadAllPlans(a, sent);
    $("dlAll").disabled = false;
    $("dlAll").textContent = `📥 ${n} ta chizma yuklab olindi — yana yuklash`;
  };
  const plans = plansOf(a);
  $("result").querySelectorAll(".show-plan").forEach((b) => (b.onclick = (e) => {
    e.preventDefault();
    const pl = plans.find((x) => x.name === b.dataset.name);
    if (pl) showPlan(pl.key);
  }));
  $("calc").oninput = updateCalc;
  updateCalc();
  const bar = document.createElement("div");
  bar.className = "journal-add";
  bar.innerHTML = p.direction === "WAIT" ? "" : `<button class="secondary">Jurnalga qo'shish (natijani keyin belgilash uchun)</button>`;
  $("result").appendChild(bar);
  bar.querySelector("button")?.addEventListener("click", (e) => {
    addJournal({ id: Date.now(), date: new Date().toISOString(), tf: a.recommended_entry_timeframe, direction: p.direction,
      entry: p.entry, sl: p.stop_loss, tp: p.take_profit_1, strategy: a.best_strategy, confidence: a.confidence, result: null,
      entry_price: +p.entry_price || null, sl_price: +p.stop_loss_price || null, tp_price: +p.take_profit_1_price || null,
      lot: calcLot(), news: a.news_impact });
    e.target.disabled = true; e.target.textContent = "Jurnalga qo'shildi ✓";
  });
}

// ---- Accuracy journal: the trader marks each saved signal as TP or SL, stats are computed per strategy. ----
const JOURNAL_KEY = "xau_journal";
function loadJournal() { try { return JSON.parse(localStorage.getItem(JOURNAL_KEY)) || []; } catch { return []; } }
function saveJournal(j) { try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(j)); } catch {} renderJournal(); }
function addJournal(entry) { saveJournal([entry, ...loadJournal()]); }

function renderJournal() {
  const j = loadJournal();
  const done = j.filter((e) => e.result === "tp" || e.result === "sl");
  const wins = done.filter((e) => e.result === "tp").length;
  const byStrat = {};
  for (const e of done) {
    byStrat[e.strategy] ??= { tp: 0, sl: 0 };
    byStrat[e.strategy][e.result]++;
  }
  const pct = (w, n) => (n ? Math.round((w / n) * 100) + "%" : "—");
  $("journalStats").innerHTML = `
    <div class="plan">
      <div><small>Jami signallar</small>${j.length}</div>
      <div><small>Yopilgan</small>${done.length}</div>
      <div><small>TP / SL</small>${wins} / ${done.length - wins}</div>
      <div><small>Aniqlik (win rate)</small>${pct(wins, done.length)}</div>
    </div>
    ${Object.keys(byStrat).length ? `<div class="tfwrap"><table class="tfs"><tr><th>Strategiya</th><th>TP</th><th>SL</th><th>Aniqlik</th></tr>
      ${Object.entries(byStrat).sort((x, y) => (y[1].tp + y[1].sl) - (x[1].tp + x[1].sl)).map(([k, v]) =>
        `<tr><td>${esc(k)}</td><td>${v.tp}</td><td>${v.sl}</td><td><b>${pct(v.tp, v.tp + v.sl)}</b></td></tr>`).join("")}</table></div>` : ""}`;
  $("journalList").innerHTML = j.length ? `<div class="tfwrap"><table class="tfs">
    <tr><th>Sana</th><th>TF</th><th>Signal</th><th>Kirish / SL / TP</th><th>Strategiya</th><th>Natija</th></tr>
    ${j.map((e) => `<tr>
      <td>${esc(new Date(e.date).toLocaleString())}</td><td>${esc(e.tf)}</td><td>${badge(e.direction)}</td>
      <td>${esc(e.entry)} / ${esc(e.sl)} / ${esc(e.tp)}</td><td>${esc(e.strategy)}</td>
      <td class="res" data-id="${e.id}">
        <button data-r="tp" class="${e.result === "tp" ? "on-tp" : ""}">TP ✓</button>
        <button data-r="sl" class="${e.result === "sl" ? "on-sl" : ""}">SL ✗</button>
        <button data-r="del" title="O'chirish">🗑</button>
      </td></tr>`).join("")}
  </table></div>` : `<p class="hint">Hali signal saqlanmagan. Tahlildan keyin "Jurnalga qo'shish" ni bosing, savdo yopilgach TP yoki SL ni belgilang.</p>`;
  $("journalList").querySelectorAll(".res button").forEach((b) => (b.onclick = () => {
    const id = +b.parentElement.dataset.id, list = loadJournal();
    if (b.dataset.r === "del") return saveJournal(list.filter((e) => e.id !== id));
    const e = list.find((x) => x.id === id);
    e.result = e.result === b.dataset.r ? null : b.dataset.r;
    saveJournal(list);
  }));
}
renderJournal();


// ---- Admin chat with Claude (streamed). ----
let lastAnalysis = null;
const chat = []; // { role, text, images: [{ mediaType, data, url }] }
const chatImgs = [];
try { chat.push(...(JSON.parse(localStorage.getItem("xau_chat")) || []).map((m) => ({ ...m, images: [] }))); } catch {}
function saveChat() {
  // Images are not persisted to keep localStorage small.
  try { localStorage.setItem("xau_chat", JSON.stringify(chat.slice(-40).map(({ role, text }) => ({ role, text })))); } catch {}
}
function updateCtxState() {
  $("ctxState").textContent = lastAnalysis ? "(mavjud)" : "(hali tahlil qilinmagan)";
}

// Light formatting for Claude's replies: escape first, then **bold**, `code`, line breaks.
const fmt = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\n/g, "<br>");

function renderChat() {
  $("chatLog").innerHTML = chat.length ? chat.map((m) => `
    <div class="msg ${m.role}">
      <div class="who">${m.role === "user" ? "Siz" : "Claude"}</div>
      ${(m.images || []).map((i) => `<img src="${i.url}" alt="">`).join("")}
      <div class="bubble">${m.text ? fmt(m.text) : '<span class="spinner"></span>'}</div>
    </div>`).join("") : `<p class="hint">Masalan: "Nega 15m tanlading?", "SL ni qayerga qo'ysam xavfsizroq?", "Bugungi CPI oltinga qanday ta'sir qiladi?"</p>`;
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
}
function renderChatImgs() {
  $("chatImgs").innerHTML = chatImgs.map((i, n) => `<span><img src="${i.url}" alt=""><button data-n="${n}">✕</button></span>`).join("");
  $("chatImgs").querySelectorAll("button").forEach((b) => (b.onclick = () => { chatImgs.splice(+b.dataset.n, 1); renderChatImgs(); }));
}
function addChatFile(file) {
  if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type) || chatImgs.length >= 5) return;
  const reader = new FileReader();
  reader.onload = () => { chatImgs.push({ mediaType: file.type, data: reader.result.split(",")[1], url: reader.result }); renderChatImgs(); };
  reader.readAsDataURL(file);
}
$("chatAttach").onclick = () => $("chatFile").click();
$("chatFile").onchange = (e) => { [...e.target.files].forEach(addChatFile); e.target.value = ""; };
$("chatClear").onclick = () => { chat.length = 0; saveChat(); renderChat(); };
$("chatText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chatSend").click(); }
});

$("chatSend").onclick = async () => {
  const text = $("chatText").value.trim();
  if (!text && !chatImgs.length) return;
  chat.push({ role: "user", text, images: chatImgs.splice(0) });
  const reply = { role: "assistant", text: "", images: [] };
  chat.push(reply);
  $("chatText").value = "";
  renderChatImgs(); renderChat();
  $("chatSend").disabled = true;
  try {
    await streamChat(
      chat.slice(0, -1).map(({ role, text, images }) => ({ role, text, images: images.map(({ mediaType, data }) => ({ mediaType, data })) })),
      $("chatContext").checked ? lastAnalysis : null,
      (t) => { reply.text = t; renderChat(); },
    );
    if (!reply.text) reply.text = "[Bo'sh javob]";
  } catch (err) {
    reply.text = `⚠️ ${err.message}`;
  } finally {
    $("chatSend").disabled = false;
    saveChat(); renderChat();
  }
};
renderChat();


// ---- Account settings and lot / risk calculator (pure math, no AI). ----
const ACCT_KEY = "xau_account";
try {
  const acct = JSON.parse(localStorage.getItem(ACCT_KEY)) || {};
  $("balance").value = acct.balance ?? ""; $("riskPct").value = acct.riskPct ?? 1; $("contract").value = acct.contract ?? 100;
} catch { $("riskPct").value = 1; $("contract").value = 100; }
["balance", "riskPct", "contract"].forEach((id) => ($(id).oninput = () => {
  try { localStorage.setItem(ACCT_KEY, JSON.stringify({ balance: $("balance").value, riskPct: $("riskPct").value, contract: $("contract").value })); } catch {}
  if ($("calc")) updateCalc();
}));

function calcInputs() {
  const v = {};
  document.querySelectorAll("#calc input").forEach((i) => (v[i.dataset.k] = parseFloat(i.value)));
  return { ...v, balance: parseFloat($("balance").value), riskPct: parseFloat($("riskPct").value), contract: parseFloat($("contract").value) || 100 };
}
// Lot size so that hitting SL loses exactly balance * risk%: lots = riskUSD / (|entry - SL| * oz per lot).
function calcLot() {
  if (!$("calc")) return null;
  const c = calcInputs();
  const dist = Math.abs(c.entry - c.sl);
  if (!(dist > 0) || !(c.balance > 0) || !(c.riskPct > 0)) return null;
  return Math.floor(((c.balance * c.riskPct) / 100 / (dist * c.contract)) * 100) / 100;
}
function updateCalc() {
  const c = calcInputs();
  const out = $("calcOut");
  if (!out) return;
  const dist = Math.abs(c.entry - c.sl);
  if (!(dist > 0)) { out.innerHTML = `<div><small>Natija</small>Kirish va Stop Loss narxini kiriting</div>`; return; }
  if (!(c.balance > 0)) { out.innerHTML = `<div><small>Natija</small>"Sozlamalar"da balansni kiriting</div>`; return; }
  const lot = calcLot();
  const money = (n) => (isFinite(n) ? `$${n.toFixed(2)}` : "—");
  const loss = lot * dist * c.contract;
  const p1 = c.tp1 ? lot * Math.abs(c.tp1 - c.entry) * c.contract : NaN;
  const p2 = c.tp2 ? lot * Math.abs(c.tp2 - c.entry) * c.contract : NaN;
  const rr = c.tp1 ? (Math.abs(c.tp1 - c.entry) / dist).toFixed(2) : "—";
  out.innerHTML = `
    <div class="hl"><small>Lot hajmi</small>${lot >= 0.01 ? lot.toFixed(2) : "0.01 dan kam — risk juda katta"}</div>
    <div><small>SL masofasi</small>${dist.toFixed(2)} $ (${(dist * 10).toFixed(0)} pips)</div>
    <div><small>SL bo'lsa zarar</small><span class="neg">−${money(loss)}</span></div>
    <div><small>TP1 foyda</small><span class="pos">+${money(p1)}</span></div>
    <div><small>TP2 foyda</small><span class="pos">+${money(p2)}</span></div>
    <div><small>R:R (TP1)</small>1 : ${rr}</div>`;
}

// ---- Streaming helper shared by chat and coach. ----
async function streamChat(messages, context, onText) {
  const res = await api("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, context }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Xato ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    onText(text);
  }
  return text;
}

// ---- Daily market brief. ----
$("briefBtn").onclick = async () => {
  $("briefBtn").disabled = true;
  $("briefOut").innerHTML = `<p><span class="spinner"></span>Forex Factory kalendari va yangiliklari o'qilmoqda... (30–90 soniya)</p>`;
  try {
    const res = await api("/api/brief", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Xato ${res.status}`);
    const n = body.news;
    $("briefOut").innerHTML = `
      <p class="muted">Tayyorlangan: ${esc(new Date(body.at).toLocaleString())}</p>
      ${n.calendarError ? `<p class="error">${esc(n.calendarError)}</p>` : ""}
      <div class="news brief">${fmt(n.text)}</div>
      ${n.sources.length ? `<p class="sources">Manbalar: ${n.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join(" · ")}</p>` : ""}`;
  } catch (err) {
    $("briefOut").innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    $("briefBtn").disabled = false;
  }
};

// ---- AI coach over the trade journal. ----
$("coachBtn").onclick = async () => {
  const j = loadJournal();
  if (!j.some((e) => e.result)) {
    $("coachOut").innerHTML = `<p class="hint">Avval kamida bir nechta savdoni TP yoki SL deb belgilang.</p>`;
    return;
  }
  $("coachBtn").disabled = true;
  $("coachOut").innerHTML = `<div class="news"><span class="spinner"></span>Jurnal tahlil qilinmoqda...</div>`;
  try {
    await streamChat(
      [{ role: "user", text: "Savdo jurnalimni murabbiy sifatida tahlil qil: win rate, eng yaxshi va eng yomon strategiya/timeframe/yo'nalish, takrorlanayotgan xatolar va aniq tavsiyalar." }],
      { journal: j.slice(0, 200) },
      (t) => ($("coachOut").innerHTML = `<div class="news">${fmt(t)}</div>`),
    );
  } catch (err) {
    $("coachOut").innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    $("coachBtn").disabled = false;
  }
};

// ---- Quick prompts in chat. ----
$("chips").querySelectorAll("button").forEach((b) => (b.onclick = () => {
  $("chatText").value = b.dataset.q;
  $("chatSend").click();
}));
