export const DEFAULT_RETRY_BUDGET = 8;

// Retry budget per account, counted in runs (started deliveries), not in
// attempt rows. Accounts without an override use DEFAULT_RETRY_BUDGET.
export class RetryBudgetPolicy {
  private readonly overrides: ReadonlyMap<string, number>;

  constructor(
    overrides: ReadonlyMap<string, number> = new Map(),
    private readonly defaultBudget: number = DEFAULT_RETRY_BUDGET,
  ) {
    assertValidBudget("default", defaultBudget);
    for (const [accountId, budget] of overrides) {
      assertValidBudget(accountId, budget);
    }
    this.overrides = new Map(overrides);
  }

  budgetFor(accountId: string): number {
    return this.overrides.get(accountId) ?? this.defaultBudget;
  }
}

function assertValidBudget(scope: string, budget: number): void {
  if (!Number.isInteger(budget) || budget < 1) {
    throw new RangeError(`Retry budget for ${scope} must be a positive integer, got ${budget}`);
  }
}
