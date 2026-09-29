export const DEFAULT_RETRY_BUDGET = 8;

// Per-account delivery retry budget. Overrides are supplied at configuration
// time, never hardcoded; accounts without one use DEFAULT_RETRY_BUDGET.
export class RetryBudgetPolicy {
  private readonly overrides: ReadonlyMap<string, number>;

  constructor(overrides: ReadonlyMap<string, number> = new Map<string, number>()) {
    for (const [accountId, budget] of overrides) {
      if (!Number.isInteger(budget) || budget < 1) {
        throw new RangeError(`Retry budget for ${accountId} must be a positive integer`);
      }
    }

    this.overrides = new Map(overrides);
  }

  budgetFor(accountId: string): number {
    return this.overrides.get(accountId) ?? DEFAULT_RETRY_BUDGET;
  }
}
