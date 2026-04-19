/**
 * Alpaca Trading Bot
 * ─────────────────────────────────────────────────────────────
 * Crypto  — 24/7, top pairs auto-discovered weekly by ATR%
 * Stocks  — NYSE hours only (9:30–16:00 ET), top movers weekly
 *
 * Strategy: EMA(9/21) trend + RSI zone + 15m bias + VWAP
 * Sizing:   HALF (0 bonus) / FULL (1 bonus) / STRONG (2+ bonus)
 * Broker:   Alpaca (paper by default)
 * Alerts:   Telegram — entry, exit, P&L, daily summary
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import http from "http";
import { notify, fmtEntry, fmtExit, fmtSummary } from "./telegram.js";

http.createServer((_, res) => res.end("OK")).on("error", () => {}).listen(process.env.PORT || 3000);

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  key:             process.env.ALPACA_API_KEY    || "",
  secret:          process.env.ALPACA_SECRET_KEY || "",
  baseUrl:         process.env.ALPACA_BASE_URL   || "https://paper-api.alpaca.markets",
  portfolioUSD:    parseFloat(process.env.PORTFOLIO_VALUE_USD  || "2000"),
  riskPct:         parseFloat(process.env.RISK_PCT             || "1"),    // % per FULL trade
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY     || "20"),
  maxOpenPos:      parseInt(process.env.MAX_OPEN_POSITIONS      || "5"),
  stockPool: (process.env.STOCK_POOL ||
    "SPY,QQQ,NVDA,AAPL,TSLA,META,GOOGL,AMD,AMZN,MSFT,NFLX,CRM,DDOG,MSTR"
  ).split(","),
};

const DATA_URL = "https://data.alpaca.markets";
const isPaper  = CONFIG.baseUrl.includes("paper");

// ─── Alpaca API helpers ───────────────────────────────────────────────────────

const AUTH = {
  "APCA-API-KEY-ID":     CONFIG.key,
  "APCA-API-SECRET-KEY": CONFIG.secret,
  "Content-Type":        "application/json",
};

async function alpaca(method, path, body) {
  const res = await fetch(`${CONFIG.baseUrl}${path}`, {
    method, headers: AUTH, body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json();
  if (!res.ok) throw new Error(`Alpaca ${method} ${path}: ${json.message || res.status}`);
  return json;
}

async function alpacaData(path) {
  const res = await fetch(`${DATA_URL}${path}`, { headers: AUTH });
  if (!res.ok) throw new Error(`AlpacaData ${path}: ${res.status}`);
  return res.json();
}

// ─── Market Data ─────────────────────────────────────────────────────────────

function parseBars(raw) {
  return (Array.isArray(raw) ? raw : []).map(b => ({
    time: new Date(b.t).getTime(),
    open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
  }));
}

async function fetchCryptoBars(symbols, tf = "5Min", limit = 100) {
  const q = `symbols=${encodeURIComponent(symbols.join(","))}&timeframe=${tf}&limit=${limit}`;
  const d = await alpacaData(`/v1beta3/crypto/us/bars?${q}`);
  const r = {};
  for (const [s, bars] of Object.entries(d.bars || {})) r[s] = parseBars(bars);
  return r;
}

async function fetchStockBars(symbols, tf = "5Min", limit = 100) {
  const q = `symbols=${encodeURIComponent(symbols.join(","))}&timeframe=${tf}&limit=${limit}&adjustment=raw&feed=iex`;
  const d = await alpacaData(`/v2/stocks/bars?${q}`);
  const r = {};
  for (const [s, bars] of Object.entries(d.bars || {})) r[s] = parseBars(bars);
  return r;
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-(period + 1));
  const trs = slice.slice(1).map((c, i) => Math.max(
    c.high - c.low,
    Math.abs(c.high - slice[i].close),
    Math.abs(c.low  - slice[i].close),
  ));
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function calcVWAP(candles) {
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  const src = candles.filter(c => c.time >= midnight.getTime());
  const use = src.length >= 5 ? src : candles.slice(-20);
  if (!use.length) return null;
  const vol = use.reduce((s, c) => s + c.volume, 0);
  if (vol === 0) return use.reduce((s, c) => s + (c.high + c.low + c.close) / 3, 0) / use.length;
  return use.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0) / vol;
}

// ─── 15m Bias Cache ───────────────────────────────────────────────────────────

const biasCache = {};

async function getTrendBias(symbol, isCrypto) {
  const now = Date.now();
  if (biasCache[symbol]?.expiresAt > now) return biasCache[symbol].bias;
  try {
    const map  = isCrypto
      ? await fetchCryptoBars([symbol], "15Min", 60)
      : await fetchStockBars([symbol], "15Min", 60);
    const bars = map[symbol] || [];
    if (bars.length < 50) return null;
    const closes = bars.map(b => b.close);
    const ema50  = calcEMA(closes, 50);
    const bias   = closes[closes.length - 1] > ema50 ? "bullish" : "bearish";
    biasCache[symbol] = { bias, expiresAt: now + 15 * 60 * 1000 };
    return bias;
  } catch { return biasCache[symbol]?.bias ?? null; }
}

// ─── Strategy ─────────────────────────────────────────────────────────────────

const PARAMS = {
  crypto: { emaFast: 9, emaSlow: 21, rsiBullMin: 45, rsiBullMax: 75, rsiBearMin: 25, rsiBearMax: 55, vwapDistMax: 2.5, trendMin: 0.05 },
  stock:  { emaFast: 9, emaSlow: 21, rsiBullMin: 45, rsiBullMax: 75, rsiBearMin: 25, rsiBearMax: 55, vwapDistMax: 1.5, trendMin: 0.08 },
};

function runStrategy(candles, trendBias, p) {
  const closes   = candles.map(c => c.close);
  const price    = closes[closes.length - 1];
  const emaFast  = calcEMA(closes, p.emaFast);
  const emaSlow  = calcEMA(closes, p.emaSlow);
  const rsi      = calcRSI(closes);
  const vwap     = calcVWAP(candles);
  const atr      = calcATR(candles);
  const trendStr = Math.abs(emaFast - emaSlow) / price * 100;

  console.log(`  $${price.toFixed(4)} | EMA(${p.emaFast}): $${emaFast.toFixed(4)} | EMA(${p.emaSlow}): $${emaSlow.toFixed(4)} | RSI: ${rsi ? rsi.toFixed(1) : "N/A"} | VWAP: ${vwap ? "$" + vwap.toFixed(4) : "N/A"}`);

  // Critical — both must pass or block
  const trendOk = emaFast !== emaSlow;
  const strengthOk = trendStr >= p.trendMin;
  console.log(`  ${trendOk ? "✅" : "🚫"} [C] EMA direction | ${strengthOk ? "✅" : "🚫"} [C] Trend strength ${trendStr.toFixed(3)}%`);
  if (!trendOk || !strengthOk) return { pass: false, score: 0, side: null, price, atr };

  const goLong = emaFast > emaSlow;
  const side   = goLong ? "buy" : "sell";

  // Bonus — each passing adds +1 to confidence
  let score = 0;
  const rsiBull = rsi !== null && rsi >= p.rsiBullMin && rsi <= p.rsiBullMax;
  const rsiBear = rsi !== null && rsi >= p.rsiBearMin && rsi <= p.rsiBearMax;
  const rsiPass = goLong ? rsiBull : rsiBear;
  if (rsiPass) score++;
  console.log(`  ${rsiPass ? "✅" : "⚪"} [B] RSI zone (${goLong ? `${p.rsiBullMin}–${p.rsiBullMax}` : `${p.rsiBearMin}–${p.rsiBearMax}`}): ${rsi ? rsi.toFixed(1) : "N/A"}`);

  if (trendBias) {
    const biasPass = (trendBias === "bullish" && goLong) || (trendBias === "bearish" && !goLong);
    if (biasPass) score++;
    console.log(`  ${biasPass ? "✅" : "⚪"} [B] 15m bias ${trendBias.toUpperCase()} aligns`);
  }

  if (vwap) {
    const dist = Math.abs(price - vwap) / vwap * 100;
    const vwapPass = (goLong ? price > vwap : price < vwap) && dist < p.vwapDistMax;
    if (vwapPass) score++;
    console.log(`  ${vwapPass ? "✅" : "⚪"} [B] VWAP aligned (dist ${dist.toFixed(2)}%)`);
  }

  return { pass: true, score, side, price, atr };
}

// ─── Trade sizing ─────────────────────────────────────────────────────────────

function calcSize(score) {
  const base = CONFIG.portfolioUSD * CONFIG.riskPct / 100;
  if (score >= 2) return +(base * 1.5).toFixed(2);
  if (score === 1) return +base.toFixed(2);
  return +(base * 0.5).toFixed(2);
}

function confidenceLabel(score) {
  if (score >= 2) return "💪 STRONG";
  if (score === 1) return "✅ FULL";
  return "〰️  HALF";
}

// ─── SL / TP ─────────────────────────────────────────────────────────────────

function calcSLTP(side, price, atr) {
  const risk = atr * 1.0;
  return {
    sl: +(side === "buy" ? price - risk : price + risk).toFixed(4),
    tp: +(side === "buy" ? price + risk * 2 : price - risk * 2).toFixed(4),
  };
}

// ─── NYSE session ─────────────────────────────────────────────────────────────

function getNYHour() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === "hour").value);
  const m = parseInt(parts.find(p => p.type === "minute").value);
  return h + m / 60;
}

function isNYSEOpen() {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short",
  }).format(new Date());
  if (day === "Sat" || day === "Sun") return false;
  const h = getNYHour();
  return h >= 9.5 && h < 16;
}

// ─── Position store ───────────────────────────────────────────────────────────

const POS_FILE = "positions.json";
const LOG_FILE = "trade-log.json";

function loadPos()   { return existsSync(POS_FILE) ? JSON.parse(readFileSync(POS_FILE, "utf8")) : {}; }
function savePos(p)  { writeFileSync(POS_FILE, JSON.stringify(p, null, 2)); }
function loadLog()   { return existsSync(LOG_FILE) ? JSON.parse(readFileSync(LOG_FILE, "utf8")) : { trades: [] }; }
function saveLog(l)  { writeFileSync(LOG_FILE, JSON.stringify(l, null, 2)); }

function todayTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(t => t.date === today && t.placed).length;
}

// ─── Exit detection ───────────────────────────────────────────────────────────

async function checkExits() {
  const stored = loadPos();
  if (!Object.keys(stored).length) return;

  let alpacaPositions;
  try {
    alpacaPositions = await alpaca("GET", "/v2/positions");
  } catch { return; }

  const live = new Set(alpacaPositions.map(p => p.symbol));
  const updated = { ...stored };

  for (const [sym, pos] of Object.entries(stored)) {
    if (live.has(sym)) continue;

    // Position closed — fetch actual exit from Alpaca orders
    let exitPrice = null;
    try {
      const orders = await alpaca("GET", `/v2/orders?status=closed&symbols=${sym}&limit=10&direction=desc`);
      const exitOrder = orders?.find(o =>
        o.symbol === sym &&
        ["stop_loss", "take_profit"].includes(o.order_class) &&
        o.status === "filled" &&
        new Date(o.filled_at).getTime() > pos.openedAt
      ) || orders?.find(o => o.symbol === sym && o.status === "filled" && new Date(o.filled_at).getTime() > pos.openedAt);
      if (exitOrder?.filled_avg_price) exitPrice = parseFloat(exitOrder.filled_avg_price);
    } catch { /* use SL/TP estimate */ }

    // Fallback: estimate by which was closer to exit
    if (!exitPrice) exitPrice = pos.side === "buy" ? pos.tp : pos.sl;

    const pnlUSD = pos.side === "buy"
      ? (exitPrice - pos.entryPrice) * (pos.size / pos.entryPrice)
      : (pos.entryPrice - exitPrice) * (pos.size / pos.entryPrice);
    const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * (pos.side === "buy" ? 100 : -100);
    const result = pnlUSD > 0.01 ? "WIN" : pnlUSD < -0.01 ? "LOSS" : "BREAKEVEN";

    const heldMs = Date.now() - pos.openedAt;
    const held   = heldMs < 3_600_000
      ? `${Math.round(heldMs / 60_000)} min`
      : `${(heldMs / 3_600_000).toFixed(1)} hr`;

    await notify(fmtExit({ symbol: sym, side: pos.side, entryPrice: pos.entryPrice, exitPrice, pnlUSD, pnlPct, result, held }));
    console.log(`  ${result === "WIN" ? "✅" : "❌"} ${sym} closed | P&L: $${pnlUSD.toFixed(2)} (${pnlPct.toFixed(2)}%)`);
    delete updated[sym];
  }

  savePos(updated);
}

