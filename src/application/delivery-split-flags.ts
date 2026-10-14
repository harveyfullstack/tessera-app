export interface DeliverySplitFlagConfig {
  pilotAccountIds: Iterable<string>;
  rollbackAccountIds: Iterable<string>;
}

export const DELIVERY_SPLIT_PILOT_ACCOUNTS_ENV = "TESSERA_DELIVERY_SPLIT_PILOT_ACCOUNTS";
export const DELIVERY_SPLIT_ROLLBACK_ACCOUNTS_ENV = "TESSERA_DELIVERY_SPLIT_ROLLBACK_ACCOUNTS";

function parseAccountList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((accountId) => accountId.trim())
    .filter((accountId) => accountId.length > 0);
}

// Per-account gate for the delivery_jobs / delivery_attempts split. Both
// sets ship empty; pilot and rollback account ids are supplied at rollout.
export class DeliverySplitFlags {
  private readonly pilotAccountIds: ReadonlySet<string>;
  private readonly rollbackAccountIds: ReadonlySet<string>;

  constructor(config: DeliverySplitFlagConfig = { pilotAccountIds: [], rollbackAccountIds: [] }) {
    this.pilotAccountIds = new Set(config.pilotAccountIds);
    this.rollbackAccountIds = new Set(config.rollbackAccountIds);
  }

  static fromEnv(env: Record<string, string | undefined>): DeliverySplitFlags {
    return new DeliverySplitFlags({
      pilotAccountIds: parseAccountList(env[DELIVERY_SPLIT_PILOT_ACCOUNTS_ENV]),
      rollbackAccountIds: parseAccountList(env[DELIVERY_SPLIT_ROLLBACK_ACCOUNTS_ENV]),
    });
  }

  // The rollback flag forces the legacy path and wins over the pilot list.
  isSplitEnabled(accountId: string): boolean {
    if (this.rollbackAccountIds.has(accountId)) {
      return false;
    }
    return this.pilotAccountIds.has(accountId);
  }
}
