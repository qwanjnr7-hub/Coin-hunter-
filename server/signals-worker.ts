import TelegramBot from 'node-telegram-bot-api';
import { db } from "./db";
import { groupBindings, signals as signalsTable, users } from "@shared/schema";
import { storage } from "./storage";
import { log } from "./index";
import { eq, and, or, sql } from "drizzle-orm";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import axios from "axios";

import { JupiterService } from "./solana";

const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const jupiter = new JupiterService(rpcUrl);

// Enhanced executeBuy with retry logic for Auto-Buy
async function executeBuy(userId: string, mint: string, amount: string, chatId: number) {
  try {
    log(`Initiating auto-buy for ${userId} on ${mint} (${amount} SOL)`, "express");
    const user = await storage.getUser(userId);
    const activeWallet = await storage.getActiveWallet(userId);
    if (!activeWallet) throw new Error("No active wallet found for user " + userId);
    
    const slippage = user?.autoBuySlippage || 100;
    const priorityFee = user?.priorityFeeAmount || "0.0015";
    const lamports = Math.floor(parseFloat(amount) * 1e9);

    log(`Fetching quote from Jupiter...`, "express");
    const quote = await jupiter.getQuote("So11111111111111111111111111111111111111112", mint, lamports.toString(), slippage);

    log(`Executing swap...`, "express");
    const userKeypair = Keypair.fromSecretKey(bs58.decode(activeWallet.privateKey));
    const txid = await jupiter.swap(userKeypair, quote, user?.mevProtection ?? true, priorityFee);
    
    await storage.createTrade({ 
      userId, 
      walletId: activeWallet.id, 
      mint, 
      amountIn: amount, 
      status: 'completed', 
      txHash: txid 
    });

    log(`Auto-buy successful for ${userId}: ${txid}`, "express");
  } catch (err: any) {
    log(`Auto-buy execution failed for ${userId}: ${err.message}`, "express");
  }
}

// Use Replit AI client
import OpenAI from "openai";
let openRouterClient: OpenAI | null = null;

async function initAI() {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  let baseURL: string | undefined;
  if (process.env.OPENROUTER_API_KEY) {
    baseURL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  } else {
    baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined;
  }

  if (apiKey) {
    openRouterClient = new OpenAI({
      apiKey,
      baseURL,
      dangerouslyAllowBrowser: true,
      defaultHeaders: {
        "HTTP-Referer": "https://replit.com",
        "X-Title": "Solana SMC Bot",
        "Authorization": `Bearer ${apiKey}`
      }
    });
    log(`SMC Worker AI initialized via ${process.env.OPENROUTER_API_KEY ? 'OpenRouter' : 'OpenAI'} API Key`);
  } else {
    log("SMC Worker AI environment variables missing", "express");
  }
}

// Initialize AI on module load
initAI().catch(err => log(`Failed to initialize AI: ${err}`));

const MONITORED_CRYPTO = [
  "BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT",
  "ADA/USDT", "DOGE/USDT", "AVAX/USDT", "DOT/USDT", "TRX/USDT",
  "LINK/USDT", "MATIC/USDT", "SHIB/USDT", "LTC/USDT", "BCH/USDT",
  "UNI/USDT", "NEAR/USDT", "ATOM/USDT", "XMR/USDT", "ETC/USDT",
  "ALGO/USDT", "VET/USDT", "ICP/USDT", "FIL/USDT", "HBAR/USDT"
];

const MONITORED_FOREX = [
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD",
  "USD/CAD", "NZD/USD", "EUR/GBP", "EUR/JPY", "GBP/JPY"
];

