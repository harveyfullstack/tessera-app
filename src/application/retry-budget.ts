export const DEFAULT_RETRY_BUDGET = 8;

export type RetryBudgetResolver = (accountId: string) => number;

export function createRetryBudgetResolver(
  configuration: string,
): RetryBudgetResolver {
  const budgets = new Map<string, number>();

  for (const entry of configuration.split(",").filter((item) => item.trim())) {
    const [rawAccountId, rawBudget, ...extra] = entry.split("=");
    const accountId = rawAccountId?.trim();
    const budgetText = rawBudget?.trim();
    const budget = Number(budgetText);

    if (
      !accountId ||
      extra.length > 0 ||
      !budgetText ||
      !/^\d+$/.test(budgetText) ||
      !Number.isSafeInteger(budget) ||
      budgets.has(accountId)
    ) {
      throw new Error(
        `Invalid WEBHOOK_DELIVERY_RETRY_BUDGETS entry: ${entry}`,
      );
    }

    budgets.set(accountId, budget);
  }

  return (accountId) => budgets.get(accountId) ?? DEFAULT_RETRY_BUDGET;
}
