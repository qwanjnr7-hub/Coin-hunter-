import { users, wallets, signals, trades, userLanes, groupBindings } from "@shared/schema";
import type { 
  User, InsertUser, 
  Wallet, InsertWallet, 
  Signal, InsertSignal, 
  Trade, InsertTrade, 
  UserLane, InsertUserLane,
  GroupBinding, InsertGroupBinding
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and } from "drizzle-orm";
import crypto from "crypto";

const MASTER_KEY = process.env.SESSION_SECRET || "default-master-key-change-me";
const ALGORITHM = "aes-256-cbc";

function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(MASTER_KEY.padEnd(32).slice(0, 32)), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(text: string): string {
  try {
    const textParts = text.split(":");
    const iv = Buffer.from(textParts.shift()!, "hex");
    const encryptedText = Buffer.from(textParts.join(":"), "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(MASTER_KEY.padEnd(32).slice(0, 32)), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) {
    return text; // Fallback for unencrypted data
  }
}

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: InsertUser): Promise<User>;
  updateUser(id: string, data: Partial<User>): Promise<User>;

  // Lanes
  getUserLanes(userId: string): Promise<UserLane[]>;
  upsertUserLane(lane: InsertUserLane): Promise<UserLane>;

  // Group Bindings
  getGroupBinding(groupId: string, topicId?: string): Promise<GroupBinding | undefined>;
  upsertGroupBinding(binding: InsertGroupBinding): Promise<GroupBinding>;

  // Wallets
  getWallets(userId: string): Promise<Wallet[]>;
  getWallet(id: number): Promise<Wallet | undefined>;
  updateWalletBalance(id: number, balance: string): Promise<Wallet>;
  createWallet(wallet: InsertWallet): Promise<Wallet>;
  deleteWallet(id: number): Promise<void>;
  setActiveWallet(userId: string, walletId: number): Promise<void>;
  getActiveWallet(userId: string): Promise<Wallet | undefined>;

  // Signals
  getSignals(): Promise<Signal[]>;
  getSignal(id: number): Promise<Signal | undefined>;
  createSignal(signal: InsertSignal): Promise<Signal>;

  // Trades
  getTrades(userId: string): Promise<Trade[]>;
  createTrade(trade: InsertTrade): Promise<Trade>;
  updateTrade(id: number, data: Partial<Trade>): Promise<Trade>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async upsertUser(insertUser: any): Promise<User> {
    const dataToSet = { ...insertUser, lastActive: new Date() };
    const [user] = await db.insert(users).values(dataToSet).onConflictDoUpdate({
      target: users.id,
      set: dataToSet
    }).returning();
    return user;
  }

  async updateUser(id: string, data: Partial<User>): Promise<User> {
    const [user] = await db.update(users).set({ ...data, lastActive: new Date() }).where(eq(users.id, id)).returning();
    if (!user) {
      return this.upsertUser({ id, ...data });
    }
    return user;
  }

  async getUserLanes(userId: string): Promise<UserLane[]> {
    return db.select().from(userLanes).where(eq(userLanes.userId, userId));
  }

  async upsertUserLane(insertLane: InsertUserLane): Promise<UserLane> {
    try {
      const [lane] = await db.insert(userLanes).values(insertLane).onConflictDoUpdate({
        target: [userLanes.userId, userLanes.lane],
        set: { enabled: insertLane.enabled }
      }).returning();
      return lane;
    } catch (error: any) {
      if (error.code === '42P10') {
        // Fallback for missing unique constraint
        const [existing] = await db.select().from(userLanes).where(
          and(eq(userLanes.userId, insertLane.userId), eq(userLanes.lane, insertLane.lane))
        );
        if (existing) {
          const [updated] = await db.update(userLanes).set({ enabled: insertLane.enabled }).where(eq(userLanes.id, existing.id)).returning();
          return updated;
        }
        const [created] = await db.insert(userLanes).values(insertLane).returning();
        return created;
      }
      throw error;
    }
  }

  async getGroupBinding(groupId: string, topicId?: string): Promise<GroupBinding | undefined> {
    const conditions = [eq(groupBindings.groupId, groupId)];
    if (topicId) conditions.push(eq(groupBindings.topicId, topicId));
    const [binding] = await db.select().from(groupBindings).where(and(...conditions));
    return binding;
  }

  async upsertGroupBinding(insertBinding: InsertGroupBinding): Promise<GroupBinding> {
    const conditions = [eq(groupBindings.groupId, insertBinding.groupId)];
    if (insertBinding.topicId) conditions.push(eq(groupBindings.topicId, insertBinding.topicId));
    
    const [existing] = await db.select().from(groupBindings).where(and(...conditions));
    
    if (existing) {
      const [updated] = await db.update(groupBindings).set({ lane: insertBinding.lane }).where(eq(groupBindings.id, existing.id)).returning();
      return updated;
    }

    const [created] = await db.insert(groupBindings).values(insertBinding).returning();
    return created;
  }

  async getWallets(userId: string): Promise<Wallet[]> {
    const results = await db.select().from(wallets).where(eq(wallets.userId, userId)).orderBy(desc(wallets.isActive), desc(wallets.createdAt));
    return results.map(w => ({
      ...w,
      privateKey: decrypt(w.privateKey)
    }));
  }

  async setActiveWallet(userId: string, walletId: number): Promise<void> {
    // Check if wallet belongs to user
    const [wallet] = await db.select().from(wallets).where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)));
    if (!wallet) throw new Error("Wallet not found or access denied");

    await db.update(wallets).set({ isActive: false }).where(eq(wallets.userId, userId));
    await db.update(wallets).set({ isActive: true }).where(eq(wallets.id, walletId));
  }

  async getActiveWallet(userId: string): Promise<Wallet | undefined> {
    const [wallet] = await db.select().from(wallets).where(and(eq(wallets.userId, userId), eq(wallets.isActive, true)));
    if (wallet) return { ...wallet, privateKey: decrypt(wallet.privateKey) };
    const [firstWallet] = await db.select().from(wallets).where(eq(wallets.userId, userId)).orderBy(desc(wallets.createdAt)).limit(1);
    if (firstWallet) return { ...firstWallet, privateKey: decrypt(firstWallet.privateKey) };
    return undefined;
  }

  async getWallet(id: number): Promise<Wallet | undefined> {
    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, id));
    if (wallet) return { ...wallet, privateKey: decrypt(wallet.privateKey) };
    return undefined;
  }

  async updateWalletBalance(id: number, balance: string): Promise<Wallet> {
    const [wallet] = await db.update(wallets).set({ balance }).where(eq(wallets.id, id)).returning();
    if (!wallet) throw new Error("Wallet not found");
    return { ...wallet, privateKey: decrypt(wallet.privateKey) };
  }

  async createWallet(insertWallet: InsertWallet): Promise<Wallet> {
    const [wallet] = await db.insert(wallets).values({
      ...insertWallet,
      privateKey: encrypt(insertWallet.privateKey)
    }).returning();
    return { ...wallet, privateKey: decrypt(wallet.privateKey) };
  }

  async deleteWallet(id: number): Promise<void> {
    await db.delete(wallets).where(eq(wallets.id, id));
  }

  async getSignals(): Promise<Signal[]> {
    return db.select().from(signals).orderBy(desc(signals.createdAt));
  }

  async getSignal(id: number): Promise<Signal | undefined> {
    const [signal] = await db.select().from(signals).where(eq(signals.id, id));
    return signal;
  }

  async createSignal(insertSignal: InsertSignal): Promise<Signal> {
    const [signal] = await db.insert(signals).values(insertSignal).returning();
    return signal;
  }

  async getTrades(userId: string): Promise<Trade[]> {
    return db.select().from(trades).where(eq(trades.userId, userId)).orderBy(desc(trades.createdAt));
  }

  async createTrade(insertTrade: InsertTrade): Promise<Trade> {
    const [trade] = await db.insert(trades).values(insertTrade).returning();
    return trade;
  }

  async updateTrade(id: number, data: Partial<Trade>): Promise<Trade> {
    const [trade] = await db.update(trades).set(data).where(eq(trades.id, id)).returning();
    if (!trade) throw new Error("Trade not found");
    return trade;
  }
}

export const storage = new DatabaseStorage();