const INSTITUTIONAL_PROMPT = `
ROLE: Institutional Swing Trading Specialist (SMC Analysis)

🔐 MANDATORY TRADING RULES:
- FOCUS: High-Probability PREMIUM Swing Trade setups ONLY. 
- EXCLUSION: Strictly NO scalping, NO day-trading noise, NO low-timeframe fluctuations.
- MTF ALIGNMENT: Must align 4H, 1D, and Weekly structures for institutional flow. 
- HTF BIAS: Signal must be backed by HTF Orderflow (Monthly/Weekly).
- MINIMUM RR: 1:3 Risk/Reward ratio for TP3.
- FOREX MINIMUM: Entry to TP3 MUST be at least 150 pips.
- CRYPTO MINIMUM: Entry to TP3 MUST be at least 10% move.

📊 OUTPUT STRUCTURE (PREMIUM TERMINAL FORMAT):
1️⃣ 🏦 Institutional Bias: BULLISH / BEARISH (HTF Orderflow confirmed)
2️⃣ 🔍 Macro Context: Identify HTF Break of Structure (BOS) and Change of Character (CHoCH). Mention HTF supply/demand zones.
3️⃣ 🎯 Premium Setup:
   - 📍 Signal Entry: [Price] (Optimal Trade Entry - OTE zone on HTF)
   - 🟢 TP 1: [Price] (HTF Liquidity Sweep)
   - 🟢 TP 2: [Price] (HTF Fair Value Gap Fill)
   - 🟢 TP 3: [Price] (HTF Target / Major Swing Point)
   - 🔴 Stop Loss: [Price] (Protected HTF Low/High)
4️⃣ ⚖️ Risk Management: Standard institutional sizing for swing positions.
`;

const COOLDOWNS = new Map<string, number>();

export async function runAutoSignalGenerator() {
  log("Starting institutional SMC signal generator...");

  // Scanner for New Signals
  setInterval(() => runScanner("crypto"), 10 * 60 * 1000);
  setInterval(() => runScanner("forex"), 10 * 60 * 1000);

  // Monitoring Loop for Active Signals
  setInterval(() => {
    log("Running scheduled monitoring loop for active signals...", "express");
    runMonitoringLoop();
  }, 15 * 60 * 1000); // 15 minutes for swing trades

  // Initial run on startup
  setTimeout(() => {
    log("INITIAL SCAN TRIGGERED");
    runScanner("crypto");
    setTimeout(() => runScanner("forex"), 30000);
    setTimeout(() => {
       log("INITIAL MONITORING TRIGGERED");
       runMonitoringLoop();
    }, 60000);
  }, 10000);
}

const SETUP_PROMPT = `
ROLE: Institutional Setup Identifier

When given market data, identify the most relevant SETUP type from the following list: Breakout, Pullback, Reversal, Indicator-Based. For the chosen setup, provide:
- Setup Type: one of Breakout | Pullback | Reversal | Indicator-Based
- Confluence Factors: list supporting factors (e.g., S/R, Fibonacci, RSI divergence, moving averages)
- Multi-Timeframe Analysis: short top-down summary (Weekly, Daily, 4H) and HTF alignment
- Volume/Orderflow Evidence: mention volume spike, orderbook sweep, liquidity grab, etc., if present
- Market Structure: BOS/CHoCH, major swing levels
- Entry: suggested entry price or zone
- Stop Loss: recommended stop loss price
- Take Profits: TP1, TP2, TP3 with rationale and R:R for each
- Risk-Reward: estimated R:R for TP3
- Summary: 1-2 sentence verdict (High/Medium/Low probability)

Return output in plain text with labeled sections.
`;

const ANALYZE_PROMPT = `
ROLE: Institutional Analyst (Detailed Analysis)

Provide a comprehensive analysis for a requested pair. Steps:
1) Identify market bias (BULLISH / BEARISH / NEUTRAL) across Weekly, Daily, 4H.
2) Describe recent Market Structure (BOS, CHoCH, key swing highs/lows).
3) Identify potential premium setups (Breakout, Pullback, Reversal, Indicator-Based) and list confluence for each.
4) Provide precise Entry, SL, TP1/TP2/TP3 levels and compute R:R (entry->tp3 vs entry->sl).
5) Note volume/orderflow signs and any cautions.

Return output in plain text with labeled sections suitable for posting to a Telegram group.
`;

