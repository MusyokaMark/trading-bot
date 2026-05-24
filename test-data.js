// save as test-data.js in your bot folder
require("dotenv").config({ path: ".env" });
const axios = require("axios");
const key = process.env.TWELVE_DATA_API_KEY;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function test() {
  console.log("Key:", key ? key.slice(0, 8) + "..." : "MISSING");

  const calls = [
    {
      name: "Price XAU/USD",
      url: `https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${key}`,
    },
    {
      name: "RSI 1H",
      url: `https://api.twelvedata.com/rsi?symbol=XAU/USD&interval=1h&time_period=14&apikey=${key}`,
    },
    {
      name: "MA20 1H",
      url: `https://api.twelvedata.com/ma?symbol=XAU/USD&interval=1h&time_period=20&apikey=${key}`,
    },
    {
      name: "ATR 1H",
      url: `https://api.twelvedata.com/atr?symbol=XAU/USD&interval=1h&time_period=14&apikey=${key}`,
    },
    {
      name: "Candles 1H",
      url: `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1h&outputsize=3&apikey=${key}`,
    },
  ];

  for (const call of calls) {
    try {
      const res = await axios.get(call.url, { timeout: 10000 });
      console.log(`✅ ${call.name}:`, JSON.stringify(res.data).slice(0, 120));
    } catch (e) {
      console.log(`❌ ${call.name}:`, e.response?.data?.message || e.message);
    }
    await delay(1500);
  }
}

test();
