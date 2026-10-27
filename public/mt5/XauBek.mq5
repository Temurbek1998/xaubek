//+------------------------------------------------------------------+
//| XauBek.mq5 — XAU Smart Trade tahlilini MetaTrader 5 grafigiga chizadi |
//| Skript faqat siz ishga tushirganda ishlaydi va savdo OCHMAYDI.       |
//+------------------------------------------------------------------+
#property copyright "XAU Smart Trade"
#property version   "1.00"
#property script_show_inputs

enum TradeStyle { Skalping = 0, Intraday = 1, Swing = 2, Pozitsion = 3 };

input string     InpUrl   = "https://xaubek.onrender.com"; // Sayt manzili
input string     InpToken = "";                            // MT5 kaliti (saytdagi Sozlamalardan)
input TradeStyle InpStyle = Intraday;                      // Savdo turi
input bool       InpNews  = true;                          // Forex Factory yangiliklari
input string     InpNote  = "";                            // Izoh (ixtiyoriy)
input int        InpBars  = 300;                           // Har bir timeframe uchun shamlar

const string PFX = "XAUBEK_";

//--- timeframes for each trading style (same as the website)
void StyleFrames(ENUM_TIMEFRAMES &tfs[], string &names[])
{
   ArrayResize(tfs, 4); ArrayResize(names, 4);
   if(InpStyle == Skalping)      { tfs[0]=PERIOD_H1;  tfs[1]=PERIOD_M15; tfs[2]=PERIOD_M5;  tfs[3]=PERIOD_M1;  }
   else if(InpStyle == Swing)    { tfs[0]=PERIOD_D1;  tfs[1]=PERIOD_H4;  tfs[2]=PERIOD_H1;  tfs[3]=PERIOD_M15; }
   else if(InpStyle == Pozitsion){ tfs[0]=PERIOD_W1;  tfs[1]=PERIOD_D1;  tfs[2]=PERIOD_H4;  tfs[3]=PERIOD_H1;  }
   else                          { tfs[0]=PERIOD_H4;  tfs[1]=PERIOD_H1;  tfs[2]=PERIOD_M15; tfs[3]=PERIOD_M5;  }
   for(int i = 0; i < 4; i++) names[i] = TfName(tfs[i]);
}

string TfName(ENUM_TIMEFRAMES tf)
{
   switch(tf)
   {
      case PERIOD_M1:  return "1m";
      case PERIOD_M5:  return "5m";
      case PERIOD_M15: return "15m";
      case PERIOD_M30: return "30m";
      case PERIOD_H1:  return "1H";
      case PERIOD_H4:  return "4H";
      case PERIOD_D1:  return "1D";
      case PERIOD_W1:  return "1W";
   }
   return "1H";
}

string StyleId()
{
   if(InpStyle == Skalping)  return "scalping";
   if(InpStyle == Swing)     return "swing";
   if(InpStyle == Pozitsion) return "position";
   return "intraday";
}

string JsonEscape(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\n", " ");
   StringReplace(s, "\r", " ");
   return s;
}

//--- HTTP helpers
int Http(string method, string path, string body, string &response)
{
   char data[], result[];
   string headers = "Content-Type: application/json\r\nX-Token: " + InpToken + "\r\n", resHeaders;
   if(body != "")
   {
      StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
      ArrayResize(data, ArraySize(data) - 1); // drop the trailing \0
   }
   string url = InpUrl;
   if(StringSubstr(url, StringLen(url) - 1) == "/") url = StringSubstr(url, 0, StringLen(url) - 1);
   ResetLastError();
   int code = WebRequest(method, url + path, headers, 90000, data, result, resHeaders);
   response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   return code;
}

void Fail(string msg)
{
   Comment("XAU Smart Trade: " + msg);
   Alert("XAU Smart Trade: " + msg);
}

//--- chart drawing
color ColorOf(string name)
{
   if(name == "green") return clrMediumSeaGreen;
   if(name == "red")   return clrTomato;
   if(name == "blue")  return clrDodgerBlue;
   if(name == "white") return clrWhite;
   return clrGold;
}

