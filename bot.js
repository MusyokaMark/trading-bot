require("dotenv").config({ path: ".env" });
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PRICE_API_KEY = process.env.TWELVE_DATA_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const ALERT_CHAT_IDS = (process.env.ALERT_CHAT_IDS || "")
  .split(",")
  .filter(Boolean);
const DAILY_CREDIT_LIMIT = 750;

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10, allowed_updates: ["message"] },
  },
});

// ─── Bot State ────────────────────────────────────────────────────────────────
let botActive = true;

// ─── Duplicate Command Guard ──────────────────────────────────────────────────
const processingCommands = new Set();
function isProcessing(chatId, command) {
  const key = `${chatId}-${command}`;
  if (processingCommands.has(key)) return true;
  processingCommands.add(key);
  setTimeout(() => processingCommands.delete(key), 90000);
  return false;
}

// ─── Delay Helper ─────────────────────────────────────────────────────────────
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Credit Tracker ───────────────────────────────────────────────────────────
const CREDIT_FILE = path.join(__dirname, "credits.json");

function loadCredits() {
  const today = new Date().toISOString().split("T")[0];
  try {
    if (fs.existsSync(CREDIT_FILE)) {
      const data = JSON.parse(fs.readFileSync(CREDIT_FILE, "utf8"));
      if (data.date !== today) {
        const fresh = { date: today, used: 0 };
        fs.writeFileSync(CREDIT_FILE, JSON.stringify(fresh));
        return fresh;
      }
      return data;
    }
  } catch {}
  const fresh = { date: today, used: 0 };
  try {
    fs.writeFileSync(CREDIT_FILE, JSON.stringify(fresh));
  } catch {}
  return fresh;
}

function addCredit(count = 1) {
  const data = loadCredits();
  data.used += count;
  try {
    fs.writeFileSync(CREDIT_FILE, JSON.stringify(data));
  } catch {}
  return data.used;
}

function creditsRemaining() {
  return Math.max(0, DAILY_CREDIT_LIMIT - loadCredits().used);
}

function hasCredits(needed = 1) {
  return creditsRemaining() >= needed;
}

// Startup reset
(function checkCreditReset() {
  const today = new Date().toISOString().split("T")[0];
  try {
    let used = 0;
    if (fs.existsSync(CREDIT_FILE)) {
      const existing = JSON.parse(fs.readFileSync(CREDIT_FILE, "utf8"));
      if (existing.date === today) used = existing.used || 0;
    }
    fs.writeFileSync(CREDIT_FILE, JSON.stringify({ date: today, used }));
  } catch (err) {
    try {
      fs.writeFileSync(CREDIT_FILE, JSON.stringify({ date: today, used: 0 }));
    } catch {}
  }
})();

// ─── Data Cache (25 min TTL) ──────────────────────────────────────────────────
const dataCache = {};
const CACHE_TTL = 25 * 60 * 1000;

function getCached(key) {
  const entry = dataCache[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    delete dataCache[key];
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  dataCache[key] = { data, timestamp: Date.now() };
}

function clearCache(instrument) {
  Object.keys(dataCache)
    .filter((k) => k.includes(instrument))
    .forEach((k) => delete dataCache[k]);
}

// ─── Trade Journal ────────────────────────────────────────────────────────────
const JOURNAL_FILE = path.join(__dirname, "journal.json");

function loadJournal() {
  try {
    if (fs.existsSync(JOURNAL_FILE))
      return JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8"));
  } catch {}
  return [];
}

function saveJournal(j) {
  try {
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify(j, null, 2));
  } catch {}
}

function logSignal(entry) {
  const journal = loadJournal();
  const id = journal.length + 1;
  journal.push({
    id,
    timestamp: new Date().toISOString(),
    ...entry,
    outcome: "pending",
  });
  saveJournal(journal);
  return id;
}

function updateOutcome(id, outcome) {
  const journal = loadJournal();
  const trade = journal.find((t) => t.id === parseInt(id));
  if (trade) {
    trade.outcome = outcome;
    trade.closedAt = new Date().toISOString();
    saveJournal(journal);
    return true;
  }
  return false;
}

// ─── Drawdown Protection ──────────────────────────────────────────────────────
let consecutiveLosses = 0;
let botPausedUntil = null;

function isBotPaused() {
  if (!botPausedUntil) return false;
  if (Date.now() > botPausedUntil) {
    botPausedUntil = null;
    consecutiveLosses = 0;
    return false;
  }
  return true;
}

function recordLoss() {
  consecutiveLosses++;
  if (consecutiveLosses >= 3) {
    botPausedUntil = Date.now() + 24 * 60 * 60 * 1000;
    broadcast(
      "DRAWDOWN PROTECTION\n\n3 consecutive losses. Bot paused 24 hours.\nReview your trades: /journal",
    );
    return true;
  }
  return false;
}

function recordWin() {
  consecutiveLosses = 0;
}

