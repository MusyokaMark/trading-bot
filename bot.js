require("dotenv").config({ path: ".env" });
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PRICE_API_KEY = process.env.TWELVE_DATA_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const ALERT_CHAT_IDS = (process.env.ALERT_CHAT_IDS || "")
  .split(",")
  .filter(Boolean);
const DAILY_LIMIT = 750;
const CACHE_TTL = 25 * 60 * 1000; // 25 minutes
const COOLDOWN_MS = 90 * 60 * 1000; // 90 minutes between auto alerts per instrument

// ─────────────────────────────────────────────────────────────────────────────
// BOT SETUP
// ─────────────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10, allowed_updates: ["message"] },
  },
});

// Add a simple HTTP server so Render stays happy
const http = require("http");
http
  .createServer((req, res) => {
    res.writeHead(200);
    res.end("TradingBot is running");
  })
  .listen(process.env.PORT || 3000);

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────

let botActive = true;
let autoAlertsEnabled = true;
let consecutiveLosses = 0;
let botPausedUntil = null;

const processingCommands = new Set();
const dataCache = {};
const lastAutoAlert = { XAUUSD: null, BTCUSD: null };

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Prevent the same command running twice at once
function isProcessing(chatId, command) {
  const key = `${chatId}-${command}`;
  if (processingCommands.has(key)) return true;
  processingCommands.add(key);
  setTimeout(() => processingCommands.delete(key), 90000);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// POLLING ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

bot.on("polling_error", (err) => {
  console.log("Polling error:", err.code, err.message);
});

// ─────────────────────────────────────────────────────────────────────────────
// CREDIT TRACKER
// Twelve Data free tier gives 800 credits/day. We stop at 750 to be safe.
// ─────────────────────────────────────────────────────────────────────────────

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

function addCredit(n = 1) {
  const data = loadCredits();
  data.used += n;
  try {
    fs.writeFileSync(CREDIT_FILE, JSON.stringify(data));
  } catch {}
  return data.used;
}

function creditsLeft() {
  return Math.max(0, DAILY_LIMIT - loadCredits().used);
}
function hasCredits(n = 1) {
  return creditsLeft() >= n;
}

// Reset credits on startup if it's a new day
(function resetIfNewDay() {
  const today = new Date().toISOString().split("T")[0];
  try {
    let used = 0;
    if (fs.existsSync(CREDIT_FILE)) {
      const existing = JSON.parse(fs.readFileSync(CREDIT_FILE, "utf8"));
      if (existing.date === today) used = existing.used || 0;
    }
    fs.writeFileSync(CREDIT_FILE, JSON.stringify({ date: today, used }));
  } catch {}
})();

// ─────────────────────────────────────────────────────────────────────────────
// CACHE
// We cache API responses for 25 minutes so we don't burn credits on repeat calls
// ─────────────────────────────────────────────────────────────────────────────

function getCached(key) {
  const entry = dataCache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    delete dataCache[key];
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  dataCache[key] = { data, ts: Date.now() };
}

function clearCache(instrument) {
  Object.keys(dataCache)
    .filter((k) => k.includes(instrument))
    .forEach((k) => delete dataCache[k]);
}

// ─────────────────────────────────────────────────────────────────────────────
// TRADE JOURNAL
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// DRAWDOWN PROTECTION
// 3 losses in a row = bot pauses for 24 hours automatically
// ─────────────────────────────────────────────────────────────────────────────

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
      "DRAWDOWN PROTECTION ACTIVATED\n\n" +
        "3 consecutive losses detected.\n" +
        "Bot paused for 24 hours to protect your account.\n\n" +
        "Use /journal to review your trades.\n" +
        "Bot will resume automatically tomorrow.",
    );
    return true;
  }
  return false;
}