int objN = 0;
string NextName() { objN++; return PFX + IntegerToString(objN); }

void HLine(double price, color c, ENUM_LINE_STYLE style, int width, string text)
{
   string n = NextName();
   ObjectCreate(0, n, OBJ_HLINE, 0, 0, price);
   ObjectSetInteger(0, n, OBJPROP_COLOR, c);
   ObjectSetInteger(0, n, OBJPROP_STYLE, style);
   ObjectSetInteger(0, n, OBJPROP_WIDTH, width);
   ObjectSetString(0, n, OBJPROP_TEXT, text);
   ObjectSetString(0, n, OBJPROP_TOOLTIP, text);
   ObjectSetInteger(0, n, OBJPROP_BACK, true);
   // a text label right above the line, at the last candle
   string t = NextName();
   ObjectCreate(0, t, OBJ_TEXT, 0, iTime(_Symbol, _Period, 0), price);
   ObjectSetString(0, t, OBJPROP_TEXT, text);
   ObjectSetInteger(0, t, OBJPROP_COLOR, c);
   ObjectSetInteger(0, t, OBJPROP_FONTSIZE, 9);
   ObjectSetInteger(0, t, OBJPROP_ANCHOR, ANCHOR_RIGHT_LOWER);
}

void Zone(datetime t1, datetime t2, double p1, double p2, color c, string text)
{
   string n = NextName();
   ObjectCreate(0, n, OBJ_RECTANGLE, 0, t1, p1, t2, p2);
   ObjectSetInteger(0, n, OBJPROP_COLOR, c);
   ObjectSetInteger(0, n, OBJPROP_FILL, true);
   ObjectSetInteger(0, n, OBJPROP_BACK, true);
   ObjectSetString(0, n, OBJPROP_TOOLTIP, text);
   string t = NextName();
   ObjectCreate(0, t, OBJ_TEXT, 0, t1, MathMax(p1, p2));
   ObjectSetString(0, t, OBJPROP_TEXT, text);
   ObjectSetInteger(0, t, OBJPROP_COLOR, c);
   ObjectSetInteger(0, t, OBJPROP_FONTSIZE, 9);
   ObjectSetInteger(0, t, OBJPROP_ANCHOR, ANCHOR_LEFT_LOWER);
}

void Segment(datetime t1, double p1, datetime t2, double p2, color c, ENUM_LINE_STYLE style, int width, bool arrow, string text)
{
   string n = NextName();
   ObjectCreate(0, n, OBJ_TREND, 0, t1, p1, t2, p2);
   ObjectSetInteger(0, n, OBJPROP_COLOR, c);
   ObjectSetInteger(0, n, OBJPROP_STYLE, style);
   ObjectSetInteger(0, n, OBJPROP_WIDTH, width);
   ObjectSetInteger(0, n, OBJPROP_RAY_RIGHT, false);
   ObjectSetString(0, n, OBJPROP_TOOLTIP, text);
   if(arrow)
   {
      string a = NextName();
      ObjectCreate(0, a, OBJ_ARROW, 0, t2, p2);
      ObjectSetInteger(0, a, OBJPROP_ARROWCODE, p2 > p1 ? 233 : 234);
      ObjectSetInteger(0, a, OBJPROP_COLOR, c);
      ObjectSetInteger(0, a, OBJPROP_WIDTH, 2);
   }
}

void ClearDrawings()
{
   ObjectsDeleteAll(0, PFX);
   Comment("");
}