// ─── Auto Reconnect ───────────────────────────────────────────────────────────
bot.on("polling_error", (err) => {
  if (err.code === "EFATAL") {
    console.log("Network drop — reconnecting in 5 seconds...");
    setTimeout(() => bot.startPolling(), 5000);
  }
});

// ─── Session Checker ──────────────────────────────────────────────────────────
function getSession() {
  const now = new Date();
  const utc = now.getUTCHours() + now.getUTCMinutes() / 60;
  const inLondon = utc >= 8 && utc < 17;
  const inNY = utc >= 13 && utc < 22;
  const inOverlap = utc >= 13 && utc < 17;
  const utcStr = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")} UTC`;
  return {
    isOptimal: inLondon || inNY,
    name: inOverlap
      ? "London/NY Overlap"
      : inLondon
        ? "London"
        : inNY
          ? "New York"
          : "Off-Hours",
    utcStr,
  };
}

// ─── Twelve Data Fetcher ──────────────────────────────────────────────────────
async function tdFetch(endpoint, params, cacheKey) {
  const cached = getCached(cacheKey);
  if (cached !== null) {
    console.log(`Cache: ${cacheKey}`);
    return cached;
  }
  if (!hasCredits(1)) {
    console.log(`No credits — skip ${cacheKey}`);
    return null;
  }
  try {
    const url = `https://api.twelvedata.com/${endpoint}?${params}&apikey=${PRICE_API_KEY}`;
    const res = await axios.get(url, { timeout: 20000 });
    if (res.data.code === 429) {
      console.log("429 rate limit — skipping");
      return null;
    }
    if (res.data.code) {
      console.log(`TD error (${endpoint}): ${res.data.message}`);
      return null;
    }
    addCredit(1);
    setCache(cacheKey, res.data);
    return res.data;
  } catch (err) {
    console.log(`TD error (${endpoint}): ${err.message}`);
    return null;
  }
}

// ─── Fetchers (max 8 TD calls per analysis) ───────────────────────────────────
async function fetchPrice(symbol) {
  try {
    if (symbol === "BTCUSD") {
      const cached = getCached("btc_price");
      if (cached) return cached;
      const res = await axios.get(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
        { timeout: 10000 },
      );
      const price = res.data.bitcoin.usd;
      setCache("btc_price", price);
      return price;
    }
    const data = await tdFetch("price", "symbol=XAU%2FUSD", `price_${symbol}`);
    return data?.price ? parseFloat(data.price) : null;
  } catch {
    return null;
  }
}

async function fetchRSI(symbol, interval) {
  const sym = symbol === "XAUUSD" ? "XAU%2FUSD" : "BTC%2FUSD";
  const data = await tdFetch(
    "rsi",
    `symbol=${sym}&interval=${interval}&time_period=14&outputsize=1`,
    `rsi_${symbol}_${interval}`,
  );
  return data?.values?.[0] ? parseFloat(data.values[0].rsi).toFixed(2) : null;
}

async function fetchMA(symbol, period, interval) {
  const sym = symbol === "XAUUSD" ? "XAU%2FUSD" : "BTC%2FUSD";
  const data = await tdFetch(
    "ma",
    `symbol=${sym}&interval=${interval}&time_period=${period}&outputsize=1`,
    `ma${period}_${symbol}_${interval}`,
  );
  return data?.values?.[0] ? parseFloat(data.values[0].ma).toFixed(2) : null;
}

async function fetchCandles(symbol, interval, count = 10) {
  const sym = symbol === "XAUUSD" ? "XAU%2FUSD" : "BTC%2FUSD";
  const data = await tdFetch(
    "time_series",
    `symbol=${sym}&interval=${interval}&outputsize=${count}`,
    `candles_${symbol}_${interval}_${count}`,
  );
  if (data?.values?.length > 0) {
    return data.values.map((c) => ({
      time: c.datetime,
      open: parseFloat(c.open).toFixed(2),
      high: parseFloat(c.high).toFixed(2),
      low: parseFloat(c.low).toFixed(2),
      close: parseFloat(c.close).toFixed(2),
    }));
  }
  return null;
}

