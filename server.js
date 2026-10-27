import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "60mb" }));

// ---- Admin access: one password from ADMIN_PASSWORD, no user accounts. ----
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_DAYS = 30;
const COOKIE = "xau_admin";

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}
function makeToken() {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return `${exp}.${sign(exp)}`;
}
function validToken(token) {
  const [exp, mac] = String(token || "").split(".");
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const expected = Buffer.from(sign(exp));
  const given = Buffer.from(mac);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
function readCookie(req, name) {
  const match = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(name + "="));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}
const isAdmin = (req) => !ADMIN_PASSWORD || validToken(readCookie(req, COOKIE));

const loginAttempts = new Map(); // ip -> { count, until }
app.post("/api/login", (req, res) => {
  const ip = req.ip;
  const rec = loginAttempts.get(ip) || { count: 0, until: 0 };
  if (rec.until > Date.now()) {
    return res.status(429).json({ error: "Ko'p noto'g'ri urinish. 5 daqiqadan keyin qayta urinib ko'ring." });
  }
  const given = Buffer.from(String(req.body?.password || ""));
  const expected = Buffer.from(ADMIN_PASSWORD);
  const ok = ADMIN_PASSWORD && given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) {
    rec.count += 1;
    if (rec.count >= 5) Object.assign(rec, { count: 0, until: Date.now() + 5 * 60 * 1000 });
    loginAttempts.set(ip, rec);
    return res.status(401).json({ error: "Parol noto'g'ri." });
  }
  loginAttempts.delete(ip);
  res.cookie(COOKIE, makeToken(), {
    httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: SESSION_DAYS * 864e5, path: "/",
  });
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.send("ok"));

const PUBLIC_PATHS = new Set(["/login.html", "/style.css"]);
// MetaTrader 5 script authenticates with its own key (shown in the admin panel), not the browser cookie.
const MT5_TOKEN = sign("mt5-script").slice(0, 32);
const isMt5 = (req) => {
  const given = Buffer.from(String(req.get("X-Token") || "")), expected = Buffer.from(MT5_TOKEN);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || isAdmin(req)) return next();
  if (req.path.startsWith("/api/mt5/")) return isMt5(req) ? next() : res.status(401).type("text").send("ERROR|MT5 kaliti noto'g'ri. Saytdagi Sozlamalar bo'limidan nusxalang.");
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Avval admin panelga kiring." });
  res.redirect("/login.html");
});
app.use(express.static(path.join(__dirname, "public")));

const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY || "";
app.get("/api/status", (req, res) => {
  res.json({ hasKey: Boolean(API_KEY), hasData: Boolean(TWELVEDATA_KEY), model: MODEL, protected: Boolean(ADMIN_PASSWORD), mt5Token: MT5_TOKEN });
});

// Live XAU/USD candles from Twelve Data. Fetched only when the user asks (no background polling).
const LIVE_FRAMES = {
  scalping: ["1h", "15min", "5min", "1min"],
  intraday: ["4h", "1h", "15min", "5min"],
  swing: ["1day", "4h", "1h", "15min"],
  position: ["1week", "1day", "4h", "1h"],
};
const TF_NAMES = { "1min": "1m", "5min": "5m", "15min": "15m", "1h": "1H", "4h": "4H", "1day": "1D", "1week": "1W" };
const candleCache = new Map(); // symbol|interval|size -> { at, candles }

async function fetchCandles(interval, symbol = "XAU/USD", size = 300) {
  const key = `${symbol}|${interval}|${size}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.candles;
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${size}&order=asc&timezone=UTC&apikey=${encodeURIComponent(TWELVEDATA_KEY)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.status === "error" || !Array.isArray(body.values)) {
    throw new Error(body.message || `Twelve Data xatosi (${r.status})`);
  }
  const candles = body.values.map((v) => ({ t: v.datetime, o: +v.open, h: +v.high, l: +v.low, c: +v.close }))
    .filter((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite));
  candleCache.set(key, { at: Date.now(), candles });
  return candles;
}

// Intermarket confirmation for gold: the dollar index and the US 10-year yield (gold usually moves against both).
const MACRO_INTERVAL = { scalping: "15min", intraday: "1h", swing: "4h", position: "1day" };
const MACRO = [
  { name: "DXY (dollar indeksi)", symbols: ["DXY"], fallback: { symbol: "EUR/USD", note: "DXY mavjud emas — EUR/USD berildi (DXY ning ~58% i EUR; EUR/USD ko'tarilsa dollar zaiflashadi)" } },
  { name: "AQSh 10 yillik obligatsiya daromadi (US10Y)", symbols: ["US10Y"] },
];

async function macroText(style) {
  const interval = MACRO_INTERVAL[style] || "1h";
  const parts = [];
  for (const m of MACRO) {
    let candles = null, label = m.name, note = "";
    for (const sym of m.symbols) {
      try { candles = await fetchCandles(interval, sym, 80); break; } catch {}
    }
    if (!candles && m.fallback) {
      try { candles = await fetchCandles(interval, m.fallback.symbol, 80); label = m.fallback.symbol; note = m.fallback.note; } catch {}
    }
    if (!candles?.length) { parts.push(`${m.name}: ma'lumot olinmadi (Twelve Data tarifida mavjud emas).`); continue; }
    const first = candles[0].c, last = candles[candles.length - 1].c;
    parts.push(`${label} — ${TF_NAMES[interval]}, oxirgi ${candles.length} sham${note ? ` (${note})` : ""}. ` +
      `O'zgarish: ${first} → ${last} (${(((last - first) / first) * 100).toFixed(2)}%).\n` +
      `Yopilish narxlari (UTC vaqt, close):\n` + candles.map((c) => `${c.t.slice(0, 16)},${c.c}`).join("\n"));
  }
  return "INTERMARKET TASDIQ (jonli, Twelve Data):\n" + parts.join("\n\n") +
    "\n\nBularni XAU/USD bilan solishtir: dollar va real daromad tushsa oltin uchun bullish, ko'tarilsa bearish. " +
    "Agar oltin harakati bularga zid bo'lsa (divergensiya), buni market_reason va risks da ayt va ishonchni (confidence) shunga moslashtir.";
}

