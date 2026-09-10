export const DEFAULT_RETRY_BUDGET = 8;

export interface RetryBudgetPolicy {
  budgetFor(accountId: string): number;
}

export class InMemoryRetryBudgetPolicy implements RetryBudgetPolicy {
  private readonly budgets = new Map<string, number>();

  setBudget(accountId: string, budget: number): void {
    this.budgets.set(accountId, budget);
  }

  budgetFor(accountId: string): number {
    return this.budgets.get(accountId) ?? DEFAULT_RETRY_BUDGET;
  }
}
