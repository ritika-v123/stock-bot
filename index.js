const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");

// Configuration
const BOT_TOKEN =  process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// Load stock symbols from file (symbols.txt)
const stockSymbols = fs.readFileSync("symbols.txt", "utf-8")
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line.length > 0);

const stockList = stockSymbols.map(sym => {
  const name = sym.replace(".NS", "").replace(".BO", "");
  return { name, symbol: sym };
});

// ==================== TELEGRAM ====================
async function sendTelegramMessage(message) {
  try {
    console.log(`📤 Sending: ${message.substring(0, 50)}...`);

    const response = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: String(CHAT_ID),
        text: message,
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
      }
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
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,
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

    const price = result.meta?.regularMarketPrice; // Current price
    const prevClose = result.meta?.chartPreviousClose; // Yesterday's close

    if (price && prevClose) {
      console.log(
        `✅ ${symbol}: Current ₹${price.toFixed(
          2
        )}, PrevClose ₹${prevClose.toFixed(2)}`
      );
      return { price, prevClose };
    } else {
      console.log(`⚠️ ${symbol}: Missing price/close data`);
      return null;
    }
  } catch (error) {
    console.error(`❌ Error fetching ${symbol}:`, error.message);
    return null;
  }
}

// ==================== STOCK CHECK ====================
async function checkStocks() {
  console.log(`\n🔍 === STOCK CHECK STARTED ===`);
  console.log(`Time: ${new Date().toLocaleString()}`);

  let messagesCount = 0;

  for (let i = 0; i < stockList.length; i++) {
    const stock = stockList[i];

    try {
      const data = await fetchStockPrice(stock.symbol);

      if (data) {
        const { price, prevClose } = data;

        const change = price - prevClose;
        const changePercent = (change / prevClose) * 100;

        console.log(
          `📊 ${stock.name}: Current=₹${price.toFixed(
            2
          )}, PrevClose=₹${prevClose.toFixed(2)}, Change=${changePercent.toFixed(
            2
          )}%`
        );

        // Alert threshold = 3% change
        if (Math.abs(changePercent) >= 2.5) {
          const direction = change > 0 ? "📈 INCREASED" : "📉 DECREASED";
          const emoji = change > 0 ? "⬆️" : "⬇️";

          const message = `${emoji} ${stock.name} ${direction}

💰 Current Price: ₹${price.toFixed(2)}
📊 Previous Close: ₹${prevClose.toFixed(2)}
💹 Change: ${change > 0 ? "+" : ""}₹${change.toFixed(2)}
📊 Percentage: ${changePercent > 0 ? "+" : ""}${changePercent.toFixed(2)}%
⏰ Time: ${new Date().toLocaleTimeString()}`;

          const sent = await sendTelegramMessage(message);
          if (sent) messagesCount++;
        } else {
          console.log(
            `📊 ${stock.name}: Change too small (${changePercent.toFixed(
              2
            )}%), not alerting`
          );
        }
      } else {
        console.log(`❌ Failed to get price for ${stock.name}`);
      }

      // Delay to avoid rate limiting
      if (i < stockList.length - 1) {
        console.log("⏳ Waiting 3 seconds before next stock...");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(`❌ Error processing ${stock.name}:`, error.message);
    }
  }

  console.log(`✅ === STOCK CHECK COMPLETED ===`);
  console.log(`📤 Messages sent: ${messagesCount}`);
  console.log(`📊 Stocks tracked: ${stockList.length}`);

  // Summary message if no alerts
  if (messagesCount === 0) {
    await sendTelegramMessage(`📊 Stock Check Complete ✅

All ${stockList.length} stocks checked - no significant changes detected.
Time: ${new Date().toLocaleTimeString()}`);
  }
}

// ==================== STARTUP TEST ====================
async function testBotOnStartup() {
  console.log("🧪 Testing bot connectivity...");

  return await sendTelegramMessage(`🚀 Stock Bot Started! 

✅ Bot is online and ready
📊 Tracking: ${stockList.map((s) => s.name).join(", ")}
⏰ Started: ${new Date().toLocaleString()}
🔄 Check interval: Every 5 minutes`);
}

// ==================== MAIN ====================
async function main() {
  console.log("🚀 Starting Stock Bot...");
  console.log(`🔗 Using Telegram Bot: ${BOT_TOKEN}`);
  console.log(`👤 Sending to: ${CHAT_ID}`);

  const botWorking = await testBotOnStartup();
  if (!botWorking) {
    console.log("❌ Bot test failed! Exiting...");
    process.exit(1);
  }

  console.log("✅ Bot test successful!");
  console.log(
    "📊 Stocks to monitor:",
    stockList.map((s) => `${s.name} (${s.symbol})`).join(", ")
  );

  // Initial check after 10 seconds
  setTimeout(async () => {
    console.log("🏃‍♂️ Running initial stock check...");
    await checkStocks();

    // Repeat every 5 minutes
    cron.schedule("*/15 * * * *", async () => {
      console.log("\n⏰ Scheduled check triggered...");
      await checkStocks();
    });

    console.log("⏰ Scheduled to check stocks every 15 minutes");
  }, 10000);
}

// ==================== ERROR HANDLING ====================
process.on("uncaughtException", async (error) => {
  console.error("❌ Uncaught Exception:", error.message);
  await sendTelegramMessage(`❌ Bot Error: ${error.message}`);
});

process.on("unhandledRejection", async (reason, promise) => {
  console.error("❌ Unhandled Rejection:", reason);
  await sendTelegramMessage(`❌ Bot Promise Rejection: ${reason}`);
});

process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down...");
  await sendTelegramMessage("🛑 Stock Bot shutting down. Monitoring stopped.");
  process.exit(0);
});

// ==================== START BOT ====================
main().catch(async (error) => {
  console.error("❌ Startup error:", error.message);
  await sendTelegramMessage(`❌ Bot failed to start: ${error.message}`);
});


const express = require("express");
const app = express();

// Health check endpoint
app.get("/", (req, res) => {
  res.send("✅ Stock Bot is running on Render!");
});

// Render requires binding to a port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