//--- parses the server's line format and draws everything
void DrawResult(string text)
{
   ClearDrawings();
   string lines[];
   int n = StringSplit(text, '\n', lines);
   string dir = "", tf = "", conf = "", bias = "", best = "", rr = "", note = "", inv = "", mainLabel = "", altLabel = "";
   double entry = 0, sl = 0, tp1 = 0, tp2 = 0;
   datetime mainT[], altT[]; double mainP[], altP[];
   for(int i = 0; i < n; i++)
   {
      string f[];
      int k = StringSplit(lines[i], '|', f);
      if(k < 2) continue;
      string tag = f[0];
      if(tag == "DIR") dir = f[1];
      else if(tag == "TF") tf = f[1];
      else if(tag == "CONF") conf = f[1];
      else if(tag == "BIAS") bias = f[1];
      else if(tag == "BEST") best = f[1];
      else if(tag == "RR") rr = f[1];
      else if(tag == "NOTE") note = f[1];
      else if(tag == "PLAN" && k >= 5) { entry = StringToDouble(f[1]); sl = StringToDouble(f[2]); tp1 = StringToDouble(f[3]); tp2 = StringToDouble(f[4]); }
      else if(tag == "INV" && k >= 3)
      {
         inv = f[2];
         HLine(StringToDouble(f[1]), clrDarkOrange, STYLE_DASH, 1, "Bekor qilish " + f[1]);
      }
      else if(tag == "LINE" && k >= 4) HLine(StringToDouble(f[1]), ColorOf(f[2]), STYLE_DOT, 1, f[3]);
      else if(tag == "ZONE" && k >= 7) Zone((datetime)StringToInteger(f[1]), (datetime)StringToInteger(f[2]), StringToDouble(f[3]), StringToDouble(f[4]), ColorOf(f[5]), f[6]);
      else if(tag == "ARROW" && k >= 7) Segment((datetime)StringToInteger(f[1]), StringToDouble(f[2]), (datetime)StringToInteger(f[3]), StringToDouble(f[4]), ColorOf(f[5]), STYLE_SOLID, 2, true, f[6]);
      else if(tag == "LABEL" && k >= 3) { if(f[1] == "MAIN") mainLabel = f[2]; else altLabel = f[2]; }
      else if(tag == "PATH" && k >= 4)
      {
         datetime t = (datetime)StringToInteger(f[2]); double p = StringToDouble(f[3]);
         if(f[1] == "MAIN") { int m = ArraySize(mainT); ArrayResize(mainT, m + 1); ArrayResize(mainP, m + 1); mainT[m] = t; mainP[m] = p; }
         else               { int m = ArraySize(altT);  ArrayResize(altT, m + 1);  ArrayResize(altP, m + 1);  altT[m] = t;  altP[m] = p; }
      }
   }
   // Entry / SL / TP levels
   if(entry > 0)
   {
      HLine(entry, clrWhite, STYLE_SOLID, 2, "Entry " + DoubleToString(entry, 2) + " " + dir);
      if(sl > 0)  HLine(sl,  clrRed,       STYLE_SOLID, 2, "SL "  + DoubleToString(sl, 2));
      if(tp1 > 0) HLine(tp1, clrLimeGreen, STYLE_SOLID, 2, "TP1 " + DoubleToString(tp1, 2));
      if(tp2 > 0) HLine(tp2, clrLimeGreen, STYLE_DASH,  1, "TP2 " + DoubleToString(tp2, 2));
   }
   // Forecast paths start at the current price on the last candle
   datetime t0 = iTime(_Symbol, _Period, 0);
   double p0 = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   datetime pt = t0; double pp = p0;
   for(int i = 0; i < ArraySize(altT); i++) { Segment(pt, pp, altT[i], altP[i], clrSilver, STYLE_DASH, 1, false, altLabel); pt = altT[i]; pp = altP[i]; }
   pt = t0; pp = p0;
   for(int i = 0; i < ArraySize(mainT); i++) { Segment(pt, pp, mainT[i], mainP[i], clrGold, STYLE_SOLID, 3, false, mainLabel); pt = mainT[i]; pp = mainP[i]; }
   // Room on the right for the forecast
   ChartSetInteger(0, CHART_SHIFT, true);
   ChartSetDouble(0, CHART_SHIFT_SIZE, 30);
   ChartRedraw();

   string c = "XAU Smart Trade — AI tahlil\n" +
              "Yo'nalish: " + bias + "   Savdo: " + dir + "   Ishonch: " + conf + "\n" +
              "Kirish TF: " + tf + "   Eng yaxshi strategiya: " + best + "\n";
   if(entry > 0) c += "Entry " + DoubleToString(entry, 2) + "   SL " + DoubleToString(sl, 2) + "   TP1 " + DoubleToString(tp1, 2) + "   TP2 " + DoubleToString(tp2, 2) + "   R:R " + rr + "\n";
   if(inv != "") c += "Bekor qilish: " + inv + "\n";
   if(mainLabel != "") c += "Asosiy (sariq): " + mainLabel + "\n";
   if(altLabel != "") c += "Muqobil (kulrang punktir): " + altLabel + "\n";
   c += note + "\nMoliyaviy maslahat emas. Savdo qarorini o'zingiz qabul qilasiz.";
   Comment(c);
}

