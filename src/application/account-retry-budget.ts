export interface AccountRetryBudget {
  getRetryBudget(accountId: string): number;
}

const DEFAULT_RETRY_BUDGET = 8;

export class InMemoryAccountRetryBudget implements AccountRetryBudget {
  private readonly budgets = new Map<string, number>();

  setRetryBudget(accountId: string, budget: number): void {
    this.budgets.set(accountId, budget);
  }

  getRetryBudget(accountId: string): number {
    return this.budgets.get(accountId) ?? DEFAULT_RETRY_BUDGET;
  }
}