// ─── Watchlist scanners ───────────────────────────────────────────────────────

const STABLECOINS = new Set(["USDCUSD","USDTUSD","BUSDUSD","DAIUSD","FRAXUSD","PAXGUSD","GUSD","TUSD"]);
const CRYPTO_WL   = "crypto-watchlist.json";
const STOCK_WL    = "stock-watchlist.json";

async function refreshCryptoWatchlist() {
  if (existsSync(CRYPTO_WL)) {
    const wl = JSON.parse(readFileSync(CRYPTO_WL, "utf8"));
    if (Date.now() - new Date(wl.updatedAt).getTime() < 24 * 3600 * 1000) return wl.symbols;
  }
  try {
    console.log("[CryptoScan] Discovering top crypto pairs from Alpaca...");
    const assets  = await alpaca("GET", "/v2/assets?asset_class=crypto&status=active&tradable=true");
    const symbols = assets
      .map(a => a.symbol.replace("/", ""))
      .filter(s => s.endsWith("USD") && !STABLECOINS.has(s));

    // Batch fetch 1-day bars in chunks of 10
    const scores = [];
    for (let i = 0; i < symbols.length; i += 10) {
      const chunk = symbols.slice(i, i + 10);
      try {
        const bars = await fetchCryptoBars(chunk, "1Day", 10);
        for (const [sym, candles] of Object.entries(bars)) {
          if (candles.length < 3) continue;
          const atr   = calcATR(candles, Math.min(candles.length - 1, 5));
          const price = candles[candles.length - 1].close;
          if (atr && price > 0) scores.push({ sym, atrPct: (atr / price) * 100 });
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }

    const top = scores.sort((a, b) => b.atrPct - a.atrPct).slice(0, 10).map(s => s.sym);
    console.log(`[CryptoScan] Top 10: ${top.join(", ")}`);
    writeFileSync(CRYPTO_WL, JSON.stringify({ symbols: top, updatedAt: new Date().toISOString() }, null, 2));
    await notify(`🔍 <b>Crypto Watchlist Updated</b>\n${top.join(", ")}`);
    return top;
  } catch (err) {
    console.log(`[CryptoScan] Failed: ${err.message}`);
    if (existsSync(CRYPTO_WL)) return JSON.parse(readFileSync(CRYPTO_WL, "utf8")).symbols;
    return ["BTCUSD","ETHUSD","SOLUSD","AVAXUSD","LINKUSD","DOGEUSD","LTCUSD","UNIUSD","BCHUSD","XLMUSD"];
  }
}

async function refreshStockWatchlist() {
  if (existsSync(STOCK_WL)) {
    const wl = JSON.parse(readFileSync(STOCK_WL, "utf8"));
    if (Date.now() - new Date(wl.updatedAt).getTime() < 7 * 24 * 3600 * 1000) return wl.symbols;
  }
  try {
    console.log("[StockScan] Scoring stocks by ATR%...");
    const bars   = await fetchStockBars(CONFIG.stockPool, "1Day", 15);
    const scores = [];
    for (const [sym, candles] of Object.entries(bars)) {
      if (candles.length < 5) continue;
      const atr   = calcATR(candles, Math.min(candles.length - 1, 10));
      const price = candles[candles.length - 1].close;
      if (atr && price > 0) scores.push({ sym, atrPct: (atr / price) * 100 });
    }
    const top = scores.sort((a, b) => b.atrPct - a.atrPct).slice(0, 8).map(s => s.sym);
    console.log(`[StockScan] Top 8: ${top.join(", ")}`);
    writeFileSync(STOCK_WL, JSON.stringify({ symbols: top, updatedAt: new Date().toISOString() }, null, 2));
    await notify(`🔍 <b>Stock Watchlist Updated</b>\n${top.join(", ")}`);
    return top;
  } catch (err) {
    console.log(`[StockScan] Failed: ${err.message}`);
    if (existsSync(STOCK_WL)) return JSON.parse(readFileSync(STOCK_WL, "utf8")).symbols;
    return ["QQQ","NVDA","TSLA","META","AMD","AMZN","GOOGL","SPY"];
  }
}

// ─── Order placement ──────────────────────────────────────────────────────────

async function placeOrder(symbol, side, size, price, sl, tp, isCrypto) {
  return alpaca("POST", "/v2/orders", {
    symbol,
    notional:       size.toFixed(2),
    side,
    type:           "market",
    time_in_force:  isCrypto ? "gtc" : "day",
    order_class:    "bracket",
    stop_loss:      { stop_price:  String(sl) },
    take_profit:    { limit_price: String(tp) },
  });
}

// ─── Per-symbol processing ────────────────────────────────────────────────────

async function processSymbol(symbol, candles, isCrypto, log) {
  console.log(`\n── ${symbol} (${isCrypto ? "crypto" : "stock"}) ${"─".repeat(30)}`);

  const positions = loadPos();
  if (positions[symbol]) { console.log(`  Already open — skipping`); return; }
  if (Object.keys(positions).length >= CONFIG.maxOpenPos) { console.log(`  Max open positions reached — skipping`); return; }

  const trendBias  = await getTrendBias(symbol, isCrypto);
  const p          = isCrypto ? PARAMS.crypto : PARAMS.stock;
  const { pass, score, side, price, atr } = runStrategy(candles, trendBias, p);

  if (!pass || !side || !atr) { console.log(`  🚫 BLOCKED`); return; }

  const confidence = confidenceLabel(score);
  const size       = calcSize(score);
  const { sl, tp } = calcSLTP(side, price, atr);

  console.log(`  ${confidence} — ${side.toUpperCase()} $${size.toFixed(2)} | SL: ${sl} | TP: ${tp}`);

  const logEntry = {
    date:   new Date().toISOString().slice(0, 10),
    symbol, side, price, size, confidence, placed: false,
  };

  try {
    const order = await placeOrder(symbol, side, size, price, sl, tp, isCrypto);
    logEntry.placed  = true;
    logEntry.orderId = order.id;

    const pos = loadPos();
    pos[symbol] = { symbol, side, entryPrice: price, size, sl, tp, openedAt: Date.now(), isCrypto };
    savePos(pos);

    await notify(fmtEntry({ symbol, side, price, size, sl, tp, confidence, mode: isPaper ? "PAPER" : "LIVE" }));
    console.log(`  ✅ Order placed — ${order.id}`);
  } catch (err) {
    console.log(`  ❌ Order failed: ${err.message}`);
    logEntry.error = err.message;
  }

  log.trades.push(logEntry);
}

// ─── Daily summary ────────────────────────────────────────────────────────────

let lastSummaryDate = "";

async function maybeSendDailySummary(log) {
  const nyH   = getNYHour();
  const today = new Date().toISOString().slice(0, 10);
  if (lastSummaryDate === today || nyH < 16 || nyH > 16.25) return;
  lastSummaryDate = today;

  const todays = log.trades.filter(t => t.date === today && t.placed);
  let equity;
  try { equity = parseFloat((await alpaca("GET", "/v2/account")).equity); } catch {}

  // Count wins/losses from closed positions (rough from log isn't possible without exit data)
  await notify(fmtSummary({
    date:       today,
    tradeCount: todays.length,
    winCount:   0,   // updated when exit tracking is enhanced
    lossCount:  0,
    pnlUSD:     equity ? equity - CONFIG.portfolioUSD : 0,
    equity,
  }));
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function run() {
  if (!CONFIG.key || !CONFIG.secret) {
    console.log("⚠️  ALPACA_API_KEY / ALPACA_SECRET_KEY missing — set them in Railway Variables");
    return;
  }

  const ts = new Date().toISOString();
  console.log(`\n${"═".repeat(56)}`);
  console.log(`  Alpaca Trading Bot — ${isPaper ? "📋 PAPER" : "🔴 LIVE"}`);
  console.log(`  ${ts}`);
  console.log(`${"═".repeat(56)}`);

  const log     = loadLog();
  const traded  = todayTrades(log);
  if (traded >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Daily trade limit reached (${traded}/${CONFIG.maxTradesPerDay})`);
    return;
  }

  await checkExits();

  const [cryptoSyms, stockSyms] = await Promise.all([
    refreshCryptoWatchlist(),
    refreshStockWatchlist(),
  ]);

  const nyseOpen = isNYSEOpen();
  console.log(`\nNYSE: ${nyseOpen ? "🟢 Open" : "🔴 Closed"} | Crypto: 🟢 24/7`);
  console.log(`Crypto (${cryptoSyms.length}): ${cryptoSyms.join(", ")}`);
  if (nyseOpen) console.log(`Stocks (${stockSyms.length}): ${stockSyms.join(", ")}`);

  // Batch fetch bars for all symbols at once
  let cryptoBars = {}, stockBars = {};
  try { cryptoBars = await fetchCryptoBars(cryptoSyms, "5Min", 100); } catch (e) { console.log(`⚠️  Crypto bars: ${e.message}`); }
  if (nyseOpen) {
    try { stockBars = await fetchStockBars(stockSyms, "5Min", 100); } catch (e) { console.log(`⚠️  Stock bars: ${e.message}`); }
  }

  // Process crypto (always)
  for (const sym of cryptoSyms) {
    if (todayTrades(log) >= CONFIG.maxTradesPerDay) break;
    const candles = cryptoBars[sym];
    if (!candles?.length) { console.log(`\n── ${sym} — no data`); continue; }
    await processSymbol(sym, candles, true, log);
  }

  // Process stocks (NYSE hours only)
  if (nyseOpen) {
    for (const sym of stockSyms) {
      if (todayTrades(log) >= CONFIG.maxTradesPerDay) break;
      const candles = stockBars[sym];
      if (!candles?.length) { console.log(`\n── ${sym} — no data`); continue; }
      await processSymbol(sym, candles, false, log);
    }
  }

  await maybeSendDailySummary(log);
  saveLog(log);
  console.log(`\n${"═".repeat(56)}\n`);
}

const RUN_INTERVAL_MS = 5 * 60 * 1000;
async function loop() {
  await run().catch(async err => {
    console.error("Cycle error:", err.message);
    await notify(`⚠️ <b>Bot error</b>\n${err.message}`).catch(() => {});
  });
  setTimeout(loop, RUN_INTERVAL_MS);
}
loop();
