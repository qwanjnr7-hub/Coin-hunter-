import { groupBindings, signals as signalsTable, users, wallets as walletsTable, trades as tradesTable, userLanes } from "@shared/schema";
import TelegramBot from 'node-telegram-bot-api';
import { storage } from './storage';
import { log } from "./index";
import { Keypair, Connection, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import axios from "axios";
import { eq, and } from "drizzle-orm";
import { db } from "./db";

import { JupiterService } from "./solana";
import TelegramBot from 'node-telegram-bot-api';

export let telegramBotInstance: TelegramBot | null = null;

export function getTelegramBot() {
  return telegramBotInstance;
}

export function setupTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log("TELEGRAM_BOT_TOKEN is missing. Bot will not start.", "telegram");
    return;
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const jupiter = new JupiterService(rpcUrl);

  log("Initializing Telegram bot...", "telegram");
  const bot = new TelegramBot(token, { polling: false }); // Disable polling on construction
  bot.stopPolling(); // Ensure it's stopped
  bot.startPolling({ restart: true }); // Start fresh

  telegramBotInstance = bot;

  bot.on('polling_error', (error: any) => {
    if (!error.message.includes('401 Unauthorized') && !error.message.includes('ETELEGRAM: 404 Not Found')) {
      log(`Telegram polling error: ${error.message}`, "telegram");
    }
  });

  const connection = new Connection(rpcUrl, "confirmed");

  const getJupiterQuote = async (userId: string, inputMint: string, outputMint: string, amount: string, slippageBps: number) => {
    return jupiter.getQuote(inputMint, outputMint, amount, slippageBps);
  };

  const ensureUser = async (msg: TelegramBot.Message) => {
    const id = msg.from?.id.toString();
    if (!id) return null;
    return await storage.upsertUser({
      id,
      username: msg.from?.username || null,
      firstName: msg.from?.first_name || null,
      isMainnet: true
    });
  };

  const executeBuy = async (userId: string, mint: string, amount: string, chatId: number) => {
    try {
      log(`Initiating buy for ${mint} (Amount: ${amount} SOL)`, "telegram");
      const user = await storage.getUser(userId);
      const activeWallet = await storage.getActiveWallet(userId);
      if (!activeWallet) throw new Error("No active wallet found.");
      
      const balance = await connection.getBalance(new PublicKey(activeWallet.publicKey));
      const lamports = Math.floor(parseFloat(amount) * 1e9);
      
      if (balance < lamports + 5000) throw new Error(`Insufficient balance.`);

      const slippage = user?.autoBuySlippage || 1500;
      const quote = await getJupiterQuote(userId, "So11111111111111111111111111111111111111112", mint, lamports.toString(), slippage);
      const userKeypair = Keypair.fromSecretKey(bs58.decode(activeWallet.privateKey));
      const txid = await jupiter.swap(userKeypair, quote, user?.mevProtection ?? true);
      
      await storage.createTrade({ 
        userId, 
        walletId: activeWallet.id, 
        mint, 
        amountIn: amount, 
        status: 'completed', 
        txHash: txid 
      });
      
      bot.sendMessage(chatId, `✅ <b>Buy Successful!</b>\n\nTX: <a href="https://solscan.io/tx/${txid}">${txid.slice(0,8)}...</a>`, { parse_mode: 'HTML' });
    } catch (e: any) {
      log(`Buy failed: ${e.message}`, "telegram");
      bot.sendMessage(chatId, `❌ <b>Buy Failed:</b> ${e.message}`, { parse_mode: 'HTML' });
    }
  };

  async function sendMainMenu(chatId: number, userId: string, messageId?: number) {
    const activeWallet = await storage.getActiveWallet(userId);
    const balance = activeWallet?.balance || "0.000";

    const header = `🚀 <b>Welcome to Coin Hunter Bot</b>\n\nThe most advanced Smart Money Concepts trading terminal on Solana.\n\n` +
                   `Wallet: <code>${activeWallet?.publicKey || ''}</code>\n` +
                   `Balance: <b>${balance} SOL</b>\n\n` +
                   `Quick Commands:\n` +
                   `• /buy [mint] [amount] - Manual Buy\n` +
                   `• /sell [mint] [percent] - Manual Sell\n` +
                   `• /settings - Configure Bot\n` +
                   `• /withdraw - Withdraw SOL\n` +
                   `• /history - View trade history`;

    const keyboard = [
      [{ text: "🔄 Refresh", callback_data: "menu_refresh" }],
      [{ text: "🛒 Buy", callback_data: "menu_buy" }, { text: "💰 Sell", callback_data: "menu_sell_list" }],
      [{ text: "💸 Withdraw", callback_data: "menu_withdraw" }, { text: "📜 History", callback_data: "menu_history" }],
      [{ text: "⚙️ Settings", callback_data: "menu_settings" }]
    ];
    if (messageId) {
      bot.editMessageText(header, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    } else {
      bot.sendMessage(chatId, header, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    }
  }

  bot.on('callback_query', async (query: any) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id.toString();
    const data = query.data;

    await ensureUser(query);

    if (data === "main_menu" || data === "menu_refresh") {
      await sendMainMenu(chatId, userId, query.message?.message_id);
    } else if (data === "menu_buy") {
      bot.sendMessage(chatId, "🛒 <b>Buy Token</b>\n\nPlease enter the token's contract address:", { parse_mode: 'HTML', reply_markup: { force_reply: true } });
    } else if (data === "menu_sell_list") {
      const trades = await storage.getTrades(userId);
      const activeTrades = trades.filter(t => t.status === 'completed');
      if (activeTrades.length === 0) {
        bot.answerCallbackQuery(query.id, { text: "No active positions found." });
        return;
      }
      const keyboard = activeTrades.slice(0, 10).map(t => [{ text: `Sell ${t.symbol || t.mint.slice(0, 8)}...`, callback_data: `trade_sell_custom_${t.mint}` }]);
      keyboard.push([{ text: "🔙 Back", callback_data: "main_menu" }]);
      bot.editMessageText("💰 <b>Your Positions</b>\nSelect a token to sell:", { chat_id: chatId, message_id: query.message?.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    } else if (data === "menu_withdraw") {
      bot.sendMessage(chatId, "💸 <b>Withdraw SOL</b>\n\nPlease enter the destination wallet address:", { parse_mode: 'HTML', reply_markup: { force_reply: true } });
    } else if (data === "menu_history") {
      const trades = await storage.getTrades(userId);
      if (trades.length === 0) {
        bot.answerCallbackQuery(query.id, { text: "No trade history found." });
        return;
      }
      const historyText = "📜 <b>Trade History</b>\n\n" + trades.slice(0, 10).map(t => 
        `• ${t.status === 'completed' ? '✅' : '❌'} ${t.mint.slice(0, 8)}... | ${t.amountIn} SOL | <a href="https://solscan.io/tx/${t.txHash}">${t.txHash?.slice(0, 4)}</a>`
      ).join('\n');
      bot.editMessageText(historyText, { chat_id: chatId, message_id: query.message?.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "main_menu" }]] } });
    } else if (data === "menu_settings") {
      const user = await storage.getUser(userId);
      const inline_keyboard = [
        [{ text: "🔑 Wallets", callback_data: "menu_wallets" }],
        [{ text: `Slippage: ${(user?.autoBuySlippage || 1500) / 100}%`, callback_data: "settings_slippage" }],
        [{ text: `TP: ${user?.tpPercent || '0'}%`, callback_data: "settings_tp" }, { text: `SL: ${user?.slPercent || '0'}%`, callback_data: "settings_sl" }],
        [{ text: `Fee: ${user?.priorityFeeAmount || '0.0015'} SOL`, callback_data: "settings_fee" }],
        [{ text: `Speed: ${user?.priorityFeeTier?.toUpperCase() || 'MEDIUM'}`, callback_data: "settings_speed" }],
        [{ text: `MEV Protect: ${user?.mevProtection ? 'ON ✅' : 'OFF ❌'}`, callback_data: "toggle_mev" }],
        [{ text: "📋 Auto-Buy Lanes", callback_data: "settings_lanes" }],
        [{ text: `Auto-Buy Master: ${user?.autoBuyEnabled ? 'ON ✅' : 'OFF ❌'}`, callback_data: "toggle_autobuy" }],
        [{ text: "🔙 Back", callback_data: "main_menu" }]
      ];
      bot.editMessageText("⚙️ <b>Settings</b>\n\n<i>⚠️ Disclaimer: Trading involves significant risk. MEV protection reduces front-running but doesn't guarantee profit. High slippage may result in poor execution prices.</i>", { chat_id: chatId, message_id: query.message?.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard } });
    } else if (data === "settings_tp") {
      bot.sendMessage(chatId, "🎯 <b>Set Take Profit (%)</b>\nEnter percentage (e.g. 50 for 50% profit):", { parse_mode: 'HTML', reply_markup: { force_reply: true } });
    } else if (data === "settings_sl") {
      bot.sendMessage(chatId, "🛑 <b>Set Stop Loss (%)</b>\nEnter percentage (e.g. 20 for 20% loss):", { parse_mode: 'HTML', reply_markup: { force_reply: true } });
    } else if (data === "settings_speed") {
      const inline_keyboard = [
        [{ text: "Low (0.0001 SOL)", callback_data: "speed_set_low" }],
        [{ text: "Medium (0.0015 SOL)", callback_data: "speed_set_medium" }],
        [{ text: "High (0.005 SOL)", callback_data: "speed_set_high" }],
        [{ text: "Turbo (0.01 SOL)", callback_data: "speed_set_turbo" }],
        [{ text: "🔙 Back", callback_data: "menu_settings" }]
      ];
      bot.editMessageText("⚡ <b>Select Transaction Speed</b>\nChoose a priority fee tier:", { chat_id: chatId, message_id: query.message?.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard } });
    } else if (data.startsWith("speed_set_")) {
      const tier = data.replace("speed_set_", "");
      const fees: Record<string, string> = { low: "0.0001", medium: "0.0015", high: "0.005", turbo: "0.01" };
      await storage.upsertUser({ id: userId, priorityFeeTier: tier, priorityFeeAmount: fees[tier] });
      bot.answerCallbackQuery(query.id, { text: `Speed set to ${tier.toUpperCase()}` });
      await sendMainMenu(chatId, userId, query.message?.message_id);
    } else if (data === "menu_wallets") {
      const wallets = await storage.getWallets(userId);
      const keyboard = wallets.map(w => [
        { text: `${w.isActive ? '✅ ' : ''}${w.label} (${w.publicKey.slice(0, 4)}...${w.publicKey.slice(-4)})`, callback_data: `wallet_select_${w.id}` }
      ]);
      keyboard.push([{ text: "➕ Import Wallet", callback_data: "wallet_import" }]);
      keyboard.push([{ text: "🔙 Back", callback_data: "menu_settings" }]);
      bot.editMessageText("🔑 <b>Your Wallets</b>\nSelect a wallet to set as active or import a new one:", { chat_id: chatId, message_id: query.message?.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    } else if (data === "wallet_import") {
      bot.sendMessage(chatId, "🔑 <b>Import Wallet</b>\n\nPlease enter your Solana Private Key (Base58 format):", { parse_mode: 'HTML', reply_markup: { force_reply: true } });
    } else if (data.startsWith("wallet_select_")) {
      const walletId = parseInt(data.replace("wallet_select_", ""));
      try {
        await storage.setActiveWallet(userId, walletId);
        bot.answerCallbackQuery(query.id, { text: "Active wallet updated!" });
        // Refresh wallet menu
        const wallets = await storage.getWallets(userId);
        const keyboard = wallets.map(w => [
          { text: `${w.isActive ? '✅ ' : ''}${w.label} (${w.publicKey.slice(0, 4)}...${w.publicKey.slice(-4)})`, callback_data: `wallet_select_${w.id}` }
        ]);
        keyboard.push([{ text: "➕ Import Wallet", callback_data: "wallet_import" }]);
        keyboard.push([{ text: "🔙 Back", callback_data: "menu_settings" }]);
        bot.editMessageReplyMarkup({ inline_keyboard: keyboard }, { chat_id: chatId, message_id: query.message?.message_id });
      } catch (e: any) {
        bot.answerCallbackQuery(query.id, { text: `Error: ${e.message}` });
      }
    } else if (data === "settings_lanes") {
      const lanes = ["low", "med", "high", "cto", "unfiltered"];
      const userLanesData = await storage.getUserLanes(userId);
      const inline_keyboard = lanes.map(lane => {
        const isEnabled = userLanesData.find(l => l.lane === lane)?.enabled;
        return [{ text: `${lane.toUpperCase()}: ${isEnabled ? 'ON ✅' : 'OFF ❌'}`, callback_data: `toggle_lane_${lane}` }];
      });
      inline_keyboard.push([{ text: "🔙 Back", callback_data: "menu_settings" }]);
      bot.editMessageText("📋 <b>Auto-Buy Lane Settings</b>\n\nToggle which lanes you want the bot to copy trades from:", { chat_id: chatId, message_id: query.message?.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard } });
    } else if (data === "toggle_autobuy") {
      const user = await storage.getUser(userId);
      if (user) {
        await storage.upsertUser({ id: userId, autoBuyEnabled: !user.autoBuyEnabled });
        bot.answerCallbackQuery(query.id, { text: `Auto-Buy ${!user.autoBuyEnabled ? 'Enabled' : 'Disabled'}` });
        // Refresh settings menu
        const updatedUser = await storage.getUser(userId);
        const inline_keyboard = [
          [{ text: `Slippage: ${(updatedUser?.autoBuySlippage || 1500) / 100}%`, callback_data: "settings_slippage" }],
          [{ text: `Fee: ${updatedUser?.priorityFeeAmount || '0.0015'} SOL`, callback_data: "settings_fee" }],
          [{ text: `MEV Protect: ${updatedUser?.mevProtection ? 'ON ✅' : 'OFF ❌'}`, callback_data: "toggle_mev" }],
          [{ text: "📋 Auto-Buy Lanes", callback_data: "settings_lanes" }],
          [{ text: `Auto-Buy Master: ${updatedUser?.autoBuyEnabled ? 'ON ✅' : 'OFF ❌'}`, callback_data: "toggle_autobuy" }],
          [{ text: "🔙 Back", callback_data: "main_menu" }]
        ];
        bot.editMessageReplyMarkup({ inline_keyboard }, { chat_id: chatId, message_id: query.message?.message_id });
      }
    } else if (data.startsWith("toggle_lane_")) {
      const lane = data.replace("toggle_lane_", "");
      const userLanesData = await storage.getUserLanes(userId);
      const isEnabled = userLanesData.find(l => l.lane === lane)?.enabled;
      await storage.upsertUserLane({ userId, lane, enabled: !isEnabled });
      bot.answerCallbackQuery(query.id, { text: `Toggled ${lane.toUpperCase()}` });
      // Refresh lane menu
      const updatedLanes = ["low", "med", "high", "cto", "unfiltered"];
      const updatedLanesData = await storage.getUserLanes(userId);
      const inline_keyboard = updatedLanes.map(l => {
        const en = updatedLanesData.find(ld => ld.lane === l)?.enabled;
        return [{ text: `${l.toUpperCase()}: ${en ? 'ON ✅' : 'OFF ❌'}`, callback_data: `toggle_lane_${l}` }];
      });
      inline_keyboard.push([{ text: "🔙 Back", callback_data: "menu_settings" }]);
      bot.editMessageReplyMarkup({ inline_keyboard }, { chat_id: chatId, message_id: query.message?.message_id });
    } else if (data === "toggle_mev") {
      const user = await storage.getUser(userId);
      if (user) {
        await storage.upsertUser({ id: userId, mevProtection: !user.mevProtection });
        bot.answerCallbackQuery(query.id, { text: "Toggled MEV Protection" });
        await sendMainMenu(chatId, userId, query.message?.message_id);
      }
    } else if (data === "settings_slippage") {
      bot.sendMessage(chatId, "🔢 <b>Set Slippage (%)</b>\nEnter new slippage (0-100):", { parse_mode: 'HTML', reply_markup: { force_reply: true } });
    } else if (data === "settings_fee") {
      bot.sendMessage(chatId, "⚡ <b>Set Priority Fee (SOL)</b>\nEnter new fee amount:", { parse_mode: 'HTML', reply_markup: { force_reply: true } });
    } else if (query.data.startsWith("buy_confirm_")) {
      const [, , mint, amount] = query.data.split("_");
      await executeBuy(userId, mint, amount, chatId);
    } else if (query.data.startsWith("trade_refresh_")) {
      const mint = query.data.split("_")[2];
      bot.answerCallbackQuery(query.id, { text: "Refreshing price data..." });
      // In a real implementation, you'd fetch the current price/PnL here and edit the message
      bot.sendMessage(chatId, `🔄 <b>Price Update for ${mint}</b>\n\nFetching latest data...`, { parse_mode: 'HTML' });
    } else if (query.data.startsWith("trade_sell_")) {
      // Handles trade_sell_{percent}_{mint}
      const parts = query.data.split("_");
      const percent = parseInt(parts[2]);
      const mint = parts.slice(3).join("_");
      if (!percent || !mint) {
        bot.answerCallbackQuery(query.id, { text: "Invalid sell parameters." });
      } else {
        bot.answerCallbackQuery(query.id, { text: `Selling ${percent}%...` });
        try {
          const user = await storage.getUser(userId);
          const activeWallet = await storage.getActiveWallet(userId);
          if (!activeWallet) throw new Error("No active wallet found.");

          // Find token accounts for this mint
          const ownerPk = new PublicKey(activeWallet.publicKey);
          const tokenAccounts = await connection.getTokenAccountsByOwner(ownerPk, { mint: new PublicKey(mint) });
          if (tokenAccounts.value.length === 0) throw new Error("No token account found for this mint.");

          const tokenAccountPubkey = tokenAccounts.value[0].pubkey;
          const bal = await connection.getTokenAccountBalance(tokenAccountPubkey);
          const total = parseFloat(bal.value.uiAmountString || "0");
          if (total <= 0) throw new Error("Token balance is zero.");

          const sellAmount = (total * (percent / 100));
          if (sellAmount <= 0) throw new Error("Computed sell amount is zero.");

          // Convert to raw amount using decimals
          const decimals = bal.value.decimals || 0;
          const rawAmount = Math.floor(sellAmount * Math.pow(10, decimals)).toString();

          const slippage = user?.autoBuySlippage || 1500;
          const quote = await jupiter.getQuote(mint, "So11111111111111111111111111111111111111112", rawAmount, slippage);
          const userKeypair = Keypair.fromSecretKey(bs58.decode(activeWallet.privateKey));
          const txid = await jupiter.swap(userKeypair, quote, user?.mevProtection ?? true, user?.priorityFeeAmount || "0.0015");

          await storage.createTrade({
            userId,
            walletId: activeWallet.id,
            mint,
            amountIn: sellAmount.toString(),
            status: 'completed',
            txHash: txid
          });

          bot.sendMessage(chatId, `✅ <b>Sell Executed</b>\n\n${percent}% of <code>${mint}</code> sold. TX: <a href=\"https://solscan.io/tx/${txid}\">${txid.slice(0,8)}...</a>`, { parse_mode: 'HTML' });
        } catch (e: any) {
          bot.sendMessage(chatId, `❌ <b>Sell Failed:</b> ${e.message}`, { parse_mode: 'HTML' });
        }
      }
    } else if (query.data.startsWith("trade_sell_custom_")) {
      const mint = query.data.split("_")[3];
      bot.sendMessage(chatId, `🛒 <b>Custom Sell: ${mint}</b>\n\nPlease enter the percentage to sell (1-100):`, { 
        parse_mode: 'HTML', 
        reply_markup: { force_reply: true } 
      });
    }
  });

  bot.on('message', async (msg: any) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.caption || msg.text;
    if (!text) return;

    if (msg.photo && text && (text.includes("/analyze") || text.includes("/setup"))) {
        const command = text.includes("/analyze") ? "analyze" : "setup";
        const intro = command === 'analyze'
          ? `📸 🔎 <b>Vision Analysis requested</b> — analyzing chart for institutional setups...`
          : `📸 🧭 <b>Setup identification requested</b> — extracting setup from your chart...`;
        bot.sendMessage(chatId, intro, { parse_mode: 'HTML' });

        // Best-effort: try to OCR the screenshot and extract a trading pair, then pass it to the scanner.
        try {
          const photos = msg.photo as any[];
          const file = photos[photos.length - 1];
          const fileInfo = await bot.getFile(file.file_id);
          const filePath = fileInfo.file_path;
          const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;

          const ai = await import("./ai");
          const extracted = await ai.extractPairFromImage(fileUrl);

          const worker = await import("./signals-worker");
          if (extracted) {
            bot.sendMessage(chatId, `✅ Detected pair: <b>${extracted}</b>. Running ${command}...`, { parse_mode: 'HTML' });
            await worker.runScanner("crypto", true, chatId.toString(), msg.message_thread_id?.toString(), extracted, command as any);
          } else {
            bot.sendMessage(chatId, `ℹ️ No explicit pair detected in the image. Running ${command} on monitored markets...`, { parse_mode: 'HTML' });
            await worker.runScanner("crypto", true, chatId.toString(), msg.message_thread_id?.toString(), undefined, command as any);
          }
        } catch (e) {
          const worker = await import("./signals-worker");
          bot.sendMessage(chatId, `⚠️ Could not extract pair from image. Running ${command} on monitored markets...`, { parse_mode: 'HTML' });
          await worker.runScanner("crypto", true, chatId.toString(), msg.message_thread_id?.toString(), undefined, command as any);
        }
        return;
    }

    // Check for auto-buy calls from bound groups
    const binding = await storage.getGroupBinding(chatId.toString());
    if (binding) {
      const mintMatch = text.match(/[a-zA-Z0-9]{32,44}/); // Basic Solana CA regex
      if (mintMatch) {
        const mint = mintMatch[0];
        log(`Detected mint ${mint} in bound group ${chatId} lane ${binding.lane}`, "telegram");
        
        // Find users who have this lane enabled for auto-buy
        const usersToNotify = await db.select()
          .from(users)
          .innerJoin(userLanes, eq(users.id, userLanes.userId))
          .where(and(
            eq(userLanes.lane, binding.lane),
            eq(userLanes.enabled, true),
            eq(users.autoBuyEnabled, true)
          ));

        for (const { users: user } of usersToNotify) {
          try {
            const activeWallet = await storage.getActiveWallet(user.id);
            if (!activeWallet) continue;

            // Duplicate protection
            const existingTrade = await db.select().from(tradesTable).where(and(
              eq(tradesTable.userId, user.id),
              eq(tradesTable.mint, mint)
            )).limit(1);

            if (existingTrade.length > 0) {
              log(`Skipping auto-buy for user ${user.id} - already traded ${mint}`, "telegram");
              continue;
            }

            // Execute Auto-Buy
            const amount = user.autoBuyAmount || "0.01";
            const lamports = Math.floor(parseFloat(amount) * 1e9);
            const balance = await connection.getBalance(new PublicKey(activeWallet.publicKey));
            
            if (balance < lamports + 5000) {
              bot.sendMessage(user.id, `⚠️ <b>Auto-Buy Skipped:</b> Insufficient balance for ${mint}`, { parse_mode: 'HTML' });
              continue;
            }

            // Execute swap with fallback and retry logic
            let txid: string | null = null;
            let retryCount = 0;
            const maxRetries = 3;

            while (retryCount < maxRetries && !txid) {
              try {
                const slippage = user.autoBuySlippage || 1500;
                // Fetch fresh quote before each attempt to ensure validity
                const quote = await jupiter.getQuote("So11111111111111111111111111111111111111112", mint, lamports.toString(), slippage);
                const userKeypair = Keypair.fromSecretKey(bs58.decode(activeWallet.privateKey));
                txid = await jupiter.swap(userKeypair, quote, user.mevProtection, user.priorityFeeAmount || "0.0015");
              } catch (err: any) {
                retryCount++;
                log(`Swap attempt ${retryCount} failed for user ${user.id}: ${err.message}`, "telegram");
                if (retryCount < maxRetries) {
                  await new Promise(res => setTimeout(res, 1000 * retryCount)); // Exponential backoff
                }
              }
            }

            if (!txid) {
              bot.sendMessage(user.id, `❌ <b>Auto-Buy Failed:</b> Could not execute swap for ${mint} after ${maxRetries} attempts.`, { parse_mode: 'HTML' });
              continue;
            }
            
            await storage.createTrade({ 
              userId: user.id, 
              walletId: activeWallet.id, 
              mint, 
              amountIn: amount, 
              status: 'completed', 
              txHash: txid 
            });

            const confirmMsg = `🤖 <b>Auto-Buy Executed!</b>\n\n` +
                             `Token: <code>${mint}</code>\n` +
                             `Amount: <b>${amount} SOL</b>\n\n` +
                             `TX: <a href="https://solscan.io/tx/${txid}">${txid.slice(0,8)}...</a>`;
            
            const keyboard = [
              [
                { text: "🔄 Refresh", callback_data: `trade_refresh_${mint}` },
                { text: "🛒 Sell 100%", callback_data: `trade_sell_100_${mint}` }
              ],
              [
                { text: "📉 Sell 50%", callback_data: `trade_sell_50_${mint}` },
                { text: "📈 Sell 25%", callback_data: `trade_sell_25_${mint}` }
              ],
              [
                { text: "✏️ Custom Sell", callback_data: `trade_sell_custom_${mint}` }
              ]
            ];

            bot.sendMessage(user.id, confirmMsg, { 
              parse_mode: 'HTML', 
              reply_markup: { inline_keyboard: keyboard } 
            });
          } catch (err: any) {
            log(`Auto-buy failed for user ${user.id}: ${err.message}`, "telegram");
          }
        }
      }
    }

    if (msg.reply_to_message?.text?.includes("Set Take Profit")) {
      const tp = parseInt(text.trim());
      if (!isNaN(tp)) {
        await storage.upsertUser({ id: userId, tpPercent: tp });
        bot.sendMessage(chatId, `✅ Take Profit set to ${tp}%`);
      }
    } else if (msg.reply_to_message?.text?.includes("Set Stop Loss")) {
      const sl = parseInt(text.trim());
      if (!isNaN(sl)) {
        await storage.upsertUser({ id: userId, slPercent: sl });
        bot.sendMessage(chatId, `✅ Stop Loss set to ${sl}%`);
      }
    } else if (msg.reply_to_message?.text?.includes("enter your Solana Private Key")) {
      const privateKey = text.trim();
      try {
        const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
        const publicKey = keypair.publicKey.toBase58();
        
        await storage.createWallet({
          userId,
          publicKey,
          privateKey,
          label: `Imported Wallet`,
          isMainnet: true,
          isActive: false,
          balance: "0"
        });
        
        bot.sendMessage(chatId, `✅ <b>Wallet Imported Successfully!</b>\n\nAddress: <code>${publicKey}</code>`, { parse_mode: 'HTML' });
        return;
      } catch (e: any) {
        bot.sendMessage(chatId, `❌ <b>Import Failed:</b> ${e.message}`, { parse_mode: 'HTML' });
        return;
      }
    }

    if (msg.reply_to_message?.text?.includes("Enter new slippage")) {
      const slippage = parseFloat(text.trim());
      if (!isNaN(slippage)) {
        await storage.upsertUser({ id: userId, autoBuySlippage: Math.floor(slippage * 100) });
        bot.sendMessage(chatId, `✅ Slippage set to ${slippage}%`);
      }
    } else if (msg.reply_to_message?.text?.includes("Enter new fee amount")) {
      const fee = parseFloat(text.trim());
      if (!isNaN(fee)) {
        await storage.upsertUser({ id: userId, priorityFeeAmount: fee.toString() });
        bot.sendMessage(chatId, `✅ Priority fee set to ${fee} SOL`);
      }
    } else if (msg.reply_to_message?.text?.includes("enter the token's contract address")) {
      const mint = text.trim();
      bot.sendMessage(chatId, `✅ Token: <code>${mint}</code>\n\nEnter SOL amount to spend:`, { parse_mode: 'HTML', reply_markup: { force_reply: true } });
    } else if (msg.reply_to_message?.text?.includes("Enter SOL amount to spend")) {
      const amount = text.trim();
      const mintMatch = msg.reply_to_message.text.match(/Token: (.+)/);
      if (mintMatch) {
        bot.sendMessage(chatId, `⚠️ <b>Confirm Buy</b>\n\nToken: <code>${mintMatch[1]}</code>\nAmount: <b>${amount} SOL</b>`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: "✅ Confirm", callback_data: `buy_confirm_${mintMatch[1]}_${amount}` }]] }
        });
      }
    } else if (msg.reply_to_message?.text?.includes("destination wallet address")) {
      const destAddress = text.trim();
      try {
        new PublicKey(destAddress);
        bot.sendMessage(chatId, `💸 <b>Withdraw SOL</b>\n\nDest: <code>${destAddress}</code>\n\nEnter amount to withdraw (SOL):`, { parse_mode: 'HTML', reply_markup: { force_reply: true } });
      } catch (e) {
        bot.sendMessage(chatId, "❌ Invalid Solana address.");
      }
    } else if (msg.reply_to_message?.text?.includes("Enter amount to withdraw")) {
      const amount = text.trim();
      const destMatch = msg.reply_to_message.text.match(/Dest: (.+)/);
      if (destMatch) {
        const dest = destMatch[1];
        try {
          const activeWallet = await storage.getActiveWallet(userId);
          if (!activeWallet) throw new Error("No wallet found.");
          const lamports = Math.floor(parseFloat(amount) * 1e9);
          const balance = await connection.getBalance(new PublicKey(activeWallet.publicKey));
          if (balance < lamports + 5000) throw new Error("Insufficient balance.");

          const transaction = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: new PublicKey(activeWallet.publicKey),
              toPubkey: new PublicKey(dest),
              lamports: BigInt(lamports),
            })
          );
          const userKeypair = Keypair.fromSecretKey(bs58.decode(activeWallet.privateKey));
          const signature = await connection.sendTransaction(transaction, [userKeypair]);
          bot.sendMessage(chatId, `✅ <b>Withdrawal Sent!</b>\n\nTX: <a href="https://solscan.io/tx/${signature}">${signature.slice(0,8)}...</a>`, { parse_mode: 'HTML' });
        } catch (e: any) {
          bot.sendMessage(chatId, `❌ <b>Withdrawal Failed:</b> ${e.message}`, { parse_mode: 'HTML' });
        }
      }
    } else if (msg.reply_to_message?.text?.includes("percentage to sell")) {
      const percent = parseInt(text.trim());
      const mintMatch = msg.reply_to_message.text.match(/Custom Sell: (.+)/);
      if (mintMatch && !isNaN(percent)) {
        const mint = mintMatch[1];
        bot.sendMessage(chatId, `⏳ <b>Executing Sell:</b> ${percent}% of <code>${mint}</code>...`, { parse_mode: 'HTML' });
        
        try {
          const user = await storage.getUser(userId);
          const activeWallet = await storage.getActiveWallet(userId);
          if (!activeWallet) throw new Error("No active wallet found.");

          // Find token accounts for this mint
          const ownerPk = new PublicKey(activeWallet.publicKey);
          const tokenAccounts = await connection.getTokenAccountsByOwner(ownerPk, { mint: new PublicKey(mint) });
          if (tokenAccounts.value.length === 0) throw new Error("No token account found for this mint.");

          const tokenAccountPubkey = tokenAccounts.value[0].pubkey;
          const bal = await connection.getTokenAccountBalance(tokenAccountPubkey);
          const total = parseFloat(bal.value.uiAmountString || "0");
          if (total <= 0) throw new Error("Token balance is zero.");

          const sellAmount = (total * (percent / 100));
          if (sellAmount <= 0) throw new Error("Computed sell amount is zero.");

          // Convert to raw amount using decimals
          const decimals = bal.value.decimals || 0;
          const rawAmount = Math.floor(sellAmount * Math.pow(10, decimals)).toString();

          const slippage = user?.autoBuySlippage || 1500;
          const quote = await jupiter.getQuote(mint, "So11111111111111111111111111111111111111112", rawAmount, slippage);
          const userKeypair = Keypair.fromSecretKey(bs58.decode(activeWallet.privateKey));
          const txid = await jupiter.swap(userKeypair, quote, user?.mevProtection ?? true, user?.priorityFeeAmount || "0.0015");

          await storage.createTrade({ 
            userId, 
            walletId: activeWallet.id, 
            mint, 
            amountIn: sellAmount.toString(), 
            status: 'completed', 
            txHash: txid 
          });

          bot.sendMessage(chatId, `✅ <b>Sell Executed</b>\n\n${percent}% of <code>${mint}</code> sold. TX: <a href=\"https://solscan.io/tx/${txid}\">${txid.slice(0,8)}...</a>`, { parse_mode: 'HTML' });
        } catch (e: any) {
          bot.sendMessage(chatId, `❌ <b>Sell Failed:</b> ${e.message}`, { parse_mode: 'HTML' });
        }
      }
    }
  });

  bot.onText(/\/withdraw/, async (msg) => {
    bot.sendMessage(msg.chat.id, "💸 <b>Withdraw SOL</b>\n\nPlease enter the destination wallet address:", { parse_mode: 'HTML', reply_markup: { force_reply: true } });
  });

  bot.onText(/\/history/, async (msg) => {
    const userId = msg.from?.id.toString();
    if (!userId) return;
    const trades = await storage.getTrades(userId);
    if (trades.length === 0) {
      bot.sendMessage(msg.chat.id, "No trade history found.");
      return;
    }
    const historyText = "📜 <b>Trade History</b>\n\n" + trades.slice(0, 10).map(t => 
      `• ${t.status === 'completed' ? '✅' : '❌'} ${t.mint.slice(0, 8)}... | ${t.amountIn} SOL | <a href="https://solscan.io/tx/${t.txHash}">${t.txHash?.slice(0, 4)}</a>`
    ).join('\n');
    bot.sendMessage(msg.chat.id, historyText, { parse_mode: 'HTML' });
  });

  bot.onText(/\/sell\s+([a-zA-Z0-9]{32,44})\s+(\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const mint = match?.[1];
    const percent = match?.[2];
    if (mint && percent) {
      bot.sendMessage(chatId, `⏳ Executing sell for ${percent}% of ${mint}...`);
      try {
        const userId = msg.from?.id.toString();
        if (!userId) throw new Error('User not found');
        const user = await storage.getUser(userId);
        const activeWallet = await storage.getActiveWallet(userId);
        if (!activeWallet) throw new Error("No active wallet found.");

        const ownerPk = new PublicKey(activeWallet.publicKey);
        const tokenAccounts = await connection.getTokenAccountsByOwner(ownerPk, { mint: new PublicKey(mint) });
        if (tokenAccounts.value.length === 0) throw new Error("No token account found for this mint.");

        const tokenAccountPubkey = tokenAccounts.value[0].pubkey;
        const bal = await connection.getTokenAccountBalance(tokenAccountPubkey);
        const total = parseFloat(bal.value.uiAmountString || "0");
        if (total <= 0) throw new Error("Token balance is zero.");

        const pct = parseInt(percent);
        const sellAmount = (total * (pct / 100));
        const decimals = bal.value.decimals || 0;
        const rawAmount = Math.floor(sellAmount * Math.pow(10, decimals)).toString();

        const slippage = user?.autoBuySlippage || 1500;
        const quote = await jupiter.getQuote(mint, "So11111111111111111111111111111111111111112", rawAmount, slippage);
        const userKeypair = Keypair.fromSecretKey(bs58.decode(activeWallet.privateKey));
        const txid = await jupiter.swap(userKeypair, quote, user?.mevProtection ?? true, user?.priorityFeeAmount || "0.0015");

        await storage.createTrade({
          userId,
          walletId: activeWallet.id,
          mint,
          amountIn: sellAmount.toString(),
          status: 'completed',
          txHash: txid
        });

        bot.sendMessage(chatId, `✅ <b>Sell Executed</b>\n\n${percent}% of <code>${mint}</code> sold. TX: <a href=\"https://solscan.io/tx/${txid}\">${txid.slice(0,8)}...</a>`, { parse_mode: 'HTML' });
      } catch (e: any) {
        bot.sendMessage(chatId, `❌ <b>Sell Failed:</b> ${e.message}`, { parse_mode: 'HTML' });
      }
    }
  });

  bot.onText(/\/bind(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id.toString();
    const raw = match?.[1];

    if (!userId) return;

    // Parse flexible bind syntax:
    // /bind <lane> [market]
    // /bind <market>
    // Examples: /bind low crypto  OR  /bind crypto  OR  /bind med forex
    let lane: string | null = null;
    let market: string | null = null;
    if (raw) {
      const parts = raw.trim().split(/\s+/);
      const p0 = parts[0].toLowerCase();
      const p1 = parts[1]?.toLowerCase();
      const lanes = ['low','med','high','cto','unfiltered'];
      const markets = ['crypto','forex'];

      if (lanes.includes(p0)) {
        lane = p0;
        if (p1 && markets.includes(p1)) market = p1;
      } else if (markets.includes(p0)) {
        lane = 'unfiltered';
        market = p0;
      } else {
        // invalid usage
        return bot.sendMessage(chatId, 'Usage: /bind <low|med|high|cto|unfiltered> [crypto|forex]\nOr: /bind <crypto|forex> to bind topic for that market');
      }
    } else {
      return bot.sendMessage(chatId, 'Usage: /bind <low|med|high|cto|unfiltered> [crypto|forex]\nOr: /bind <crypto|forex> to bind topic for that market');
    }

    try {
      await storage.upsertGroupBinding({
        groupId: chatId.toString(),
        lane: lane!,
        topicId: msg.message_thread_id?.toString() || null,
        market: market || null
      });
      const marketNote = market ? ` for <b>${market.toUpperCase()}</b>` : '';
      bot.sendMessage(chatId, `✅ <b>Success!</b> This ${msg.message_thread_id ? 'topic' : 'group'} is now bound to the <b>${lane.toUpperCase()}</b> lane${marketNote}.`, { 
        parse_mode: 'HTML',
        reply_to_message_id: msg.message_id
      });
      log(`Admin bound ${chatId}${msg.message_thread_id ? ':' + msg.message_thread_id : ''} to ${lane} lane${market ? ' market='+market : ''}`, "telegram");
    } catch (err: any) {
      bot.sendMessage(chatId, `❌ <b>Binding Failed:</b> ${err.message}`, { parse_mode: 'HTML' });
    }
  });

  // Set a purpose/description for this group/topic
  bot.onText(/\/setpurpose\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const text = match?.[1]?.trim();
    const topicId = msg.message_thread_id?.toString() || undefined;
    if (!text) return bot.sendMessage(chatId, 'Usage: /setpurpose <short description> (run in the topic to set topic purpose)');

    try {
      const existing = await storage.getGroupBinding(chatId.toString(), topicId);
      const lane = existing?.lane || 'unfiltered';
      const market = existing?.market || null;
      await storage.upsertGroupBinding({
        groupId: chatId.toString(),
        topicId: topicId || null,
        lane,
        market,
        purpose: text
      });
      bot.sendMessage(chatId, `✅ Purpose saved for this ${topicId ? 'topic' : 'group'}:\n<i>${text}</i>`, { parse_mode: 'HTML' });
    } catch (e: any) {
      bot.sendMessage(chatId, `❌ Failed to save purpose: ${e.message}`);
    }
  });

  // Admin helper: force a bound-lane auto-buy flow for testing
  bot.onText(/\/forcebound\s+(low|med|high|cto|unfiltered)\s+([a-zA-Z0-9]{32,44})/, async (msg, match) => {
    const chatId = msg.chat.id;
    const callerId = msg.from?.id?.toString();
    const lane = match?.[1];
    const mint = match?.[2];

    const admins = (process.env.ADMIN_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (admins.length > 0 && (!callerId || !admins.includes(callerId))) {
      return bot.sendMessage(chatId, "❌ You are not authorized to run this command.");
    }

    if (!lane || !mint) return bot.sendMessage(chatId, "Usage: /forcebound <lane> <mint>");

    bot.sendMessage(chatId, `🚀 Forcing auto-buy flow for lane <b>${lane.toUpperCase()}</b> and mint <code>${mint}</code>...`, { parse_mode: 'HTML' });

    try {
      const usersToNotify = await db.select()
        .from(users)
        .innerJoin(userLanes, eq(users.id, userLanes.userId))
        .where(and(
          eq(userLanes.lane, lane),
          eq(userLanes.enabled, true),
          eq(users.autoBuyEnabled, true)
        ));

      let executed = 0;
      for (const { users: user } of usersToNotify) {
        try {
          const activeWallet = await storage.getActiveWallet(user.id);
          if (!activeWallet) continue;

          // Duplicate protection (same as in message handler)
          const existingTrade = await db.select().from(tradesTable).where(and(
            eq(tradesTable.userId, user.id),
            eq(tradesTable.mint, mint)
          )).limit(1);
          if (existingTrade.length > 0) continue;

          const amount = user.autoBuyAmount || "0.01";
          const lamports = Math.floor(parseFloat(amount) * 1e9);
          const balance = await connection.getBalance(new PublicKey(activeWallet.publicKey));
          if (balance < lamports + 5000) continue;

          let txid: string | null = null;
          let retryCount = 0;
          const maxRetries = 3;
          while (retryCount < maxRetries && !txid) {
            try {
              const slippage = user.autoBuySlippage || 1500;
              const quote = await jupiter.getQuote("So11111111111111111111111111111111111111112", mint, lamports.toString(), slippage);
              const userKeypair = Keypair.fromSecretKey(bs58.decode(activeWallet.privateKey));
              txid = await jupiter.swap(userKeypair, quote, user.mevProtection, user.priorityFeeAmount || "0.0015");
            } catch (err: any) {
              retryCount++;
              if (retryCount < maxRetries) await new Promise(res => setTimeout(res, 1000 * retryCount));
            }
          }

          if (!txid) continue;

          await storage.createTrade({
            userId: user.id,
            walletId: activeWallet.id,
            mint,
            amountIn: amount,
            status: 'completed',
            txHash: txid
          });

          executed++;
        } catch (e) {
          // ignore per-user errors
        }
      }

      bot.sendMessage(chatId, `✅ Forced auto-buy attempted for ${executed} user(s) in lane ${lane.toUpperCase()}.`);
    } catch (err: any) {
      bot.sendMessage(chatId, `❌ Failed to force bound flow: ${err.message}`);
    }
  });

  // Status command - show quick health info
  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const callerId = msg.from?.id?.toString();
      const sigs = await storage.getSignals();
      const bindings = await db.select().from(groupBindings);
      const usersCount = await db.select().from(users);
      const envOk = {
        DATABASE_URL: !!process.env.DATABASE_URL,
        TELEGRAM_BOT_TOKEN: !!process.env.TELEGRAM_BOT_TOKEN,
        AI_KEY: !!(process.env.OPENROUTER_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY)
      };

      const admins = (process.env.ADMIN_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

      let msgText = `🩺 <b>Bot Status</b>\n\n` +
        `• Signals stored: <b>${sigs.length}</b>\n` +
        `• Bound groups: <b>${bindings.length}</b>\n` +
        `• Known users: <b>${usersCount.length}</b>\n\n` +
        `🔧 Env:\n` +
        `• DATABASE_URL: ${envOk.DATABASE_URL ? '✅' : '❌'}\n` +
        `• TELEGRAM_BOT_TOKEN: ${envOk.TELEGRAM_BOT_TOKEN ? '✅' : '❌'}\n` +
        `• AI Key: ${envOk.AI_KEY ? '✅' : '❌'}\n`;

      // If caller is admin, include detailed bound-group list with chat titles and topic ids
      if (callerId && admins.includes(callerId)) {
        if (bindings.length > 0) {
          msgText += `\n📎 <b>Bound Groups / Topics</b>:\n`;
          for (const b of bindings) {
            try {
              const chatInfo = await bot.getChat(b.groupId as any);
              let displayName = chatInfo.title || `${chatInfo.first_name || ''} ${chatInfo.last_name || ''}`.trim() || chatInfo.username || b.groupId;
              msgText += `• <b>${displayName}</b> (<code>${b.groupId}</code>)`;
              if (b.topicId) msgText += ` — Topic: <code>${b.topicId}</code>`;
              msgText += ` — Lane: <b>${b.lane.toUpperCase()}</b>`;
              if (b.purpose) msgText += ` — Purpose: <i>${b.purpose}</i>`;
              msgText += `\n`;
            } catch (e) {
              // Fallback to raw data if getChat fails
              msgText += `• <code>${b.groupId}</code>`;
              if (b.topicId) msgText += ` — Topic: <code>${b.topicId}</code>`;
              msgText += ` — Lane: <b>${b.lane.toUpperCase()}</b>\n`;
            }
          }
        } else {
          msgText += `\n📎 No bound groups found.\n`;
        }
      }

      bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
    } catch (e: any) {
      bot.sendMessage(chatId, `❌ Could not retrieve status: ${e.message}`);
    }
  });

  // Price command - fetch current price for a pair
  bot.onText(/\/price(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match?.[1];
    if (!input) return bot.sendMessage(chatId, 'Usage: /price BTC/USDT or /price BTC');

    const pair = input.trim().toUpperCase();
    try {
      // Try CoinGecko by coin id (assume symbol is coin id for common coins)
      const coin = pair.split('/')[0].toLowerCase();
      let price: string | null = null;
      try {
        const cg = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coin}&vs_currencies=usd`);
        if (cg.data && cg.data[coin] && cg.data[coin].usd) price = cg.data[coin].usd.toString();
      } catch (e) {}

      // Fallback to Binance symbol
      if (!price) {
        const sym = pair.replace('/', '');
        try {
          const b = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
          if (b.data?.price) price = b.data.price;
        } catch (e) {}
      }

      if (!price) return bot.sendMessage(chatId, `❌ Could not fetch price for ${pair}`);
      bot.sendMessage(chatId, `💱 <b>Price for ${pair}</b>\n\nCurrent: <b>${price} USD</b>`, { parse_mode: 'HTML' });
    } catch (e: any) {
      bot.sendMessage(chatId, `❌ Price lookup failed: ${e.message}`);
    }
  });

  // More tolerant bind helper (also accepts `bind <lane>`) - confirm binding
  bot.onText(/\/bind(?:\s+(low|med|high|cto|unfiltered))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const lane = match?.[1];
    if (!lane) return bot.sendMessage(chatId, 'Usage: /bind <low|med|high|cto|unfiltered> — binds this group/topic to an auto-buy lane');
    try {
      await storage.upsertGroupBinding({ groupId: chatId.toString(), lane, topicId: msg.message_thread_id?.toString() || null });
      bot.sendMessage(chatId, `✅ Bound this ${msg.message_thread_id ? 'topic' : 'group'} to lane <b>${lane.toUpperCase()}</b>`, { parse_mode: 'HTML' });
      log(`Admin bound ${chatId}${msg.message_thread_id ? ':' + msg.message_thread_id : ''} to ${lane} lane`, "telegram");
    } catch (e: any) {
      bot.sendMessage(chatId, `❌ Bind failed: ${e.message}`);
    }
  });

  bot.onText(/\/unbind/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await db.delete(groupBindings).where(eq(groupBindings.groupId, chatId.toString()));
      bot.sendMessage(chatId, `✅ <b>Success!</b> All bindings for this group have been removed.`, { parse_mode: 'HTML' });
    } catch (err: any) {
      bot.sendMessage(chatId, `❌ <b>Unbinding Failed:</b> ${err.message}`, { parse_mode: 'HTML' });
    }
  });

  bot.onText(/\/(setup|analyze)(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id.toString();
    const command = match?.[1];
    const pair = match?.[2]?.toUpperCase();

    if (!userId) return;

    if (!pair && !msg.photo) {
      if (command === "setup") {
        await ensureUser(msg);
        const activeWallet = await storage.getActiveWallet(userId);
        const message = `⚙️ <b>Bot Setup</b>\n\n` +
                       `Status: 🟢 Connected\n` +
                       `Wallet: <code>${activeWallet?.publicKey || 'None'}</code>\n\n` +
                       `Use /settings to configure auto-buy and risk lanes. Or use <code>/setup [pair]</code> for market analysis.`;
        return bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      } else {
        return bot.sendMessage(chatId, "🔍 <b>Institutional Market Scan</b>\n\nUse <code>/analyze [pair]</code> or send a screenshot with /analyze to scan a specific asset.", { parse_mode: 'HTML' });
      }
    }

    bot.sendMessage(chatId, `🔍 <b>Processing ${command?.toUpperCase()} for ${pair || 'Screenshot'}...</b>\n\nPlease wait while our AI analyzes current price action for premium swing setups.`, { parse_mode: 'HTML' });

    // Normalize pair (e.g. BTCUSDT -> BTC/USDT) and determine market type
    import("./signals-worker").then(async (worker) => {
      let normalizedPair = pair;
      if (pair && !pair.includes("/")) {
        const up = pair.toUpperCase();
        const suffix4 = ["USDT", "USDC", "BUSD", "TUSD", "PAX", "USDP"]; // common 4-letter quote assets
        let splitAt = -1;
        for (const s of suffix4) {
          if (up.endsWith(s) && up.length > s.length) {
            splitAt = pair.length - s.length;
            break;
          }
        }
        if (splitAt === -1) splitAt = pair.length - 3; // fallback to 3-letter quote (e.g. EURUSD)
        if (splitAt > 0) normalizedPair = pair.slice(0, splitAt) + "/" + pair.slice(splitAt);
      }

      if (normalizedPair) {
        const marketType = normalizedPair.includes("/") ? "crypto" : "forex";
        worker.runScanner(marketType as any, true, chatId.toString(), msg.message_thread_id?.toString(), normalizedPair, command as any);
      } else if (msg.photo) {
        bot.sendMessage(chatId, "📸 <b>Vision Analysis:</b> I see your screenshot. Analyzing patterns and institutional orderflow...", { parse_mode: 'HTML' });
        worker.runScanner("crypto", true, chatId.toString(), msg.message_thread_id?.toString(), undefined, command as any);
      }
    });
  });

  bot.onText(/\/start/, async (msg) => {
    const user = await ensureUser(msg);
    if (!user) return;
    await sendMainMenu(msg.chat.id, user.id);
  });
}
