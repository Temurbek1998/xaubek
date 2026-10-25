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
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || isAdmin(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Avval admin panelga kiring." });
  res.redirect("/login.html");
});
app.use(express.static(path.join(__dirname, "public")));

const API_KEY = process.env.ANTHROPIC_API_KEY || "";
app.get("/api/status", (req, res) => {
  res.json({ hasKey: Boolean(API_KEY), model: MODEL, protected: Boolean(ADMIN_PASSWORD) });
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
6. Agar kun yangiliklari berilgan bo'lsa, ularni (FOMC, CPI, NFP, Fed nutqlari, DXY, real yield, geosiyosat) texnik tahlil bilan birlashtir: bozor nima sababdan shu yo'nalishda ketayotganini va yaqin soatlarda qanday yangilik xavfi borligini tushuntir. Muhim yangilik oldidan kirishni tavsiya qilma yoki ogohlantir.
7. Rasmlar ustiga chizish uchun "drawings" ber: tavsiya etilgan kirish timeframe rasmiga albatta TradingView "Long/Short position" vositasi kabi pozitsiyani chiz — Entry dan TP gacha yashil zona (kind "zone", color "green"), Entry dan SL gacha qizil zona (kind "zone", color "red"), ikkalasi ham hozirgi shamdan o'ngga; shuningdek Entry, Stop Loss, TP1, TP2 gorizontal chiziqlarini (kind "hline"), diapazon / POC (agar Volume Profile bo'lsa), asosiy zonalarni (kind "zone": order block, FVG, supply/demand) va kutilayotgan narx harakatini (kind "arrow") chiz. Boshqa rasmlarga ham asosiy darajalarni chizishing mumkin. Koordinatalar rasm o'lchamiga nisbatan 0 dan 1 gacha kasr: x=0 chap chet, x=1 o'ng chet, y=0 yuqori chet, y=1 pastki chet. Chiziqning y qiymatini grafikning o'ng tomonidagi narx shkalasiga qarab, narx aynan shu balandlikka to'g'ri keladigan qilib hisobla. image_index — rasm raqami (Rasm 1, Rasm 2...). hline uchun y2=y1; label uchun x2=x1, y2=y1.
8. Yakuniy savdo rejasini strategiyalar konfluensiyasi (bir nechtasi bir xil yo'nalish va zonani ko'rsatishi) asosida tuz va qaysi strategiyalar uni qo'llab-quvvatlashini yoz.
9. Agar grafiklar aniq signal bermasa yoki timeframe'lar bir-biriga zid bo'lsa, "KUTISH" deb ayt — majburan savdo o'ylab topma.

Qoidalar:
- Faqat rasmda ko'rinadigan narsaga tayan. Narxlarni grafik shkalasidan o'qi; aniq o'qib bo'lmasa, taxminiy ekanini ayt.
- Har bir rasmning timeframe'ini foydalanuvchi bergan yorliqdan ol; yorliq bo'lmasa, grafikdagi yozuvdan aniqla.
- Javobni o'zbek tilida yoz.
- Bu moliyaviy maslahat emas; ishonch darajasini halol baholagin.`;

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
        required: ["strategy", "signal", "timeframe", "score", "reasoning", "checks"],
      },
    },
    best_strategy: { type: "string" },
    best_strategy_reason: { type: "string" },
    market_reason: { type: "string" },
    news_impact: { type: "string" },
    drawings: {
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
        },
        required: ["image_index", "kind", "color", "label", "x1", "y1", "x2", "y2"],
      },
    },
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
      },
      required: [
        "direction", "entry", "stop_loss", "take_profit_1", "take_profit_2",
        "risk_reward", "confirmation", "invalidation",
      ],
    },
    confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
    risks: { type: "array", items: { type: "string" } },
  },
  required: [
    "overall_bias", "summary", "timeframes", "strategies", "best_strategy",
    "best_strategy_reason", "market_reason", "news_impact", "drawings",
    "supporting_strategies", "recommended_entry_timeframe",
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

app.get("/api/strategies", (req, res) => {
  res.json(Object.entries(STRATEGIES).map(([id, st]) => ({ id, label: st.label, rules: st.rules })));
});

app.post("/api/analyze", async (req, res) => {
  const apiKey = API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Serverda ANTHROPIC_API_KEY o'rnatilmagan (Render → Environment)." });
  }

  const { images, note, strategies, useNews } = req.body || {};
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
    content.push({ type: "text", text: `Rasm ${i + 1} — timeframe: ${img.timeframe || "noma'lum"}` });
    content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  }
  content.push({
    type: "text",
    text:
      "Yuqoridagi XAU/USD grafiklarini tahlil qil va qaysi timeframe'da savdoga kirishni tavsiya qil.\n\n" +
      "Quyidagi strategiyalarning har birini alohida sinab ko'r:\n" +
      chosen.map((k, i) => `${i + 1}. ${STRATEGIES[k].label}\n` + STRATEGIES[k].rules.map((r) => `   - ${r}`).join("\n")).join("\n") +
      (note ? `\n\nTreyderning izohi: ${note}` : ""),
  });

  const client = new Anthropic({ apiKey });
  try {
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

    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: ANALYSIS_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      return res.status(422).json({ error: "Claude bu so'rovni tahlil qilishdan bosh tortdi. Boshqa rasmlar bilan urinib ko'ring." });
    }
    if (message.stop_reason === "max_tokens") {
      return res.status(502).json({ error: "Javob juda uzun bo'lib kesilib qoldi. Kamroq rasm bilan urinib ko'ring." });
    }
    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    let analysis;
    try {
      analysis = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "Claude javobini o'qib bo'lmadi.", raw: text });
    }
    res.json({ analysis, news, newsError, model: message.model });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(401).json({ error: "API kalit noto'g'ri yoki muddati o'tgan." });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "So'rovlar limiti oshdi. Birozdan keyin qayta urinib ko'ring." });
    }
    if (err instanceof Anthropic.BadRequestError) {
      return res.status(400).json({ error: `So'rov xatosi: ${err.message}` });
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(502).json({ error: `Claude API xatosi (${err.status ?? "?"}): ${err.message}` });
    }
    console.error(err);
    res.status(500).json({ error: "Serverda kutilmagan xato yuz berdi." });
  }
});

const CHAT_PROMPT = `Sen XAU Smart Trade platformasining AI yordamchisisan va admin (treyder) bilan o'zbek tilida gaplashasan.
Mutaxassisliging: XAU/USD (oltin) texnik tahlili, Volume Profile, SMC/ICT, price action, risk-menejment, fundamental omillar (Fed, CPI, NFP, DXY).
Agar suhbatga oxirgi tahlil natijasi (JSON) berilgan bo'lsa, savollarga shunga tayanib javob ber va qaysi qismga tayanganingni ayt.
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
    ? `${CHAT_PROMPT}\n\nOxirgi tahlil natijasi (JSON):\n${JSON.stringify(context).slice(0, 60000)}`
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
