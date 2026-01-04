import { pgTable, text, serial, integer, boolean, timestamp, jsonb, varchar, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { relations, sql } from "drizzle-orm";

// === SETTINGS / TOPICS ===
export const groupBindings = pgTable("group_bindings", {
  id: serial("id").primaryKey(),
  groupId: varchar("group_id").notNull(),
  topicId: varchar("topic_id"),
  lane: text("lane").notNull(), // high | med | low | cto
  market: text("market"), // optional: crypto | forex
  purpose: text("purpose"), // optional human-friendly description of the topic's use
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  uniqueBinding: sql`UNIQUE(${table.groupId}, ${table.lane})`
}));

// === USERS ===
export const users = pgTable("users", {
  id: varchar("id").primaryKey(), // Telegram ID
  username: text("username"),
  firstName: text("first_name"),
  safetyProfile: text("safety_profile").default("balanced").notNull(),
  autoBuyEnabled: boolean("auto_buy_enabled").default(false).notNull(),
  autoBuyAmount: numeric("auto_buy_amount").default("0.01"),
  autoBuySlippage: integer("auto_buy_slippage").default(500), // 500 = 5%
  priorityFeeTier: text("priority_fee_tier").default("medium"),
  showTokenPreview: boolean("show_token_preview").default(true).notNull(),
  unsafeOverride: boolean("unsafe_override").default(false).notNull(),
  priceImpactLimit: integer("price_impact_limit").default(500), // 5% BPS
  liquidityMinimum: numeric("liquidity_minimum").default("1000"), // USD
  tpPercent: integer("tp_percent"),
  slPercent: integer("sl_percent"),
  minBuyAmount: numeric("min_buy_amount").default("0.01"),
  priorityFeeAmount: numeric("priority_fee_amount").default("0.0015"),
  mevProtection: boolean("mev_protection").default(true).notNull(),
  maxRetries: integer("max_retries").default(3),
  rpcPreference: text("rpc_preference").default("auto"), // auto | custom
  customRpcUrl: text("custom_rpc_url"),
  duplicateProtection: boolean("duplicate_protection").default(true).notNull(),
  isMainnet: boolean("is_mainnet").default(true).notNull(),
  lastAirdrop: timestamp("last_airdrop"),
  lastActive: timestamp("last_active").defaultNow(),
  withdrawalAddress: text("withdrawal_address"),
  withdrawalAmount: text("withdrawal_amount"),
});

// User Lane settings (separate from Master Auto-Buy)
export const userLanes = pgTable("user_lanes", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => users.id),
  lane: text("lane").notNull(), // unfiltered | low | med | high
  enabled: boolean("enabled").default(false).notNull(),
}, (table) => ({
  uniqueUserLane: sql`UNIQUE(${table.userId}, ${table.lane})`
}));

// === WALLETS ===
export const wallets = pgTable("wallets", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => users.id),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  label: text("label").notNull(),
  isMainnet: boolean("is_mainnet").default(true).notNull(),
  isActive: boolean("is_active").default(false).notNull(),
  balance: numeric("balance").default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// === SIGNALS ===
export const signals = pgTable("signals", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  type: text("type").notNull(),
  bias: text("bias").notNull(),
  reasoning: text("reasoning").notNull(),
  timeframe: text("timeframe").default("1h"),
  status: text("status").default("active"),
  entryPrice: numeric("entry_price"),
  tp1: numeric("tp1"),
  tp2: numeric("tp2"),
  tp3: numeric("tp3"),
  sl: numeric("sl"),
  messageId: varchar("message_id"),
  chatId: varchar("chat_id"),
  topicId: varchar("topic_id"),
  lastUpdateAt: timestamp("last_update_at").defaultNow(),
  nextUpdateAt: timestamp("next_update_at"),
  data: jsonb("data"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// === TRADES ===
export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => users.id),
  walletId: integer("wallet_id").notNull().references(() => wallets.id),
  mint: text("mint").notNull(),
  symbol: text("symbol"),
  amountIn: numeric("amount_in").notNull(),
  amountOut: numeric("amount_out"),
  entryPrice: numeric("entry_price"),
  status: text("status").default("pending"),
  txHash: text("tx_hash"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// === CHAT MODELS (Required for Integrations) ===
export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(users);
export const insertWalletSchema = createInsertSchema(wallets).omit({ id: true, createdAt: true });
export const insertSignalSchema = createInsertSchema(signals).omit({ id: true, createdAt: true });
export const insertTradeSchema = createInsertSchema(trades).omit({ id: true, createdAt: true });
export const insertUserLaneSchema = createInsertSchema(userLanes).omit({ id: true });
export const insertGroupBindingSchema = createInsertSchema(groupBindings).omit({ id: true, createdAt: true });

export type User = typeof users.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type Signal = typeof signals.$inferSelect;
export type Trade = typeof trades.$inferSelect;
export type UserLane = typeof userLanes.$inferSelect;
export type GroupBinding = typeof groupBindings.$inferSelect;

export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertWallet = z.infer<typeof insertWalletSchema>;
export type InsertSignal = z.infer<typeof insertSignalSchema>;
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type InsertUserLane = z.infer<typeof insertUserLaneSchema>;
export type InsertGroupBinding = z.infer<typeof insertGroupBindingSchema>;

// === RELATIONS ===
export const usersRelations = relations(users, ({ many }) => ({
  wallets: many(wallets),
  trades: many(trades),
  lanes: many(userLanes),
  conversations: many(conversations),
}));

export const userLanesRelations = relations(userLanes, ({ one }) => ({
  user: one(users, { fields: [userLanes.userId], references: [users.id] }),
}));

export const conversationsRelations = relations(conversations, ({ many }) => ({
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
}));
