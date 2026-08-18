/**
 * Glue between the pure `Quota` counter and the account store: resolves
 * seat-aware defaults, applies per-account `config.json` overrides, and
 * persists the ledger back to `rate-state.json` after each consumed slot.
 *
 * Kept separate from `quota.ts` so the counting logic stays pure/testable and
 * only this module knows about the store.
 */
import type { Store } from "../store/index.js";
import type { AccountConfig, AccountRateState } from "../store/types.js";
import {
  DAY_MS,
  defaultCompanyQuota,
  defaultEnrichmentQuota,
  defaultInviteQuota,
  Quota,
  type QuotaWindow,
} from "./quota.js";

export type QuotaKind = "enrichment" | "company" | "invite";

/** Resolve the effective quota window for a kind, honoring config overrides. */
export function resolveQuotaWindow(
  kind: QuotaKind,
  config: AccountConfig,
  hasSeat: boolean
): QuotaWindow {
  const rl = config.rateLimit;
  if (kind === "enrichment") {
    const base = defaultEnrichmentQuota(hasSeat);
    return {
      max: rl?.maxEnrichments ?? base.max,
      windowMs: rl?.enrichmentWindowMs ?? base.windowMs,
    };
  }
  if (kind === "company") {
    const base = defaultCompanyQuota(hasSeat);
    return {
      max: rl?.maxCompanyLookups ?? base.max,
      windowMs: rl?.companyWindowMs ?? base.windowMs,
    };
  }
  const base = defaultInviteQuota(hasSeat);
  return { max: rl?.maxInvitesPerDay ?? base.max, windowMs: DAY_MS };
}

const LEDGER_KEY: Record<
  QuotaKind,
  "enrichmentTimestamps" | "companyTimestamps" | "inviteTimestamps"
> = {
  enrichment: "enrichmentTimestamps",
  company: "companyTimestamps",
  invite: "inviteTimestamps",
};

/**
 * A quota bound to an account: consuming a slot writes the ledger straight
 * back to `rate-state.json`, so a crash mid-run can't hand back free capacity.
 */
export class AccountQuota {
  private constructor(
    private readonly store: Store,
    private readonly profileId: string,
    private readonly kind: QuotaKind,
    readonly window: QuotaWindow,
    private readonly quota: Quota,
    private rateState: AccountRateState
  ) {}

  static async load(
    store: Store,
    profileId: string,
    kind: QuotaKind,
    config: AccountConfig,
    hasSeat: boolean
  ): Promise<AccountQuota> {
    const window = resolveQuotaWindow(kind, config, hasSeat);
    const rateState = (await store.accounts.readRateState(profileId)) ?? {
      lastMessageSentAt: 0,
    };
    const timestamps = rateState[LEDGER_KEY[kind]] ?? [];
    return new AccountQuota(
      store,
      profileId,
      kind,
      window,
      new Quota(window, { timestamps }),
      rateState
    );
  }

  status() {
    return this.quota.status();
  }

  /** Consume a slot and persist. Returns false when the window is full. */
  async tryConsume(): Promise<boolean> {
    if (!this.quota.tryConsume()) return false;
    this.rateState = {
      ...this.rateState,
      [LEDGER_KEY[this.kind]]: this.quota.toState().timestamps,
    };
    await this.store.accounts.writeRateState(this.profileId, this.rateState);
    return true;
  }
}
