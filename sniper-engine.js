import {
  Connection,
  PublicKey,
  VersionedTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  getAssociatedTokenAddress
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount
} from "@solana/spl-token";
import { createClient } from "@supabase/supabase-js";
import Groq from "groq-sdk";
import express from "express";
import cors from "cors";
import fetch from "cross-fetch";
import WebSocket from "ws";
import bs58 from "bs58";
import { BN } from "bn.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const WSOL_MINT = SOL_MINT;
const METEORA_DAMM_ID = new PublicKey("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB");
const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap";
const JITO_ENDPOINTS = [
  "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles"
];

// Config
const config = {
  heliusApiKey: process.env.HELIUS_API_KEY,
  privateKey: bs58.decode(process.env.PRIVATE_KEY),
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_ANON_KEY,
  groqApiKey: process.env.GROQ_API_KEY,
  jitoAuth: process.env.JITO_AUTH_KEY,
  minUsd: 2,
  maxSol: 1,
  slippageBps: 100,
  port: process.env.PORT || 3001
};

const wallet = Keypair.fromSecretKey(config.privateKey);
const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
const connection = new Connection(rpcUrl, { 
  commitment: 'confirmed',
  wsEndpoint: wsUrl 
});

const supabase = createClient(config.supabaseUrl, config.supabaseKey);
const groq = new Groq({ apiKey: config.groqApiKey });

let sniperActive = false;
let ws = null;

// Jito Bundler
async function sendJitoTransaction(tx) {
  const wireTransaction = Buffer.from(tx.serialize()).toString('base64');
  
  for (const endpoint of JITO_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [[wireTransaction]]
        })
      });
      
      if (response.ok) {
        console.log('✅ Jito bundle sent');
        return true;
      }
    } catch (e) {
      console.log('Jito failed, falling back to standard RPC');
    }
  }
  
  // Fallback to standard RPC
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 5
  });
  return sig;
}

// Wallet Manager
class WalletManager {
  async getBalance() {
    const lamports = await connection.getBalance(wallet.publicKey);
    return { sol: lamports / LAMPORTS_PER_SOL, lamports };
  }

  async hasEnough(amountUsd) {
    const { sol } = await this.getBalance();
    return sol > (amountUsd / 170) + 0.05; // $170 SOL + fees
  }
}

// Risk Analyzer (Groq AI)
class RiskAnalyzer {
  async analyze(mint) {
    try {
      const chat = await groq.chat.completions.create({
        messages: [{
          role: "user",
          content: `Analyze Solana token ${mint}: rug risks, honeypot, mint auth? Score 0-100.`
        }],
        model: "llama3-70b-8192",
        max_tokens: 100
      });
      
      const score = parseInt(chat.choices[0].message.content.match(/(d+)/)?.[1] || '50');
      return { score, passed: score >= 70, insight: chat.choices[0].message.content };
    } catch {
      return { score: 50, passed: false, insight: 'Analysis failed' };
    }
  }
}

const wm = new WalletManager();
const riskAnalyzer = new RiskAnalyzer();

// Pool Detection (Helius Enhanced WS)
async function startPoolMonitoring() {
  ws = new WebSocket(wsUrl);
  
  ws.on('open', () => {
    console.log('🔌 Helius WS Connected');
    // Subscribe to Meteora program account changes (new pools)
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'programSubscribe',
      params: [
        METEORA_DAMM_ID.toBase58(),
        {
          commitment: 'confirmed',
          encoding: 'base64',
          filters: [{ dataSize: 500 }] // Typical pool size
        }
      ]
    }));
  });

  ws.on('message', async (data) => {
    const notification = JSON.parse(data);
    if (notification.method === 'programNotification') {
      const poolAddress = notification.params.result.value.pubkey;
      console.log(`🔔 New Meteora pool: ${poolAddress}`);
      
      // Parse pool details from account/logs
      const pool = {
        poolAddress,
        tokenA: SOL_MINT,
        tokenB: 'PUMPED_TOKEN', // Parse from account data in prod
        liquidityUsd: 10000,
        timestamp: Date.now(),
        signature: notification.params.result.value.signature || '',
        slot: notification.params.result.context.slot,
        riskScore: 0
      };
      
      await handleNewPool(pool);
    }
  });
}