void OnStart()
{
   if(InpToken == "") { Fail("MT5 kalitini kiriting (saytdagi Sozlamalar bo'limida)."); return; }

   ENUM_TIMEFRAMES tfs[]; string names[];
   StyleFrames(tfs, names);
   string frames = "";
   for(int i = 0; i < ArraySize(tfs); i++)
   {
      MqlRates r[];
      int got = CopyRates(_Symbol, tfs[i], 0, InpBars, r);
      if(got <= 10) { Print("XauBek: ", names[i], " shamlari olinmadi"); continue; }
      string cs = "";
      for(int j = 0; j < got; j++)
      {
         if(j > 0) cs += ",";
         cs += "[" + IntegerToString((long)r[j].time) + "," + DoubleToString(r[j].open, 2) + "," + DoubleToString(r[j].high, 2) + "," +
               DoubleToString(r[j].low, 2) + "," + DoubleToString(r[j].close, 2) + "]";
      }
      if(frames != "") frames += ",";
      frames += "{\"timeframe\":\"" + names[i] + "\",\"candles\":[" + cs + "]}";
   }
   if(frames == "") { Fail("Shamlarni olib bo'lmadi. Grafik tarixini yuklang."); return; }

   string body = "{\"symbol\":\"" + JsonEscape(_Symbol) + "\",\"style\":\"" + StyleId() + "\",\"useNews\":" + (InpNews ? "true" : "false") +
                 ",\"note\":\"" + JsonEscape(InpNote) + "\",\"serverTime\":" + IntegerToString((long)TimeCurrent()) + ",\"frames\":[" + frames + "]}";

   Comment("XAU Smart Trade: ma'lumot yuborilmoqda... (sayt uxlab qolgan bo'lsa ~1 daqiqa)");
   string resp;
   int code = Http("POST", "/api/mt5/analyze", body, resp);
   if(code == -1)
   {
      Fail("Saytga ulanib bo'lmadi (xato " + IntegerToString(GetLastError()) + "). Tools → Options → Expert Advisors → 'Allow WebRequest' ga " + InpUrl + " ni qo'shing.");
      return;
   }
   if(StringFind(resp, "JOB|") != 0) { Fail(StringFind(resp, "ERROR|") == 0 ? StringSubstr(resp, 6) : "Server javobi: " + IntegerToString(code)); return; }
   string jobId = StringSubstr(resp, 4);
   StringTrimRight(jobId);

   // The analysis runs on the server (usually 2–5 minutes); check every 5 seconds.
   for(int tries = 0; tries < 180 && !IsStopped(); tries++)
   {
      Sleep(5000);
      code = Http("GET", "/api/mt5/jobs/" + jobId, "", resp);
      if(code == -1) continue;
      if(StringFind(resp, "RUNNING") == 0)
      {
         int secs = tries * 5 + 5;
         Comment(StringFormat("XAU Smart Trade: Claude 11 ta strategiya bo'yicha tahlil qilmoqda... %d:%02d", secs / 60, secs % 60));
         continue;
      }
      if(StringFind(resp, "ERROR|") == 0) { Fail(StringSubstr(resp, 6)); return; }
      if(StringFind(resp, "OK") == 0) { DrawResult(resp); return; }
   }
   Fail("Tahlil juda uzoq davom etdi. Qayta urinib ko'ring.");
}
//+------------------------------------------------------------------+