export async function runScanner(marketType: "crypto" | "forex", isForce: boolean = false, forceChatId?: string, forceTopicId?: string, forcePair?: string, mode?: "setup" | "analyze") {
  try {
    const symbols = forcePair ? [forcePair] : (marketType === "crypto" ? MONITORED_CRYPTO : MONITORED_FOREX);
    
    // Check if signal already active for this market lane
    let activeSignals: any[] = [];
    try {
      if (!forcePair) {
        activeSignals = await db.select().from(signalsTable).where(
          and(
            eq(signalsTable.type, marketType),
            eq(signalsTable.status, "active")
          )
        );
      }
    } catch (dbErr) {
      log(`Database query error in runScanner: ${dbErr}`);
      return;
    }
    
    if (activeSignals.length > 0 && !isForce) {
      log(`Active ${marketType} signal exists for ${activeSignals[0].symbol}, resetting to allow fresh scan.`);
      await db.delete(signalsTable).where(eq(signalsTable.id, activeSignals[0].id));
    }

    // Weekend check for Forex (skip if forcing a specific pair)
    if (marketType === "forex" && !forcePair) {
      const now = new Date();
      const day = now.getUTCDay(); // 0 = Sunday, 1-5 = Mon-Fri, 6 = Saturday
      const hour = now.getUTCHours();
      
      // Forex market usually closes Friday 22:00 UTC and opens Sunday 22:00 UTC
      const isWeekend = (day === 6) || (day === 5 && hour >= 22) || (day === 0 && hour < 22);
      
      if (isWeekend) {
        log("Forex market is closed for the weekend. Skipping scan.", "express");
        return;
      }
    }

    // RELAXED COOLDOWN: Reducing from 60 mins to 15 mins for better user experience
    if (!isForce) {
      try {
        const lastSignals = await db.select().from(signalsTable).where(eq(signalsTable.type, marketType)).orderBy(sql`${signalsTable.createdAt} DESC`).limit(1);
        if (lastSignals.length > 0) {
          const lastSignalTime = new Date(lastSignals[0].createdAt).getTime();
          const timeSinceLast = Date.now() - lastSignalTime;
          if (timeSinceLast < 15 * 60 * 1000) {
            log(`Cooldown active for ${marketType}. Time since last: ${Math.round(timeSinceLast / 1000 / 60)}m. Skipping.`);
            return;
          }
        }
      } catch (dbErr) {
        log(`Database query error in runScanner cooldown check: ${dbErr}`);
      }
    }

    log(`${isForce ? 'Admin forced ' : 'Institutional '}${marketType} analysis...`);
    
    // For auto-scans, log the symbol being scanned
    if (!isForce) {
      log(`Auto-scanning ${marketType} candidates... Symbol pool: ${symbols.length}`);
    }
    
    // Updated scanner logic: Top 25 Crypto volume, Top 10 Forex majors
    const candidates = isForce ? symbols : symbols;
    let bestSignal = null;

    // Shuffle candidates for better coverage in auto-scans
    const shuffled = [...candidates].sort(() => 0.5 - Math.random());
    
    // Process candidates (limit to top 25 volume logic in pool)
    let currentRealPrice = "0";
    for (const symbol of shuffled) {
      if (forcePair && symbol !== forcePair) continue; // Only scan the requested pair if forced
      
      // Safety: Add a small delay between analyses to avoid AI rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      try {
        let priceContext = "";
        currentRealPrice = "0";
        try {
          if (marketType === "crypto") {
            const coinId = symbol.split('/')[0].toLowerCase();
            const symbolClean = symbol.replace("/", "").toUpperCase();
            log(`Fetching price for ${symbol} (coinId: ${coinId})...`, "express");

            // 1. CoinGecko
            try {
              const cgRes = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`, { 
                timeout: 5000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
              });
              if (cgRes.data[coinId]?.usd) {
                currentRealPrice = cgRes.data[coinId].usd.toString();
                log(`CoinGecko price for ${symbol}: ${currentRealPrice}`, "express");
              }
            } catch (e: any) {
              log(`CoinGecko fallback failed: ${e.message}`, "express");
            }

            // 2. CoinPaprika (Public - No Key)
            if (currentRealPrice === "0") {
              try {
                const cpId = `${coinId}-${symbol.split('/')[0].toLowerCase() === 'btc' ? 'bitcoin' : coinId}`;
                const cpRes = await axios.get(`https://api.coinpaprika.com/v1/tickers/${cpId}`, { timeout: 5000 });
                if (cpRes.data?.quotes?.USD?.price) {
                  currentRealPrice = cpRes.data.quotes.USD.price.toString();
                  log(`CoinPaprika price for ${symbol}: ${currentRealPrice}`, "express");
                }
              } catch (e: any) {
                log(`CoinPaprika fallback failed: ${e.message}`, "express");
              }
            }

            // 3. DIA (Public - No Key)
            if (currentRealPrice === "0") {
              try {
                const diaRes = await axios.get(`https://api.diadata.org/v1/quotation/${symbol.split('/')[0].toUpperCase()}`, { timeout: 5000 });
                if (diaRes.data?.Price) {
                  currentRealPrice = diaRes.data.Price.toString();
                  log(`DIA price for ${symbol}: ${currentRealPrice}`, "express");
                }
              } catch (e: any) {
                log(`DIA fallback failed: ${e.message}`, "express");
              }
            }

            // 4. Binance
            if (currentRealPrice === "0") {
              try {
                const binanceRes = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbolClean}`, { 
                  timeout: 5000,
                  headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                if (binanceRes.data?.price) {
                  currentRealPrice = binanceRes.data.price;
                  log(`Binance price for ${symbol}: ${currentRealPrice}`, "express");
                }
              } catch (e: any) {
                log(`Binance fallback failed: ${e.message}`, "express");
              }
            }

            // 3. CoinDesk (Mainly BTC)
            if (currentRealPrice === "0" && coinId === "btc") {
              try {
                const cdRes = await axios.get('https://api.coindesk.com/v1/bpi/currentprice/BTC.json', { timeout: 5000 });
                if (cdRes.data?.bpi?.USD?.rate_float) {
                  currentRealPrice = cdRes.data.bpi.USD.rate_float.toString();
                  log(`CoinDesk BTC price: ${currentRealPrice}`, "express");
                }
              } catch (e: any) {
                log(`CoinDesk fallback failed: ${e.message}`, "express");
              }
            }

            if (currentRealPrice !== "0") {
              priceContext = `CURRENT REAL-TIME PRICE: ${currentRealPrice} USD. `;
            }
          } else if (marketType === "forex") {
            const pair = symbol.replace("/", "").toUpperCase();
            
            // 1. Yahoo Finance (via 1m interval)
            try {
              const forexRes = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${pair}=X?interval=1m&range=1d`, { 
                timeout: 5000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
              });
              const price = forexRes.data.chart.result[0].meta.regularMarketPrice;
              if (price) {
                currentRealPrice = price.toString();
                log(`Yahoo Finance price for ${symbol}: ${currentRealPrice}`, "express");
              }
            } catch (fe: any) {
              log(`Yahoo Finance failed: ${fe.message}`, "express");
            }

            // 2. ExchangeRate-API (General rates)
            if (currentRealPrice === "0") {
              try {
                const base = symbol.split('/')[0];
                const target = symbol.split('/')[1];
                const exRes = await axios.get(`https://open.er-api.com/v6/latest/${base}`, { timeout: 5000 });
                if (exRes.data?.rates?.[target]) {
                  currentRealPrice = exRes.data.rates[target].toString();
                  log(`ExchangeRate-API price for ${symbol}: ${currentRealPrice}`, "express");
                }
              } catch (e: any) {
                log(`ExchangeRate-API failed: ${e.message}`, "express");
              }
            }

            if (currentRealPrice !== "0") {
              priceContext = `CURRENT REAL-TIME PRICE: ${currentRealPrice}. `;
            }
          }
        } catch (pe) {
          log(`Major price fetching error for ${symbol}: ${pe}`, "express");
        }

        if (!openRouterClient) {
          log("AI client not initialized, attempting to re-initialize...", "express");
          await initAI();
          if (!openRouterClient) {
            log("AI client re-initialization failed, skipping analysis for " + symbol, "express");
            continue;
          }
        }
        const chosenSystemPrompt = mode === "setup" ? SETUP_PROMPT : (mode === "analyze" ? ANALYZE_PROMPT : INSTITUTIONAL_PROMPT);

        const userInstruction = mode === "setup"
          ? `${priceContext}Please IDENTIFY the best matching SETUP and provide the labeled sections described in the system prompt for ${symbol}. Use current price ${currentRealPrice} as reference.`
          : `${priceContext}LATEST MARKET DATA FOR ${symbol}: Analyze 4H, Daily, and Weekly timeframes for a PREMIUM INSTITUTIONAL SWING TRADE. Ignore noise and scalping opportunities. If no high-probability 1:3+ RR swing trade exists on the HTF, respond with "BIAS: NEUTRAL". ENTRY PRICE SHOULD ALIGN WITH ${currentRealPrice}.`;

          const response = await openRouterClient.chat.completions.create({
          model: "google/gemini-2.0-flash-001",
          max_completion_tokens: 1024,
          messages: [
            { role: "system", content: chosenSystemPrompt },
            { role: "user", content: userInstruction }
          ],
          extra_headers: {
            "HTTP-Referer": "https://replit.com",
            "X-Title": "Solana SMC Bot",
          }
        } as any);

      // Debug: log a trimmed version of the raw AI response for troubleshooting
      try {
        log(`AI raw response (truncated): ${JSON.stringify(response).slice(0,4000)}`, "express");
      } catch (e) {
        // ignore stringify errors
      }

      // Robust extraction of AI text from various response shapes
      const analysis = (
        response?.choices?.[0]?.message?.content ||
        response?.choices?.[0]?.text ||
        response?.output?.[0]?.content?.[0]?.text ||
        (typeof response === 'string' ? response : undefined) ||
        ""
      ).toString();

      log(`AI analysis excerpt: ${analysis.slice(0,1000)}`, "express");

      let bias: "bullish" | "bearish" | "neutral" = "neutral";
      try {
        if (analysis.match(/\bBullish\b/i)) bias = "bullish";
        else if (analysis.match(/\bBearish\b/i)) bias = "bearish";
      } catch (e) {
        // ignore
      }

      // If this scan was forced by a user (forceChatId provided), always post the AI analysis back to the requester
        if (forceChatId) {
      try {
        const header = mode === 'setup'
          ? `🧭 <b>Setup Result: ${symbol}</b>\n\n` // setup header emoji
          : `🔍 <b>Analysis Result: ${symbol}</b>\n\n`; // analyze header emoji
        // Prefer the running bot instance from telegram module to preserve polling/state
        let bot: any = null;
        try {
          const tg = await import("./telegram");
          bot = tg.getTelegramBot();
        } catch (e) {
          bot = null;
        }

        if (!bot) {
          const token = process.env.TELEGRAM_BOT_TOKEN;
          if (!token) throw new Error("No TELEGRAM_BOT_TOKEN available to post analysis");
          const tgModule = await import('node-telegram-bot-api');
          const TelegramBotClass = (tgModule && (tgModule.default || tgModule)) as any;
          bot = new TelegramBotClass(token, { polling: false });
        }

        log(`Posting forced analysis to chat ${forceChatId}`, "express");
        const res = await bot.sendMessage(forceChatId, header + (analysis || 'No analysis returned.'), {
          parse_mode: 'HTML',
          message_thread_id: forceTopicId ? parseInt(forceTopicId) : undefined
        });
        log(`Posted analysis to chat ${forceChatId}: ${res?.message_id || 'unknown message id'}`, "express");
      } catch (e: any) {
        log(`Failed to post forced analysis to chat ${forceChatId}: ${e?.message || e}`, "express");
      }
    }

      if (bias !== "neutral") {
        bestSignal = { symbol, analysis, bias };
        break;
      }

        
      } catch (e) {
        log(`Error analyzing ${symbol}: ${e}`);
      }
    }

    if (bestSignal) {
      const { symbol, analysis, bias } = bestSignal;
      
      // Parse detailed signal data for DB storage
      const entryMatch = analysis.match(/Signal Entry:\s*([\d.]+)/);
      const slMatch = analysis.match(/Stop Loss:\s*([\d.]+)/);
      const tp1Match = analysis.match(/TP 1:\s*([\d.]+)/);
      const tp2Match = analysis.match(/TP 2:\s*([\d.]+)/);
      const tp3Match = analysis.match(/TP 3:\s*([\d.]+)/);

      const [newSignal] = await db.insert(signalsTable).values({
        symbol,
        type: marketType,
        bias,
        reasoning: analysis,
        timeframe: "1H",
        status: "active",
        price: currentRealPrice !== "0" ? currentRealPrice : "0",
        entryPrice: entryMatch ? entryMatch[1] : (currentRealPrice !== "0" ? currentRealPrice : "0"),
        sl: slMatch ? slMatch[1] : "0",
        tp1: tp1Match ? tp1Match[1] : "0",
        tp2: tp2Match ? tp2Match[1] : "0",
        tp3: tp3Match ? tp3Match[1] : "0",
        nextUpdateAt: new Date(Date.now() + 30 * 60 * 1000)
      } as any).returning();

        // Post to any bound groups (groupBindings.lane stores lanes like low|med|high|cto)
        const bindings = await db.select().from(groupBindings);
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (token && bindings.length > 0) {
        const tgModule = await import('node-telegram-bot-api');
        const TelegramBotClass = (tgModule && (tgModule.default || tgModule)) as any;
        const bot = new TelegramBotClass(token, { polling: false });
        for (const b of bindings) {
          try {
            // If a binding specifies a market, only post when it matches the signal marketType
            if (b.market && b.market.toLowerCase() !== marketType.toLowerCase()) continue;
            const groupHeader = mode === 'setup'
              ? `🧭 <b>Institutional ${marketType.toUpperCase()} Setup</b>\n\nAsset: ${symbol}`
              : `🔔 <b>Institutional ${marketType.toUpperCase()} Analysis</b>\n\nAsset: ${symbol}`;
            await bot.sendMessage(b.groupId, `${groupHeader}\n\n${analysis}`, { 
              parse_mode: 'HTML', 
              message_thread_id: b.topicId ? parseInt(b.topicId) : undefined 
            });
          } catch (err: any) {
            log(`Failed to post to group ${b.groupId}: ${err?.message || err}`);
          }
        }
      }
    }
  } catch (error) {
    log(`SMC ${marketType} engine error: ${error}`);
  }
}