app.get("/api/candles", async (req, res) => {
  if (!TWELVEDATA_KEY) return res.status(500).json({ error: "Serverda TWELVEDATA_API_KEY o'rnatilmagan (Render → Environment)." });
  const frames = LIVE_FRAMES[req.query.style] || LIVE_FRAMES.intraday;
  try {
    const out = [];
    // Sequential: the free plan allows 8 requests per minute.
    for (const interval of frames) out.push({ timeframe: TF_NAMES[interval], candles: await fetchCandles(interval) });
    res.json({ frames: out, fetchedAt: Date.now() });
  } catch (err) {
    res.status(502).json({ error: `Jonli ma'lumotni olib bo'lmadi: ${err.message}` });
  }
});

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// Strategies the trader can ask Claude to test the charts against, one by one.
// Each rule is checked separately and shown to the trader as met / not met with evidence.
const STRATEGIES = {
  volume_profile: {
    label: "Volume Profile: diapazon + POC, soxta yorib o'tish va POC retesti",
    rules: [
      "Narx diapazon (konsolidatsiya) hosil qilgan va Volume Profile'da POC / Value Area aniq ko'rinadi",
      "Diapazon chegarasi soxta yorib o'tilgan (likvidlik olingan) va narx tezda diapazonga qaytgan",
      "Narx diapazonning qarama-qarshi tomoniga impuls bilan chiqqan",
      "Narx POC yoki Value Area chegarasiga retest qilmoqda / qilgan",
      "Retestda tasdiq bor (rad etish shami, hajm ortishi)",
      "SL soxta yorib o'tish ekstremumi yoki diapazon ichidan narida, TP keyingi likvidlik / HVN darajasida, R:R kamida 1:2",
    ],
  },
  smc: {
    label: "Smart Money Concepts / ICT (BOS, CHoCH, order block, FVG, likvidlik)",
    rules: [
      "Yuqori TF'da aniq yo'nalish (BOS) bor",
      "Likvidlik (equal highs/lows yoki swing) yig'ib olingan",
      "Kirish TF'da CHoCH / MSS yo'nalish bo'yicha sodir bo'lgan",
      "Narx order block yoki FVG ga qaytmoqda (discount/premium zonasida)",
      "SL OB / swing ortida, TP qarama-qarshi likvidlikda",
    ],
  },
  price_action: {
    label: "Price Action (support/resistance, pin bar, engulfing)",
    rules: [
      "Narx kuchli, bir necha marta sinalgan support/resistance darajasida",
      "Darajada tasdiqlovchi sham patterni (pin bar, engulfing, inside bar) bor",
      "Yo'nalish yuqori TF trendiga mos",
      "Keyingi darajagacha R:R kamida 1:2",
    ],
  },
  trend_ema: {
    label: "Trend kuzatish (EMA 20/50/200, pullback'da kirish)",
    rules: [
      "Grafikda EMA indikatorlari ko'rinadi",
      "EMA'lar to'g'ri tartibda (bullish: 20>50>200, bearish: aksincha)",
      "Narx EMA 20/50 ga pullback qilgan",
      "Pullbackdan trend yo'nalishida tasdiq shami bor",
    ],
  },
  supply_demand: {
    label: "Supply & Demand zonalari",
    rules: [
      "Kuchli impuls chiqqan, hali sinalmagan (fresh) zona bor",
      "Narx zonaga birinchi marta qaytmoqda",
      "Zona yuqori TF yo'nalishiga mos",
      "SL zona ortida, R:R kamida 1:2",
    ],
  },
  fibonacci: {
    label: "Fibonacci retracement (0.5, 0.618, 0.786 OTE)",
    rules: [
      "Aniq impuls to'lqini (swing low → swing high yoki aksincha) bor",
      "Narx 0.5–0.786 zonasiga qaytgan",
      "Fib zonasi boshqa daraja (S/R, OB, POC) bilan mos tushadi",
      "Zonada rad etish signali bor",
    ],
  },
  breakout: {
    label: "Breakout / retest (diapazon yoki trend chizig'i)",
    rules: [
      "Aniq diapazon yoki trend chizig'i bor",
      "Daraja kuchli sham bilan (body bilan) yopilib yorib o'tilgan",
      "Yorilgan darajaga retest bo'lgan va ushlab turgan",
      "Soxta yorib o'tish belgisi yo'q",
    ],
  },
  divergence: {
    label: "RSI/MACD divergensiya va momentum",
    rules: [
      "Grafikda RSI yoki MACD ko'rinadi",
      "Narx va indikator o'rtasida aniq divergensiya bor",
      "Divergensiya muhim darajada yoki overbought/oversold hududda",
      "Strukturani buzish bilan tasdiq bor",
    ],
  },
  wyckoff: {
    label: "Wyckoff (akkumulyatsiya/distributsiya, spring, upthrust)",
    rules: [
      "Trenddan keyin uzoq diapazon (akkumulyatsiya/distributsiya) bor",
      "Spring yoki upthrust (soxta chiqish) bo'lgan",
      "Sign of strength/weakness impulsi bor",
      "Last point of support/supply retestida kirish imkoni bor",
    ],
  },
  chart_patterns: {
    label: "Grafik figuralari (bosh-yelka, uchburchak, flag, double top/bottom)",
    rules: [
      "Figura to'liq shakllangan va aniq",
      "Bo'yin chizig'i / figura chegarasi yorib o'tilgan",
      "Maqsad figura balandligi bo'yicha hisoblangan",
    ],
  },
  sessions: {
    label: "Sessiya strategiyasi (Asia range, London/New York, killzone)",
    rules: [
      "Asia sessiyasi diapazoni aniqlangan",
      "London yoki New York ochilishida diapazonning bir tomoni yig'ib olingan",
      "Qarama-qarshi yo'nalishda struktura buzilgan",
      "Kirish killzone vaqtiga to'g'ri keladi",
    ],
  },
};