function recordWin() {
  consecutiveLosses = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION CHECKER
// We only scan during London and New York sessions for best signal quality
// ─────────────────────────────────────────────────────────────────────────────

function getSession() {
  const now = new Date();
  const utc = now.getUTCHours() + now.getUTCMinutes() / 60;
  const utcStr = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")} UTC`;

  const inLondon = utc >= 8 && utc < 17;
  const inNY = utc >= 13 && utc < 22;
  const inOverlap = utc >= 13 && utc < 17;

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

// ─────────────────────────────────────────────────────────────────────────────
// ECONOMIC CALENDAR
// Checks for high-impact news events in the next 2 hours.
// If found, we skip trading to protect the account from news spikes.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCalendar() {
  try {
    const cached = getCached("calendar");
    if (cached) return cached;

    if (!PRICE_API_KEY || !hasCredits(1))
      return {
        hasHighImpact: false,
        events: "Calendar unavailable",
        nextEvent: null,
      };

    const today = new Date().toISOString().split("T")[0];
    const res = await axios.get(
      `https://api.twelvedata.com/economic_calendar?start_date=${today}&end_date=${today}&importance=high&apikey=${PRICE_API_KEY}`,
      { timeout: 8000 },
    );

    addCredit(1);

    if (!res.data.result?.length)
      return {
        hasHighImpact: false,
        events: "No high-impact events today",
        nextEvent: null,
      };

    const now = Date.now();

    // Find events within the next 2 hours or last 30 minutes
    const upcoming = res.data.result.filter((e) => {
      const mins = (new Date(e.date).getTime() - now) / 60000;
      return mins > -30 && mins < 120;
    });

    // Find the next upcoming event for warning
    const next = res.data.result
      .filter((e) => new Date(e.date).getTime() > now)
      .sort((a, b) => new Date(a.date) - new Date(b.date))[0];

    const result = {
      hasHighImpact: upcoming.length > 0,
      events:
        upcoming.length > 0
          ? upcoming
              .map(
                (e) =>
                  `${e.event} (${e.currency}) at ${e.date.slice(11, 16)} UTC`,
              )
              .join(", ")
          : "None in next 2 hours",
      nextEvent: next
        ? `${next.event} (${next.currency}) at ${next.date.slice(11, 16)} UTC`
        : null,
    };

    setCache("calendar", result);
    return result;
  } catch {
    return {
      hasHighImpact: false,
      events: "Calendar unavailable",
      nextEvent: null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TWELVE DATA FETCHER
// All indicator calls go through here. Checks cache first to save credits.
// ─────────────────────────────────────────────────────────────────────────────

async function tdFetch(endpoint, params, cacheKey) {
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`Cache hit: ${cacheKey}`);
    return cached;
  }
  if (!hasCredits(1)) {
    console.log(`No credits — skipping ${cacheKey}`);
    return null;
  }

  try {
    const url = `https://api.twelvedata.com/${endpoint}?${params}&apikey=${PRICE_API_KEY}`;
    const res = await axios.get(url, { timeout: 20000 });

    if (res.data.code === 429) {
      console.log("Rate limit hit");
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
    console.log(`TD fetch failed (${endpoint}): ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA FETCHERS
// Each function fetches one piece of market data.
// We limit to 8 Twelve Data calls per analysis to stay within free tier limits.
// ─────────────────────────────────────────────────────────────────────────────

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
  if (!data?.values?.length) return null;
  return data.values.map((c) => ({
    time: c.datetime,
    open: parseFloat(c.open).toFixed(2),
    high: parseFloat(c.high).toFixed(2),
    low: parseFloat(c.low).toFixed(2),
    close: parseFloat(c.close).toFixed(2),
  }));
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
      if (res.data.articles?.length) {
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

// ─────────────────────────────────────────────────────────────────────────────
// SMC ANALYSIS
// Smart Money Concepts — detects institutional footprints in price action.
// This is what separates professional trading from retail indicator chasing.
// ─────────────────────────────────────────────────────────────────────────────

function detectSwings(candles) {
  // A swing high is a candle with a higher high than the 2 candles on each side
  // A swing low is the opposite
  const swingHighs = [];
  const swingLows = [];

  for (let i = 2; i < candles.length - 2; i++) {
    const curr = candles[i];
    const prev1 = candles[i - 1],
      prev2 = candles[i - 2];
    const next1 = candles[i + 1],
      next2 = candles[i + 2];

    const high = parseFloat(curr.high);
    const low = parseFloat(curr.low);

    // Swing high: higher than 2 candles before and after
    if (
      high > parseFloat(prev1.high) &&
      high > parseFloat(prev2.high) &&
      high > parseFloat(next1.high) &&
      high > parseFloat(next2.high)
    ) {
      swingHighs.push({ price: high, time: curr.time, index: i });
    }

    // Swing low: lower than 2 candles before and after
    if (
      low < parseFloat(prev1.low) &&
      low < parseFloat(prev2.low) &&
      low < parseFloat(next1.low) &&
      low < parseFloat(next2.low)
    ) {
      swingLows.push({ price: low, time: curr.time, index: i });
    }
  }

  return { swingHighs, swingLows };
}

function detectBOS(candles, swingHighs, swingLows) {
  // Break of Structure: price closes above a recent swing high (bullish BOS)
  // or closes below a recent swing low (bearish BOS)
  if (!candles.length || !swingHighs.length || !swingLows.length)
    return { hasBOS: false, type: null, level: null };

  const latest = candles[candles.length - 1];
  const latestClose = parseFloat(latest.close);

  // Get the most recent swing high and low
  const recentHigh = swingHighs[swingHighs.length - 1];
  const recentLow = swingLows[swingLows.length - 1];

  if (latestClose > recentHigh.price)
    return {
      hasBOS: true,
      type: "BULLISH",
      level: recentHigh.price,
      time: latest.time,
    };

  if (latestClose < recentLow.price)
    return {
      hasBOS: true,
      type: "BEARISH",
      level: recentLow.price,
      time: latest.time,
    };

  return { hasBOS: false, type: null, level: null };
}

function detectCHOCH(candles, swingHighs, swingLows) {
  // Change of Character: in a downtrend, price breaks above a swing high (bullish CHoCH)
  // In an uptrend, price breaks below a swing low (bearish CHoCH)
  // This is the FIRST sign of a trend reversal
  if (candles.length < 6) return { hasCHOCH: false, type: null };

  const closes = candles.map((c) => parseFloat(c.close));

  // Simple trend detection: compare first half vs second half closes
  const firstHalf = closes.slice(0, Math.floor(closes.length / 2));
  const secondHalf = closes.slice(Math.floor(closes.length / 2));
  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  const inDowntrend = firstAvg > secondAvg;
  const inUptrend = firstAvg < secondAvg;

  const latest = parseFloat(closes[closes.length - 1]);

  if (inDowntrend && swingHighs.length) {
    const lastHigh = swingHighs[swingHighs.length - 1].price;
    if (latest > lastHigh)
      return { hasCHOCH: true, type: "BULLISH", level: lastHigh };
  }

  if (inUptrend && swingLows.length) {
    const lastLow = swingLows[swingLows.length - 1].price;
    if (latest < lastLow)
      return { hasCHOCH: true, type: "BEARISH", level: lastLow };
  }

  return { hasCHOCH: false, type: null };
}

function detectOrderBlocks(candles, direction) {
  // An order block is the last bearish candle before a bullish move (bullish OB)
  // or the last bullish candle before a bearish move (bearish OB)
  // These are zones where institutions placed large orders
  if (candles.length < 5) return null;

  for (let i = candles.length - 3; i >= 1; i--) {
    const curr = candles[i];
    const next = candles[i + 1];

    const currOpen = parseFloat(curr.open);
    const currClose = parseFloat(curr.close);
    const nextOpen = parseFloat(next.open);
    const nextClose = parseFloat(next.close);

    const currBearish = currClose < currOpen;
    const currBullish = currClose > currOpen;
    const nextBullish = nextClose > nextOpen;
    const nextBearish = nextClose < nextOpen;

    // Bullish OB: bearish candle followed by strong bullish move
    if (direction === "BUY" && currBearish && nextBullish) {
      return {
        type: "BULLISH",
        high: parseFloat(curr.high).toFixed(2),
        low: parseFloat(curr.low).toFixed(2),
        time: curr.time,
        midpoint: ((parseFloat(curr.high) + parseFloat(curr.low)) / 2).toFixed(
          2,
        ),
      };
    }

    // Bearish OB: bullish candle followed by strong bearish move
    if (direction === "SELL" && currBullish && nextBearish) {
      return {
        type: "BEARISH",
        high: parseFloat(curr.high).toFixed(2),
        low: parseFloat(curr.low).toFixed(2),
        time: curr.time,
        midpoint: ((parseFloat(curr.high) + parseFloat(curr.low)) / 2).toFixed(
          2,
        ),
      };
    }
  }

  return null;
}

function detectFVG(candles) {
  // Fair Value Gap: a 3-candle pattern where candle 1 high and candle 3 low
  // don't overlap, leaving a price gap (imbalance) that often gets filled
  const fvgs = [];

  for (let i = 0; i < candles.length - 2; i++) {
    const c1 = candles[i];
    const c3 = candles[i + 2];

    const c1High = parseFloat(c1.high);
    const c3Low = parseFloat(c3.low);
    const c1Low = parseFloat(c1.low);
    const c3High = parseFloat(c3.high);

    // Bullish FVG: gap between c1 high and c3 low (price moved up fast)
    if (c3Low > c1High) {
      fvgs.push({
        type: "BULLISH",
        top: c3Low.toFixed(2),
        bottom: c1High.toFixed(2),
        midpoint: ((c3Low + c1High) / 2).toFixed(2),
        time: c3.time,
      });
    }

    // Bearish FVG: gap between c1 low and c3 high (price moved down fast)
    if (c3High < c1Low) {
      fvgs.push({
        type: "BEARISH",
        top: c1Low.toFixed(2),
        bottom: c3High.toFixed(2),
        midpoint: ((c1Low + c3High) / 2).toFixed(2),
        time: c3.time,
      });
    }
  }

  // Return the most recent FVG
  return fvgs.length ? fvgs[fvgs.length - 1] : null;
}

function runSMCAnalysis(candles1h, candles30m, price) {
  if (!candles1h || !candles30m || !price) return null;

  const swings1h = detectSwings(candles1h);
  const bos1h = detectBOS(candles1h, swings1h.swingHighs, swings1h.swingLows);
  const choch1h = detectCHOCH(
    candles1h,
    swings1h.swingHighs,
    swings1h.swingLows,
  );
  const fvg1h = detectFVG(candles1h);
  const fvg30m = detectFVG(candles30m);

  // Determine bias from BOS and CHoCH
  let smcBias = "NEUTRAL";
  if (bos1h.hasBOS) smcBias = bos1h.type === "BULLISH" ? "BULLISH" : "BEARISH";
  if (choch1h.hasCHOCH)
    smcBias = choch1h.type === "BULLISH" ? "BULLISH" : "BEARISH";

  const direction =
    smcBias === "BULLISH" ? "BUY" : smcBias === "BEARISH" ? "SELL" : null;

  const ob1h = detectOrderBlocks(candles1h, direction || "BUY");
  const ob30m = detectOrderBlocks(candles30m, direction || "BUY");

  // Nearest swing levels for S/R
  const recentSwingHigh = swings1h.swingHighs.slice(-1)[0];
  const recentSwingLow = swings1h.swingLows.slice(-1)[0];

  return {
    bias: smcBias,
    direction,
    bos: bos1h,
    choch: choch1h,
    orderBlock1h: ob1h,
    orderBlock30m: ob30m,
    fvg1h,
    fvg30m,
    swingHigh: recentSwingHigh?.price?.toFixed(2) || null,
    swingLow: recentSwingLow?.price?.toFixed(2) || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFLUENCE SCORER
// Scores how many factors agree on a direction. We need 4+ to signal a trade.
// Now includes SMC factors for much higher accuracy.
// ─────────────────────────────────────────────────────────────────────────────

function scoreConfluence(data) {
  const { price, rsi1h, rsi4h, ma20_1h, ma50_1h, smc } = data;

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

  // Factor 1: Price vs MA20
  if (ma20_1h) {
    if (p > parseFloat(ma20_1h)) {
      bullish++;
      factors.push(`Price above MA20 ($${ma20_1h})`);
    } else {
      bearish++;
      factors.push(`Price below MA20 ($${ma20_1h})`);
    }
  }

  // Factor 2: Price vs MA50
  if (ma50_1h) {
    if (p > parseFloat(ma50_1h)) {
      bullish++;
      factors.push(`Price above MA50 ($${ma50_1h})`);
    } else {
      bearish++;
      factors.push(`Price below MA50 ($${ma50_1h})`);
    }
  }

  // Factor 3: RSI 1H momentum
  if (rsi1h) {
    const r = parseFloat(rsi1h);
    if (r > 52 && r < 70) {
      bullish++;
      factors.push(`RSI 1H bullish momentum (${r})`);
    } else if (r < 48 && r > 30) {
      bearish++;
      factors.push(`RSI 1H bearish momentum (${r})`);
    } else {
      factors.push(`RSI 1H neutral (${r})`);
    }
  }

  // Factor 4: RSI 4H trend
  if (rsi4h) {
    const r = parseFloat(rsi4h);
    if (r > 50) {
      bullish++;
      factors.push(`RSI 4H bullish trend (${r})`);
    } else {
      bearish++;
      factors.push(`RSI 4H bearish trend (${r})`);
    }
  }

  // Factor 5: MA crossover
  if (ma20_1h && ma50_1h) {
    if (parseFloat(ma20_1h) > parseFloat(ma50_1h)) {
      bullish++;
      factors.push("MA20 above MA50 — uptrend confirmed");
    } else {
      bearish++;
      factors.push("MA20 below MA50 — downtrend confirmed");
    }
  }

  // Factor 6: SMC Break of Structure
  if (smc?.bos?.hasBOS) {
    if (smc.bos.type === "BULLISH") {
      bullish++;
      factors.push(`Bullish BOS at $${smc.bos.level?.toFixed(2)}`);
    } else {
      bearish++;
      factors.push(`Bearish BOS at $${smc.bos.level?.toFixed(2)}`);
    }
  }

  // Factor 7: SMC Change of Character
  if (smc?.choch?.hasCHOCH) {
    if (smc.choch.type === "BULLISH") {
      bullish++;
      factors.push(`Bullish CHoCH — trend reversing up`);
    } else {
      bearish++;
      factors.push(`Bearish CHoCH — trend reversing down`);
    }
  }

  // Factor 8: SMC Fair Value Gap
  if (smc?.fvg1h) {
    if (smc.fvg1h.type === "BULLISH") {
      bullish++;
      factors.push(`Bullish FVG at $${smc.fvg1h.bottom}–$${smc.fvg1h.top}`);
    } else {
      bearish++;
      factors.push(`Bearish FVG at $${smc.fvg1h.bottom}–$${smc.fvg1h.top}`);
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

// ─────────────────────────────────────────────────────────────────────────────
// BUILD DATA BLOCK
// Fetches all market data and packages it into a block for Claude to analyze.
// Max 8 Twelve Data calls to stay within free tier rate limits.
// ─────────────────────────────────────────────────────────────────────────────

async function buildDataBlock(instrument, forceRefresh = false) {
  if (forceRefresh) clearCache(instrument);

  console.log(
    `Fetching data for ${instrument} (${creditsLeft()} credits left)...`,
  );

  // Fetch sequentially with 1s delay to avoid rate limits (8 calls/minute free tier)
  const price = await fetchPrice(instrument);
  await delay(1000);
  const rsi4h = await fetchRSI(instrument, "4h");
  await delay(1000);
  const rsi1h = await fetchRSI(instrument, "1h");
  await delay(1000);
  const rsi30m = await fetchRSI(instrument, "30min");
  await delay(1000);
  const ma20_1h = await fetchMA(instrument, 20, "1h");
  await delay(1000);
  const ma50_1h = await fetchMA(instrument, 50, "1h");
  await delay(1000);
  const candles1h = await fetchCandles(instrument, "1h", 12);
  await delay(1000);
  const candles30m = await fetchCandles(instrument, "30min", 12);

  // Free calls — no TD credits needed
  const news = await fetchNews(instrument);
  const fearGreed = instrument === "BTCUSD" ? await fetchFearGreed() : null;
  const calendar = await fetchCalendar();
  const session = getSession();

  // Run SMC analysis on the candle data
  const smc = runSMCAnalysis(candles1h, candles30m, price);

  // Score confluence including SMC factors
  const confluence = scoreConfluence({
    price,
    rsi1h,
    rsi4h,
    ma20_1h,
    ma50_1h,
    smc,
  });

  // Estimate ATR from average candle range (saves one API call)
  const p = price ? parseFloat(price) : 0;
  let atr = null;
  if (candles1h?.length >= 5) {
    const ranges = candles1h
      .slice(0, 5)
      .map((c) => parseFloat(c.high) - parseFloat(c.low));
    atr = (ranges.reduce((a, b) => a + b, 0) / ranges.length).toFixed(2);
  }

  const levels = {
    sl_buy: atr ? (p - parseFloat(atr) * 1.5).toFixed(2) : null,
    tp1_buy: atr ? (p + parseFloat(atr) * 2.0).toFixed(2) : null,
    tp2_buy: atr ? (p + parseFloat(atr) * 3.5).toFixed(2) : null,
    sl_sell: atr ? (p + parseFloat(atr) * 1.5).toFixed(2) : null,
    tp1_sell: atr ? (p - parseFloat(atr) * 2.0).toFixed(2) : null,
    tp2_sell: atr ? (p - parseFloat(atr) * 3.5).toFixed(2) : null,
  };

  // Build the data block string for Claude
  let block = `=== ${instrument} MARKET DATA ===\n`;
  block += `Price: $${price ? parseFloat(price).toLocaleString() : "unavailable"}\n`;
  block += `Session: ${session.name} | ${session.utcStr}\n`;
  block += `News risk: ${calendar.hasHighImpact ? "HIGH — " + calendar.events : "None"}\n`;
  if (calendar.nextEvent) block += `Next event: ${calendar.nextEvent}\n`;
  block += `\n`;

  block += `--- CONFLUENCE (${confluence.score}/${confluence.total} factors | bias: ${confluence.direction || "NEUTRAL"}) ---\n`;
  block += confluence.factors.map((f) => `  ${f}`).join("\n") + "\n\n";

  block += `--- SMC ANALYSIS ---\n`;
  block += `SMC Bias: ${smc?.bias || "NEUTRAL"}\n`;
  block += `Break of Structure: ${smc?.bos?.hasBOS ? smc.bos.type + " BOS at $" + smc.bos.level?.toFixed(2) : "None detected"}\n`;
  block += `Change of Character: ${smc?.choch?.hasCHOCH ? smc.choch.type + " CHoCH" : "None detected"}\n`;
  block += `Order Block (1H): ${smc?.orderBlock1h ? smc.orderBlock1h.type + " OB zone $" + smc.orderBlock1h.low + "-$" + smc.orderBlock1h.high : "None"}\n`;
  block += `Order Block (30M): ${smc?.orderBlock30m ? smc.orderBlock30m.type + " OB zone $" + smc.orderBlock30m.low + "-$" + smc.orderBlock30m.high : "None"}\n`;
  block += `Fair Value Gap (1H): ${smc?.fvg1h ? smc.fvg1h.type + " FVG $" + smc.fvg1h.bottom + "-$" + smc.fvg1h.top : "None"}\n`;
  block += `Fair Value Gap (30M): ${smc?.fvg30m ? smc.fvg30m.type + " FVG $" + smc.fvg30m.bottom + "-$" + smc.fvg30m.top : "None"}\n`;
  block += `Swing High: ${smc?.swingHigh ? "$" + smc.swingHigh : "n/a"}\n`;
  block += `Swing Low: ${smc?.swingLow ? "$" + smc.swingLow : "n/a"}\n\n`;

  block += `--- INDICATORS ---\n`;
  block += `ATR estimate: ${atr || "n/a"}\n`;
  if (atr) {
    block += `BUY levels:  SL $${levels.sl_buy} | TP1 $${levels.tp1_buy} | TP2 $${levels.tp2_buy}\n`;
    block += `SELL levels: SL $${levels.sl_sell} | TP1 $${levels.tp1_sell} | TP2 $${levels.tp2_sell}\n`;
  }
  block += `RSI 4H: ${rsi4h || "n/a"} | RSI 1H: ${rsi1h || "n/a"} | RSI 30M: ${rsi30m || "n/a"}\n`;
  block += `MA20 1H: ${ma20_1h ? "$" + ma20_1h : "n/a"} | MA50 1H: ${ma50_1h ? "$" + ma50_1h : "n/a"}\n\n`;

  block += `--- 1H CANDLES (O/H/L/C) ---\n`;
  if (candles1h)
    candles1h.forEach((c) => {
      block += `  ${c.time}: ${c.open}/${c.high}/${c.low}/${c.close}\n`;
    });
  else block += `  Unavailable\n`;

  block += `\n--- 30M CANDLES (O/H/L/C) ---\n`;
  if (candles30m)
    candles30m.forEach((c) => {
      block += `  ${c.time}: ${c.open}/${c.high}/${c.low}/${c.close}\n`;
    });
  else block += `  Unavailable\n`;

  block += `\n`;
  if (fearGreed)
    block += `--- SENTIMENT ---\nFear & Greed: ${fearGreed.value}/100 — ${fearGreed.label}\n\n`;
  block += `--- NEWS ---\n${news || "No news — using price action only."}\n`;

  return { block, price, session, calendar, confluence, smc, atr, levels };
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// This tells Claude exactly how to think and what to output.
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a professional trader analyzing setups for a $20 account.

RULES:
- Need 4+ confluence factors to signal a trade
- Risk 1% = $0.20 | Lot 0.01 only | Min R/R 1:2
- No trade during high-impact news
- Every level must come from the candle data

OUTPUT FORMAT — keep it short, plain text, no symbols:

INSTRUMENT: [XAUUSD or BTCUSD]
SIGNAL: [BUY / SELL / NO TRADE]
ENTRY: [price]
STOP LOSS: [price]
TAKE PROFIT 1: [price]
TAKE PROFIT 2: [price]
REASON: [one sentence — the main technical reason]

If NO TRADE: one sentence on what to wait for.`;

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE API
// ─────────────────────────────────────────────────────────────────────────────

async function callClaude(message, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: "claude-sonnet-4-6",
          max_tokens: 1200,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: message }],
        },
        {
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
          },
          timeout: 60000,
        },
      );
      return res.data.content[0].text;
    } catch (err) {
      if (err.response?.data)
        console.log("Claude error:", JSON.stringify(err.response.data));
      console.log(`Claude attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) await delay(3000);
      else throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BROADCAST
// Sends a message to all configured chat IDs
// ─────────────────────────────────────────────────────────────────────────────

async function broadcast(text) {
  if (!ALERT_CHAT_IDS.length) {
    console.log("No chat IDs configured.");
    return;
  }
  for (const chatId of ALERT_CHAT_IDS) {
    try {
      await bot.sendMessage(chatId.trim(), text);
    } catch (err) {
      console.error(`Broadcast failed for ${chatId}:`, err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO SCANNER
// Runs every 30 minutes during London and NY sessions.
// Only sends an alert if confluence score is 4+ and setup quality is A or B.
// This means you get notified of good setups without having to ask.
// ─────────────────────────────────────────────────────────────────────────────

async function scanMarket(instrument) {
  if (!botActive || !autoAlertsEnabled) return;
  if (isBotPaused()) return;

  const session = getSession();
  if (!session.isOptimal) {
    console.log(`Scanner: ${instrument} skipped — off-hours (${session.name})`);
    return;
  }

  try {
    console.log(`Scanner: checking ${instrument}...`);

    // Check if we already sent an alert recently for this instrument
    const last = lastAutoAlert[instrument];
    if (last && Date.now() - last < COOLDOWN_MS) {
      const minsLeft = Math.round((COOLDOWN_MS - (Date.now() - last)) / 60000);
      console.log(
        `Scanner: ${instrument} cooldown — ${minsLeft} mins remaining`,
      );
      return;
    }

    const data = await buildDataBlock(instrument);

    // Hard stop: high-impact news in the next 2 hours
    if (data.calendar.hasHighImpact) {
      console.log(
        `Scanner: ${instrument} blocked — high-impact news: ${data.calendar.events}`,
      );
      return;
    }

    // Only alert if confluence is strong enough
    if (!data.confluence.direction || data.confluence.score < 4) {
      console.log(
        `Scanner: ${instrument} — confluence too low (${data.confluence.score}/${data.confluence.total})`,
      );
      return;
    }

    // Get full analysis from Claude
    const analysis = await callClaude(
      data.block +
        `\nThis is an automated scan. Provide full trade analysis for a $20 account trader.`,
    );

    // Log it
    const signalId = logSignal({
      instrument,
      signal: data.confluence.direction,
      quality: data.confluence.score >= 5 ? "A" : "B",
      confidence: data.confluence.score >= 6 ? "High" : "Medium",
      session: session.name,
      source: "auto-scan",
      smc_bias: data.smc?.bias || "n/a",
    });

    lastAutoAlert[instrument] = Date.now();

    await broadcast(
      `SIGNAL — ${instrument} | ${session.name}\n\n` +
        `${analysis}\n\n` +
        `Log: /win ${signalId} or /loss ${signalId}`,
    );

    console.log(`Scanner: alert sent for ${instrument}`);
  } catch (err) {
    console.error(`Scanner error (${instrument}):`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULED JOBS
// ─────────────────────────────────────────────────────────────────────────────

// Scan both markets every 30 minutes
cron.schedule("*/30 * * * *", async () => {
  console.log(`\n[${new Date().toISOString()}] Running scheduled scan...`);
  await scanMarket("XAUUSD");
  await delay(5000); // small gap between the two scans
  await scanMarket("BTCUSD");
});

// Send news warning 30 minutes before high-impact events
cron.schedule("*/15 * * * *", async () => {
  try {
    const cal = await fetchCalendar();
    if (!cal.hasHighImpact) return;

    // Only warn once per event (check if we warned in the last 20 mins)
    const warnKey = `warned_${cal.events}`;
    if (getCached(warnKey)) return;
    setCache(warnKey, true);
    // Cache for 20 minutes so we don't spam
    dataCache[warnKey].ts = Date.now() - (CACHE_TTL - 20 * 60 * 1000);

    await broadcast(
      `NEWS WARNING\n\n` +
        `High-impact event detected:\n${cal.events}\n\n` +
        `Avoid opening new trades.\n` +
        `Close or protect any open positions.\n` +
        `Wait 15-30 minutes after the news before re-entering.`,
    );
  } catch (err) {
    console.error("News warning error:", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────

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
    const sent = await bot.sendMessage(
      chatId,
      `Analyzing ${instrument}...\n` +
        `Fetching price, RSI, MAs, candles and running SMC analysis.\n` +
        `Estimated time: 20-25 seconds.\n` +
        `Credits remaining: ${creditsLeft()}`,
    );
    msgId = sent.message_id;

    const data = await buildDataBlock(instrument, forceRefresh);
    const analysis = await callClaude(
      data.block + `\nProvide full trade analysis for $20 account trader.`,
    );

    const header =
      `${instrument} | ${data.session.name} | ${data.session.utcStr}\n` +
      (data.calendar.hasHighImpact
        ? `NEWS RISK: ${data.calendar.events}\n`
        : "") +
      `\n`;

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
      smc_bias: data.smc?.bias || "n/a",
    });
  } catch (err) {
    console.error("Analysis error:", err.message);
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

// ─────────────────────────────────────────────────────────────────────────────
// COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  botActive = true;
  bot.sendMessage(
    msg.chat.id,
    `TradingBot Pro — $20 Account\n\n` +
      `Bot is ACTIVE.\n\n` +
      `What is new in this version:\n` +
      `- SMC analysis: BOS, CHoCH, Order Blocks, FVG\n` +
      `- Auto-alerts every 30 mins during London/NY\n` +
      `- News warnings before high-impact events\n` +
      `- 8-factor confluence scoring\n\n` +
      `MARKET COMMANDS:\n` +
      `/gold — Analyze XAUUSD\n` +
      `/btc — Analyze BTCUSD\n` +
      `/both — Analyze both\n` +
      `/refresh — Force fresh data\n` +
      `/confluence — Live confluence scores\n\n` +
      `AUTO ALERTS:\n` +
      `/alerts on — Enable auto scanning\n` +
      `/alerts off — Disable auto scanning\n\n` +
      `INFO:\n` +
      `/session — Current session\n` +
      `/calendar — Economic events today\n` +
      `/feargreed — BTC sentiment\n` +
      `/credits — API usage\n\n` +
      `JOURNAL:\n` +
      `/journal — Trade history\n` +
      `/win [n] — Mark win\n` +
      `/loss [n] — Mark loss\n\n` +
      `CONTROLS:\n` +
      `/stop — Pause bot\n` +
      `/resume — Resume bot\n` +
      `/status — Bot status\n\n` +
      `/risk | /sizing | /ask [question] | /help`,
  );
});

bot.onText(/\/stop/, (msg) => {
  botActive = false;
  bot.sendMessage(
    msg.chat.id,
    "Bot paused. No commands or scans will run.\n\nSend /resume to reactivate.",
  );
});

bot.onText(/\/resume/, (msg) => {
  botActive = true;
  bot.sendMessage(
    msg.chat.id,
    `Bot resumed. Credits remaining: ${creditsLeft()}\n\nSend /gold or /btc to analyze.`,
  );
});

bot.onText(/\/alerts (.+)/, (msg, match) => {
  const arg = match[1].toLowerCase().trim();
  if (arg === "on") {
    autoAlertsEnabled = true;
    bot.sendMessage(
      msg.chat.id,
      `Auto-alerts ENABLED\n\n` +
        `Bot will scan XAUUSD and BTCUSD every 30 minutes.\n` +
        `You will be notified when confluence score reaches 4+.\n` +
        `Alerts are blocked during high-impact news events.\n` +
        `90 minute cooldown per instrument to avoid spam.`,
    );
  } else if (arg === "off") {
    autoAlertsEnabled = false;
    bot.sendMessage(
      msg.chat.id,
      "Auto-alerts DISABLED.\n\nBot will only analyze when you ask manually.",
    );
  } else {
    bot.sendMessage(msg.chat.id, "Usage: /alerts on or /alerts off");
  }
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
    const sent = await bot.sendMessage(
      chatId,
      "Analyzing both markets...\nEstimated time: 50-60 seconds.",
    );
    msgId = sent.message_id;
    for (const instrument of ["XAUUSD", "BTCUSD"]) {
      const data = await buildDataBlock(instrument);
      const analysis = await callClaude(
        data.block + `\nFull analysis for $20 account trader.`,
      );
      await bot.sendMessage(
        chatId,
        `${instrument}\n` +
          `Confluence: ${data.confluence.score}/${data.confluence.total} | Bias: ${data.confluence.direction || "Neutral"}\n` +
          `SMC: ${data.smc?.bias || "Neutral"}\n\n` +
          `${analysis}`,
      );
      await delay(5000);
    }
    try {
      await bot.deleteMessage(chatId, msgId);
    } catch {}
  } catch (err) {
    console.error("Both error:", err.message);
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
    const sent = await bot.sendMessage(
      msg.chat.id,
      "Calculating confluence scores...",
    );
    msgId = sent.message_id;
    let text = `Confluence Scores\n\n`;
    for (const instrument of ["XAUUSD", "BTCUSD"]) {
      const data = await buildDataBlock(instrument);
      const c = data.confluence;
      text += `${instrument} — ${c.score}/${c.total} | ${c.direction || "NEUTRAL"} | SMC: ${data.smc?.bias || "n/a"}\n`;
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
  const left = creditsLeft();
  const pct = Math.min(100, Math.round((used / DAILY_LIMIT) * 100));
  const bar =
    "#".repeat(Math.floor(pct / 10)) + ".".repeat(10 - Math.floor(pct / 10));
  bot.sendMessage(
    msg.chat.id,
    `API Credits Today\n\n[${bar}] ${pct}%\nUsed: ${used} / ${DAILY_LIMIT}\nRemaining: ${left}\n\n` +
      `Each analysis uses 8 credits.\nCache saves credits for 25 mins.\nResets: midnight UTC`,
  );
});

bot.onText(/\/session/, (msg) => {
  const s = getSession();
  bot.sendMessage(
    msg.chat.id,
    `Trading Session\n\n${s.utcStr}\n${s.name}\nOptimal: ${s.isOptimal ? "YES" : "NO"}\n\n` +
      `London: 08:00-17:00 UTC\nNew York: 13:00-22:00 UTC\nBest: 13:00-17:00 UTC overlap\n\n` +
      `Auto-scan runs every 30 mins during London and NY only.`,
  );
});

bot.onText(/\/calendar/, async (msg) => {
  let msgId = null;
  try {
    const sent = await bot.sendMessage(
      msg.chat.id,
      "Checking economic calendar...",
    );
    msgId = sent.message_id;
    const cal = await fetchCalendar();
    try {
      await bot.deleteMessage(msg.chat.id, msgId);
    } catch {}
    await bot.sendMessage(
      msg.chat.id,
      `Economic Calendar\n\n` +
        `Status: ${cal.hasHighImpact ? "HIGH IMPACT — avoid trading" : "Clear — safe to trade"}\n` +
        `Events: ${cal.events}\n` +
        (cal.nextEvent ? `Next event: ${cal.nextEvent}` : ""),
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
    const sent = await bot.sendMessage(
      msg.chat.id,
      "Fetching Fear & Greed index...",
    );
    msgId = sent.message_id;
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
      `Fear & Greed Index\n\n[${bar}]\n${fg?.value ?? "n/a"}/100 — ${fg?.label ?? "n/a"}\n\n` +
        `0-24: Extreme Fear\n25-49: Fear\n50-74: Greed\n75-100: Extreme Greed`,
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
    text += `[${icon}] #${t.id} ${t.instrument} ${t.signal} ${t.quality || ""} ${t.source === "auto-scan" ? "[auto]" : "[manual]"} — ${new Date(t.timestamp).toLocaleDateString()}\n`;
  });
  text += `\n/win [id] or /loss [id] to update`;
  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/win (.+)/, (msg, match) => {
  if (updateOutcome(match[1], "win")) {
    recordWin();
    bot.sendMessage(
      msg.chat.id,
      `#${match[1]} marked WIN. Loss streak reset to 0.`,
    );
  } else bot.sendMessage(msg.chat.id, "ID not found. Check /journal.");
});

