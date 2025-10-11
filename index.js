const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");
const express = require("express");

// Configuration
const BOT_TOKEN = "8285018516:AAFfLO6o6aofB2S8W0eQV7-NA0JHpDyvCkM";
const CHAT_ID = "1642232617";

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing! Set them as environment variables.");
  process.exit(1);
}

// ==================== STOCK LIST ====================
const stockSymbols = fs.readFileSync("symbols.txt", "utf-8")
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line.length > 0);

const stockList = stockSymbols.map(sym => ({
  name: sym.replace(".NS", "").replace(".BO", ""),
  symbol: sym,
}));

// ==================== TIME HELPERS ====================
function getCurrentIST() {
  return new Date().toLocaleString("en-IN", { 
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "medium"
  });
}

function isMarketOpen() {
  // Get current time in IST
  const now = new Date();
  const istTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  
  const hours = istTime.getHours();
  const minutes = istTime.getMinutes();
  const day = istTime.getDay();

  // Market closed on weekends (0 = Sunday, 6 = Saturday)
  if (day === 0 || day === 6) {
    console.log("⏰ Weekend - Market is closed");
    return false;
  }

  // Market hours: 9:00 AM - 4:00 PM IST
  const currentMinutes = hours * 60 + minutes;
  const marketOpen = 9 * 60; // 9:00 AM
  const marketClose = 16 * 60; // 4:00 PM

  const isOpen = currentMinutes >= marketOpen && currentMinutes < marketClose;
  
  if (!isOpen) {
    console.log(`⏰ Market is closed (Current time: ${hours}:${minutes.toString().padStart(2, '0')})`);
  }
  
  return isOpen;
}

// ==================== TELEGRAM ====================
async function sendTelegramMessage(message) {
  // Check if market is open before sending
  if (!isMarketOpen()) {
    console.log("⏰ Message not sent - Market is closed");
    return false;
  }

  try {
    console.log(`📤 Sending: ${message.substring(0, 50)}...`);
    const response = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: String(CHAT_ID), text: message },
      { headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );
    console.log(`✅ Message sent (ID: ${response.data.result.message_id})`);
    return true;
  } catch (error) {
    console.error("❌ Telegram error:", error.response?.data || error.message);
    return false;
  }
}

// ==================== FETCH STOCK DATA ====================
async function fetchStockPrice(symbol) {
  try {
    console.log(`🔍 Fetching ${symbol}...`);

    // Fetch current price (5 days)
    const currentResponse = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`,
      {
        timeout: 12000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
        },
      }
    );

    const currentResult = currentResponse.data?.chart?.result?.[0];
    if (!currentResult) return null;

    const timestamps = currentResult.timestamp || [];
    const closes = currentResult.indicators?.quote?.[0]?.close || [];

    // Merge timestamps & closes, filter invalid
    const currentData = timestamps
      .map((ts, i) => ({ time: ts, close: closes[i] }))
      .filter(d => d.close !== null && !isNaN(d.close));

    if (currentData.length < 2) return null;

    // Current price is the LATEST available (today if market open, or yesterday's close if closed)
    const lastData = currentData[currentData.length - 1];  // Current/Latest price
    const prevData = currentData[currentData.length - 2];  // Previous day's closing price

    const price = lastData.close;  // Current price (today's or last available)
    const prevClose = prevData.close;  // Previous closing price

    // Convert timestamp to IST
    const lastDate = new Date(lastData.time * 1000).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "short"
    });

    // Fetch 3 months data for averages
    const historyResponse = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3mo`,
      {
        timeout: 12000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
        },
      }
    );

    const historyResult = historyResponse.data?.chart?.result?.[0];
    let avg1w = null;
    let avg3m = null;

    if (historyResult) {
      const historyTimestamps = historyResult.timestamp || [];
      const historyCloses = historyResult.indicators?.quote?.[0]?.close || [];

      const historyData = historyTimestamps
        .map((ts, i) => ({ time: ts, close: historyCloses[i] }))
        .filter(d => d.close !== null && !isNaN(d.close));

      // Weekly average: last 5-7 trading days
      if (historyData.length > 0) {
        const weeklyDataPoints = Math.min(7, historyData.length);
        const lastWeek = historyData.slice(-weeklyDataPoints);
        avg1w = lastWeek.reduce((sum, d) => sum + d.close, 0) / lastWeek.length;
      }

      // 3 month average: all available data
      if (historyData.length > 0) {
        avg3m = historyData.reduce((sum, d) => sum + d.close, 0) / historyData.length;
      }
    }

    console.log(
      `✅ ${symbol}: Current ₹${price.toFixed(2)}, PrevClose ₹${prevClose.toFixed(
        2
      )}, 1W Avg ₹${avg1w ? avg1w.toFixed(2) : 'N/A'}, 3M Avg ₹${avg3m ? avg3m.toFixed(2) : 'N/A'}, Time: ${lastDate}`
    );

    return { price, prevClose, avg3m, avg1w, lastDate };
  } catch (error) {
    console.error(`❌ Error fetching ${symbol}:`, error.message);
    return null;
  }
}

