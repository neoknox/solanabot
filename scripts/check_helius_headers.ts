import dotenv from 'dotenv';
dotenv.config();

const httpUrl = process.env.SOLANA_RPC_HTTP || '';

async function checkHeaders() {
  try {
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSlot'
      })
    });
    console.log('HTTP Status:', res.status);
    console.log('Headers:');
    res.headers.forEach((val, key) => {
      console.log(`  ${key}: ${val}`);
    });
    const data = await res.json();
    console.log('Body slot:', data.result);
  } catch (err: any) {
    console.error('Fetch error:', err.message);
  }
}

checkHeaders();
