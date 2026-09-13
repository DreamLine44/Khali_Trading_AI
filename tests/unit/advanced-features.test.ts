import * as assert from "assert";
import { bollinger, detectCandlestickPatterns, macd, marketStructure, stochastic, wma } from "../../src/core/features/advanced";
import { Candle } from "../../src/core/types";

function c(i:number,o:number,h:number,l:number,cl:number):Candle{return {symbol:"EURUSD",timeframe:"M15",timestampUtc:Date.now()+i*900000,open:o,high:h,low:l,close:cl,volume:100,isClosed:true};}
const up=Array.from({length:60},(_,i)=>c(i,1+i*.001,1+i*.0012,1+i*.0008,1+i*.001));
assert.ok(wma(up.map(x=>x.close),20)!>1);
assert.ok(macd(up.map(x=>x.close)).histogram !== null);
assert.ok(stochastic(up).k !== null);
assert.ok(bollinger(up.map(x=>x.close)).width !== null);
const engulf=[c(0,1.01,1.02,.99,1.0),c(1,1.0,1.01,.98,.99),c(2,.985,1.03,.98,1.025)];
assert.ok(detectCandlestickPatterns(engulf).includes("BULLISH_ENGULFING"));
assert.notStrictEqual(marketStructure(up).trend,"UNKNOWN");

// [FIX-CHOCH-DEAD-CODE] Regression coverage: chochBull/chochBear must be
// able to fire at all. Prior to the fix, `recent` (used for
// higherHigh/lowerHigh/higherLow/lowerLow) always included the very last
// candle, and last.high >= last.close always holds — so whenever bosBull
// was 1, lowerHigh was mathematically guaranteed to be 0 (and symmetrically
// for bosBear/higherLow), making chochBull/chochBear permanently stuck at
// 0 for every possible input (see the commit fixing this for a 200k-trial
// property-test proof). These two scenarios construct a real "was making
// the opposite-direction extreme, then broke structure the other way"
// setup for each direction and assert the CHoCH flag actually lights up.
const priorBlock = Array.from({ length: 20 }, (_, i) => c(i, 1.02, 1.05, 1.00, 1.02));
const padding = Array.from({ length: 2 }, (_, i) => c(-2 + i, 1.02, 1.05, 1.00, 1.02));

const bullishDip = Array.from({ length: 19 }, (_, i) => c(20 + i, 0.97, 1.00, 0.95, 0.97)); // lower low than prior
const bullishBreakout = c(39, 1.06, 1.11, 1.05, 1.10); // close breaks above prior high
const chochBullCandles = [...padding, ...priorBlock, ...bullishDip, bullishBreakout];
const chochBullStructure = marketStructure(chochBullCandles, 20);
assert.strictEqual(chochBullStructure.chochBull, 1, "chochBull must fire when a bullish break of structure follows a fresh lower low");

const bearishSpike = Array.from({ length: 19 }, (_, i) => c(20 + i, 1.08, 1.10, 1.05, 1.08)); // higher high than prior
const bearishBreakdown = c(39, 0.96, 1.00, 0.94, 0.95); // close breaks below prior low
const chochBearCandles = [...padding, ...priorBlock, ...bearishSpike, bearishBreakdown];
const chochBearStructure = marketStructure(chochBearCandles, 20);
assert.strictEqual(chochBearStructure.chochBear, 1, "chochBear must fire when a bearish break of structure follows a fresh higher high");

console.log("Advanced feature tests passed.");