// Handle New Pool
async function handleNewPool(pool) {
  console.log(`🔍 Analyzing pool ${pool.poolAddress}`);
  
  // Save raw pool
  await supabase.from('pools').upsert({
    pool_address: pool.poolAddress,
    token_a: pool.tokenA,
    token_b: pool.tokenB,
    liquidity_usd: pool.liquidityUsd,
    slot: pool.slot,
    status: 'analyzing',
    created_at: new Date().toISOString()
  });

  // Risk analysis
  const risk = await riskAnalyzer.analyze(pool.tokenB);
  await supabase.from('pools').update({ 
    risk_score: risk.score,
    status: risk.passed ? 'pending' : 'risky'
  }).eq('pool_address', pool.poolAddress);

  if (risk.passed) {
    console.log(`✅ Pool passed risk: ${risk.score}`);
    // Check whitelist
    const { data: wl } = await supabase
      .from('whitelist')
      .select('*')
      .eq('pool_address', pool.poolAddress)
      .single();
    
    if (wl) await executeBuy(pool);
  }
}

// Jupiter V6 + Jito Buy
async function executeBuy(pool) {
  if (!await wm.hasEnough(config.minUsd)) {
    console.log('❌ Insufficient balance');
    return;
  }

  const amountLamports = Math.floor((config.minUsd / 170) * LAMPORTS_PER_SOL);
  
  try {
    // 1. Get Quote
    const quoteRes = await fetch(`${JUPITER_QUOTE_API}?inputMint=${SOL_MINT}&outputMint=${pool.tokenB}&amount=${amountLamports}&slippageBps=${config.slippageBps}`);
    const quote = await quoteRes.json();

    // 2. Get Swap Transaction
    const swapRes = await fetch(JUPITER_SWAP_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: 'auto'
      })
    });
    const { swapTransaction } = await swapRes.json();

    // 3. Sign & Jito Bundle
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);
    
    const sig = await sendJitoTransaction(tx);
    
    // 4. Save Trade
    await supabase.from('trades').insert({
      id: sig,
      pool_address: pool.poolAddress,
      token_out: pool.tokenB,
      amount_in_sol: amountLamports / LAMPORTS_PER_SOL,
      amount_out: quote.outAmount,
      status: 'executed',
      signature: sig,
      created_at: new Date().toISOString()
    });

    console.log(`✅ SNIPED! ${sig}`);
  } catch (e) {
    console.error('❌ Buy failed:', e.message);
  }
}

// Express API (Lovable Dashboard)
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', async (req, res) => {
  const balance = await wm.getBalance();
  res.json({ 
    status: 'active', 
    balance: balance.sol.toFixed(4),
    wallet: wallet.publicKey.toBase58(),
    active: sniperActive 
  });
});

app.get('/balance', async (req, res) => res.json(await wm.getBalance()));
app.get('/pools', async (req, res) => {
  const { data } = await supabase.from('pools').select('*').order('created_at', { ascending: false }).limit(50);
  res.json(data);
});
app.get('/trades', async (req, res) => {
  const { data } = await supabase.from('trades').select('*').order('created_at', { ascending: false }).limit(50);
  res.json(data);
});

app.post('/pools/approve', async (req, res) => {
  const { poolAddress } = req.body;
  await supabase.from('whitelist').upsert({ pool_address: poolAddress });
  res.json({ status: 'approved', poolAddress });
});

app.post('/start', async (req, res) => {
  sniperActive = true;
  startPoolMonitoring();
  res.json({ status: 'started' });
});

app.post('/stop', (req, res) => {
  sniperActive = false;
  if (ws) ws.close();
  res.json({ status: 'stopped' });
});

const server = app.listen(config.port, () => {
  console.log(`🚀 Sniper Engine: http://localhost:${config.port}`);
  console.log(`💳 Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`🎯 Min Buy: $${config.minUsd} via Jupiter V6 + Jito`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  sniperActive = false;
  server.close(() => process.exit(0));
});