async function fetchNews(instrument) {
  try {
    const cached = getCached(`news_${instrument}`);
    if (cached) return cached;
    const query =
      instrument === "XAUUSD" ? "gold XAU price" : "bitcoin BTC price";
    if (NEWS_API_KEY) {
      const res = await axios.get(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=3&language=en&apiKey=${NEWS_API_KEY}`,
        { timeout: 8000 },
      );
      if (res.data.articles?.length > 0) {
        const result = res.data.articles
          .slice(0, 3)
          .map((a, i) => `${i + 1}. ${a.title}`)
          .join("\n");
        setCache(`news_${instrument}`, result);
        return result;
      }
    }
    if (instrument === "BTCUSD") {
      const res = await axios.get(
        "https://cryptopanic.com/api/v1/posts/?auth_token=free&currencies=BTC&kind=news",
        { timeout: 8000 },
      );
      if (res.data.results) {
        const result = res.data.results
          .slice(0, 3)
          .map((a, i) => `${i + 1}. ${a.title}`)
          .join("\n");
        setCache("news_BTCUSD_cp", result);
        return result;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchFearGreed() {
  try {
    const cached = getCached("feargreed");
    if (cached) return cached;
    const res = await axios.get("https://api.alternative.me/fng/?limit=1", {
      timeout: 8000,
    });
    const d = res.data.data[0];
    const result = { value: parseInt(d.value), label: d.value_classification };
    setCache("feargreed", result);
    return result;
  } catch {
    return null;
  }
}

async function fetchEconomicEvents() {
  try {
    const cached = getCached("calendar");
    if (cached) return cached;
    if (PRICE_API_KEY && hasCredits(1)) {
      const today = new Date().toISOString().split("T")[0];
      const res = await axios.get(
        `https://api.twelvedata.com/economic_calendar?start_date=${today}&end_date=${today}&importance=high&apikey=${PRICE_API_KEY}`,
        { timeout: 8000 },
      );
      addCredit(1);
      if (res.data.result?.length > 0) {
        const now = Date.now();
        const upcoming = res.data.result.filter((e) => {
          const mins = (new Date(e.date).getTime() - now) / 60000;
          return mins > -30 && mins < 120;
        });
        const result = {
          hasHighImpact: upcoming.length > 0,
          events:
            upcoming.length > 0
              ? upcoming.map((e) => `${e.event} (${e.currency})`).join(", ")
              : "None",
        };
        setCache("calendar", result);
        return result;
      }
    }
    return { hasHighImpact: false, events: "None" };
  } catch {
    return { hasHighImpact: false, events: "Unavailable" };
  }
}

// ─── Confluence Scorer ────────────────────────────────────────────────────────
function scoreConfluence(data) {
  const { price, rsi1h, rsi4h, ma20_1h, ma50_1h } = data;
  if (!price)
    return {
      score: 0,
      direction: null,
      factors: [],
      bullish: 0,
      bearish: 0,
      total: 0,
    };
  const p = parseFloat(price);
  const factors = [];
  let bullish = 0,
    bearish = 0;

  if (ma20_1h) {
    if (p > parseFloat(ma20_1h)) {
      bullish++;
      factors.push(`Price above MA20 1H ($${ma20_1h})`);
    } else {
      bearish++;
      factors.push(`Price below MA20 1H ($${ma20_1h})`);
    }
  }
  if (ma50_1h) {
    if (p > parseFloat(ma50_1h)) {
      bullish++;
      factors.push(`Price above MA50 1H ($${ma50_1h})`);
    } else {
      bearish++;
      factors.push(`Price below MA50 1H ($${ma50_1h})`);
    }
  }
  if (rsi1h) {
    const r = parseFloat(rsi1h);
    if (r > 52 && r < 70) {
      bullish++;
      factors.push(`RSI 1H bullish (${r})`);
    } else if (r < 48 && r > 30) {
      bearish++;
      factors.push(`RSI 1H bearish (${r})`);
    } else factors.push(`RSI 1H neutral (${r})`);
  }
  if (rsi4h) {
    const r = parseFloat(rsi4h);
    if (r > 50) {
      bullish++;
      factors.push(`RSI 4H bullish (${r})`);
    } else {
      bearish++;
      factors.push(`RSI 4H bearish (${r})`);
    }
  }
  if (ma20_1h && ma50_1h) {
    if (parseFloat(ma20_1h) > parseFloat(ma50_1h)) {
      bullish++;
      factors.push("MA20 above MA50 — uptrend");
    } else {
      bearish++;
      factors.push("MA20 below MA50 — downtrend");
    }
  }

  const direction =
    bullish > bearish ? "BUY" : bearish > bullish ? "SELL" : null;
  return {
    score: Math.max(bullish, bearish),
    direction,
    bullish,
    bearish,
    total: bullish + bearish,
    factors,
  };
}

