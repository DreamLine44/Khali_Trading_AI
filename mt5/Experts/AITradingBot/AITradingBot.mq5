#property strict
#property version   "2.0.0"
#property description "Authenticated MT5 bridge for the AI Trading Bot. Live execution is explicitly opt-in."

#include <Trade/Trade.mqh>

input string InpBridgeSecret = "CHANGE_THIS_TO_A_LONG_RANDOM_SECRET";
input int    InpTimerSeconds = 1;
input long   InpMagicNumber = 26090601;
input int    InpMaxDeviationPoints = 20;
input int    InpMaxRequestAgeSeconds = 30;

string RequestFile = "ai_trading_request.txt";
string ResponseFile = "ai_trading_response.txt";
string TempResponseFile = "ai_trading_response.tmp";
CTrade Trade;

int OnInit()
  {
   if(StringLen(InpBridgeSecret) < 16 || InpBridgeSecret == "CHANGE_THIS_TO_A_LONG_RANDOM_SECRET")
     {
      Print("AITradingBot: configure a unique bridge secret of at least 16 characters");
      return(INIT_PARAMETERS_INCORRECT);
     }
   if(InpTimerSeconds < 1 || InpMaxDeviationPoints < 0 || InpMaxRequestAgeSeconds < 1)
      return(INIT_PARAMETERS_INCORRECT);
   Trade.SetExpertMagicNumber(InpMagicNumber);
   Trade.SetMarginMode();
   Trade.SetAsyncMode(false);
   EventSetTimer(InpTimerSeconds);
   Print("AITradingBot: bridge started. Magic=", InpMagicNumber, " Common files path: ", TerminalInfoString(TERMINAL_COMMONDATA_PATH), "\\Files");
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

void OnTick() {}

void OnTimer()
  {
   if(!FileIsExist(RequestFile, FILE_COMMON))
      return;

   int handle=FileOpen(RequestFile, FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle==INVALID_HANDLE)
      return;
   string request=FileReadString(handle);
   FileClose(handle);
   FileDelete(RequestFile, FILE_COMMON);

   string fields[];
   int count=StringSplit(request, StringGetCharacter("|",0), fields);
   if(count < 3)
      return;

   string request_id=fields[0];
   if(StringFind(request_id, "req_") != 0) { WriteError(request_id, "invalid request id"); return; }
   string request_stamp=StringSubstr(request_id, 4);
   int underscore=StringFind(request_stamp, "_");
   if(underscore < 1) { WriteError(request_id, "invalid request timestamp"); return; }
   long request_ms=(long)StringToInteger(StringSubstr(request_stamp, 0, underscore));
   // Must be compared against true UTC, not the terminal host's local wall
   // clock: the Node bridge client stamps every request with Date.now(),
   // which is always UTC epoch ms regardless of where it runs. TimeLocal()
   // returns the host machine's local time reinterpreted as if it were UTC
   // (no timezone conversion at all), so on any terminal host whose system
   // clock isn't itself set to UTC+0 this comparison is off by the host's
   // UTC offset — hours, not seconds. That made every request either look
   // like it came from "the future" (host ahead of UTC: immediate rejection
   // via the +2000ms check) or instantly "stale" (host behind UTC, or ahead
   // by more than InpMaxRequestAgeSeconds), i.e. every bridge call (history,
   // quotes, symbol specs, orders) fails closed the moment the terminal
   // runs anywhere other than a UTC-clocked host. TimeGMT() converts using
   // the OS's own timezone settings and matches Date.now() regardless of
   // host locale.
   long now_ms=(long)TimeGMT()*1000;
   if(request_ms <= 0 || request_ms > now_ms + 2000 || now_ms-request_ms > (long)InpMaxRequestAgeSeconds*1000) { WriteError(request_id, "stale or invalid request"); return; }
   string secret=fields[1];
   string operation=fields[2];
   if(request_id=="" || secret!=InpBridgeSecret)
     {
      WriteError(request_id, "authentication failed");
      return;
     }

   if(operation=="PING")
    WriteResponse(request_id, StringFormat("PONG|%I64d|%I64d|%s|%s|%s|2.0.0", InpMagicNumber, AccountInfoInteger(ACCOUNT_LOGIN), AccountInfoString(ACCOUNT_SERVER), _Symbol, ChartTimeframeName()));
   else if(operation=="QUOTE" && count>=4)
      HandleQuote(request_id, fields[3]);
   else if(operation=="HISTORY" && count>=5)
      HandleHistory(request_id, fields[3], fields[4], count>=6 ? (int)StringToInteger(fields[5]) : 0);
   else if(operation=="ACCOUNT")
      HandleAccount(request_id);
  else if(operation=="RESOLVE" && count>=4)
    HandleResolve(request_id, fields[3]);
   else if(operation=="POSITIONS")
      HandlePositions(request_id);
   else if(operation=="SYMBOL" && count>=7)
      HandleSymbol(request_id, fields[3], fields[4], StringToDouble(fields[5]), StringToDouble(fields[6]));
   else if(operation=="ORDER" && count>=10)
      HandleOrder(request_id, fields);
   else
      WriteError(request_id, "invalid request");
  }

string ChartTimeframeName()
  {
   switch((ENUM_TIMEFRAMES)_Period)
     {
      case PERIOD_M1: return "M1";
      case PERIOD_M5: return "M5";
      case PERIOD_M15: return "M15";
      case PERIOD_H1: return "H1";
      case PERIOD_H4: return "H4";
      case PERIOD_D1: return "D1";
     }
   return "";
  }

void WriteResponse(const string request_id, const string payload)
  {
   int handle=FileOpen(TempResponseFile, FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle==INVALID_HANDLE)
     {
      Print("AITradingBot: cannot open response file, error ", GetLastError());
      return;
     }
   FileWriteString(handle, request_id+"|OK|"+payload+"\n");
   FileFlush(handle);
   FileClose(handle);
   FileDelete(ResponseFile, FILE_COMMON);
   FileMove(TempResponseFile, FILE_COMMON, ResponseFile, FILE_COMMON|FILE_REWRITE);
  }

void WriteError(const string request_id, const string message)
  {
   if(request_id=="") return;
   int handle=FileOpen(TempResponseFile, FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle==INVALID_HANDLE) return;
   FileWriteString(handle, request_id+"|ERROR|"+message+"\n");
   FileFlush(handle);
   FileClose(handle);
   FileDelete(ResponseFile, FILE_COMMON);
   FileMove(TempResponseFile, FILE_COMMON, ResponseFile, FILE_COMMON|FILE_REWRITE);
  }

ENUM_TIMEFRAMES ParseTimeframe(const string value)
  {
   if(value=="M1") return PERIOD_M1;
   if(value=="M5") return PERIOD_M5;
   if(value=="M15") return PERIOD_M15;
   if(value=="H1") return PERIOD_H1;
   if(value=="H4") return PERIOD_H4;
   if(value=="D1") return PERIOD_D1;
   return PERIOD_CURRENT;
  }

void HandleQuote(const string request_id, const string symbol)
  {
   if(!SymbolSelect(symbol, true)) { WriteError(request_id, "symbol unavailable"); return; }
   MqlTick tick;
   if(!SymbolInfoTick(symbol, tick) || tick.bid<=0 || tick.ask<tick.bid) { WriteError(request_id, "quote unavailable"); return; }
   double point=SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(point<=0) { WriteError(request_id, "symbol point unavailable"); return; }
   long timestamp=(long)tick.time_msc;
   double spread=tick.ask-tick.bid;
   WriteResponse(request_id, StringFormat("Q|%I64d|%.10f|%.10f|%.10f", timestamp, tick.bid, tick.ask, spread));
  }

bool ResolveBrokerSymbol(const string requested, string &resolved)
  {
   string wanted=requested;
   StringToUpper(wanted);
   if(wanted=="") return false;

   if(SymbolSelect(requested, true))
     {
      resolved=requested;
      return true;
     }

   string candidate="";
   int candidate_length=2147483647;
   int total=SymbolsTotal(false);
   for(int i=0; i<total; i++)
     {
      string name=SymbolName(i, false);
      string upper=name;
      StringToUpper(upper);
      if(StringFind(upper, wanted)<0) continue;
      if(candidate!="" && StringLen(name)==candidate_length) return false;
      if(StringLen(name)<candidate_length)
        {
         candidate=name;
         candidate_length=StringLen(name);
        }
     }
   if(candidate=="") return false;
   if(!SymbolSelect(candidate, true)) return false;
   resolved=candidate;
   return true;
  }

void HandleResolve(const string request_id, const string requested)
  {
   string resolved="";
   if(!ResolveBrokerSymbol(requested, resolved))
     {
      WriteError(request_id, "symbol unavailable or symbol alias is ambiguous");
      return;
     }
   WriteResponse(request_id, "R|"+resolved);
  }

void HandleHistory(const string request_id, const string symbol, const string timeframe_value, const int requested_count)
  {
   ENUM_TIMEFRAMES timeframe=ParseTimeframe(timeframe_value);
   if(timeframe==PERIOD_CURRENT || requested_count<2 || requested_count>100000 || !SymbolSelect(symbol, true)) { WriteError(request_id, "invalid history request"); return; }
   MqlRates rates[];
   int copied=CopyRates(symbol, timeframe, 1, requested_count, rates);
   if(copied<=0) { WriteError(request_id, "history unavailable"); return; }
   int handle=FileOpen(TempResponseFile, FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle==INVALID_HANDLE) { WriteError(request_id, "cannot open history response"); return; }
   for(int i=0; i<copied; i++)
     {
      long timestamp=(long)rates[i].time*1000;
      FileWriteString(handle, StringFormat("%s|OK|C|%I64d|%.10f|%.10f|%.10f|%.10f|%I64d|1\n", request_id, timestamp, rates[i].open, rates[i].high, rates[i].low, rates[i].close, rates[i].tick_volume));
     }
   FileFlush(handle); FileClose(handle);
   FileDelete(ResponseFile, FILE_COMMON);
   FileMove(TempResponseFile, FILE_COMMON, ResponseFile, FILE_COMMON|FILE_REWRITE);
  }

void HandleAccount(const string request_id)
  {
   double balance=AccountInfoDouble(ACCOUNT_BALANCE);
   double equity=AccountInfoDouble(ACCOUNT_EQUITY);
   double free_margin=AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   int positions=PositionsTotal();
   if(!MathIsValidNumber(balance) || !MathIsValidNumber(equity) || !MathIsValidNumber(free_margin) || equity<=0 || free_margin<0)
     {
      Print("AITradingBot: account state unavailable. balance=", DoubleToString(balance, 2), " equity=", DoubleToString(equity, 2), " free_margin=", DoubleToString(free_margin, 2), " positions=", positions, " error=", GetLastError());
      WriteError(request_id, StringFormat("account state unavailable balance=%.2f equity=%.2f free_margin=%.2f positions=%d error=%d", balance, equity, free_margin, positions, GetLastError()));
      return;
     }
   WriteResponse(request_id, StringFormat("A|%.10f|%.10f|%.10f|%d", balance, equity, free_margin, positions));
  }

void HandlePositions(const string request_id)
  {
   int handle=FileOpen(TempResponseFile, FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle==INVALID_HANDLE) { WriteError(request_id, "cannot open positions response"); return; }
   // [FIX-POSITIONS-EMPTY-RESPONSE] Zero open positions is the normal,
   // majority-of-the-time account state, but writing zero lines produced
   // a genuinely empty response file. Mt5FileBridge.request() (Node side)
   // treats ANY empty response as a hard protocol error ("MT5 returned an
   // empty response") for every operation, because for every other
   // operation an empty response really is an error. POSITIONS is the one
   // operation whose correct, common answer is "nothing to report", so it
   // must always write at least one line. This sentinel carries no "P"
   // marker, so Mt5FileBridge.getPositions() (which filters on
   // fields[0]==="P") correctly turns it into an empty array rather than
   // a position record.
   if(PositionsTotal()==0)
      FileWriteString(handle, StringFormat("%s|OK|NONE\n", request_id));
   for(int i=0; i<PositionsTotal(); i++)
     {
      ulong ticket=PositionGetTicket(i);
      if(ticket==0 || !PositionSelectByTicket(ticket)) continue;
      string symbol=PositionGetString(POSITION_SYMBOL);
      ulong magic=(ulong)PositionGetInteger(POSITION_MAGIC);
      ENUM_POSITION_TYPE position_type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      string side=position_type==POSITION_TYPE_BUY ? "BUY" : "SELL";
      double volume=PositionGetDouble(POSITION_VOLUME);
      double open_price=PositionGetDouble(POSITION_PRICE_OPEN);
      double stop_loss=PositionGetDouble(POSITION_SL);
      double take_profit=PositionGetDouble(POSITION_TP);
      string comment=PositionGetString(POSITION_COMMENT);
      FileWriteString(handle, StringFormat("%s|OK|P|%I64u|%I64u|%s|%.10f|%.10f|%.10f|%.10f|%s|%s\n", request_id, ticket, magic, side, volume, open_price, stop_loss, take_profit, symbol, comment));
     }
   FileFlush(handle); FileClose(handle);
   FileDelete(ResponseFile, FILE_COMMON);
   FileMove(TempResponseFile, FILE_COMMON, ResponseFile, FILE_COMMON|FILE_REWRITE);
  }

void HandleSymbol(const string request_id, const string symbol, const string side, const double entry, const double stop_loss)
  {
   if(!SymbolSelect(symbol, true) || (side!="BUY" && side!="SELL") || entry<=0 || stop_loss<=0) { WriteError(request_id, "invalid symbol request"); return; }
   MqlTick tick;
   if(!SymbolInfoTick(symbol, tick)) { WriteError(request_id, "symbol quote unavailable"); return; }
   if(!MathIsValidNumber(entry)) { WriteError(request_id, "invalid entry price"); return; }
   double point=SymbolInfoDouble(symbol, SYMBOL_POINT);
   double tick_size=SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   double tick_value=SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
   double volume_min=SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double volume_max=SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double volume_step=SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   int digits=(int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   int stops_level=(int)SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
   int freeze_level=(int)SymbolInfoInteger(symbol, SYMBOL_TRADE_FREEZE_LEVEL);
   if(point<=0 || tick_size<=0 || tick_value<0 || volume_min<=0 || volume_max<volume_min || volume_step<=0) { WriteError(request_id, "symbol trading specifications unavailable"); return; }
   ENUM_ORDER_TYPE type=side=="BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   double loss=0.0;
   if(!OrderCalcProfit(type, symbol, 1.0, entry, stop_loss, loss)) { WriteError(request_id, "OrderCalcProfit failed"); return; }
   loss=MathAbs(loss);
   if(!MathIsValidNumber(loss) || loss<=0) { WriteError(request_id, "invalid calculated stop loss value"); return; }
   WriteResponse(request_id, StringFormat("S|%d|%.10f|%.10f|%.10f|%.10f|%.10f|%.10f|%d|%d|%.10f", digits, point, tick_size, tick_value, volume_min, volume_max, volume_step, stops_level, freeze_level, loss));
  }

string SafeGlobalKey(const string idempotency)
  {
   string value="AI_TRADE_"+idempotency;
   StringReplace(value, ":", "_");
   StringReplace(value, "|", "_");
   if(StringLen(value)>63) value=StringSubstr(value, 0, 63);
   return value;
  }

void HandleOrder(const string request_id, string &fields[])
  {
   string order_id=fields[3];
   string symbol=fields[4];
   string side=fields[5];
   double volume=StringToDouble(fields[6]);
   double stop_loss=StringToDouble(fields[7]);
   double take_profit=StringToDouble(fields[8]);
   string idempotency=fields[9];
   string global_key=SafeGlobalKey(idempotency);

   if(order_id=="" || idempotency=="" || StringLen(idempotency)>31 || !SymbolSelect(symbol, true) || volume<=0 || stop_loss<=0 || take_profit<=0 || (side!="BUY" && side!="SELL")) { WriteError(request_id, "invalid order parameters"); return; }
   if(GlobalVariableCheck(global_key)) { WriteError(request_id, "duplicate idempotency key"); return; }

   double volume_min=SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double volume_max=SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double volume_step=SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   int digits=(int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double point=SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(volume_min<=0 || volume_max<volume_min || volume_step<=0 || point<=0) { WriteError(request_id, "symbol trading specifications unavailable"); return; }
   double normalized_volume=MathFloor((volume+1e-12)/volume_step)*volume_step;
   int volume_digits=0;
   double step_probe=volume_step;
   while(volume_digits<8 && MathAbs(step_probe-MathRound(step_probe))>1e-10) { step_probe*=10.0; volume_digits++; }
   normalized_volume=NormalizeDouble(normalized_volume, volume_digits);
   if(normalized_volume<volume_min || normalized_volume>volume_max || MathAbs(normalized_volume-volume)>MathMax(volume_step/10.0, 1e-12)) { WriteError(request_id, "volume violates broker min/max/step"); return; }

   MqlTick tick;
   if(!SymbolInfoTick(symbol, tick)) { WriteError(request_id, "symbol quote unavailable"); return; }
   int stops_level=(int)SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
   int freeze_level=(int)SymbolInfoInteger(symbol, SYMBOL_TRADE_FREEZE_LEVEL);
   double minimum_distance=MathMax(stops_level, freeze_level)*point;
   double reference_price=side=="BUY" ? tick.ask : tick.bid;
   stop_loss=NormalizeDouble(stop_loss, digits);
   take_profit=NormalizeDouble(take_profit, digits);
   if(side=="BUY" && !(stop_loss<reference_price && take_profit>reference_price)) { WriteError(request_id, "BUY stop/target are on the wrong side of market"); return; }
   if(side=="SELL" && !(stop_loss>reference_price && take_profit<reference_price)) { WriteError(request_id, "SELL stop/target are on the wrong side of market"); return; }
   if(MathAbs(reference_price-stop_loss)<minimum_distance || MathAbs(take_profit-reference_price)<minimum_distance) { WriteError(request_id, "stop or target violates broker minimum/freeze distance"); return; }

   double required_margin=0.0;
   ENUM_ORDER_TYPE order_type=side=="BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   if(!OrderCalcMargin(order_type, symbol, normalized_volume, reference_price, required_margin) || required_margin<=0 || required_margin>AccountInfoDouble(ACCOUNT_MARGIN_FREE)) { WriteError(request_id, "insufficient margin or margin calculation failed"); return; }

   Trade.SetExpertMagicNumber(InpMagicNumber);
   Trade.SetDeviationInPoints(InpMaxDeviationPoints);
   Trade.SetTypeFillingBySymbol(symbol);
   Trade.SetMarginMode();
   Trade.SetAsyncMode(false);

   bool sent=false;
   if(side=="BUY") sent=Trade.Buy(normalized_volume, symbol, 0.0, stop_loss, take_profit, idempotency);
   else sent=Trade.Sell(normalized_volume, symbol, 0.0, stop_loss, take_profit, idempotency);

   uint retcode=Trade.ResultRetcode();
   if(!sent || (retcode!=TRADE_RETCODE_DONE && retcode!=TRADE_RETCODE_DONE_PARTIAL && retcode!=TRADE_RETCODE_PLACED))
     { WriteError(request_id, StringFormat("broker rejected order retcode=%u comment=%s", retcode, Trade.ResultRetcodeDescription())); return; }

   ulong broker_order=Trade.ResultOrder();
   ulong deal=Trade.ResultDeal();
   double filled_price=Trade.ResultPrice();
   double filled_volume=Trade.ResultVolume();
   if((broker_order==0 && deal==0) || filled_price<=0 || filled_volume<=0) { WriteError(request_id, "broker confirmation incomplete"); return; }

   GlobalVariableSet(global_key, (double)TimeCurrent());
   WriteResponse(request_id, StringFormat("O|%I64u|%I64u|%.10f|%.10f", broker_order, deal, filled_price, filled_volume));
  }
