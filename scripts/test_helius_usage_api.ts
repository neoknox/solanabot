import dotenv from 'dotenv';
dotenv.config();

const httpUrl = process.env.SOLANA_RPC_HTTP || '';
let apiKey: string | null = null;
try {
  apiKey = new URL(httpUrl).searchParams.get('api-key');
} catch {}

async function checkUsage() {
  if (!apiKey) {
    console.log('No API key found in SOLANA_RPC_HTTP');
    return;
  }
  
  const endpoints = [
    'https://api.helius.xyz/v0/usage',
    'https://admin-api.helius.xyz/v0/usage',
    'https://api-mainnet.helius-rpc.com/v0/usage'
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(`${ep}?api-key=${apiKey}`, {
        headers: { 'X-Api-Key': apiKey }
      });
      console.log(`Endpoint ${ep} status:`, res.status);
      if (res.ok) {
        const data = await res.json();
        console.log(`Endpoint ${ep} response:`, JSON.stringify(data, null, 2));
      } else {
        const text = await res.text();
        console.log(`Endpoint ${ep} error text:`, text.slice(0, 100));
      }
    } catch (err: any) {
      console.log(`Endpoint ${ep} fetch error:`, err.message);
    }
  }
}

checkUsage();
