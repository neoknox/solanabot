import fs from 'fs';
import path from 'path';
import Decimal from 'decimal.js';

export const VALID_PROFIT_THRESHOLDS_CENTS = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70] as const;
export type ValidProfitThresholdCents = typeof VALID_PROFIT_THRESHOLDS_CENTS[number];

export const VALID_CENTS_SET = new Set<number>(VALID_PROFIT_THRESHOLDS_CENTS);

export const DEFAULT_PROFIT_THRESHOLD_CENTS: ValidProfitThresholdCents = 50; // $0.50 USDC
export const MIN_PROFIT_THRESHOLD_USDC = 0.20;
export const MAX_PROFIT_THRESHOLD_USDC = 0.70;
export const STEP_PROFIT_THRESHOLD_USDC = 0.05;

export interface ThresholdUpdateResult {
  success: boolean;
  error?: string;
  thresholdUSDC: number;
  thresholdCents: number;
  formatted: string;
}

export type ThresholdChangeListener = (thresholdUSDC: number, thresholdCents: number) => void;

export interface ProfitThresholdManagerOptions {
  filePath?: string;
  initialThresholdUSDC?: number;
  silent?: boolean;
}

/**
 * ProfitThresholdManager
 * 
 * Single authoritative owner for the runtime minimum conservative net-profit threshold.
 * - Integer cents representation (20, 25, ..., 70) eliminates floating-point drift.
 * - Precise Decimal conversions for mathematical comparisons in pricing and rechecks.
 * - Safe atomic local JSON persistence (write to temp file then rename).
 * - Startup validation with automatic fallback to $0.50 USDC on missing or corrupt files.
 * - Event listener support for immediate updates without restarting the scanner.
 */
export class ProfitThresholdManager {
  private currentCents: number = DEFAULT_PROFIT_THRESHOLD_CENTS;
  private filePath: string;
  private silent: boolean;
  private listeners: Set<ThresholdChangeListener> = new Set();

  constructor(options: ProfitThresholdManagerOptions = {}) {
    this.filePath = options.filePath || path.join(process.cwd(), 'data', 'profit_threshold.json');
    this.silent = options.silent ?? false;

    // Check disk persistence or initialize with default/configured initial value
    this.initFromDiskOrDefault(options.initialThresholdUSDC);
  }

