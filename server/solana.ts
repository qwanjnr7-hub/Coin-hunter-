import { Connection, PublicKey, Transaction, SystemProgram, Keypair, VersionedTransaction } from "@solana/web3.js";
import axios from "axios";

// This is a simplified Jupiter execution wrapper
// In a real bot, you'd use @jup-ag/api properly with versioned transactions
export class JupiterService {
  private connection: Connection;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, { 
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60000 
    });
  }

  private JUPITER_ENDPOINTS = [
    "https://quote-api.jup.ag/v6",
    "https://jupiter-quote-api.jup.ag/v6",
    "https://quote.jup.ag/v6",
    "https://jup.nodes.bitflow.live/v6",
    "https://api.jup.ag/swap/v6",
    "https://public.jupiterapi.com",
    "https://jupiter.api.dex.guru/v6",
    "https://solana-gateway.hellomoon.io/v1/jupiter/quote"
  ];

  async getQuote(inputMint: string, outputMint: string, amount: string, slippageBps: number = 100) {
    let lastError;
    // Try each endpoint with retry logic
    for (const endpoint of this.JUPITER_ENDPOINTS) {
      for (let i = 0; i < 3; i++) {
        try {
          const url = `${endpoint}/quote`;
          console.log(`[jupiter] Requesting ${url} with params:`, { inputMint, outputMint, amount: amount.toString(), slippageBps });
          const response = await axios.get(url, {
            params: {
              inputMint,
              outputMint,
              amount: amount.toString(),
              slippageBps,
              onlyDirectRoutes: false,
              asLegacyTransaction: false,
            },
            timeout: 25000,
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'SolanaSMCBot/1.0',
            }
          });
          if (response.data && response.data.outAmount) return response.data;
        } catch (error: any) {
          lastError = error;
          const status = error.response?.status;
          console.error(`[jupiter] Error on ${endpoint}:`, {
            message: error.message,
            status,
            data: error.response?.data,
            code: error.code
          });
          
          if (status === 401 || status === 403 || status === 400 || status === 429) {
            await new Promise(r => setTimeout(r, 2000 * (i + 1))); // Wait on rate limit
            if (status === 401 || status === 403) break; // Auth errors, try next endpoint
          }
          if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
            break;
          }
          await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
      }
    }
    
    // Emergency Public Proxy Bridge with robust parsing and multiple proxies
    const proxyServices = [
      (target: string) => `https://api.allorigins.win/get?url=${encodeURIComponent(target)}`,
      (target: string) => `https://thingproxy.freeboard.io/fetch/${target}`,
      (target: string) => `https://corsproxy.io/?${encodeURIComponent(target)}`,
      (target: string) => `https://cors-anywhere.herokuapp.com/${target}`,
      (target: string) => `https://proxy.cors.sh/${target}`,
      (target: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`,
      (target: string) => `https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all&target=${encodeURIComponent(target)}`
    ];

    console.log(`[jupiter] Attempting emergency proxy fallback with ${proxyServices.length} options...`);
    const targetUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;

    for (const getProxyUrl of proxyServices) {
      try {
        const proxyUrl = getProxyUrl(targetUrl);
        console.log(`[jupiter] Trying proxy: ${proxyUrl}`);
        const res = await axios.get(proxyUrl, { timeout: 15000 });
        let data = res.data;
        if (data && data.contents) {
          data = typeof data.contents === 'string' ? JSON.parse(data.contents) : data.contents;
        }
        if (data && data.outAmount) {
          console.log(`[jupiter] Proxy fallback success!`);
          return data;
        }
      } catch (e: any) {
        console.error(`[jupiter] Proxy fallback failed:`, e.message);
      }
    }

    throw new Error(`Execution failed: Trade routes are currently unreachable. This is often due to network restrictions. Please try again in 1 minute.`);
  }

  async swap(userKeypair: Keypair, quoteResponse: any, mevProtection: boolean = true, priorityFee: string = "0.0015") {
    let lastError;
    const priorityFeeLamports = Math.floor(parseFloat(priorityFee) * 1e9).toString();
    
    for (const endpoint of this.JUPITER_ENDPOINTS) {
      try {
        const { swapTransaction } = await axios.post(`${endpoint}/swap`, {
          quoteResponse,
          userPublicKey: userKeypair.publicKey.toString(),
          wrapAndUnwrapSol: true,
          useSharedAccounts: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: priorityFeeLamports,
        }, { timeout: 15000 }).then(res => res.data);

        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        
        transaction.sign([userKeypair]);
        
        const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: true,
          maxRetries: 3,
        });

        const latestBlockHash = await this.connection.getLatestBlockhash();
        await this.connection.confirmTransaction({
          blockhash: latestBlockHash.blockhash,
          lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
          signature: signature,
        }, 'confirmed');

        return signature;
      } catch (error: any) {
        lastError = error;
        console.error(`Jupiter Swap on ${endpoint} Error:`, error.message);
        // Continue to next endpoint if it's a network error
        if (error.code === 'ECONNABORTED' || !error.response) continue;
        throw error; // If it's a logic error (e.g. invalid quote), don't retry
      }
    }
    throw new Error(`Failed to execute swap on Jupiter. Last error: ${lastError?.message}`);
  }
}