bot.onText(/\/loss (.+)/, (msg, match) => {
  if (updateOutcome(match[1], "loss")) {
    const paused = recordLoss();
    if (!paused)
      bot.sendMessage(
        msg.chat.id,
        `#${match[1]} marked LOSS. Streak: ${consecutiveLosses}/3.${consecutiveLosses === 2 ? " One more triggers 24H pause." : ""}`,
      );
  } else bot.sendMessage(msg.chat.id, "ID not found. Check /journal.");
});

bot.onText(/\/status/, (msg) => {
  const s = getSession();
  const now = Date.now();
  const fmtLastAlert = (ts) =>
    !ts ? "Never" : `${Math.round((now - ts) / 60000)} mins ago`;
  const fmtCooldown = (ts) => {
    if (!ts) return "Ready";
    const left = Math.round((COOLDOWN_MS - (now - ts)) / 60000);
    return left > 0 ? `Cooldown: ${left} mins` : "Ready";
  };
  bot.sendMessage(
    msg.chat.id,
    `Bot Status\n\n` +
      `Bot: ${botActive ? "ACTIVE" : "STOPPED"}\n` +
      `Auto-alerts: ${autoAlertsEnabled ? "ON" : "OFF"}\n` +
      `Session: ${s.name} | ${s.utcStr}\n` +
      `Drawdown lock: ${isBotPaused() ? "YES — 24H pause active" : `No (${consecutiveLosses}/3 losses)`}\n` +
      `Credits: ${creditsLeft()} remaining\n` +
      `Cache entries: ${Object.keys(dataCache).length} active\n\n` +
      `XAUUSD last alert: ${fmtLastAlert(lastAutoAlert.XAUUSD)} | ${fmtCooldown(lastAutoAlert.XAUUSD)}\n` +
      `BTCUSD last alert: ${fmtLastAlert(lastAutoAlert.BTCUSD)} | ${fmtCooldown(lastAutoAlert.BTCUSD)}`,
  );
});

