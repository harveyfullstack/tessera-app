export const DEFAULT_RETRY_BUDGET = 8;

function assertValidBudget(budget: number, label: string): void {
  if (!Number.isInteger(budget) || budget < 1) {
    throw new RangeError(`Retry budget for ${label} must be a positive integer, got ${budget}`);
  }
}

// Maximum number of delivery attempts (attempt rows) per delivery job before
// the job's endpoint is DLQ-bound. Defaults to 8, overridable per account.
export class RetryBudgetPolicy {
  private readonly overrides: ReadonlyMap<string, number>;

  constructor(
    accountOverrides: ReadonlyMap<string, number> = new Map(),
    private readonly defaultBudget: number = DEFAULT_RETRY_BUDGET,
  ) {
    assertValidBudget(defaultBudget, "default");
    for (const [accountId, budget] of accountOverrides) {
      assertValidBudget(budget, `account ${accountId}`);
    }
    this.overrides = new Map(accountOverrides);
  }

  budgetFor(accountId: string): number {
    return this.overrides.get(accountId) ?? this.defaultBudget;
  }
}
