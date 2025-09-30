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

// ==================== TELEGRAM ====================
async function sendTelegramMessage(message) {
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

    const response = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`,
      {
        timeout: 12000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
        },
      }
    );

    const result = response.data?.chart?.result?.[0];
    if (!result) return null;

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];

    // Merge timestamps & closes, filter invalid
    const validData = timestamps
      .map((ts, i) => ({ time: ts, close: closes[i] }))
      .filter(d => d.close !== null && !isNaN(d.close));

    if (validData.length < 2) return null;

    // Latest and previous close
    const lastData = validData[validData.length - 1];
    const prevData = validData[validData.length - 2];

    const price = lastData.close;
    const prevClose = prevData.close;

    // Convert timestamp to IST
    const lastDate = new Date(lastData.time * 1000).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    });

    // Calculate averages
    let avg3m = null;
    let avg1w = null;

    if (validData.length > 0) {
      avg3m = validData.reduce((sum, d) => sum + d.close, 0) / validData.length;
      const last7 = validData.slice(-7);
      avg1w = last7.reduce((sum, d) => sum + d.close, 0) / last7.length;
    }

    console.log(
      `✅ ${symbol}: Current ₹${price.toFixed(2)}, PrevClose ₹${prevClose.toFixed(
        2
      )}, 1W Avg ₹${avg1w?.toFixed(2)}, 3M Avg ₹${avg3m?.toFixed(
        2
      )}, Time: ${lastDate}`
    );

    return { price, prevClose, avg3m, avg1w, lastDate };
  } catch (error) {
    console.error(`❌ Error fetching ${symbol}:`, error.message);
    return null;
  }
}

// ==================== STOCK CHECK ====================
async function checkStocks() {
  console.log(`\n🔍 === STOCK CHECK STARTED ===`);
  console.log(`Time: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);

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
📉 1W Average: ₹${avg1w ? avg1w.toFixed(2) : "N/A"}
📉 3M Average: ₹${avg3m ? avg3m.toFixed(2) : "N/A"}
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
Time: ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}`);
  }
}

// ==================== STARTUP TEST ====================
async function testBotOnStartup() {
  console.log("🧪 Testing bot connectivity...");
  return await sendTelegramMessage(`🚀 Stock Bot Started! 

✅ Bot is online and ready
📊 Tracking: ${stockList.map(s => s.name).join(", ")}
⏰ Started: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
🔄 Check interval: Every 15 minutes`);
}

// ==================== MAIN ====================
async function main() {
  console.log("🚀 Starting Stock Bot...");
  console.log(`👤 Sending to: ${CHAT_ID}`);

  const botWorking = await testBotOnStartup();
  if (!botWorking) {
    console.log("❌ Bot test failed! Exiting...");
    process.exit(1);
  }

  console.log("✅ Bot test successful!");
  console.log("📊 Stocks to monitor:", stockList.map(s => `${s.name} (${s.symbol})`).join(", "));

  // Initial check after 10s
  setTimeout(async () => {
    console.log("🏃‍♂️ Running initial stock check...");
    await checkStocks();

    // Schedule every 15 min
    cron.schedule("*/15 * * * *", async () => {
      await checkStocks();
    }, {
      timezone: "Asia/Kolkata"
    });

    console.log("⏰ Scheduled to check stocks every 15 minutes");
  }, 10000);
}

// ==================== ERROR HANDLING ====================
process.on("uncaughtException", async (error) => {
  console.error("❌ Uncaught Exception:", error.message);
  await sendTelegramMessage(`❌ Bot Error: ${error.message}`);
});

process.on("unhandledRejection", async (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
  await sendTelegramMessage(`❌ Bot Promise Rejection: ${reason}`);
});

process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down...");
  await sendTelegramMessage("🛑 Stock Bot shutting down. Monitoring stopped.");
  process.exit(0);
});

// ==================== EXPRESS SERVER ====================
const app = express();
app.get("/", (req, res) => res.send("✅ Stock Bot is running on Railway!"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// ==================== START BOT ====================
main().catch(async (error) => {
  console.error("❌ Startup error:", error.message);
  await sendTelegramMessage(`❌ Bot failed to start: ${error.message}`);
});
