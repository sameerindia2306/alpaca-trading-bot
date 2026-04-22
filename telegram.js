const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT  = process.env.TELEGRAM_CHAT_ID   || "";

export async function notify(text) {
  if (!TOKEN || !CHAT) {
    console.log(`[Telegram] SKIPPED — token: ${TOKEN ? "set" : "MISSING"}, chat: ${CHAT ? "set" : "MISSING"}`);
    return;
  }
  try {
    const res  = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML" }),
    });
    const json = await res.json();
    if (!json.ok) console.log(`[Telegram] ERROR: ${json.description}`);
    else console.log(`[Telegram] Sent OK`);
  } catch (err) {
    console.log(`[Telegram] FAILED: ${err.message}`);
  }
}

export function fmtEntry({ symbol, side, price, size, sl, tp, confidence, mode }) {
  const emoji     = side === "buy" ? "🟢" : "🔴";
  const direction = side === "buy" ? "LONG" : "SHORT";
  return [
    `${emoji} <b>${side.toUpperCase()} ${symbol} — ${direction}</b>${mode === "PAPER" ? " [PAPER]" : ""}`,
    `Entry: $${price.toFixed(4)} | Size: $${size.toFixed(2)}`,
    `SL: $${sl.toFixed(4)} | TP: $${tp.toFixed(4)}`,
  ].join("\n");
}

export function fmtExit({ symbol, side, entryPrice, exitPrice, pnlUSD, pnlPct, result, held }) {
  const emoji = result === "WIN" ? "✅" : result === "BREAKEVEN" ? "〰️" : "🔴";
  const sign  = pnlUSD >= 0 ? "+" : "";
  return [
    `${emoji} <b>CLOSED ${symbol}</b> — ${result}`,
    `P&L: ${sign}$${pnlUSD.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`,
    `Entry: $${entryPrice.toFixed(4)} → Exit: $${exitPrice.toFixed(4)}`,
  ].join("\n");
}

export function fmtSummary({ equity, lastEquity, trades, wins, losses, mode }) {
  const dayPnL  = equity - lastEquity;
  const sign    = dayPnL >= 0 ? "+" : "";
  const pct     = lastEquity > 0 ? (dayPnL / lastEquity * 100).toFixed(2) : "0.00";
  const emoji   = dayPnL >= 0 ? "📈" : "📉";
  return [
    `${emoji} <b>Daily Summary${mode === "PAPER" ? " [PAPER]" : ""}</b>`,
    `Equity: $${equity.toFixed(2)} (${sign}$${dayPnL.toFixed(2)} / ${sign}${pct}%)`,
    `Trades: ${trades} | Wins: ${wins} | Losses: ${losses}`,
  ].join("\n");
}