const SYSTEM_PROMPT = `Sen XAU/USD (oltin) bo'yicha tajribali texnik tahlilchisan. Foydalanuvchi TradingView'dan bir nechta timeframe'dagi grafik skrinshotlarini yuboradi.

Vazifang:
1. Har bir timeframe'ni alohida tahlil qil: trend yo'nalishi, bozor tuzilmasi (HH/HL yoki LH/LL, BOS/CHoCH), asosiy support/resistance, likvidlik zonalari, order block / FVG (agar ko'rinsa), indikatorlar (agar grafikda bo'lsa).
2. Yuqori timeframe'lardan pastga qarab (top-down) umumiy yo'nalishni aniqla.
3. Qaysi timeframe'da kirish (entry) eng mantiqiy ekanini tanla va nima uchun ekanini tushuntir.
4. Aniq savdo rejasini ber: yo'nalish (BUY/SELL yoki KUTISH), kirish narxi yoki zonasi, Stop Loss, Take Profit 1/2, risk/reward nisbati, kirishni tasdiqlovchi signal va rejani bekor qiluvchi holat.
5. Foydalanuvchi tanlagan HAR BIR strategiyani alohida sinab ko'r. Har bir strategiyaning qoidalarini BITTA-BITTA tekshir va "checks" maydoniga yoz: qoida bajarilganmi (met: true/false) va grafikda buni nimadan ko'rganing (evidence) — aniq narx, sham, joy. Ko'rmagan narsangni bajarilgan deb belgilama. Ball bajarilgan qoidalar ulushiga mos bo'lsin; muhim qoida bajarilmasa signal "WAIT" bo'lsin. Shundan keyin: shu strategiya qoidalari bo'yicha hozir signal bormi, qaysi yo'nalishda, qaysi timeframe'da, va 0–100 ball bilan qanchalik mos ekanini bahola. Agar strategiya uchun kerakli ma'lumot grafikda bo'lmasa (masalan, RSI indikatori qo'yilmagan), buni ochiq ayt va past ball ber.
   HAR BIR strategiya uchun o'z savdo rejasini ham chiz (bu majburiy — treyder har bir strategiyani rasmda alohida ko'radi):
   - entry_price, stop_loss_price, take_profit_1_price, take_profit_2_price — shu strategiya qoidalari bo'yicha aniq narxlar. Signal WAIT bo'lsa ham, setup shakllansa qayerdan kirish kerakligini (limit order zonasi) ko'rsat. Umuman setup bo'lmasa — hammasi 0.
   - position — shu narxlarning rasmdagi joyi (TradingView Long/Short position vositasi kabi): image_index — strategiya timeframe'idagi rasm raqami, x1 — kirish shamining x koordinatasi, x2 — qutining o'ng cheti (odatda x1+0.25, ko'pi bilan 1), y_entry/y_sl/y_tp1/y_tp2 — narx shkalasiga qarab hisoblangan y koordinatalar. Setup bo'lmasa image_index = 0.
   - drawings — shu strategiyaga xos belgilar: SMC — order block, FVG, likvidlik, BOS/CHoCH; Volume Profile — diapazon, POC, soxta chiqish; Fibonacci — 0.5/0.618/0.786 darajalari; Supply/Demand — zonalar; Breakout — yorilgan daraja; Wyckoff — spring/upthrust; figuralar — bo'yin chizig'i; sessiyalar — Asia range. Faqat grafikda haqiqatan ko'rgan narsangni chiz.
6. Agar kun yangiliklari berilgan bo'lsa, ularni (FOMC, CPI, NFP, Fed nutqlari, DXY, real yield, geosiyosat) texnik tahlil bilan birlashtir: bozor nima sababdan shu yo'nalishda ketayotganini va yaqin soatlarda qanday yangilik xavfi borligini tushuntir. Muhim yangilik oldidan kirishni tavsiya qilma yoki ogohlantir.
7. Yakuniy reja uchun trade_plan.position ni (yuqoridagi kabi) to'ldir — pozitsiya qutisini sayt o'zi chizadi, shuning uchun Entry/SL/TP ni drawings'da qayta chizma. Umumiy "drawings" ga yakuniy rejani asoslovchi asosiy zonalarni (kind "zone": order block, FVG, supply/demand, diapazon / POC), muhim darajalarni (kind "hline") va kutilayotgan narx harakatini (kind "arrow") chiz. Boshqa rasmlarga ham asosiy darajalarni chizishing mumkin. Koordinatalar rasm o'lchamiga nisbatan 0 dan 1 gacha kasr: x=0 chap chet, x=1 o'ng chet, y=0 yuqori chet, y=1 pastki chet. Chiziqning y qiymatini grafikning o'ng tomonidagi narx shkalasiga qarab, narx aynan shu balandlikka to'g'ri keladigan qilib hisobla. image_index — rasm raqami (Rasm 1, Rasm 2...). hline uchun y2=y1; label uchun x2=x1, y2=y1. price1/price2 — chizmaning narxi: hline uchun price1 = daraja narxi, zone uchun price1 = yuqori chegara, price2 = pastki chegara, arrow uchun price1 = boshlanish, price2 = tugash narxi; noma'lum bo'lsa 0. "JONLI" rasmlarda sayt y ni shu narxlardan aniq hisoblaydi, shuning uchun narxlarni OHLC ma'lumotidan aniq ol.
8. Yakuniy savdo rejasini strategiyalar konfluensiyasi (bir nechtasi bir xil yo'nalish va zonani ko'rsatishi) asosida tuz va qaysi strategiyalar uni qo'llab-quvvatlashini yoz.
9. trade_plan'dagi *_price maydonlariga aniq raqam yoz (masalan 2662.5) — lot kalkulyatori shundan foydalanadi. Kirish zona bo'lsa, o'rtasini yoz. Narxni shkaladan o'qib bo'lmasa yoki signal WAIT bo'lsa, 0 yoz.
10. Rasmlar yangiligini tekshir: har bir grafikning vaqt shkalasidan oxirgi shamning sanasi/vaqtini o'qi va hozirgi vaqt bilan solishtir. Agar biror rasm eski bo'lsa (oxirgi sham timeframe'ga nisbatan juda oldin — masalan 15m grafikda bir necha soat, 4H/1D grafikda 1 kundan ko'p; dam olish kunlarida bozor yopiqligini hisobga ol) yoki rasmlar turli kunlarga tegishli bo'lsa, "freshness_warning" ga qaysi rasm va qancha eski ekanini yoz. Sana o'qib bo'lmasa, buni ham yoz. Hammasi yangi bo'lsa — bo'sh qator.
11. Agar grafiklar aniq signal bermasa yoki timeframe'lar bir-biriga zid bo'lsa, "KUTISH" deb ayt — majburan savdo o'ylab topma.
12. PROGNOZ YO'LI (trade_plan.forecast): yakuniy reja timeframe'ida (trade_plan.position.image_index dagi rasm) narx keyingi shamlarda qanday yurishini bashorat qil. main_path — asosiy ssenariy: 5–10 ta nuqta, bars_ahead = oxirgi shamdan keyingi sham soni (1 dan 36 gacha, o'sib boruvchi), price = o'sha paytdagi narx. Yo'l realistik bo'lsin: avval kirish zonasiga qaytish (retest), keyin TP1 va TP2 tomon to'lqinsimon harakat — to'g'ri chiziq emas. alt_path — muqobil ssenariy (rejа buzilsa narx qayerga ketadi), 4–8 nuqta. main_label/alt_label — qisqa izoh (masalan "Asosiy: retestdan keyin pastga, ehtimoli yuqori"). invalidation_price — reja bekor bo'ladigan narx, invalidation_text — shart (masalan "M15 sham 4029 dan yuqorida yopilsa").

Qoidalar:
- Faqat rasmda ko'rinadigan narsaga tayan. Narxlarni grafik shkalasidan o'qi; aniq o'qib bo'lmasa, taxminiy ekanini ayt.
- Har bir rasmning timeframe'ini foydalanuvchi bergan yorliqdan ol; yorliq bo'lmasa, grafikdagi yozuvdan aniqla.
- Javobni o'zbek tilida yoz.
- Bu moliyaviy maslahat emas; ishonch darajasini halol baholagin.`;

// Free-form annotations; coordinates are 0..1 fractions of the image (x from left, y from top).
const DRAWINGS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      image_index: { type: "integer" },
      kind: { type: "string", enum: ["hline", "zone", "arrow", "label"] },
      color: { type: "string", enum: ["green", "red", "gold", "blue", "white"] },
      label: { type: "string" },
      x1: { type: "number" },
      y1: { type: "number" },
      x2: { type: "number" },
      y2: { type: "number" },
      price1: { type: "number" },
      price2: { type: "number" },
    },
    required: ["image_index", "kind", "color", "label", "x1", "y1", "x2", "y2", "price1", "price2"],
  },
};