// ==================== STOCK CHECK ====================
async function checkStocks() {
  const nowIST = getCurrentIST();
  console.log(`\n🔍 === STOCK CHECK STARTED ===`);
  console.log(`Time: ${nowIST}`);

  // Check if market is open
  if (!isMarketOpen()) {
    console.log("⏰ Market is closed. Skipping stock check.");
    return;
  }

  let messagesCount = 0;

  for (let i = 0; i < stockList.length; i++) {
    const stock = stockList[i];

    try {
      const data = await fetchStockPrice(stock.symbol);

      if (data) {
        const { price, prevClose, avg3m, avg1w, lastDate } = data;
        const change = price - prevClose;
        const changePercent = (change / prevClose) * 100;

        console.log(
          `📊 ${stock.name}: Current=₹${price.toFixed(
            2
          )}, PrevClose=₹${prevClose.toFixed(
            2
          )}, Change=${changePercent.toFixed(2)}%`
        );

        if (Math.abs(changePercent) >= 2.5) {
          const direction = change > 0 ? "📈 INCREASED" : "📉 DECREASED";
          const emoji = change > 0 ? "⬆️" : "⬇️";

          const message = `${emoji} ${stock.name} ${direction}

💰 Current Price: ₹${price.toFixed(2)}
📊 Previous Close: ₹${prevClose.toFixed(2)}
📉 1W Average: ₹${avg1w.toFixed(2)}
📉 3M Average: ₹${avg3m.toFixed(2)}
💹 Change: ${change > 0 ? "+" : ""}₹${change.toFixed(2)}
📊 Percentage: ${changePercent > 0 ? "+" : ""}${changePercent.toFixed(2)}%
⏰ Last Update: ${lastDate}`;

          const sent = await sendTelegramMessage(message);
          if (sent) messagesCount++;
        } else {
          console.log(`📊 ${stock.name}: Change too small, no alert`);
        }
      } else {
        console.log(`❌ Failed to get price for ${stock.name}`);
      }

      // Small delay to avoid rate-limiting
      if (i < stockList.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(`❌ Error processing ${stock.name}:`, error.message);
    }
  }

  console.log(`✅ === STOCK CHECK COMPLETED ===`);
  console.log(`📤 Messages sent: ${messagesCount}`);
  console.log(`📊 Stocks tracked: ${stockList.length}`);

  if (messagesCount === 0) {
    await sendTelegramMessage(`📊 Stock Check Complete ✅

All ${stockList.length} stocks checked - no significant changes detected.
Time: ${getCurrentIST()}`);
  }
}

// ==================== STARTUP TEST ====================
async function testBotOnStartup() {
  console.log("🧪 Testing bot connectivity...");
  
  // Only send startup message if market is open
  if (!isMarketOpen()) {
    console.log("⏰ Market is closed. Startup message will not be sent.");
    return true; // Return true to allow bot to start
  }
  
  return await sendTelegramMessage(`🚀 Stock Bot Started! 

✅ Bot is online and ready
📊 Tracking: ${stockList.map(s => s.name).join(", ")}
⏰ Started: ${getCurrentIST()}
🔄 Check interval: Every 15 minutes (9 AM - 4 PM IST)`);
}

// ==================== MAIN ====================
async function main() {
  console.log("🚀 Starting Stock Bot...");
  console.log(`👤 Sending to: ${CHAT_ID}`);

  const botWorking = await testBotOnStartup();
  if (!botWorking && isMarketOpen()) {
    console.log("❌ Bot test failed during market hours! Exiting...");
    process.exit(1);
  }

  console.log("✅ Bot initialized successfully!");
  console.log("📊 Stocks to monitor:", stockList.map(s => `${s.name} (${s.symbol})`).join(", "));

  // Initial check after 10s
  setTimeout(async () => {
    if (isMarketOpen()) {
      console.log("🏃‍♂️ Running initial stock check...");
      await checkStocks();
    } else {
      console.log("⏰ Market is closed. Waiting for market hours...");
    }
  }, 10000);

  // Schedule every 15 min - checkStocks will verify market hours
  cron.schedule("*/15 * * * *", async () => {
    await checkStocks();
  }, {
    timezone: "Asia/Kolkata"
  });

  console.log("⏰ Scheduled to check stocks every 15 minutes (9 AM - 4 PM IST)");
}

// ==================== ERROR HANDLING ====================
process.on("uncaughtException", async (error) => {
  console.error("❌ Uncaught Exception:", error.message);
  if (isMarketOpen()) {
    await sendTelegramMessage(`❌ Bot Error: ${error.message}`);
  }
});

process.on("unhandledRejection", async (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
  if (isMarketOpen()) {
    await sendTelegramMessage(`❌ Bot Promise Rejection: ${reason}`);
  }
});

process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down...");
  if (isMarketOpen()) {
    await sendTelegramMessage("🛑 Stock Bot shutting down. Monitoring stopped.");
  }
  process.exit(0);
});

// ==================== EXPRESS SERVER ====================
const app = express();
app.get("/", (req, res) => {
  const marketStatus = isMarketOpen() ? "🟢 OPEN" : "🔴 CLOSED";
  res.send(`✅ Stock Bot is running on Railway!

Market Status: ${marketStatus}
Current Time: ${getCurrentIST()}
Tracking: ${stockList.length} stocks`);
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// ==================== START BOT ====================
main().catch(async (error) => {
  console.error("❌ Startup error:", error.message);
  if (isMarketOpen()) {
    await sendTelegramMessage(`❌ Bot failed to start: ${error.message}`);
  }
});