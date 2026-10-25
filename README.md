# XAU Smart Trade

XAU/USD (oltin) uchun TradingView skrinshotlarini Claude AI orqali tahlil qiluvchi platforma.
Bir nechta timeframe grafiklarini yuklaysiz, tanlangan strategiyalarning har biri alohida sinab ko'riladi,
va Claude qaysi timeframe'da kirishni, Entry / Stop Loss / Take Profit'ni tavsiya qiladi.

## Ishga tushirish

1. [Node.js](https://nodejs.org) 18+ o'rnating.
2. Shu papkada:
   ```bash
   npm install
   npm start
   ```
3. Brauzerda oching: http://localhost:3000
4. Claude API kalitingizni kiriting (https://console.anthropic.com/settings/keys).

Kalitni serverda saqlash uchun: `ANTHROPIC_API_KEY=sk-ant-... npm start` (unda saytda kiritish shart emas).
Modelni o'zgartirish: `CLAUDE_MODEL=claude-sonnet-5-5 npm start` (arzonroq va tezroq). Standart: `claude-opus-5-5`.

## Foydalanish

- TradingView'da grafik ustida **Alt+S** (skrinshotni nusxalash), so'ng saytda **Ctrl+V**. Yoki fayllarni tashlang.
- Har bir rasmga timeframe tanlang (1D, 4H, 1H, 15m, 5m...). Fayl nomida `4H`, `15m` bo'lsa, avtomatik aniqlanadi.
- Strategiyalarni belgilang: SMC/ICT, Price Action, EMA trend, Supply/Demand, Fibonacci, Breakout,
  RSI/MACD divergensiya, Wyckoff, grafik figuralari, sessiya strategiyasi va Volume Profile (diapazon + POC,
  soxta yorib o'tish, POC retesti). Har bir strategiyaning qoidalari bittalab tekshiriladi: bajarildi / bajarilmadi va
  grafikdagi dalil ko'rsatiladi.
  Indikatorga tayanadigan strategiyalar uchun o'sha indikatorni TradingView grafigiga qo'yib skrinshot oling.
- **Forex Factory yangiliklari**: belgilansa, server Forex Factory'ning rasmiy haftalik kalendarini
  (`nfs.faireconomy.media/ff_calendar_thisweek.json`, USD, High/Medium ta'sir) yuklaydi, Claude esa faqat forexfactory.com
  ichida qidirib bugungi yangiliklar va chiqqan natijalarni topadi, keyin ularni tahlilga qo'shadi.
  Qidiruv uchun Claude Console'da web search yoqilgan bo'lishi kerak. Kalendar 15 daqiqa keshlanadi.
- **Rasmga chizish**: Claude Entry / SL / TP chiziqlarini, order block / FVG zonalarini va kutilayotgan harakat strelkasini
  yuklangan skrinshot ustiga chizib qaytaradi; "PNG yuklab olish" bilan saqlaysiz. Chiziqlar narx shkalasiga qarab
  taxminiy joylashadi, aniq narxlar "Savdo rejasi" bo'limida.
- Strategiya qo'shish: `server.js` dagi `STRATEGIES` ro'yxatiga yangi qator qo'shing.

## Aniqlik jurnali

Tahlildan keyin "Jurnalga qo'shish" ni bosing, savdo yopilgach TP yoki SL ni belgilang. "Aniqlik jurnali" sahifasida
umumiy win rate va har bir strategiya bo'yicha aniqlik hisoblanadi (ma'lumot shu brauzerda saqlanadi).

## Dizayn

Yuqori o'ng burchakda 5 ta rang mavzusi: Qora-oltin, TradingView, Zumrad, Binafsha, Yorug'.

## Narx

Har bir tahlil sizning Claude API hisobingizdan to'lanadi (rasmlar soni va strategiyalarga qarab bir necha sentdan).

## ⚠️ Ogohlantirish

Bu moliyaviy maslahat emas. AI tahlili xato bo'lishi mumkin. Avval demo hisobda sinab ko'ring va riskni boshqaring.
