import { loadConfig } from '../src/config/index.js';
import { PoolRegistry } from '../src/scanner/poolRegistry.js';
import { loadDiscoveredCandidates } from '../src/scanner/poolDiscovery.js';
import { SolanaRpcProvider } from '../src/providers/solanaRpc.js';
import { dexRegistry } from '../src/dex/index.js';
import { PublicKey } from '@solana/web3.js';
import { KNOWN_PROGRAM_IDS } from '../src/config/index.js';

async function main() {
  const config = loadConfig();
  const rpc = new SolanaRpcProvider(config);
  const registry = new PoolRegistry();

  const discPath = 'C:/Users/HP/solanabot/data/discovered_pools.json';
  const disc = loadDiscoveredCandidates(discPath);
  registry.loadDiscoveredCandidates(disc);

  const pools = registry.getAllPools();
  console.log(`Total registered pools: ${pools.length}`);

  // Fetch all pool account data
  const pubkeys = pools.map(p => new PublicKey(p.id));
  console.log('Fetching on-chain account data for all pools...');
  const res = await rpc.getMultipleAccountsAndContext(pubkeys);
  const accounts = res.value;

  console.log(`Fetched ${accounts.length} accounts at slot ${res.slot}`);

  const breakdown: Record<string, number> = {};
  const poolDetails: Array<{ id: string; dex: string; status: string; blocker: string }> = [];

  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    const acc = accounts[i];
    let blocker = 'UNKNOWN';
    let status = 'QUOTE_UNVERIFIED';

    if (!acc) {
      blocker = 'ACCOUNT_NOT_FOUND';
    } else {
      const ownerStr = acc.owner ? acc.owner.toBase58() : '';
      const dataLen = acc.data.length;

      if (p.dex === 'ORCA_WHIRLPOOL') {
        if (ownerStr !== KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL) {
          blocker = `INVALID_PROGRAM_OWNER (${ownerStr})`;
        } else if (dataLen < 653) {
          blocker = `INVALID_ACCOUNT_LAYOUT (${dataLen} < 653)`;
        } else {
          const adapter = dexRegistry.getAdapter(p.dex);
          const decoded = adapter?.decodePoolState(acc.data, p.id, res.slot);
          if (!decoded) {
            blocker = 'DECODE_FAILED';
          } else {
            const extra = decoded.extraData as any;
            const liquidity = BigInt(extra?.liquidity || '0');
            const tickCurrent = extra?.tickCurrent;
            if (liquidity <= 0n) {
              blocker = 'ZERO_LIQUIDITY';
            } else if (tickCurrent === undefined) {
              blocker = 'NO_TICK_CURRENT';
            } else {
              // Valid pool structure!
              status = 'VALID_POOL_STRUCTURE';
              blocker = 'PENDING_TICK_HYDRATION';
            }
          }
        }
      } else if (p.dex === 'RAYDIUM_AMM') {
        if (ownerStr !== KNOWN_PROGRAM_IDS.RAYDIUM_AMM_V4) {
          blocker = `INVALID_PROGRAM_OWNER (${ownerStr})`;
        } else if (dataLen < 752) {
          blocker = `INVALID_ACCOUNT_LAYOUT (${dataLen} < 752)`;
        } else {
          status = 'VALID_POOL_STRUCTURE';
          blocker = 'PENDING_OPENORDERS_HYDRATION';
        }
      } else if (p.dex === 'RAYDIUM_CLMM') {
        if (ownerStr !== KNOWN_PROGRAM_IDS.RAYDIUM_CLMM) {
          blocker = `INVALID_PROGRAM_OWNER (${ownerStr})`;
        } else if (dataLen < 1544) {
          blocker = `INVALID_ACCOUNT_LAYOUT (${dataLen} < 1544)`;
        } else {
          status = 'VALID_POOL_STRUCTURE';
          blocker = 'PENDING_CLMM_HYDRATION';
        }
      } else {
        blocker = `UNSUPPORTED_DEX (${p.dex})`;
      }
    }

    breakdown[blocker] = (breakdown[blocker] || 0) + 1;
    poolDetails.push({ id: p.id, dex: p.dex, status, blocker });
  }

  console.log('\n--- POOL VERIFICATION BLOCKER BREAKDOWN ---');
  for (const [b, count] of Object.entries(breakdown)) {
    console.log(`  ${b.padEnd(35)} : ${count}`);
  }

  console.log('\n--- FIRST 15 POOL DETAILS ---');
  for (const item of poolDetails.slice(0, 15)) {
    console.log(`Pool ${item.id} [${item.dex}]: ${item.status} | Blocker: ${item.blocker}`);
  }
}

main().catch(err => {
  console.error('Fatal inspect error:', err);
  process.exit(1);
});
