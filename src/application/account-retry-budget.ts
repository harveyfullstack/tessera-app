export const DEFAULT_RETRY_BUDGET = 8;

export class AccountRetryBudget {
  constructor(private readonly overrides = new Map<string, number>()) {}

  get(accountId: string): number {
    return this.overrides.get(accountId) ?? DEFAULT_RETRY_BUDGET;
  }

  set(accountId: string, budget: number): void {
    this.overrides.set(accountId, budget);
  }
}
