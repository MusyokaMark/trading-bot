require("dotenv").config({ path: ".env" });
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cron = require("node-cron");

// ─── Config ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PRICE_API_KEY = process.env.TWELVE_DATA_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const ALERT_CHAT_IDS = (process.env.ALERT_CHAT_IDS || "")
  .split(",")
  .filter(Boolean);

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
// Auto-reconnect on network errors
bot.on("polling_error", (err) => {
  if (err.code === "EFATAL") {
    console.log("Network drop detected — reconnecting in 5 seconds...");
    setTimeout(() => {
      bot.startPolling();
    }, 5000);
  }
});

// ─── System Prompt ────────────────────────────────────────────────────────────
const TRADING_SYSTEM_PROMPT = `You are a professional short-term trading analyst. The trader has a small account between $50 and $100. Every recommendation must reflect this reality with strict discipline.

ACCOUNT RULES — never break these:
- Account size: $50–$100
- Max risk per trade: 1% of account ($0.50–$1.00)
- Minimum Risk/Reward ratio: 1:2 (preferably 1:3)
- Timeframes: 30-minute and 1-hour charts only
- Maximum 1 open trade at a time
- No trading during major news events
- If setup is not clean and clear, output NO TRADE
- Stop loss is mandatory on every trade
- Never widen a stop loss once set

TIMEFRAME CONTEXT:
- 1H chart = primary trend direction
- 30M chart = entry timing and confirmation
- Look for alignment between both timeframes before recommending entry

For each analysis (which includes live price, RSI, MA20, MA50, and recent news), provide:

1. TREND ANALYSIS
- 1H trend: bullish / bearish / sideways
- 30M trend: bullish / bearish / sideways
- Timeframe alignment: aligned / conflicted
- Price position relative to MA20 and MA50
- Key support and resistance levels closest to current price

2. MOMENTUM
- RSI reading and what it means right now
- Is momentum increasing or fading
- Any divergence signals if present

3. NEWS & SENTIMENT
- Brief summary of relevant headlines
- Sentiment: Bullish / Bearish / Neutral
- High impact news risk: Yes / No
- If Yes, output NO TRADE regardless of technicals

4. TRADE SETUP
Output in exactly this format, no deviation:

INSTRUMENT: [XAUUSD or BTCUSD]
SIGNAL: [BUY / SELL / NO TRADE]
TIMEFRAME: [30M / 1H]
ENTRY: [exact price or tight range]
STOP LOSS: [exact price] — [X] pips/points
TAKE PROFIT 1: [price] — [X] pips/points (1:1.5 — partial close)
TAKE PROFIT 2: [price] — [X] pips/points (1:3 — full close)
RISK ON $50 ACCOUNT: $0.50 (1%)
RISK ON $100 ACCOUNT: $1.00 (1%)
CONFIDENCE: [Low / Medium / High]
SETUP QUALITY: [A — strong confluence / B — moderate / C — weak, avoid]
REASONING: [3 sentences max. Be direct. State the exact technical reason for the call.]

POSITION SIZING NOTE:
Always remind the trader that on a $50–$100 account they should use the minimum lot size available on their broker (usually 0.01 lots). Never suggest increasing size to make more money.

If SIGNAL is NO TRADE, explain in 2 sentences exactly what needs to happen before a valid setup forms.
Do not use excessive emojis. Keep the tone professional, concise, and direct. This is real money.`;

