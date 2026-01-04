import OpenAI from "openai";

let client: OpenAI | null = null;

function initClient() {
  if (client) return client;
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  let baseURL: string | undefined;
  if (process.env.OPENROUTER_API_KEY) {
    baseURL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  } else {
    baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined;
  }
  if (!apiKey) return null;
  client = new OpenAI({ apiKey, baseURL });
  return client;
}

export async function extractPairFromImage(imageUrl: string): Promise<string | null> {
  const c = initClient();
  if (!c) return null;

  try {
    const response: any = await c.chat.completions.create({
      model: "google/gemini-2.0-flash-001",
      max_completion_tokens: 200,
      messages: [
        { role: "system", content: "You are a concise OCR assistant. Given an image URL, extract any trading symbol or pair present in the image (examples: BTC/USDT, BTCUSDT, EUR/USD, EURUSD, BTC-USD). Return a single normalized pair in the format BASE/QUOTE (e.g., BTC/USDT or EUR/USD). If none found, return the word NONE." },
        { role: "user", content: `Image: ${imageUrl}\n\nExtract the trading pair and ONLY reply with the normalized pair or NONE.` }
      ]
    } as any);

    const text = response.choices?.[0]?.message?.content || "";
    const t = (text || "").trim();
    if (!t) return null;

    // Normalize common formats
    const match = t.match(/([A-Z]{2,8})\s*[-\/]?\s*([A-Z]{2,8})/i);
    if (match) {
      const base = match[1].toUpperCase();
      const quote = match[2].toUpperCase();
      return `${base}/${quote}`;
    }
    if (/NONE/i.test(t)) return null;
    return t;
  } catch (e) {
    return null;
  }
}