// ─── Build Data Block (max 8 TD calls) ───────────────────────────────────────
async function buildDataBlock(instrument, forceRefresh = false) {
  if (forceRefresh) clearCache(instrument);
  console.log(
    `Building data for ${instrument} (credits: ${creditsRemaining()})...`,
  );

  // Call 1 — price (CoinGecko for BTC, TD for gold)
  const price = await fetchPrice(instrument);
  await delay(1000);

  // Call 2 — RSI 4H
  const rsi4h = await fetchRSI(instrument, "4h");
  await delay(1000);

  // Call 3 — RSI 1H
  const rsi1h = await fetchRSI(instrument, "1h");
  await delay(1000);

  // Call 4 — RSI 30M
  const rsi30m = await fetchRSI(instrument, "30min");
  await delay(1000);

  // Call 5 — MA20 1H
  const ma20_1h = await fetchMA(instrument, 20, "1h");
  await delay(1000);

  // Call 6 — MA50 1H
  const ma50_1h = await fetchMA(instrument, 50, "1h");
  await delay(1000);

  // Call 7 — 1H candles (10 candles = price action + S/R + patterns)
  const candles1h = await fetchCandles(instrument, "1h", 10);
  await delay(1000);

  // Call 8 — 30M candles (entry timing)
  const candles30m = await fetchCandles(instrument, "30min", 10);

  // Free calls — no TD credits used
  const news = await fetchNews(instrument);
  const fearGreed = instrument === "BTCUSD" ? await fetchFearGreed() : null;
  const calendar = await fetchEconomicEvents();
  const session = getSession();

  // ATR and MACD dropped — Claude calculates from candle data instead
  // This keeps us at exactly 8 TD calls per analysis

  const confluence = scoreConfluence({ price, rsi1h, rsi4h, ma20_1h, ma50_1h });
  const p = price ? parseFloat(price) : 0;

  // Manual ATR estimate from candles (average candle range)
  let atrEstimate = null;
  if (candles1h && candles1h.length >= 5) {
    const ranges = candles1h
      .slice(0, 5)
      .map((c) => parseFloat(c.high) - parseFloat(c.low));
    atrEstimate = (ranges.reduce((a, b) => a + b, 0) / ranges.length).toFixed(
      2,
    );
  }

  const levels = {
    sl_buy: atrEstimate ? (p - parseFloat(atrEstimate) * 1.5).toFixed(2) : null,
    tp1_buy: atrEstimate
      ? (p + parseFloat(atrEstimate) * 2.0).toFixed(2)
      : null,
    tp2_buy: atrEstimate
      ? (p + parseFloat(atrEstimate) * 3.5).toFixed(2)
      : null,
    sl_sell: atrEstimate
      ? (p + parseFloat(atrEstimate) * 1.5).toFixed(2)
      : null,
    tp1_sell: atrEstimate
      ? (p - parseFloat(atrEstimate) * 2.0).toFixed(2)
      : null,
    tp2_sell: atrEstimate
      ? (p - parseFloat(atrEstimate) * 3.5).toFixed(2)
      : null,
  };

  let block = `=== ${instrument} MARKET DATA ===\n`;
  block += `Price: $${price ? parseFloat(price).toLocaleString() : "unavailable"}\n`;
  block += `Session: ${session.name} | ${session.utcStr}\n`;
  block += `High-impact news: ${calendar.hasHighImpact ? "YES — " + calendar.events : "None"}\n\n`;

  block += `--- CONFLUENCE (${confluence.score}/${confluence.total} | ${confluence.direction || "NEUTRAL"}) ---\n`;
  block += confluence.factors.map((f) => `  ${f}`).join("\n") + "\n\n";

  block += `--- INDICATORS ---\n`;
  block += `ATR estimate (avg 5-candle range, 1H): ${atrEstimate || "n/a"}\n`;
  if (atrEstimate) {
    block += `BUY:  SL $${levels.sl_buy} | TP1 $${levels.tp1_buy} | TP2 $${levels.tp2_buy}\n`;
    block += `SELL: SL $${levels.sl_sell} | TP1 $${levels.tp1_sell} | TP2 $${levels.tp2_sell}\n`;
  }
  block += `RSI 4H: ${rsi4h || "n/a"}\n`;
  block += `RSI 1H: ${rsi1h || "n/a"}\n`;
  block += `RSI 30M: ${rsi30m || "n/a"}\n`;
  block += `MA20 1H: ${ma20_1h ? "$" + ma20_1h : "n/a"}\n`;
  block += `MA50 1H: ${ma50_1h ? "$" + ma50_1h : "n/a"}\n\n`;

  block += `--- 1H CANDLES (O/H/L/C) ---\n`;
  if (candles1h) {
    candles1h.forEach((c) => {
      block += `  ${c.time}: ${c.open}/${c.high}/${c.low}/${c.close}\n`;
    });
  } else {
    block += `  Unavailable\n`;
  }

  block += `\n--- 30M CANDLES (O/H/L/C) ---\n`;
  if (candles30m) {
    candles30m.forEach((c) => {
      block += `  ${c.time}: ${c.open}/${c.high}/${c.low}/${c.close}\n`;
    });
  } else {
    block += `  Unavailable\n`;
  }

  block += `\n`;
  if (fearGreed)
    block += `--- SENTIMENT ---\nFear & Greed: ${fearGreed.value}/100 — ${fearGreed.label}\n\n`;
  block += `--- NEWS ---\n${news || "No news — analysis based on price action only."}\n`;

  return { block, price, session, calendar, confluence, atrEstimate, levels };
}

// ─── System Prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a professional proprietary trader analyzing short-term setups for a $20 account.

