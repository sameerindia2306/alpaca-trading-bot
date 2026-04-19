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
  const emoji = side === "buy" ? "🟢" : "🔴";
  return [
    `${emoji} <b>${side.toUpperCase()} ${symbol}</b>${mode === "PAPER" ? " [PAPER]" : ""}`,
    `Entry:      $${price.toFixed(4)}`,
    `Size:       $${size.toFixed(2)} — ${confidence}`,
    `Stop Loss:  $${sl.toFixed(4)}`,
    `Take Profit:$${tp.toFixed(4)}`,
  ].join("\n");
}

export function fmtExit({ symbol, side, entryPrice, exitPrice, pnlUSD, pnlPct, result, held }) {
  const emoji = result === "WIN" ? "✅" : result === "BREAKEVEN" ? "〰️" : "❌";
  const sign  = pnlUSD >= 0 ? "+" : "";
  return [
    `${emoji} <b>CLOSED ${symbol}</b> — ${result}`,
    `Entry:  $${entryPrice.toFixed(4)}`,
    `Exit:   $${exitPrice.toFixed(4)}`,
    `P&amp;L:    ${sign}$${pnlUSD.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`,
    `Held:   ${held}`,
  ].join("\n");
}

export function fmtSummary({ date, tradeCount, winCount, lossCount, pnlUSD, equity }) {
  const sign    = pnlUSD >= 0 ? "+" : "";
  const winRate = tradeCount > 0 ? ((winCount / tradeCount) * 100).toFixed(0) : "0";
  return [
    `📊 <b>Daily Summary — ${date}</b>`,
    `Trades:   ${tradeCount}  (${winCount}W / ${lossCount}L)`,
    `Win Rate: ${winRate}%`,
    `P&amp;L:      ${sign}$${pnlUSD.toFixed(2)}`,
    equity ? `Portfolio: $${equity.toFixed(2)}` : "",
  ].filter(Boolean).join("\n");
}