  /**
   * Reads existing threshold from disk or writes default.
   */
  private initFromDiskOrDefault(initialThresholdUSDC?: number): void {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        const validated = this.validateCandidateValue(parsed.cents !== undefined ? parsed.cents : parsed.thresholdUSDC);
        if (validated.valid && validated.cents !== undefined) {
          this.currentCents = validated.cents;
          return;
        } else {
          if (!this.silent) {
            console.warn(
              `[ProfitThresholdManager] WARNING: Corrupt or non-compliant threshold payload in "${this.filePath}". Falling back to default $0.50 USDC.`
            );
          }
        }
      } catch (err) {
        if (!this.silent) {
          console.warn(
            `[ProfitThresholdManager] WARNING: Failed to parse threshold file "${this.filePath}". Falling back to default $0.50 USDC. (${err instanceof Error ? err.message : String(err)})`
          );
        }
      }
    }

    // If initial threshold passed explicitly in options, try validating it
    if (initialThresholdUSDC !== undefined) {
      const initialValidated = this.validateCandidateValue(initialThresholdUSDC);
      if (initialValidated.valid && initialValidated.cents !== undefined) {
        this.currentCents = initialValidated.cents;
      } else {
        this.currentCents = DEFAULT_PROFIT_THRESHOLD_CENTS;
      }
    } else {
      this.currentCents = DEFAULT_PROFIT_THRESHOLD_CENTS;
    }

    // Persist active default to file safely
    try {
      this.saveToDisk();
    } catch (err) {
      if (!this.silent) {
        console.warn(
          `[ProfitThresholdManager] WARNING: Initial persistence to "${this.filePath}" failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  /**
   * Persists threshold to disk using atomic temporary file replacement (.tmp + renameSync).
   * Throws if write or rename fails. Does NOT use non-atomic copy fallback.
   */
  public saveToDiskSync(cents: number): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const payload = {
      thresholdUSDC: cents / 100,
      cents: cents,
      updatedAt: new Date().toISOString(),
      mode: 'READ-ONLY / SHADOW MODE',
      version: 1
    };

    const serialized = JSON.stringify(payload, null, 2);
    const tmpPath = `${this.filePath}.tmp.${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    fs.writeFileSync(tmpPath, serialized, 'utf-8');

    try {
      fs.renameSync(tmpPath, this.filePath);
    } catch (renameErr) {
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {}
      throw renameErr;
    }
  }

  /**
   * Safely persists current threshold to disk using atomic write/replace.
   * Throws on failure.
   */
  private saveToDisk(): void {
    this.saveToDiskSync(this.currentCents);
  }

  /**
   * Validates a candidate value (number or string representation of USDC or cents).
   * Strict validation:
   * - Must be numeric, non-empty, finite.
   * - Must be between $0.20 and $0.70 USDC in exact $0.05 increments (integer cents 20, 25, ..., 70).
   * - Rejects NaN, non-numeric strings, negative numbers, out-of-range, and non-multiples of $0.05.
   */
  public validateCandidateValue(input: unknown): { valid: boolean; cents?: number; error?: string } {
    if (input === null || input === undefined || typeof input === 'boolean') {
      return { valid: false, error: 'Threshold input is required and must be a valid number' };
    }

    let num: number;
    if (typeof input === 'string') {
      // Clean leading dollar sign or trailing USDC if provided by UI
      const clean = input.replace(/^\$/, '').replace(/USDC$/i, '').trim();
      if (clean === '') {
        return { valid: false, error: 'Empty threshold string provided' };
      }
      num = Number(clean);
    } else if (typeof input === 'number') {
      num = input;
    } else {
      return { valid: false, error: 'Invalid threshold type. Expected number or string' };
    }

    if (isNaN(num) || !isFinite(num)) {
      return { valid: false, error: 'Threshold must be a valid finite number' };
    }

    // Determine if input is provided as cents integer (e.g. 20, 50, 70) or decimal USDC (0.20, 0.50, 0.70)
    let cents: number;
    if (Number.isInteger(num) && num >= 20 && num <= 70 && VALID_CENTS_SET.has(num)) {
      cents = num;
    } else {
      // Range check for USDC dollars
      if (num < MIN_PROFIT_THRESHOLD_USDC || num > MAX_PROFIT_THRESHOLD_USDC) {
        return {
          valid: false,
          error: `Threshold out of allowed range [$${MIN_PROFIT_THRESHOLD_USDC.toFixed(2)}, $${MAX_PROFIT_THRESHOLD_USDC.toFixed(2)}]. Received: $${num.toFixed(2)}`
        };
      }

      cents = Math.round(num * 100);
      // Floating-point precision guard: verify input does not contain fractional cents (e.g. 0.205)
      if (Math.abs(num * 100 - cents) > 1e-4) {
        return {
          valid: false,
          error: `Fractional cents not allowed. Threshold must increment in $0.05 steps. Received: $${num}`
        };
      }
    }

    if (!VALID_CENTS_SET.has(cents)) {
      return {
        valid: false,
        error: `Invalid threshold step. Must be an exact multiple of $0.05 USDC between $0.20 and $0.70. Received: $${(cents / 100).toFixed(2)}`
      };
    }

    return { valid: true, cents };
  }

  /**
   * Sets the threshold from either a dollar amount (e.g. 0.35, "0.35", "$0.35") or integer cents (e.g. 35).
   * - Never silently clamps invalid inputs.
   * - Rejects invalid values and leaves running setting unchanged.
   * - Notifies registered listeners immediately on success.
   */
  public setThreshold(input: unknown): ThresholdUpdateResult {
    const validated = this.validateCandidateValue(input);
    if (!validated.valid || validated.cents === undefined) {
      return {
        success: false,
        error: validated.error || 'Invalid threshold input',
        thresholdUSDC: this.getThresholdUSDC(),
        thresholdCents: this.currentCents,
        formatted: this.getFormattedThreshold()
      };
    }

    const previousCents = this.currentCents;
    const targetCents = validated.cents;

    // Persist to local JSON file atomically BEFORE committing state change
    try {
      this.saveToDiskSync(targetCents);
    } catch (persistErr) {
      // On persistence failure:
      // - Keep previous confirmed threshold
      // - Return an actionable error
      // - Leave scanner qualification unchanged (no listeners notified)
      // - Keep HUD showing confirmed value
      const errorMsg = `Persistence failure: Failed to atomically save threshold to "${this.filePath}": ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`;
      if (!this.silent) {
        console.error(`[ProfitThresholdManager] ${errorMsg}`);
      }
      return {
        success: false,
        error: errorMsg,
        thresholdUSDC: this.getThresholdUSDC(),
        thresholdCents: this.currentCents,
        formatted: this.getFormattedThreshold()
      };
    }

    // Persistence succeeded! Now commit memory state
    this.currentCents = targetCents;

    // Trigger listeners if value changed
    if (previousCents !== this.currentCents) {
      const usdc = this.getThresholdUSDC();
      for (const listener of this.listeners) {
        try {
          listener(usdc, this.currentCents);
        } catch (err) {
          if (!this.silent) {
            console.error('[ProfitThresholdManager] Error in change listener:', err);
          }
        }
      }
    }

    return {
      success: true,
      thresholdUSDC: this.getThresholdUSDC(),
      thresholdCents: this.currentCents,
      formatted: this.getFormattedThreshold()
    };
  }

  /**
   * Returns active threshold in dollars as a JS number (e.g. 0.50).
   */
  public getThresholdUSDC(): number {
    return this.currentCents / 100;
  }

  /**
   * Returns active threshold in integer cents (e.g. 50).
   */
  public getThresholdCents(): number {
    return this.currentCents;
  }

  /**
   * Returns active threshold as a high-precision Decimal.js instance.
   */
  public getThresholdDecimal(): Decimal {
    return new Decimal(this.currentCents).div(100);
  }

  /**
   * Returns formatted dollar string to two decimal places (e.g. "$0.50 USDC").
   */
  public getFormattedThreshold(): string {
    return `$${(this.currentCents / 100).toFixed(2)} USDC`;
  }

  /**
   * Subscribes to threshold changes. Returns an unsubscribe function.
   */
  public onThresholdChange(listener: ThresholdChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Returns configured file path for test verification.
   */
  public getFilePath(): string {
    return this.filePath;
  }
}
