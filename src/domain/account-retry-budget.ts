export const DEFAULT_RETRY_BUDGET = 8;

export interface AccountRetryBudget {
  getRetryBudget(accountId: string): number;
}