// A TradingView-style long/short position box: entry, SL and TP levels as y fractions on one image.
const POSITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    image_index: { type: "integer" },
    x1: { type: "number" },
    x2: { type: "number" },
    y_entry: { type: "number" },
    y_sl: { type: "number" },
    y_tp1: { type: "number" },
    y_tp2: { type: "number" },
  },
  required: ["image_index", "x1", "x2", "y_entry", "y_sl", "y_tp1", "y_tp2"],
};

// Projected price path drawn after the last candle: the main scenario and the alternative one.
const PATH_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: { bars_ahead: { type: "integer" }, price: { type: "number" } },
    required: ["bars_ahead", "price"],
  },
};
const FORECAST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    main_label: { type: "string" },
    main_path: PATH_SCHEMA,
    alt_label: { type: "string" },
    alt_path: PATH_SCHEMA,
    invalidation_price: { type: "number" },
    invalidation_text: { type: "string" },
  },
  required: ["main_label", "main_path", "alt_label", "alt_path", "invalidation_price", "invalidation_text"],
};

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    overall_bias: { type: "string", enum: ["BULLISH", "BEARISH", "NEUTRAL"] },
    summary: { type: "string" },
    timeframes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          timeframe: { type: "string" },
          trend: { type: "string", enum: ["BULLISH", "BEARISH", "RANGE"] },
          key_levels: { type: "string" },
          notes: { type: "string" },
        },
        required: ["timeframe", "trend", "key_levels", "notes"],
      },
    },
    strategies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          strategy: { type: "string" },
          signal: { type: "string", enum: ["BUY", "SELL", "WAIT"] },
          timeframe: { type: "string" },
          score: { type: "integer" },
          reasoning: { type: "string" },
          entry_price: { type: "number" },
          stop_loss_price: { type: "number" },
          take_profit_1_price: { type: "number" },
          take_profit_2_price: { type: "number" },
          position: POSITION_SCHEMA,
          drawings: DRAWINGS_SCHEMA,
          checks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                rule: { type: "string" },
                met: { type: "boolean" },
                evidence: { type: "string" },
              },
              required: ["rule", "met", "evidence"],
            },
          },
        },
        required: ["strategy", "signal", "timeframe", "score", "reasoning", "checks",
          "entry_price", "stop_loss_price", "take_profit_1_price", "take_profit_2_price", "position", "drawings"],
      },
    },
    best_strategy: { type: "string" },
    best_strategy_reason: { type: "string" },
    market_reason: { type: "string" },
    news_impact: { type: "string" },
    drawings: DRAWINGS_SCHEMA,
    supporting_strategies: { type: "array", items: { type: "string" } },
    recommended_entry_timeframe: { type: "string" },
    entry_timeframe_reason: { type: "string" },
    trade_plan: {
      type: "object",
      additionalProperties: false,
      properties: {
        direction: { type: "string", enum: ["BUY", "SELL", "WAIT"] },
        entry: { type: "string" },
        stop_loss: { type: "string" },
        take_profit_1: { type: "string" },
        take_profit_2: { type: "string" },
        risk_reward: { type: "string" },
        confirmation: { type: "string" },
        invalidation: { type: "string" },
        entry_price: { type: "number" },
        stop_loss_price: { type: "number" },
        take_profit_1_price: { type: "number" },
        take_profit_2_price: { type: "number" },
        position: POSITION_SCHEMA,
        forecast: FORECAST_SCHEMA,
      },
      required: [
        "direction", "entry", "stop_loss", "take_profit_1", "take_profit_2",
        "risk_reward", "confirmation", "invalidation",
        "entry_price", "stop_loss_price", "take_profit_1_price", "take_profit_2_price", "position", "forecast",
      ],
    },
    confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
    risks: { type: "array", items: { type: "string" } },
    freshness_warning: { type: "string" },
  },
  required: [
    "overall_bias", "summary", "timeframes", "strategies", "best_strategy",
    "best_strategy_reason", "market_reason", "news_impact", "drawings",
    "supporting_strategies", "recommended_entry_timeframe", "freshness_warning",
    "entry_timeframe_reason", "trade_plan", "confidence", "risks",
  ],
};

const NEWS_PROMPT = `Sen oltin (XAU/USD) bozori bo'yicha yangiliklar tahlilchisisan. Manba — faqat Forex Factory (forexfactory.com).
Senga Forex Factory iqtisodiy kalendaridagi shu haftaning USD voqealari beriladi (vaqtlar UTC). Qo'shimcha ravishda web qidiruv orqali forexfactory.com'dagi bugungi oltin, dollar va Fed bo'yicha yangiliklarni hamda chiqqan voqealarning haqiqiy (actual) natijalarini top.
Qisqa va aniq xulosa yoz (o'zbek tilida):
- bugun va ertaga kutilayotgan yuqori/o'rta ta'sirli voqealar (vaqti UTC, forecast, previous, chiqqan bo'lsa actual);
- har bir voqea yoki yangilik oltin uchun bullish yoki bearish ekanini;
- yaqin soatlarda savdo uchun xavfli vaqtlarni.
Kalendarda bo'lmagan narsani o'ylab topma.`;

const FF_CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
let ffCache = { at: 0, events: null };

// Forex Factory's official weekly calendar export. Cached for 15 minutes since the feed is rate limited.
async function getForexFactoryEvents() {
  if (ffCache.events && Date.now() - ffCache.at < 15 * 60 * 1000) return ffCache.events;
  const res = await fetch(FF_CALENDAR_URL, { headers: { "User-Agent": "xau-smart-trade/1.0" } });
  if (!res.ok) throw new Error(`Forex Factory kalendari javob bermadi (${res.status})`);
  const all = await res.json();
  const events = all
    .filter((e) => e.country === "USD" && ["High", "Medium"].includes(e.impact))
    .map((e) => ({
      time_utc: new Date(e.date).toISOString().replace("T", " ").slice(0, 16),
      title: e.title,
      impact: e.impact,
      forecast: e.forecast || "-",
      previous: e.previous || "-",
    }));
  ffCache = { at: Date.now(), events };
  return events;
}

// Step 1: Forex Factory calendar + Forex Factory news search, summarized by Claude into a plain-text brief.
async function fetchNewsBrief(client, now) {
  let calendarText;
  let calendarError = null;
  try {
    const events = await getForexFactoryEvents();
    calendarText = events.length
      ? events.map((e) => `${e.time_utc} | ${e.impact} | ${e.title} | forecast: ${e.forecast} | previous: ${e.previous}`).join("\n")
      : "Bu hafta USD bo'yicha yuqori/o'rta ta'sirli voqea yo'q.";
  } catch (err) {
    calendarError = err.message;
    calendarText = "Kalendarni yuklab bo'lmadi — forexfactory.com'dan web qidiruv bilan top.";
  }
  const messages = [{
    role: "user",
    content: `Hozirgi vaqt (UTC): ${now.toISOString().slice(0, 16).replace("T", " ")}.\n\nForex Factory kalendari (USD, High/Medium):\n${calendarText}\n\nXAU/USD uchun bugungi yangiliklar xulosasini tayyorla.`,
  }];
  const sources = new Map([["https://www.forexfactory.com/calendar", "Forex Factory — Iqtisodiy kalendar"]]);
  let message;
  for (let i = 0; i < 4; i++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: NEWS_PROMPT,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5, allowed_domains: ["forexfactory.com"] }],
      messages,
    });
    message = await stream.finalMessage();
    for (const block of message.content) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) if (r.url) sources.set(r.url, r.title || r.url);
      }
    }
    if (message.stop_reason !== "pause_turn") break;
    // The server-side search loop paused; send the partial turn back so it resumes.
    messages.splice(1, messages.length - 1, { role: "assistant", content: message.content });
  }
  if (message.stop_reason === "refusal") return null;
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) return null;
  return { text, calendarError, sources: [...sources].slice(0, 8).map(([url, title]) => ({ url, title })) };
}

