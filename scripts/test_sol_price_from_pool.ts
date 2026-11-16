import { loadConfig, CANONICAL_WSOL_MINT, CANONICAL_USDC_MINT } from '../src/config/index.js';
import { SolanaRpcProvider } from '../src/providers/solanaRpc.js';
import { PublicKey } from '@solana/web3.js';
import { dexRegistry } from '../src/dex/index.js';
import { deriveTickArrayPda, getSurroundingTickArrayStartIndices, decodeTickArrayAccount } from '../src/dex/orcaTickArray.js';
import Decimal from 'decimal.js';

async function main() {
  const config = loadConfig();
  const rpc = new SolanaRpcProvider(config);
  const poolId = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
  
  const poolRes = await rpc.getMultipleAccountsAndContext([new PublicKey(poolId)]);
  const adapter = dexRegistry.getAdapter('ORCA_WHIRLPOOL')!;
  const state = adapter.decodePoolState(poolRes.value[0]!.data, poolId, poolRes.slot)!;

  const extra = state.extraData as any;
  const surrounding = getSurroundingTickArrayStartIndices(extra.tickCurrent, extra.tickSpacing);
  const pdas = surrounding.map(s => deriveTickArrayPda(poolId, s));
  const tickRes = await rpc.getMultipleAccountsAndContext(pdas);
  extra.tickArrays = {};
  for (let i = 0; i < surrounding.length; i++) {
    if (tickRes.value[i]?.data) {
      extra.tickArrays[surrounding[i]] = decodeTickArrayAccount(tickRes.value[i]!.data, poolId);
    }
  }

  // Quote 1 SOL (1,000,000,000 lamports) to USDC
  const quote = adapter.quoteExactInput(state, CANONICAL_WSOL_MINT, 1000000000n);
  if (quote) {
    console.log('1 SOL in USDC units (6 dec):', quote.outAmount.toString());
    const priceUSDC = new Decimal(quote.outAmount.toString()).div(1e6);
    console.log('Derived SOL/USDC price:', priceUSDC.toFixed(4));
  } else {
    console.log('Quote returned null, reason:', adapter.getLastFailureReason?.());
  }
}

main().catch(console.error);