PHILOSOPHY:
- Price action and structure first. Indicators confirm, they do not lead.
- No news is fine — candlestick patterns and S/R levels are sufficient.
- Confluence of 4+ factors required. Below that, NO TRADE.
- Every level must come from the candle data provided. Never guess.
- Protecting the $20 account is the absolute priority.

ACCOUNT RULES:
- Risk: 1% = $0.20 max | Lot: 0.01 only | Min R/R: 1:2
- SL: use ATR estimate provided, or nearest swing high/low from candles
- Timeframe hierarchy: 4H trend, 1H confirmation, 30M entry

PRICE ACTION TECHNIQUES:
- Support and resistance from swing highs/lows in the candle data
- Candlestick patterns: engulfing, pin bar, inside bar, doji, hammer, shooting star
- Break and retest of key levels
- Higher highs/lower lows trend structure
- Price rejection at MA levels
- RSI divergence across timeframes

OUTPUT FORMAT — no markdown, no asterisks, no HTML tags, plain text only:

INSTRUMENT: [XAUUSD or BTCUSD]
SIGNAL: [BUY / SELL / NO TRADE]
TIMEFRAME: [30M / 1H]
CONFLUENCE: [X/5]

ENTRY: [exact price]
STOP LOSS: [price] - [reason from candle data]
TAKE PROFIT 1: [price] - [R/R ratio]
TAKE PROFIT 2: [price] - [R/R ratio]
LOT SIZE: 0.01 - $0.20 risk on $20 account

4H STRUCTURE: [bullish/bearish/ranging + brief reason]
1H STRUCTURE: [bullish/bearish/ranging + brief reason]
30M STRUCTURE: [bullish/bearish/ranging + brief reason]
PATTERN: [pattern name and candle, or none]
RSI NOTE: [key observation across timeframes]
KEY S/R: [exact levels from candle highs/lows]

CONFIDENCE: [Low / Medium / High]
SETUP QUALITY: [A / B / C]
REASONING: [3 sentences - precise, technical, no vague language]

If NO TRADE: state exactly what confluence is missing and what price level to watch for entry.`;

// ─── Claude API ───────────────────────────────────────────────────────────────
async function callClaude(userMessage, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: "claude-sonnet-4-6",
          max_tokens: 1200,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        },
        {
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          timeout: 60000,
        },
      );
      return res.data.content[0].text;
    } catch (err) {
      // Log the full error response so we can see exactly what's wrong
      if (err.response?.data) {
        console.log(`Claude error detail:`, JSON.stringify(err.response.data));
      }
      console.log(`Claude attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) await delay(3000);
      else throw err;
    }
  }
}

// ─── Broadcast ────────────────────────────────────────────────────────────────
async function broadcast(text) {
  if (!ALERT_CHAT_IDS.length) {
    console.log("No chat IDs set.");
    return;
  }
  for (const chatId of ALERT_CHAT_IDS) {
    try {
      await bot.sendMessage(chatId.trim(), text);
    } catch (err) {
      console.error(`Broadcast failed (${chatId}):`, err.message);
    }
  }
}

// ─── Run Analysis ─────────────────────────────────────────────────────────────
async function runAnalysis(chatId, instrument, forceRefresh = false) {
  if (!botActive) {
    bot.sendMessage(chatId, "Bot is stopped. Send /start to reactivate.");
    return;
  }
  if (isBotPaused()) {
    bot.sendMessage(
      chatId,
      "Bot paused — 3 losses hit. Resumes in 24 hours. Use /journal to review.",
    );
    return;
  }

  let msgId = null;
  try {
    const sentMsg = await bot.sendMessage(
      chatId,
      `Analyzing ${instrument}...\nFetching data — 8 API calls with 1s delay each.\nEstimated time: 20-25 seconds.\nCredits remaining: ${creditsRemaining()}`,
    );
    msgId = sentMsg.message_id;

    const data = await buildDataBlock(instrument, forceRefresh);
    const analysis = await callClaude(
      data.block + `\nProvide full trade analysis for $20 account trader.`,
    );

    const header =
      `${instrument} - ANALYSIS\n` +
      `Session: ${data.session.name} | ${data.session.utcStr}\n` +
      `Confluence: ${data.confluence.score}/${data.confluence.total} | Bias: ${data.confluence.direction || "Neutral"}\n` +
      (data.calendar.hasHighImpact
        ? `NEWS RISK: High-impact event active\n`
        : "") +
      `Credits used today: ${loadCredits().used}/${DAILY_CREDIT_LIMIT}\n\n`;

    try {
      await bot.deleteMessage(chatId, msgId);
    } catch {}
    await bot.sendMessage(chatId, header + analysis);

    logSignal({
      instrument,
      signal: data.confluence.direction || "ANALYZED",
      quality: data.confluence.score >= 4 ? "B" : "C",
      confidence:
        data.confluence.score >= 5
          ? "High"
          : data.confluence.score >= 4
            ? "Medium"
            : "Low",
      session: data.session.name,
      source: "manual",
    });
  } catch (err) {
    console.error("runAnalysis error:", err.message);
    try {
      if (msgId)
        await bot.editMessageText(`Error: ${err.message.slice(0, 100)}`, {
          chat_id: chatId,
          message_id: msgId,
        });
      else await bot.sendMessage(chatId, "Error occurred. Please try again.");
    } catch {
      bot.sendMessage(chatId, "Error occurred. Please try again.");
    }
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  botActive = true;
  bot.sendMessage(
    msg.chat.id,
    `TradingBot Pro - $20 Account\n\n` +
      `Bot is ACTIVE. Ready to analyze.\n\n` +
      `MARKET COMMANDS:\n` +
      `/gold - Analyze XAUUSD\n` +
      `/btc - Analyze BTCUSD\n` +
      `/both - Analyze both markets\n` +
      `/refresh - Force fresh data\n` +
      `/confluence - Live confluence scores\n\n` +
      `INFO COMMANDS:\n` +
      `/session - Current session\n` +
      `/calendar - Economic events\n` +
      `/feargreed - BTC Fear & Greed\n` +
      `/credits - API usage today\n\n` +
      `JOURNAL:\n` +
      `/journal - Trade history\n` +
      `/win [n] - Mark win\n` +
      `/loss [n] - Mark loss\n\n` +
      `BOT CONTROLS:\n` +
      `/stop - Pause bot\n` +
      `/resume - Resume bot\n` +
      `/status - Bot status\n\n` +
      `/risk - Risk rules\n` +
      `/sizing - Position sizing\n` +
      `/ask [question] - Ask anything\n` +
      `/help - This menu`,
  );
});