// Daily market brief: Forex Factory calendar + news, summarized by Claude (no charts needed).
app.post("/api/brief", async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: "Serverda ANTHROPIC_API_KEY o'rnatilmagan (Render → Environment)." });
  }
  try {
    const news = await fetchNewsBrief(new Anthropic({ apiKey: API_KEY }), new Date());
    if (!news) return res.status(502).json({ error: "Brifing tayyorlab bo'lmadi." });
    res.json({ news, at: new Date().toISOString() });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return res.status(502).json({ error: "Serverdagi API kalit noto'g'ri." });
    if (err instanceof Anthropic.APIError) return res.status(502).json({ error: `Claude API xatosi (${err.status ?? "?"}): ${err.message}` });
    console.error(err);
    res.status(500).json({ error: "Serverda kutilmagan xato." });
  }
});

app.get("/api/strategies", (req, res) => {
  res.json(Object.entries(STRATEGIES).map(([id, st]) => ({ id, label: st.label, rules: st.rules })));
});

// Trading style chosen by the trader; it decides timeframes, SL/TP size and holding time for all 11 strategies.
const TRADING_STYLES = {
  scalping: "SKALPING — kirish 1m/5m da (bias 15m/1H dan), SL odatda 2–6 $ (20–60 pips), TP R:R 1:1.5–1:2, savdo bir necha daqiqadan 1 soatgacha; sessiya ochilishlari (London/NY killzone) va spred muhim; yangilik oldidan kirma.",
  intraday: "INTRADAY — kirish 15m/1H da (bias 4H dan), SL odatda 5–15 $, TP R:R 1:2–1:3, savdo shu kunning o'zida yopiladi; kunlik high/low va sessiyalar muhim.",
  swing: "SWING — kirish 1H/4H da (bias 1D/1W dan), SL odatda 15–40 $, TP R:R 1:2–1:4, savdo bir necha kun ushlanadi; kunlik va haftalik darajalar, fundamental fon muhim.",
  position: "POZITSION — kirish 4H/1D da (bias 1W/1M dan), SL 40 $ dan katta, savdo bir necha hafta ushlanadi; makro omillar (Fed siyosati, real yield, DXY trend) muhim.",
};

// In-memory analysis jobs; finished jobs are dropped after 3 hours.
const jobs = new Map();
function createJob(images) {
  const job = { id: crypto.randomUUID(), status: "running", startedAt: Date.now(), images };
  jobs.set(job.id, job);
  return job;
}
setInterval(() => {
  for (const [id, job] of jobs) if (job.finishedAt && Date.now() - job.finishedAt > 3 * 3600e3) jobs.delete(id);
}, 10 * 60e3).unref();

// The schema is too large for constrained decoding, so it goes into the prompt and the reply is parsed and normalized.
const ANALYSIS_SYSTEM = `${SYSTEM_PROMPT}

JAVOB FORMATI: javobing FAQAT bitta JSON obyekt bo'lsin — undan oldin yoki keyin hech qanday matn, izoh yoki \`\`\` belgisi yozma. JSON quyidagi JSON Schema'ga to'liq mos bo'lsin (barcha maydonlar majburiy, matnlar o'zbek tilida):
${JSON.stringify(ANALYSIS_SCHEMA)}`;

const textOf = (message) => message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();