async function runMonitoringLoop() {
  const activeSignals = await db.select().from(signalsTable).where(eq(signalsTable.status, "active"));
  if (activeSignals.length === 0) return;

  for (const signal of activeSignals) {
    try {
      const now = new Date();
      if (signal.nextUpdateAt && now >= signal.nextUpdateAt) {
        // Monitor for TP/SL hits
        try {
          let currentPrice = 0;
          if (signal.type === "crypto") {
            const cgId = signal.symbol.split('/')[0].toLowerCase();
            const res = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`);
            currentPrice = res.data[cgId]?.usd || 0;
          } else {
            const symbolClean = signal.symbol.replace("/", "");
            const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbolClean}=X?interval=1m&range=1d`);
            currentPrice = res.data.chart.result[0].meta.regularMarketPrice || 0;
          }

          if (currentPrice > 0) {
            const entry = parseFloat(signal.entryPrice || "0");
            const sl = parseFloat(signal.sl || "0");
            const tp1 = parseFloat(signal.tp1 || "0");
            const tp2 = parseFloat(signal.tp2 || "0");
            const tp3 = parseFloat(signal.tp3 || "0");

            let statusUpdate = "";
            let pnl = 0;
            let forexPips = 0;
            
            if (entry > 0) {
              if (signal.type === "forex") {
                // For Forex, PnL is pips. Standard is 4 decimals, so 1 pip = 0.0001
                forexPips = signal.bias === "bullish" 
                  ? (currentPrice - entry) * 10000 
                  : (entry - currentPrice) * 10000;
              } else {
                pnl = signal.bias === "bullish" 
                  ? ((currentPrice - entry) / entry) * 100 
                  : ((entry - currentPrice) / entry) * 100;
              }
            }

            // Event-driven check: Pullback or Trend Change
            let eventAlert = "";
            const lastData = signal.data as any || {};
            const lastPrice = lastData.lastPrice ? parseFloat(lastData.lastPrice) : entry;
            
            if (lastPrice > 0) {
              const movePercent = Math.abs((currentPrice - lastPrice) / lastPrice) * 100;
              const isOpposite = (signal.bias === "bullish" && currentPrice < lastPrice) || (signal.bias === "bearish" && currentPrice > lastPrice);
              
              if (movePercent >= 0.5) { // 0.5% move or equivalent
                eventAlert = isOpposite ? "⚠️ <b>Pullback Detected</b>" : "🚀 <b>Strong Momentum</b>";
              }
            }

            if (signal.bias === "bullish") {
              if (currentPrice <= sl) statusUpdate = "SL HIT 🔴";
              else if (currentPrice >= tp3) statusUpdate = "TP3 HIT 🟢🟢🟢";
              else if (currentPrice >= tp2) statusUpdate = "TP2 HIT 🟢🟢";
              else if (currentPrice >= tp1) statusUpdate = "TP1 HIT 🟢";
            } else {
              if (currentPrice >= sl) statusUpdate = "SL HIT 🔴";
              else if (currentPrice <= tp3) statusUpdate = "TP3 HIT 🟢🟢🟢";
              else if (currentPrice <= tp2) statusUpdate = "TP2 HIT 🟢🟢";
              else if (currentPrice <= tp1) statusUpdate = "TP1 HIT 🟢";
            }

            // Enhanced Update with AI Insight (Interval or Event)
            const isInterval = (signal.nextUpdateAt && now >= signal.nextUpdateAt);
            if (isInterval || eventAlert || statusUpdate) {
              let aiInsight = "";
              if (openRouterClient) {
                try {
                  const response = await openRouterClient.chat.completions.create({
                    model: "google/gemini-2.0-flash-001",
                    max_completion_tokens: 512,
                    messages: [
                      { role: "system", content: `You are an institutional SMC analyst. Provide a brief update for ${signal.type === "forex" ? "Forex" : "Crypto"}.` },
                      { role: "user", content: `Signal: ${signal.symbol}, Bias: ${signal.bias}, Entry: ${entry}, Current: ${currentPrice}, ${signal.type === "forex" ? "Pips: " + forexPips.toFixed(1) : "PnL: " + pnl.toFixed(2) + "%"}. Event: ${eventAlert || "Routine update"}. Provide a 2-sentence update on trend and validity.` }
                    ],
                    extra_headers: {
                      "HTTP-Referer": "https://replit.com",
                      "X-Title": "Solana SMC Bot",
                    }
                  } as any);
                  aiInsight = response.choices[0]?.message?.content || "";
                } catch (e) {
                  log(`AI update failed for ${signal.symbol}: ${e}`);
                }
              }

              const token = process.env.TELEGRAM_BOT_TOKEN;
              if (token) {
                const bot = new TelegramBot(token, { polling: false });
                const bindings = await db.select().from(groupBindings).where(eq(groupBindings.lane, signal.type));
                for (const b of bindings) {
                  const metric = signal.type === "forex" 
                    ? `Running Pips: <b>${forexPips > 0 ? '+' : ''}${forexPips.toFixed(1)} Pips</b>`
                    : `Running PnL: <b>${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}%</b>`;

                  const message = `📊 <b>Signal Monitoring: ${signal.symbol}</b>\n\n` +
                    `Current Price: <b>${currentPrice}</b>\n` +
                    `${metric}\n` +
                    `Trend: <b>${signal.bias.toUpperCase()}</b>\n\n` +
                    (eventAlert ? `${eventAlert}\n` : "") +
                    (statusUpdate ? `📢 <b>Status: ${statusUpdate}</b>\n\n` : "") +
                    (aiInsight ? `🧠 <b>AI Insight:</b>\n<i>${aiInsight}</i>` : "");

                  await bot.sendMessage(b.groupId, message, { 
                    parse_mode: 'HTML',
                    message_thread_id: b.topicId ? parseInt(b.topicId) : undefined
                  });
                }
              }

              if (statusUpdate && statusUpdate.includes("HIT")) {
                await db.update(signalsTable).set({ status: "completed", lastUpdateAt: new Date() }).where(eq(signalsTable.id, signal.id));
              } else {
                // Update internal tracking data
                await db.update(signalsTable).set({
                  lastUpdateAt: now,
                  nextUpdateAt: new Date(now.getTime() + 30 * 60 * 1000),
                  data: { lastPrice: currentPrice.toString() }
                }).where(eq(signalsTable.id, signal.id));
              }
            }
          }
        } catch (monitorErr) {
          log(`Monitoring error for ${signal.symbol}: ${monitorErr}`);
        }

        await db.update(signalsTable).set({
          lastUpdateAt: now,
          nextUpdateAt: new Date(now.getTime() + 30 * 60 * 1000)
        }).where(eq(signalsTable.id, signal.id));
      }
    } catch (err) {}
  }
}
