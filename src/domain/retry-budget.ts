export class AccountRetryBudgets {
  static readonly defaultAttempts = 8;

  constructor(private readonly overrides: ReadonlyMap<string, number> = new Map()) {}

  forAccount(accountId: string): number {
    return this.overrides.get(accountId) ?? AccountRetryBudgets.defaultAttempts;
  }
}