bot.onText(/\/stop/, (msg) => {
  botActive = false;
  bot.sendMessage(
    msg.chat.id,
    `Bot Paused\n\nAll commands disabled. No API calls.\n\nSend /resume to reactivate.`,
  );
});

bot.onText(/\/resume/, (msg) => {
  botActive = true;
  bot.sendMessage(
    msg.chat.id,
    `Bot Resumed\n\nActive again. Credits remaining: ${creditsRemaining()}\n\nSend /gold or /btc to analyze.`,
  );
});

bot.onText(/\/gold/, (msg) => {
  if (isProcessing(msg.chat.id, "gold")) return;
  runAnalysis(msg.chat.id, "XAUUSD");
});

bot.onText(/\/btc/, (msg) => {
  if (isProcessing(msg.chat.id, "btc")) return;
  runAnalysis(msg.chat.id, "BTCUSD");
});

bot.onText(/\/both/, async (msg) => {
  if (!botActive) {
    bot.sendMessage(msg.chat.id, "Bot is stopped. Send /start to reactivate.");
    return;
  }
  if (isProcessing(msg.chat.id, "both")) return;
  const chatId = msg.chat.id;
  let msgId = null;
  try {
    const sentMsg = await bot.sendMessage(
      chatId,
      "Analyzing both markets...\nEstimated time: 50-60 seconds.",
    );
    msgId = sentMsg.message_id;
    for (const instrument of ["XAUUSD", "BTCUSD"]) {
      const data = await buildDataBlock(instrument);
      const analysis = await callClaude(
        data.block + `\nFull analysis for $20 account trader.`,
      );
      await bot.sendMessage(
        chatId,
        `${instrument}\nConfluence: ${data.confluence.score}/5 | Bias: ${data.confluence.direction || "Neutral"}\n\n${analysis}`,
      );
      await delay(5000); // pause between instruments
    }
    try {
      await bot.deleteMessage(chatId, msgId);
    } catch {}
  } catch (err) {
    console.error("both error:", err.message);
    try {
      if (msgId)
        await bot.editMessageText(`Error: ${err.message.slice(0, 100)}`, {
          chat_id: chatId,
          message_id: msgId,
        });
    } catch {
      bot.sendMessage(chatId, "Error occurred. Please try again.");
    }
  }
});

bot.onText(/\/refresh/, async (msg) => {
  if (!botActive) {
    bot.sendMessage(msg.chat.id, "Bot is stopped. Send /start to reactivate.");
    return;
  }
  if (isProcessing(msg.chat.id, "refresh")) return;
  clearCache("XAUUSD");
  clearCache("BTCUSD");
  await bot.sendMessage(
    msg.chat.id,
    "Cache cleared. Use /gold or /btc to fetch fresh data.",
  );
});

