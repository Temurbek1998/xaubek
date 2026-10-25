const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1H", "4H", "1D", "1W", "1M"];
const KEY_STORAGE = "xau_claude_key";
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

try { $("apiKey").value = localStorage.getItem(KEY_STORAGE) || ""; } catch {}
$("saveKey").onclick = () => {
  try { localStorage.setItem(KEY_STORAGE, $("apiKey").value.trim()); } catch {}
  $("saveKey").textContent = "Saqlandi ✓";
  setTimeout(() => ($("saveKey").textContent = "Saqlash"), 1500);
};

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
}));

function alertMsg(msg) {
  showResultCard();
  $("result").innerHTML = `<p class="error">${esc(msg)}</p>`;
}

let strategyLabels = {};
fetch("/api/strategies").then((r) => r.json()).then((list) => {
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
  [...(e.clipboardData?.items || [])].filter((it) => it.kind === "file").forEach((it) => addFile(it.getAsFile()));
});

$("analyze").onclick = async () => {
  const key = $("apiKey").value.trim();
  if (!key) return alertMsg("Avval Claude API kalitini kiriting.");
  const strategies = selectedStrategies();
  if (strategies.length === 0) return alertMsg("Kamida bitta strategiyani tanlang.");
  // Send higher timeframes first so Claude reads them top-down.
  const sorted = [...images].sort((a, b) => TIMEFRAMES.indexOf(b.timeframe) - TIMEFRAMES.indexOf(a.timeframe));
  const useNews = $("useNews").checked;
  $("analyze").disabled = true;
  showResultCard();
  $("result").innerHTML = `<p><span class="spinner"></span>Claude ${sorted.length} ta grafikni ${strategies.length} ta strategiya bo'yicha tahlil qilmoqda${useNews ? ", kun yangiliklarini qidirmoqda" : ""}... (1–4 daqiqa)</p>`;
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-claude-key": key },
      body: JSON.stringify({
        note: $("note").value.trim(),
        strategies,
        useNews,
        images: sorted.map(({ mediaType, data, timeframe }) => ({ mediaType, data, timeframe })),
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Xato ${res.status}`);
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
function drawChart(canvas, img, drawings) {
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
}

function renderCharts(a, sent) {
  const box = $("charts");
  const byImage = sent.map((img, i) => ({ img, i, drawings: (a.drawings || []).filter((d) => d.image_index === i + 1) }))
    .filter((x) => x.drawings.length);
  // Show the recommended entry timeframe first.
  byImage.sort((x, y) => (y.img.timeframe === a.recommended_entry_timeframe) - (x.img.timeframe === a.recommended_entry_timeframe));
  if (!byImage.length) { box.innerHTML = `<p class="hint">Chizmalar qaytarilmadi.</p>`; return; }
  box.innerHTML = "";
  for (const { img, i, drawings } of byImage) {
    const fig = document.createElement("div");
    fig.className = "chart";
    fig.innerHTML = `<figure><figcaption><span>${esc(img.timeframe)} — Rasm ${i + 1}</span><a href="#" download="XAUUSD_${esc(img.timeframe)}_tahlil.png">PNG yuklab olish</a></figcaption><canvas></canvas></figure>`;
    box.appendChild(fig);
    const el = new Image();
    el.onload = () => {
      const canvas = fig.querySelector("canvas");
      drawChart(canvas, el, drawings);
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
    <p class="hint">Chiziqlar AI tomonidan rasmdagi narx shkalasiga qarab taxminan joylashtirilgan — aniq narxlar uchun "Savdo rejasi" raqamlariga qarang.</p>
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
    <h3>Timeframe'lar bo'yicha</h3>
    <div class="tfwrap"><table class="tfs">
      <tr><th>TF</th><th>Trend</th><th>Asosiy darajalar</th><th>Izoh</th></tr>
      ${a.timeframes.map((t) => `<tr><td><b>${esc(t.timeframe)}</b></td><td>${badge(t.trend)}</td><td>${esc(t.key_levels)}</td><td>${esc(t.notes)}</td></tr>`).join("")}
    </table></div>
    <h3>Risklar</h3>
    <ul>${a.risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`;
  renderCharts(a, sent);
  const bar = document.createElement("div");
  bar.className = "journal-add";
  bar.innerHTML = p.direction === "WAIT" ? "" : `<button class="secondary">Jurnalga qo'shish (natijani keyin belgilash uchun)</button>`;
  $("result").appendChild(bar);
  bar.querySelector("button")?.addEventListener("click", (e) => {
    addJournal({ id: Date.now(), date: new Date().toISOString(), tf: a.recommended_entry_timeframe, direction: p.direction,
      entry: p.entry, sl: p.stop_loss, tp: p.take_profit_1, strategy: a.best_strategy, confidence: a.confidence, result: null });
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
