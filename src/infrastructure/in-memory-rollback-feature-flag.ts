import type { RollbackFeatureFlag } from "../domain/rollback-feature-flag";

export class InMemoryRollbackFeatureFlag implements RollbackFeatureFlag {
  private readonly accounts: Set<string>;

  constructor(enabledAccounts: readonly string[] = []) {
    this.accounts = new Set(enabledAccounts);
  }

  isEnabled(accountId: string): boolean {
    return this.accounts.has(accountId);
  }
}
