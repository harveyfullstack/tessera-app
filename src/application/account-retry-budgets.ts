export const DEFAULT_RETRY_BUDGET = 8;

export class AccountRetryBudgets {
  private readonly budgets = new Map<string, number>();

  get(accountId: string): number {
    return this.budgets.get(accountId) ?? DEFAULT_RETRY_BUDGET;
  }

  set(accountId: string, budget: number): void {
    this.budgets.set(accountId, budget);
  }
}