// ─── Price Fetcher ────────────────────────────────────────────────────────────
async function fetchPrice(symbol) {
  try {
    if (symbol === "BTCUSD") {
      const res = await axios.get(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
        { timeout: 5000 },
      );
      return res.data.bitcoin.usd;
    }
    if (PRICE_API_KEY) {
      const res = await axios.get(
        `https://api.twelvedata.com/price?symbol=${symbol === "XAUUSD" ? "XAU/USD" : "BTC/USD"}&apikey=${PRICE_API_KEY}`,
        { timeout: 5000 },
      );
      return res.data.price ? parseFloat(res.data.price) : null;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── RSI Fetcher (30M and 1H) ─────────────────────────────────────────────────
async function fetchRSI(symbol, interval = "1h") {
  try {
    if (!PRICE_API_KEY) return null;
    const res = await axios.get(
      `https://api.twelvedata.com/rsi?symbol=${symbol === "XAUUSD" ? "XAU/USD" : "BTC/USD"}&interval=${interval}&time_period=14&apikey=${PRICE_API_KEY}`,
      { timeout: 5000 },
    );
    const values = res.data.values;
    return values && values[0] ? parseFloat(values[0].rsi).toFixed(2) : null;
  } catch {
    return null;
  }
}

// ─── MA Fetcher (30M and 1H) ──────────────────────────────────────────────────
async function fetchMA(symbol, period, interval = "1h") {
  try {
    if (!PRICE_API_KEY) return null;
    const res = await axios.get(
      `https://api.twelvedata.com/ma?symbol=${symbol === "XAUUSD" ? "XAU/USD" : "BTC/USD"}&interval=${interval}&time_period=${period}&apikey=${PRICE_API_KEY}`,
      { timeout: 5000 },
    );
    const values = res.data.values;
    return values && values[0] ? parseFloat(values[0].ma).toFixed(2) : null;
  } catch {
    return null;
  }
}

// ─── News Fetcher ─────────────────────────────────────────────────────────────
async function fetchNews(instrument) {
  try {
    const query =
      instrument === "XAUUSD"
        ? "gold price XAU Federal Reserve inflation"
        : "bitcoin BTC crypto price market";

    if (NEWS_API_KEY) {
      const res = await axios.get(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=5&language=en&apiKey=${NEWS_API_KEY}`,
        { timeout: 5000 },
      );
      if (res.data.articles && res.data.articles.length > 0) {
        return res.data.articles
          .slice(0, 5)
          .map((a, i) => `${i + 1}. ${a.title} (${a.source.name})`)
          .join("\n");
      }
    }

    if (instrument === "BTCUSD") {
      const res = await axios.get(
        "https://cryptopanic.com/api/v1/posts/?auth_token=free&currencies=BTC&kind=news",
        { timeout: 5000 },
      );
      if (res.data.results) {
        return res.data.results
          .slice(0, 5)
          .map((a, i) => `${i + 1}. ${a.title}`)
          .join("\n");
      }
    }
    return "No live news available.";
  } catch {
    return "News fetch failed.";
  }
}

// ─── Build Full Prompt ────────────────────────────────────────────────────────
async function buildAnalysisPrompt(instrument) {
  console.log(`Fetching live data for ${instrument}...`);

  const [price, rsi1h, rsi30m, ma20_1h, ma50_1h, ma20_30m, ma50_30m, news] =
    await Promise.all([
      fetchPrice(instrument),
      fetchRSI(instrument, "1h"),
      fetchRSI(instrument, "30min"),
      fetchMA(instrument, 20, "1h"),
      fetchMA(instrument, 50, "1h"),
      fetchMA(instrument, 20, "30min"),
      fetchMA(instrument, 50, "30min"),
      fetchNews(instrument),
    ]);

  let dataBlock = `=== LIVE MARKET DATA: ${instrument} ===\n`;
  dataBlock += `Current Price: $${price ? price.toLocaleString() : "unavailable"}\n\n`;

  dataBlock += `--- 1H CHART ---\n`;
  dataBlock += `RSI(14): ${rsi1h || "unavailable"}\n`;
  dataBlock += `MA20: ${ma20_1h ? "$" + ma20_1h : "unavailable"}\n`;
  dataBlock += `MA50: ${ma50_1h ? "$" + ma50_1h : "unavailable"}\n\n`;

  dataBlock += `--- 30M CHART ---\n`;
  dataBlock += `RSI(14): ${rsi30m || "unavailable"}\n`;
  dataBlock += `MA20: ${ma20_30m ? "$" + ma20_30m : "unavailable"}\n`;
  dataBlock += `MA50: ${ma50_30m ? "$" + ma50_30m : "unavailable"}\n\n`;

  dataBlock += `--- LATEST NEWS ---\n${news}\n\n`;
  dataBlock += `Perform a full short-term analysis (30M/1H) and give your trade recommendation for a $50–$100 account trader.`;

  return dataBlock;
}

// ─── Claude API ───────────────────────────────────────────────────────────────
async function analyzeWithClaude(userMessage) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: TRADING_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    },
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      timeout: 30000,
    },
  );
  return response.data.content[0].text;
}

// ─── Broadcast ────────────────────────────────────────────────────────────────
async function broadcastAlert(text) {
  for (const chatId of ALERT_CHAT_IDS) {
    try {
      await bot.sendMessage(chatId.trim(), text, { parse_mode: "HTML" });
    } catch (err) {
      console.error(`Broadcast failed for ${chatId}:`, err.message);
    }
  }
}

// ─── Scheduled Alerts (every 2 hours during market hours) ────────────────────
cron.schedule("0 */2 * * *", async () => {
  console.log("Running scheduled analysis...");
  for (const instrument of ["XAUUSD", "BTCUSD"]) {
    try {
      const prompt = await buildAnalysisPrompt(instrument);
      const analysis = await analyzeWithClaude(prompt);
      await broadcastAlert(
        `<b>SCHEDULED ALERT — ${instrument}</b>\n\n${analysis}`,
      );
    } catch (err) {
      console.error(`Scheduled error (${instrument}):`, err.message);
    }
  }
});

// ─── Run Analysis Helper ──────────────────────────────────────────────────────
async function runAnalysis(chatId, instrument) {
  const thinking = await bot.sendMessage(
    chatId,
    `Fetching live data for ${instrument} — 30M and 1H charts...\nPlease wait 10–15 seconds.`,
  );
  try {
    const prompt = await buildAnalysisPrompt(instrument);
    const analysis = await analyzeWithClaude(prompt);
    await bot.deleteMessage(chatId, thinking.message_id);
    await bot.sendMessage(
      chatId,
      `<b>${instrument} — SHORT TERM ANALYSIS</b>\n\n${analysis}`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    await bot.editMessageText(`Error: ${err.message}`, {
      chat_id: chatId,
      message_id: thinking.message_id,
    });
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `<b>TradingBot — Short Term Edition</b>\n\n` +
      `Professional 30M/1H analysis for small accounts ($50–$100).\n\n` +
      `<b>Commands:</b>\n` +
      `/gold — Analyze XAUUSD (30M + 1H)\n` +
      `/btc — Analyze BTCUSD (30M + 1H)\n` +
      `/both — Analyze both markets\n` +
      `/ask [question] — Ask anything\n` +
      `/risk — Risk management rules\n` +
      `/sizing — Position sizing guide\n` +
      `/help — Show this menu\n\n` +
      `Alerts run automatically every 2 hours.`,
    { parse_mode: "HTML" },
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `<b>Commands</b>\n\n` +
      `/gold — XAUUSD 30M/1H analysis\n` +
      `/btc — BTCUSD 30M/1H analysis\n` +
      `/both — Both markets\n` +
      `/ask [question] — Custom question\n` +
      `/risk — Risk rules\n` +
      `/sizing — Position sizing for $50–$100\n` +
      `/help — This menu`,
    { parse_mode: "HTML" },
  );
});

bot.onText(/\/risk/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `<b>Risk Management Rules — $50 to $100 Account</b>\n\n` +
      `1. Risk maximum 1% per trade\n` +
      `   $50 account = $0.50 max risk\n` +
      `   $100 account = $1.00 max risk\n\n` +
      `2. Minimum 1:2 Risk/Reward on every trade\n` +
      `   If risking $1, target must be at least $2\n\n` +
      `3. One trade at a time only\n` +
      `   Do not open a second position while one is running\n\n` +
      `4. No trading 30 minutes before/after major news\n` +
      `   NFP, CPI, FOMC, Fed speeches — stay out\n\n` +
      `5. Stop loss is set at entry and never moved wider\n\n` +
      `6. Three consecutive losses — stop for the day\n` +
      `   Review your trades before tomorrow\n\n` +
      `7. Do not increase lot size to recover losses\n` +
      `   Stick to 0.01 lots until account reaches $500`,
    { parse_mode: "HTML" },
  );
});

bot.onText(/\/sizing/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `<b>Position Sizing Guide — Small Account</b>\n\n` +
      `Always trade minimum lot size: <b>0.01 lots</b>\n\n` +
      `<b>XAUUSD (Gold)</b>\n` +
      `0.01 lots = ~$0.10 per pip\n` +
      `10 pip stop loss = $1.00 risk\n` +
      `20 pip stop loss = $2.00 risk\n\n` +
      `<b>BTCUSD (Bitcoin)</b>\n` +
      `Use minimum contract size on your broker\n` +
      `Keep stop loss tight — BTC moves fast\n\n` +
      `<b>Rule of thumb:</b>\n` +
      `Calculate your stop loss in pips first.\n` +
      `Then size your position so that stop = 1% of account.\n` +
      `Never do it the other way around.\n\n` +
      `At $50–$100, your goal is <b>consistency, not profit size</b>.\n` +
      `Focus on winning percentage and R/R ratio.`,
    { parse_mode: "HTML" },
  );
});

bot.onText(/\/gold/, (msg) => runAnalysis(msg.chat.id, "XAUUSD"));
bot.onText(/\/btc/, (msg) => runAnalysis(msg.chat.id, "BTCUSD"));

bot.onText(/\/both/, async (msg) => {
  const chatId = msg.chat.id;
  const thinking = await bot.sendMessage(
    chatId,
    "Fetching live data for both markets — 30M and 1H charts...\nPlease wait 20–30 seconds.",
  );
  try {
    for (const instrument of ["XAUUSD", "BTCUSD"]) {
      const prompt = await buildAnalysisPrompt(instrument);
      const analysis = await analyzeWithClaude(prompt);
      await bot.sendMessage(
        chatId,
        `<b>${instrument} — SHORT TERM ANALYSIS</b>\n\n${analysis}`,
        { parse_mode: "HTML" },
      );
    }
    await bot.deleteMessage(chatId, thinking.message_id);
  } catch (err) {
    await bot.editMessageText(`Error: ${err.message}`, {
      chat_id: chatId,
      message_id: thinking.message_id,
    });
  }
});

bot.onText(/\/ask (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const question = match[1];
  const thinking = await bot.sendMessage(chatId, "Analyzing...");
  try {
    const answer = await analyzeWithClaude(
      `The trader has a $50–$100 account trading short term (30M/1H). Their question: ${question}`,
    );
    await bot.deleteMessage(chatId, thinking.message_id);
    await bot.sendMessage(chatId, `<b>Analysis</b>\n\n${answer}`, {
      parse_mode: "HTML",
    });
  } catch (err) {
    await bot.editMessageText(`Error: ${err.message}`, {
      chat_id: chatId,
      message_id: thinking.message_id,
    });
  }
});

bot.on("message", (msg) => {
  if (msg.text && !msg.text.startsWith("/")) {
    bot.sendMessage(
      msg.chat.id,
      "Use /gold, /btc, /both, or /ask [question] to get started. Type /help for all commands.",
    );
  }
});

console.log("TradingBot (Short Term Edition) is running...");
