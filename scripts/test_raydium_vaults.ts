import { loadConfig } from '../src/config/index.js';
import { SolanaRpcProvider } from '../src/providers/solanaRpc.js';
import { PoolRegistry } from '../src/scanner/poolRegistry.js';
import { loadDiscoveredCandidates } from '../src/scanner/poolDiscovery.js';
import { PublicKey } from '@solana/web3.js';
import { dexRegistry } from '../src/dex/index.js';

async function main() {
  const config = loadConfig();
  const rpc = new SolanaRpcProvider(config);
  const registry = new PoolRegistry();
  const discPath = 'C:/Users/HP/solanabot/data/discovered_pools.json';
  registry.loadDiscoveredCandidates(loadDiscoveredCandidates(discPath));

  const pools = registry.getAllPools().filter(p => p.dex === 'RAYDIUM_AMM');
  console.log(`Checking ${pools.length} Raydium AMM pools...`);

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
    if (!decoded) {
      console.log(`Pool ${p.id} decode failed`);
      continue;
    }
    const extra = decoded.extraData as any;
    const vA = extra?.baseVault;
    const vB = extra?.quoteVault;
    const oo = extra?.openOrders;

    console.log(`Pool ${p.id.slice(0, 8)}: vA=${vA?.slice(0, 8)}, vB=${vB?.slice(0, 8)}, oo=${oo?.slice(0, 8)}`);

    if (vA && vB) {
      const vRes = await rpc.getMultipleAccountsAndContext([new PublicKey(vA), new PublicKey(vB)]);
      const accA = vRes.value[0];
      const accB = vRes.value[1];
      const balA = accA && accA.data.length >= 72 ? accA.data.readBigUInt64LE(64) : null;
      const balB = accB && accB.data.length >= 72 ? accB.data.readBigUInt64LE(64) : null;
      console.log(`   Vault balances: A=${balA}, B=${balB}`);
    }
  }
}

main().catch(console.error);