bot.onText(/\/risk/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Risk Rules — $20 Account\n\n` +
      `1. Max risk $0.20 (1%) per trade\n` +
      `2. Minimum R/R 1:2 — always\n` +
      `3. One trade at a time only\n` +
      `4. Never trade during high-impact news\n` +
      `5. Stop loss based on ATR or swing structure\n` +
      `6. Move SL to entry after TP1 is hit\n` +
      `7. Three losses in a row = bot auto-pauses 24H\n` +
      `8. 0.01 lots until account reaches $100\n` +
      `9. Only trade London and New York sessions`,
  );
});

bot.onText(/\/sizing/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Position Sizing — $20 Account\n\n` +
      `Lot size: 0.01 always\n` +
      `XAUUSD: approximately $0.10 per pip\n` +
      `2 pip SL = $0.20 risk (1%)\n\n` +
      `SL = 1.5x ATR\n` +
      `TP1 = 2x ATR (1:1.3 R/R)\n` +
      `TP2 = 3.5x ATR (1:2.3 R/R)\n\n` +
      `$20 to $100: stay at 0.01 lots\n` +
      `$100 and above: reassess sizing`,
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Commands\n\n` +
      `/gold — XAUUSD analysis\n` +
      `/btc — BTCUSD analysis\n` +
      `/both — Both markets\n` +
      `/refresh — Clear cache\n` +
      `/confluence — Scores\n` +
      `/alerts on/off — Auto scanning\n` +
      `/session — Session info\n` +
      `/calendar — Economic events\n` +
      `/feargreed — BTC sentiment\n` +
      `/credits — API usage\n` +
      `/journal — Trade log\n` +
      `/win [n] | /loss [n] — Log outcome\n` +
      `/status — Full bot status\n` +
      `/stop | /resume — Bot controls\n` +
      `/risk | /sizing — Account rules\n` +
      `/ask [question] — Ask anything\n` +
      `/help — This menu`,
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
    const sent = await bot.sendMessage(chatId, "Analyzing your question...");
    msgId = sent.message_id;
    const answer = await callClaude(
      `$20 account trader using SMC concepts on 30M/1H timeframes. Question: ${match[1]}`,
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
    bot.sendMessage(msg.chat.id, "Type /help to see all available commands.");
});

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\nTradingBot Pro — ${new Date().toISOString()}`);
console.log(`Chat IDs: ${ALERT_CHAT_IDS.join(", ") || "NONE SET"}`);
console.log(`Credits today: ${loadCredits().used} used / ${DAILY_LIMIT} limit`);
console.log(
  `Auto-alerts: ${autoAlertsEnabled ? "ON" : "OFF"} (every 30 mins, London/NY sessions only)`,
);
console.log(`SMC analysis: BOS, CHoCH, Order Blocks, FVG — enabled`);
console.log(`News protection: auto-blocks trading during high-impact events`);
console.log(`Cache TTL: 25 minutes\n`);
