import {
  DEFAULT_RETRY_BUDGET,
  type AccountRetryBudget,
} from "../domain/account-retry-budget";

export class InMemoryAccountRetryBudget implements AccountRetryBudget {
  private readonly budgets = new Map<string, number>();

  setRetryBudget(accountId: string, budget: number): void {
    this.budgets.set(accountId, budget);
  }

  getRetryBudget(accountId: string): number {
    return this.budgets.get(accountId) ?? DEFAULT_RETRY_BUDGET;
  }
}