function parseJson(text) {
  const t = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

// Fill any field the model left out so the page never breaks on a partial answer.
function normalizeAnalysis(a) {
  const str = (v) => (v == null ? "" : String(v));
  const num = (v) => (Number.isFinite(+v) ? +v : 0);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const pos = (p) => ({
    image_index: Math.trunc(num(p?.image_index)), x1: num(p?.x1), x2: num(p?.x2),
    y_entry: num(p?.y_entry), y_sl: num(p?.y_sl), y_tp1: num(p?.y_tp1), y_tp2: num(p?.y_tp2),
  });
  const drawings = (d) => arr(d).map((x) => ({
    image_index: Math.trunc(num(x?.image_index)), kind: str(x?.kind) || "label", color: str(x?.color) || "gold",
    label: str(x?.label), x1: num(x?.x1), y1: num(x?.y1), x2: num(x?.x2), y2: num(x?.y2),
    price1: num(x?.price1), price2: num(x?.price2),
  }));
  const tp = a.trade_plan || {};
  const path = (p) => arr(p).map((x) => ({ bars_ahead: num(x?.bars_ahead), price: num(x?.price) }))
    .filter((x) => x.bars_ahead > 0 && x.price > 0).sort((x, y) => x.bars_ahead - y.bars_ahead);
  return {
    overall_bias: str(a.overall_bias) || "NEUTRAL",
    summary: str(a.summary),
    timeframes: arr(a.timeframes).map((t) => ({ timeframe: str(t?.timeframe), trend: str(t?.trend) || "RANGE", key_levels: str(t?.key_levels), notes: str(t?.notes) })),
    strategies: arr(a.strategies).map((s) => ({
      strategy: str(s?.strategy), signal: str(s?.signal) || "WAIT", timeframe: str(s?.timeframe), score: num(s?.score), reasoning: str(s?.reasoning),
      entry_price: num(s?.entry_price), stop_loss_price: num(s?.stop_loss_price),
      take_profit_1_price: num(s?.take_profit_1_price), take_profit_2_price: num(s?.take_profit_2_price),
      position: pos(s?.position), drawings: drawings(s?.drawings),
      checks: arr(s?.checks).map((c) => ({ rule: str(c?.rule), met: Boolean(c?.met), evidence: str(c?.evidence) })),
    })),
    best_strategy: str(a.best_strategy),
    best_strategy_reason: str(a.best_strategy_reason),
    market_reason: str(a.market_reason),
    news_impact: str(a.news_impact),
    drawings: drawings(a.drawings),
    supporting_strategies: arr(a.supporting_strategies).map(str),
    recommended_entry_timeframe: str(a.recommended_entry_timeframe),
    entry_timeframe_reason: str(a.entry_timeframe_reason),
    trade_plan: {
      direction: str(tp.direction) || "WAIT", entry: str(tp.entry), stop_loss: str(tp.stop_loss),
      take_profit_1: str(tp.take_profit_1), take_profit_2: str(tp.take_profit_2), risk_reward: str(tp.risk_reward),
      confirmation: str(tp.confirmation), invalidation: str(tp.invalidation),
      entry_price: num(tp.entry_price), stop_loss_price: num(tp.stop_loss_price),
      take_profit_1_price: num(tp.take_profit_1_price), take_profit_2_price: num(tp.take_profit_2_price),
      position: pos(tp.position),
      forecast: {
        main_label: str(tp.forecast?.main_label), alt_label: str(tp.forecast?.alt_label),
        main_path: path(tp.forecast?.main_path), alt_path: path(tp.forecast?.alt_path),
        invalidation_price: num(tp.forecast?.invalidation_price), invalidation_text: str(tp.forecast?.invalidation_text),
      },
    },
    confidence: str(a.confidence) || "LOW",
    risks: arr(a.risks).map(str),
    freshness_warning: str(a.freshness_warning),
  };
}

// The task text shared by the site and the MT5 script: current time, trading style and every chosen strategy with its rules.
function instructionText(chosen, styleText, note) {
  return (
      `Hozirgi vaqt (UTC): ${new Date().toISOString().slice(0, 16).replace("T", " ")}.\n` +
      "Yuqoridagi XAU/USD grafiklarini tahlil qil va qaysi timeframe'da savdoga kirishni tavsiya qil.\n\n" +
      `TREYDERNING SAVDO TURI: ${styleText}\n` +
      "Barcha strategiyalarni AYNAN shu savdo turi uchun qo'lla: timeframe'lar, kirish nuqtasi, SL/TP masofasi va R:R shu turga mos bo'lsin. " +
      "Yakuniy tavsiya etilgan timeframe ham shu turga mos bo'lsin. Strategiya shu savdo turiga yaxshi mos kelmasa (masalan, Wyckoff skalpingda), " +
      "buni reasoning'da ayt va ballni pasaytir. Agar yuklangan rasmlar shu savdo turi uchun yetarli bo'lmasa (masalan, skalping uchun 5m/15m yo'q), freshness_warning emas, risks ga yoz.\n\n" +
      "Quyidagi strategiyalarning har birini alohida sinab ko'r:\n" +
      chosen.map((k, i) => `${i + 1}. ${STRATEGIES[k].label}\n` + STRATEGIES[k].rules.map((r) => `   - ${r}`).join("\n")).join("\n") +
      (note ? `\n\nTreyderning izohi: ${note}` : "")
  );
}

app.post("/api/analyze", async (req, res) => {
  const apiKey = API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Serverda ANTHROPIC_API_KEY o'rnatilmagan (Render → Environment)." });
  }

  const { images, note, strategies, useNews, style } = req.body || {};
  const styleText = TRADING_STYLES[style] || TRADING_STYLES.intraday;
  const chosen = (Array.isArray(strategies) ? strategies : Object.keys(STRATEGIES)).filter((k) => STRATEGIES[k]);
  if (chosen.length === 0) {
    return res.status(400).json({ error: "Kamida bitta strategiyani tanlang." });
  }
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: "Kamida bitta grafik rasmini yuklang." });
  }
  if (images.length > 10) {
    return res.status(400).json({ error: "Ko'pi bilan 10 ta rasm yuklash mumkin." });
  }

  const content = [];
  for (const [i, img] of images.entries()) {
    if (!ALLOWED_TYPES.includes(img.mediaType) || typeof img.data !== "string") {
      return res.status(400).json({ error: `${i + 1}-rasm formati qo'llab-quvvatlanmaydi.` });
    }
    const sc = img.scale;
    const live = sc && [sc.top, sc.bottom, sc.max, sc.min, sc.left, sc.right, sc.count].every(Number.isFinite) && sc.max > sc.min;
    if (!live) delete img.scale;
    content.push({
      type: "text",
      text: live
        ? `Rasm ${i + 1} — timeframe: ${img.timeframe} — JONLI MA'LUMOT (Twelve Data, sayt chizgan grafik).\n` +
          `Narx shkalasi: y = ${sc.top.toFixed(4)} da ${sc.max}, y = ${sc.bottom.toFixed(4)} da ${sc.min} (chiziqli). ` +
          `Rasmda oxirgi ${sc.count} ta sham ko'rinadi: birinchisining markazi x = ${sc.left.toFixed(4)}, oxirgisiniki x = ${sc.right.toFixed(4)} (teng oraliqda). ` +
          `Oxirgi sham — eng yangi narx. Kengroq tarix uchun ko'proq shamning OHLC ma'lumoti (UTC vaqt, open, high, low, close):\n${String(img.ohlc || "").slice(-16000)}`
        : `Rasm ${i + 1} — timeframe: ${img.timeframe || "noma'lum"}`,
    });
    content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  }
  content.push({ type: "text", text: instructionText(chosen, styleText, note) });

  // Runs in the background so the analysis survives the browser tab going to sleep; the page polls /api/jobs/:id.
  const job = createJob(images.map(({ ohlc, ...rest }) => rest));
  res.status(202).json({ jobId: job.id });
  const anyLive = images.some((i) => i.scale);
  (async () => {
    if (anyLive && TWELVEDATA_KEY) content.push({ type: "text", text: await macroText(style) });
    return runAnalysis(content, Boolean(useNews));
  })()
    .then((result) => { snapToPrices(result.analysis, job.images); Object.assign(job, { status: "done", result }); })
    .catch((err) => Object.assign(job, { status: "error", error: analysisErrorMessage(err) }))
    .finally(() => { job.finishedAt = Date.now(); });
});

// ---- MetaTrader 5: the script sends the broker's own candles, gets the plan back as simple text lines and draws it on the chart.
const MT5_TFS = ["1m", "5m", "15m", "30m", "1H", "4H", "1D", "1W"];