bot.onText(/\/confluence/, async (msg) => {
  if (!botActive) {
    bot.sendMessage(msg.chat.id, "Bot is stopped. Send /start to reactivate.");
    return;
  }
  if (isProcessing(msg.chat.id, "confluence")) return;
  let msgId = null;
  try {
    const sentMsg = await bot.sendMessage(
      msg.chat.id,
      "Calculating confluence scores...",
    );
    msgId = sentMsg.message_id;
    let text = `Confluence Scores\n\n`;
    for (const instrument of ["XAUUSD", "BTCUSD"]) {
      const data = await buildDataBlock(instrument);
      const c = data.confluence;
      text += `${instrument} - ${c.score}/${c.total} | ${c.direction || "NEUTRAL"}\n`;
      text += c.factors.map((f) => `  ${f}`).join("\n") + "\n\n";
    }
    text += `Threshold: 4+ factors required to signal`;
    try {
      await bot.deleteMessage(msg.chat.id, msgId);
    } catch {}
    await bot.sendMessage(msg.chat.id, text);
  } catch (err) {
    try {
      if (msgId)
        await bot.editMessageText(`Error: ${err.message.slice(0, 100)}`, {
          chat_id: msg.chat.id,
          message_id: msgId,
        });
    } catch {
      bot.sendMessage(msg.chat.id, "Error occurred.");
    }
  }
});

bot.onText(/\/credits/, (msg) => {
  const used = loadCredits().used;
  const remaining = creditsRemaining();
  const pct = Math.min(100, Math.round((used / DAILY_CREDIT_LIMIT) * 100));
  const bar =
    "#".repeat(Math.floor(pct / 10)) + ".".repeat(10 - Math.floor(pct / 10));
  bot.sendMessage(
    msg.chat.id,
    `API Credits Today\n\n[${bar}] ${pct}%\nUsed: ${used} / ${DAILY_CREDIT_LIMIT}\nRemaining: ${remaining}\n\nEach analysis uses 8 credits.\nCache reuses data for 25 mins.\nResets: midnight UTC`,
  );
});

bot.onText(/\/session/, (msg) => {
  const s = getSession();
  bot.sendMessage(
    msg.chat.id,
    `Trading Session\n\n${s.utcStr}\n${s.name}\nOptimal: ${s.isOptimal ? "YES" : "NO"}\n\nLondon: 08:00-17:00 UTC\nNew York: 13:00-22:00 UTC\nBest overlap: 13:00-17:00 UTC`,
  );
});

bot.onText(/\/calendar/, async (msg) => {
  let msgId = null;
  try {
    const sentMsg = await bot.sendMessage(msg.chat.id, "Checking calendar...");
    msgId = sentMsg.message_id;
    const cal = await fetchEconomicEvents();
    try {
      await bot.deleteMessage(msg.chat.id, msgId);
    } catch {}
    await bot.sendMessage(
      msg.chat.id,
      `Economic Calendar\n\nHigh-impact: ${cal.hasHighImpact ? "YES - avoid trading" : "None"}\n${cal.events}`,
    );
  } catch {
    try {
      if (msgId)
        await bot.editMessageText("Error fetching calendar.", {
          chat_id: msg.chat.id,
          message_id: msgId,
        });
    } catch {}
  }
});

bot.onText(/\/feargreed/, async (msg) => {
  let msgId = null;
  try {
    const sentMsg = await bot.sendMessage(msg.chat.id, "Fetching index...");
    msgId = sentMsg.message_id;
    const fg = await fetchFearGreed();
    const bar =
      fg?.value != null
        ? "#".repeat(Math.floor(fg.value / 10)) +
          ".".repeat(10 - Math.floor(fg.value / 10))
        : "unavailable";
    try {
      await bot.deleteMessage(msg.chat.id, msgId);
    } catch {}
    await bot.sendMessage(
      msg.chat.id,
      `Fear & Greed Index\n\n[${bar}]\n${fg?.value ?? "n/a"}/100 - ${fg?.label ?? "n/a"}\n\n0-24: Extreme Fear\n25-49: Fear\n50-74: Greed\n75-100: Extreme Greed`,
    );
  } catch {
    try {
      if (msgId)
        await bot.editMessageText("Error.", {
          chat_id: msg.chat.id,
          message_id: msgId,
        });
    } catch {}
  }
});

