import { loadConfig } from '../src/config/index.js';
import { SolanaRpcProvider } from '../src/providers/solanaRpc.js';
import { PoolRegistry } from '../src/scanner/poolRegistry.js';
import { loadDiscoveredCandidates } from '../src/scanner/poolDiscovery.js';
import { PublicKey } from '@solana/web3.js';
import { dexRegistry } from '../src/dex/index.js';
import { deriveTickArrayPda, getSurroundingTickArrayStartIndices } from '../src/dex/orcaTickArray.js';
import { deriveRaydiumClmmTickArrayPda, getBidirectionalRaydiumClmmTickArrayStartIndices } from '../src/dex/raydiumClmmTickArray.js';

async function main() {
  const config = loadConfig();
  const rpc = new SolanaRpcProvider(config);
  const registry = new PoolRegistry();
  const discPath = 'C:/Users/HP/solanabot/data/discovered_pools.json';
  registry.loadDiscoveredCandidates(loadDiscoveredCandidates(discPath));

  const pools = registry.getAllPools().filter(p => p.dex === 'ORCA_WHIRLPOOL' || p.dex === 'RAYDIUM_CLMM');
  console.log(`Checking ${pools.length} concentrated pools...`);

  const poolPubkeys = pools.map(p => new PublicKey(p.id));
  const res = await rpc.getMultipleAccountsAndContext(poolPubkeys);

  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    const acc = res.value[i];
    if (!acc) {
      console.log(`Pool ${p.id} account not found`);
      continue;
    }
    const adapter = dexRegistry.getAdapter(p.dex);
    const decoded = adapter?.decodePoolState(acc.data, p.id, res.slot);
    if (!decoded) continue;

    const isClmm = p.dex === 'RAYDIUM_CLMM';
    const extra = decoded.extraData as any;
    const tickCurrent = extra?.tickCurrent;
    const tickSpacing = extra?.tickSpacing || 1;

    if (tickCurrent === undefined) {
      console.log(`Pool ${p.id} has no tickCurrent`);
      continue;
    }

    const surrounding = isClmm
      ? getBidirectionalRaydiumClmmTickArrayStartIndices(tickCurrent, tickSpacing)
      : getSurroundingTickArrayStartIndices(tickCurrent, tickSpacing);

    const pdas = surrounding.map(startIdx =>
      isClmm ? deriveRaydiumClmmTickArrayPda(p.id, startIdx) : deriveTickArrayPda(p.id, startIdx)
    );

    const tickRes = await rpc.getMultipleAccountsAndContext(pdas);
    const initialized = tickRes.value.map(v => v !== null);
    console.log(`Pool ${p.id.slice(0, 8)} [${p.dex}]: tick=${tickCurrent}, surrounding initialized: [${initialized.join(', ')}]`);
  }
}

main().catch(console.error);