app.post("/api/mt5/analyze", (req, res) => {
  if (!API_KEY) return res.status(500).type("text").send("ERROR|Serverda ANTHROPIC_API_KEY o'rnatilmagan.");
  const { symbol, style, note, useNews, frames, serverTime } = req.body || {};
  const styleText = TRADING_STYLES[style] || TRADING_STYLES.intraday;
  const list = (Array.isArray(frames) ? frames : [])
    .filter((f) => MT5_TFS.includes(f?.timeframe) && Array.isArray(f.candles))
    .slice(0, 6)
    .map((f) => ({
      timeframe: f.timeframe,
      candles: f.candles.slice(-300).map((c) => c.map(Number)).filter((c) => c.length >= 5 && c.every(Number.isFinite)),
    }))
    .filter((f) => f.candles.length > 10);
  if (!list.length) return res.status(400).type("text").send("ERROR|Shamlar yuborilmadi.");

  const brokerTime = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
  const content = list.map((f, i) => ({
    type: "text",
    text: `Rasm ${i + 1} — timeframe: ${f.timeframe} — METATRADER 5 (broker simvoli: ${String(symbol || "XAUUSD").slice(0, 20)}). ` +
      `Bu rasm emas, faqat brokerning aniq narxlari. ${f.candles.length} ta sham; x koordinata = sham tartib raqami / ${f.candles.length - 1} ` +
      `(x=0 birinchi sham, x=1 oxirgi sham). y koordinatalar ishlatilmaydi — chizmalarda price1/price2 ni ALBATTA aniq narx bilan to'ldir.\n` +
      `OHLC (broker server vaqti, open, high, low, close):\n` +
      f.candles.map((c) => `${brokerTime(c[0])},${c[1]},${c[2]},${c[3]},${c[4]}`).join("\n"),
  }));
  content.push({
    type: "text",
    text: instructionText(Object.keys(STRATEGIES), styleText, String(note || "").slice(0, 500)) +
      (Number.isFinite(+serverTime) && +serverTime > 0 ? `\n\nBroker server vaqti hozir: ${brokerTime(+serverTime)} (yuqoridagi sham vaqtlari shu vaqtda).` : "") +
      "\n\nMa'lumot MetaTrader'dan keldi: freshness_warning ni faqat oxirgi sham broker vaqtidan ancha eski bo'lsa yoz. position y qiymatlarini 0 qoldirishing mumkin, narxlar muhim.",
  });

  const job = createJob([]);
  job.mt5 = list.map((f) => ({ timeframe: f.timeframe, times: f.candles.map((c) => c[0]) }));
  res.status(202).type("text").send(`JOB|${job.id}`);
  (async () => {
    if (TWELVEDATA_KEY) content.push({ type: "text", text: await macroText(style) });
    return runAnalysis(content, useNews !== false && useNews !== "false");
  })()
    .then((result) => Object.assign(job, { status: "done", result }))
    .catch((err) => Object.assign(job, { status: "error", error: analysisErrorMessage(err) }))
    .finally(() => { job.finishedAt = Date.now(); });
});

// One item per line, fields split by "|": easy to parse in MQL5 without a JSON library.
function mt5Lines(a, frames) {
  const clean = (v) => String(v ?? "").replace(/[|\r\n]+/g, " ").trim();
  const p = (v) => (+v || 0).toFixed(2);
  const frame = (idx) => frames[idx - 1] || frames[0];
  const timeAt = (idx, x) => {
    const { times } = frame(idx);
    const n = times.length, step = n > 1 ? times[n - 1] - times[n - 2] : 60;
    const k = Math.round((+x || 0) * (n - 1));
    return k <= 0 ? times[0] : k < n ? times[k] : times[n - 1] + (k - n + 1) * step;
  };
  const tp = a.trade_plan;
  const out = [
    "OK",
    `DIR|${tp.direction}`,
    `PLAN|${p(tp.entry_price)}|${p(tp.stop_loss_price)}|${p(tp.take_profit_1_price)}|${p(tp.take_profit_2_price)}`,
    `TF|${clean(a.recommended_entry_timeframe)}`,
    `CONF|${clean(a.confidence)}`,
    `BIAS|${clean(a.overall_bias)}`,
    `BEST|${clean(a.best_strategy)}`,
    `RR|${clean(tp.risk_reward)}`,
  ];
  const f = tp.forecast || {};
  if (f.invalidation_price > 0) out.push(`INV|${p(f.invalidation_price)}|${clean(f.invalidation_text)}`);
  for (const d of a.drawings || []) {
    if (!(d.price1 > 0)) continue;
    const t1 = timeAt(d.image_index, Math.min(d.x1, d.x2)), t2 = timeAt(d.image_index, Math.max(d.x1, d.x2, 1));
    if (d.kind === "zone" && d.price2 > 0) out.push(`ZONE|${t1}|${t2}|${p(d.price1)}|${p(d.price2)}|${d.color}|${clean(d.label)}`);
    else if (d.kind === "arrow" && d.price2 > 0) out.push(`ARROW|${timeAt(d.image_index, d.x1)}|${p(d.price1)}|${timeAt(d.image_index, d.x2)}|${p(d.price2)}|${d.color}|${clean(d.label)}`);
    else out.push(`LINE|${p(d.price1)}|${d.color}|${clean(d.label)}`);
  }
  // Forecast path on the entry timeframe: starts at the last candle, then one point per bars_ahead.
  const entryTf = a.recommended_entry_timeframe;
  const fr = frames.find((x) => x.timeframe.toLowerCase() === String(entryTf).toLowerCase()) || frame(tp.position?.image_index);
  const n = fr.times.length, step = n > 1 ? fr.times[n - 1] - fr.times[n - 2] : 60, last = fr.times[n - 1];
  out.push(`PERIOD|${step}`);
  for (const [name, path] of [["MAIN", f.main_path], ["ALT", f.alt_path]]) {
    for (const pt of path || []) out.push(`PATH|${name}|${last + pt.bars_ahead * step}|${p(pt.price)}`);
  }
  if (f.main_label) out.push(`LABEL|MAIN|${clean(f.main_label)}`);
  if (f.alt_label) out.push(`LABEL|ALT|${clean(f.alt_label)}`);
  out.push(`NOTE|${clean(a.summary).slice(0, 400)}`);
  return out.join("\n");
}

app.get("/api/mt5/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  res.type("text");
  if (!job || !job.mt5) return res.status(404).send("ERROR|Tahlil topilmadi (server qayta ishga tushgan bo'lishi mumkin). Skriptni qayta ishga tushiring.");
  if (job.status === "running") return res.send(`RUNNING|${Math.round((Date.now() - job.startedAt) / 1000)}`);
  if (job.status === "error") return res.send(`ERROR|${String(job.error).replace(/[\r\n|]+/g, " ")}`);
  res.send(mt5Lines(job.result.analysis, job.mt5));
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Tahlil topilmadi (server qayta ishga tushgan bo'lishi mumkin). Qayta tahlil qiling." });
  const out = { status: job.status, startedAt: job.startedAt };
  if (job.status === "done") Object.assign(out, job.result, { images: job.images });
  if (job.status === "error") out.error = job.error;
  res.json(out);
});

// On live charts the site knows the exact price scale, so drawings and position boxes are placed by price, not by Claude's y guess.
function snapToPrices(a, images) {
  if (!a) return;
  const yOf = (idx, price) => {
    const sc = images[idx - 1]?.scale;
    if (!sc || !(price > 0)) return null;
    return sc.top + ((sc.max - price) / (sc.max - sc.min)) * (sc.bottom - sc.top);
  };
  const fixDrawings = (list) => (list || []).forEach((d) => {
    const y1 = yOf(d.image_index, d.price1);
    if (y1 === null) return;
    const y2 = yOf(d.image_index, d.price2);
    d.y1 = y1;
    d.y2 = d.kind === "hline" || d.kind === "label" || y2 === null ? y1 : y2;
  });
  const fixPos = (pos, prices) => {
    if (!pos || yOf(pos.image_index, prices.e) === null) return;
    pos.y_entry = yOf(pos.image_index, prices.e);
    if (prices.s > 0) pos.y_sl = yOf(pos.image_index, prices.s);
    if (prices.t1 > 0) pos.y_tp1 = yOf(pos.image_index, prices.t1);
    pos.y_tp2 = prices.t2 > 0 ? yOf(pos.image_index, prices.t2) : 0;
  };
  const pricesOf = (x) => ({ e: x.entry_price, s: x.stop_loss_price, t1: x.take_profit_1_price, t2: x.take_profit_2_price });
  fixDrawings(a.drawings);
  fixPos(a.trade_plan?.position, pricesOf(a.trade_plan || {}));
  for (const st of a.strategies || []) { fixDrawings(st.drawings); fixPos(st.position, pricesOf(st)); }
}

