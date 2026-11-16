import dotenv from 'dotenv';
import WebSocket from 'ws';

dotenv.config();

const httpUrl = process.env.SOLANA_RPC_HTTP || '';
const wsUrl = process.env.SOLANA_RPC_WS || '';

// Extract key safely
let apiKey = '';
try {
  const parsed = new URL(httpUrl);
  apiKey = parsed.searchParams.get('api-key') || '';
} catch {}

if (!apiKey) {
  try {
    const parsed = new URL(wsUrl);
    apiKey = parsed.searchParams.get('api-key') || '';
  } catch {}
}

const candidates = [
  wsUrl,
  `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`,
  `wss://mainnet.helius-rpc.com?api-key=${apiKey}`,
  `wss://rpc.helius.xyz/?api-key=${apiKey}`
];

function mask(u: string): string {
  return u.replace(/api-key=[^&]+/i, 'api-key=***');
}

async function testUrl(targetUrl: string): Promise<{ url: string; success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const masked = mask(targetUrl);
    console.log(`Testing: ${masked}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(targetUrl);
    } catch (err: any) {
      resolve({ url: masked, success: false, error: err.message });
      return;
    }

    const timeout = setTimeout(() => {
      try { ws.terminate(); } catch {}
      resolve({ url: masked, success: false, error: 'TIMEOUT (5s)' });
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      resolve({ url: masked, success: true });
    });

    ws.on('error', (err: any) => {
      clearTimeout(timeout);
      resolve({ url: masked, success: false, error: err.message });
    });
  });
}

async function run() {
  for (const c of candidates) {
    if (!c) continue;
    const res = await testUrl(c);
    console.log(`Result: ${res.success ? 'CONNECTED (200/101)' : 'FAILED: ' + res.error}\n`);
  }
}

run();
