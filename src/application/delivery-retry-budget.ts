export const DEFAULT_RETRY_BUDGET = 8;

export const DELIVERY_RETRY_BUDGETS_ENV = "TESSERA_DELIVERY_RETRY_BUDGETS";

function parseBudget(raw: string | undefined): number | null {
  const budget = Number(raw);
  return Number.isInteger(budget) && budget > 0 ? budget : null;
}

// Parses "acct-a=5,acct-b=12". Entries without a positive integer budget are
// ignored, so a malformed override falls back to the default.
function parseAccountBudgets(raw: string | undefined): Array<[string, number]> {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.split("="))
    .flatMap(([accountId, value]): Array<[string, number]> => {
      const id = accountId?.trim() ?? "";
      const budget = parseBudget(value?.trim());
      return id.length > 0 && budget !== null ? [[id, budget]] : [];
    });
}

// Per-account delivery retry budget: the number of executions a delivery may
// use before it moves to the Dead Letter Queue.
export class DeliveryRetryBudget {
  private readonly accountBudgets: ReadonlyMap<string, number>;

  constructor(
    accountBudgets: Iterable<[string, number]> = [],
    private readonly defaultBudget: number = DEFAULT_RETRY_BUDGET,
  ) {
    this.accountBudgets = new Map(accountBudgets);
  }

  static fromEnv(env: Record<string, string | undefined>): DeliveryRetryBudget {
    return new DeliveryRetryBudget(parseAccountBudgets(env[DELIVERY_RETRY_BUDGETS_ENV]));
  }

  forAccount(accountId: string): number {
    return this.accountBudgets.get(accountId) ?? this.defaultBudget;
  }
}