bot.onText(/\/journal/, (msg) => {
  const journal = loadJournal();
  if (!journal.length) {
    bot.sendMessage(msg.chat.id, "No trades logged yet.");
    return;
  }
  const wins = journal.filter((t) => t.outcome === "win").length;
  const losses = journal.filter((t) => t.outcome === "loss").length;
  const pending = journal.filter((t) => t.outcome === "pending").length;
  const wr =
    wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(0) : "n/a";
  const recent = journal.slice(-10).reverse();
  let text = `Trade Journal\n\nTotal: ${journal.length} | W: ${wins} | L: ${losses} | Pending: ${pending}\nWin rate: ${wr}%\n\nLast 10:\n`;
  recent.forEach((t) => {
    const icon = t.outcome === "win" ? "W" : t.outcome === "loss" ? "L" : "?";
    text += `[${icon}] #${t.id} ${t.instrument} ${t.signal} ${t.quality || ""} - ${new Date(t.timestamp).toLocaleDateString()}\n`;
  });
  text += `\n/win [id] or /loss [id] to update`;
  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/win (.+)/, (msg, match) => {
  if (updateOutcome(match[1], "win")) {
    recordWin();
    bot.sendMessage(msg.chat.id, `#${match[1]} marked WIN. Loss streak reset.`);
  } else bot.sendMessage(msg.chat.id, "ID not found. Check /journal.");
});

bot.onText(/\/loss (.+)/, (msg, match) => {
  if (updateOutcome(match[1], "loss")) {
    const paused = recordLoss();
    if (!paused)
      bot.sendMessage(
        msg.chat.id,
        `#${match[1]} marked LOSS. Streak: ${consecutiveLosses}/3.${consecutiveLosses === 2 ? " One more = 24H pause." : ""}`,
      );
  } else bot.sendMessage(msg.chat.id, "ID not found. Check /journal.");
});

bot.onText(/\/status/, (msg) => {
  const s = getSession();
  bot.sendMessage(
    msg.chat.id,
    `Bot Status\n\n` +
      `Bot: ${botActive ? "ACTIVE" : "STOPPED - send /start"}\n` +
      `Session: ${s.name} | ${s.utcStr}\n` +
      `Drawdown lock: ${isBotPaused() ? "YES - 24H pause active" : `No (${consecutiveLosses}/3 losses)`}\n` +
      `Credits: ${creditsRemaining()} remaining today\n` +
      `Cache entries: ${Object.keys(dataCache).length} active\n` +
      `Calls per analysis: 8 (rate limit safe)`,
  );
});

bot.onText(/\/risk/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Risk Rules - $20 Account\n\n` +
      `1. Max risk $0.20 (1%) per trade\n` +
      `2. Min R/R 1:2 always\n` +
      `3. One trade at a time\n` +
      `4. No trading during high-impact news\n` +
      `5. SL = ATR estimate or nearest swing\n` +
      `6. Move SL to entry after TP1\n` +
      `7. 3 losses = 24H auto-pause\n` +
      `8. 0.01 lots until account reaches $100`,
  );
});

bot.onText(/\/sizing/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Position Sizing - $20 Account\n\n` +
      `Lot size: 0.01 always\n` +
      `XAUUSD: approx $0.10 per pip\n` +
      `2 pip SL = $0.20 risk (1%)\n\n` +
      `SL = 1.5x ATR estimate\n` +
      `TP1 = 2x ATR | TP2 = 3.5x ATR\n\n` +
      `$20 to $100: 0.01 lots only\n` +
      `$100+: reassess sizing`,
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Commands\n\n` +
      `/gold - XAUUSD analysis\n` +
      `/btc - BTCUSD analysis\n` +
      `/both - Both markets\n` +
      `/refresh - Clear cache\n` +
      `/confluence - Scores\n` +
      `/session - Session info\n` +
      `/calendar - Economic events\n` +
      `/feargreed - BTC sentiment\n` +
      `/credits - API usage\n` +
      `/journal - Trade log\n` +
      `/win [n] | /loss [n] - Log outcome\n` +
      `/status - Bot status\n` +
      `/stop - Pause bot\n` +
      `/resume - Resume bot\n` +
      `/risk - Risk rules\n` +
      `/sizing - Position sizing\n` +
      `/ask [question] - Ask anything\n` +
      `/help - This menu`,
  );
});

bot.onText(/\/ask (.+)/, async (msg, match) => {
  if (!botActive) {
    bot.sendMessage(msg.chat.id, "Bot is stopped. Send /start to reactivate.");
    return;
  }
  if (isProcessing(msg.chat.id, "ask")) return;
  const chatId = msg.chat.id;
  let msgId = null;
  try {
    const sentMsg = await bot.sendMessage(chatId, "Analyzing...");
    msgId = sentMsg.message_id;
    const answer = await callClaude(
      `$20 account, 30M/1H trader. Question: ${match[1]}`,
    );
    try {
      await bot.deleteMessage(chatId, msgId);
    } catch {}
    await bot.sendMessage(chatId, `Answer\n\n${answer}`);
  } catch (err) {
    try {
      if (msgId)
        await bot.editMessageText(`Error: ${err.message.slice(0, 100)}`, {
          chat_id: chatId,
          message_id: msgId,
        });
    } catch {
      bot.sendMessage(chatId, "Error occurred. Please try again.");
    }
  }
});

bot.on("message", (msg) => {
  if (msg.text && !msg.text.startsWith("/"))
    bot.sendMessage(msg.chat.id, "Type /help for all commands.");
});

console.log(`\nTradingBot Pro - ${new Date().toISOString()}`);
console.log(`Chat IDs: ${ALERT_CHAT_IDS.join(", ") || "NONE SET"}`);
console.log(
  `Credits today: ${loadCredits().used} used / ${DAILY_CREDIT_LIMIT} limit`,
);
console.log(`Mode: Manual only - no automatic scanning`);
console.log(`Cache TTL: 25 minutes`);
console.log(`API calls per analysis: 8 (within free tier rate limit)\n`);