class AnalysisError extends Error {}

function analysisErrorMessage(err) {
  if (err instanceof AnalysisError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return "Serverdagi API kalit noto'g'ri yoki muddati o'tgan (Render → Environment).";
  if (err instanceof Anthropic.RateLimitError) return "So'rovlar limiti oshdi. Birozdan keyin qayta urinib ko'ring.";
  if (err instanceof Anthropic.BadRequestError) return `So'rov xatosi: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Claude API xatosi (${err.status ?? "?"}): ${err.message}`;
  console.error(err);
  return "Serverda kutilmagan xato yuz berdi.";
}

async function runAnalysis(content, useNews) {
  const client = new Anthropic({ apiKey: API_KEY });
  let news = null;
  let newsError = null;
  if (useNews) {
    try {
      news = await fetchNewsBrief(client, new Date());
      if (!news) newsError = "Yangiliklarni olib bo'lmadi.";
      else if (news.calendarError) newsError = `${news.calendarError}. Yangiliklar faqat forexfactory.com qidiruvidan olindi.`;
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw err;
      newsError = `Yangiliklarni olib bo'lmadi: ${err.message}`;
    }
  }
  content.push({
    type: "text",
    text: news
      ? `Bugungi yangiliklar xulosasi (Forex Factory):\n${news.text}`
      : "Yangiliklar ma'lumoti berilmagan — news_impact maydonida buni ayt va faqat texnik tahlilga tayan.",
  });

  const analysisRequest = (messages, effort) => client.beta.messages.stream({
    model: MODEL,
    max_tokens: 128000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort },
    system: [{ type: "text", text: ANALYSIS_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages,
  }).finalMessage();

  const messages = [{ role: "user", content }];
  let message = await analysisRequest(messages, process.env.ANALYSIS_EFFORT || "xhigh");
  if (message.stop_reason === "refusal") {
    throw new AnalysisError("Claude bu so'rovni tahlil qilishdan bosh tortdi. Boshqa rasmlar bilan urinib ko'ring.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new AnalysisError("Javob juda uzun bo'lib kesilib qoldi. Kamroq rasm yoki strategiya bilan urinib ko'ring.");
  }
  let analysis = parseJson(textOf(message));
  if (!analysis) {
    // One repair turn: hand the broken output back and ask for valid JSON only.
    message = await analysisRequest([
      ...messages,
      { role: "assistant", content: message.content.filter((b) => b.type === "text") },
      { role: "user", content: "Javobing yaroqli JSON emas edi. Xuddi shu tahlilni sxemaga mos, faqat bitta to'g'ri JSON obyekt sifatida qaytar — boshqa matnsiz." },
    ], "low");
    analysis = parseJson(textOf(message));
  }
  if (!analysis) throw new AnalysisError("Claude javobini o'qib bo'lmadi. Qayta urinib ko'ring.");
  return { analysis: normalizeAnalysis(analysis), news, newsError, model: message.model };
}

const CHAT_PROMPT = `Sen XAU Smart Trade platformasining AI yordamchisisan va admin (treyder) bilan o'zbek tilida gaplashasan.
Mutaxassisliging: XAU/USD (oltin) texnik tahlili, Volume Profile, SMC/ICT, price action, risk-menejment, fundamental omillar (Fed, CPI, NFP, DXY).
Agar suhbatga qo'shimcha kontekst (oxirgi tahlil natijasi yoki savdo jurnali, JSON) berilgan bo'lsa, savollarga shunga tayanib javob ber va qaysi qismga tayanganingni ayt.
Savdo jurnali berilsa, murabbiy sifatida ishla: qaysi strategiya, timeframe va yo'nalish yaxshi/yomon natija berayotganini raqamlar bilan ko'rsat, takrorlanayotgan xatolarni top va 3–5 ta aniq tavsiya ber. Namuna kichik bo'lsa (20 tadan kam savdo), xulosalar ishonchsiz ekanini ayt.
Admin rasm yuborsa, uni grafik sifatida tahlil qil. Aniq bo'l, bilmagan narsangni bilmayman de, va savdo qarori treyderning o'zida ekanini unutma.`;

// Admin chat with Claude. Streams plain text back to the browser as it is generated.
app.post("/api/chat", async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: "Serverda ANTHROPIC_API_KEY o'rnatilmagan (Render → Environment)." });
  }
  const { messages, context } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Xabar bo'sh." });
  }
  const history = [];
  for (const m of messages.slice(-30)) {
    if (!["user", "assistant"].includes(m.role)) continue;
    const content = [];
    for (const img of m.images || []) {
      if (ALLOWED_TYPES.includes(img.mediaType) && typeof img.data === "string") {
        content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
      }
    }
    if (m.text) content.push({ type: "text", text: String(m.text) });
    if (content.length) history.push({ role: m.role, content });
  }
  if (!history.length || history[history.length - 1].role !== "user") {
    return res.status(400).json({ error: "Oxirgi xabar admin xabari bo'lishi kerak." });
  }
  const system = context
    ? `${CHAT_PROMPT}\n\nQo'shimcha kontekst (JSON):\n${JSON.stringify(context).slice(0, 60000)}`
    : CHAT_PROMPT;

  const client = new Anthropic({ apiKey: API_KEY });
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system,
      messages: history,
    });
    res.on("close", () => { if (!res.writableEnded) stream.abort(); });
    stream.on("text", (delta) => res.write(delta));
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") res.write("\n\n[Claude bu savolga javob berishdan bosh tortdi.]");
    if (message.stop_reason === "max_tokens") res.write("\n\n[Javob uzunlik chegarasida kesildi.]");
    res.end();
  } catch (err) {
    if (res.writableEnded || err instanceof Anthropic.APIUserAbortError) return;
    const msg = err instanceof Anthropic.AuthenticationError
      ? "Serverdagi API kalit noto'g'ri."
      : err instanceof Anthropic.RateLimitError
        ? "So'rovlar limiti oshdi, birozdan keyin urinib ko'ring."
        : err instanceof Anthropic.APIError
          ? `Claude API xatosi (${err.status ?? "?"}): ${err.message}`
          : "Serverda kutilmagan xato.";
    if (!(err instanceof Anthropic.APIError)) console.error(err);
    if (!res.headersSent) return res.status(502).json({ error: msg });
    res.end(`\n\n[Xato: ${msg}]`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`XAU Smart Trade ishga tushdi: http://localhost:${PORT}`);
  if (!ADMIN_PASSWORD) console.warn("DIQQAT: ADMIN_PASSWORD o'rnatilmagan — sayt parolsiz ochiq.");
  if (!API_KEY) console.warn("DIQQAT: ANTHROPIC_API_KEY o'rnatilmagan — tahlil ishlamaydi.");
});
