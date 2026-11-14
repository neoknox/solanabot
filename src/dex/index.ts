import { DexAdapter } from './types.js';
import { RaydiumAmmAdapter } from './raydiumAmmAdapter.js';
import { OrcaWhirlpoolAdapter } from './orcaWhirlpoolAdapter.js';
import { MeteoraDlmmAdapter } from './meteoraDlmmAdapter.js';
import { RaydiumClmmAdapter } from './raydiumClmmAdapter.js';
import { DexType, DexSupportStatus } from '../types/index.js';
import { KNOWN_PROGRAM_IDS } from '../config/index.js';

export * from './types.js';
export * from './raydiumAmmAdapter.js';
export * from './orcaWhirlpoolAdapter.js';
export * from './meteoraDlmmAdapter.js';
export * from './raydiumClmmAdapter.js';
export * from './raydiumClmmTickArray.js';

export class DexRegistry {
  private adapters = new Map<DexType, DexAdapter>();
  private programIdMap = new Map<string, DexAdapter>();

  constructor() {
    this.register(new RaydiumAmmAdapter());
    this.register(new OrcaWhirlpoolAdapter());
    this.register(new MeteoraDlmmAdapter());
    this.register(new RaydiumClmmAdapter());
  }

  public register(adapter: DexAdapter): void {
    this.adapters.set(adapter.dex, adapter);
    this.programIdMap.set(adapter.programId, adapter);
  }

  public getAdapter(dex: DexType): DexAdapter | undefined {
    return this.adapters.get(dex);
  }

  public getAdapterByProgramId(programId: string): DexAdapter | undefined {
    return this.programIdMap.get(programId);
  }

  public getSupportStatus(dex: DexType): DexSupportStatus {
    switch (dex) {
      case 'RAYDIUM_AMM':
      case 'ORCA_WHIRLPOOL':
      case 'METEORA_DLMM':
        return 'DIRECT_SUPPORTED';

      case 'RAYDIUM_CPMM':
      case 'RAYDIUM_CLMM':
      case 'METEORA_DAMM':
      case 'PHOENIX':
      case 'PANCAKESWAP':
      case 'MANIFEST':
        return 'JUPITER_BUILD_METIS';

      case 'ZERO_FI':
      case 'HUMIDI_FI':
      case 'SOL_FI':
      case 'GOON_FI':
      case 'BISON_FI':
        return 'PROPRIETARY_RESTRICTED';

      case 'OPENBOOK_V2':
      case 'PUMP_FUN':
      case 'UNKNOWN':
      default:
        return 'UNSUPPORTED';
    }
  }

  public getSupportedDexes(): DexType[] {
    return Array.from(this.adapters.keys());
  }
}

export const dexRegistry = new DexRegistry();
