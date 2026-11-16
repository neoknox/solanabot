import { JupiterClient } from '../src/providers/jupiterClient.js';
import { loadConfig, CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT } from '../src/config/index.js';

import { JupiterClient } from '../src/providers/jupiterClient.js';
import { loadConfig, CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT } from '../src/config/index.js';

import { JupiterClient } from '../src/providers/jupiterClient.js';
import { loadConfig, CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT } from '../src/config/index.js';

async function main() {
  const config = loadConfig({ JUPITER_API_URL: 'https://api.jup.ag/swap/v1' });
  const jup = new JupiterClient(config);
  const q = await jup.getQuote(CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT, 1000000000n);
  console.log('Jup quote outAmount:', q?.outAmount.toString());
  console.log('Jup quote full:', q);
}

main().catch(console.error);
