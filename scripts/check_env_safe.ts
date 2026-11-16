import dotenv from 'dotenv';
dotenv.config();

function maskUrl(urlStr?: string): string {
  if (!urlStr) return '(not set)';
  try {
    const parsed = new URL(urlStr);
    const domain = parsed.hostname;
    const protocol = parsed.protocol;
    const hasKey = parsed.searchParams.has('api-key');
    return `${protocol}//${domain}?api-key=${hasKey ? '***' : '(none)'}`;
  } catch {
    return '(invalid url)';
  }
}

const httpEndpoint = process.env.SOLANA_RPC_HTTP;
const wsEndpoint = process.env.SOLANA_RPC_WS;

console.log('--- Environment RPC Configuration Check ---');
console.log('HTTP Endpoint:', maskUrl(httpEndpoint));
console.log('WS Endpoint:  ', maskUrl(wsEndpoint));
console.log('Helius Detected HTTP:', httpEndpoint ? httpEndpoint.includes('helius') : false);
console.log('Helius Detected WS:  ', wsEndpoint ? wsEndpoint.includes('helius') : false);
console.log('Has API Key query param:', httpEndpoint ? httpEndpoint.includes('api-key=') : false);
