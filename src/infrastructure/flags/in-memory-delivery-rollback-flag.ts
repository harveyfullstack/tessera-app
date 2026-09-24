import type { DeliveryRollbackFlag } from "../../domain/delivery-rollback-flag";

export class InMemoryDeliveryRollbackFlag implements DeliveryRollbackFlag {
  private readonly rolledBackAccounts: ReadonlySet<string>;

  constructor(rolledBackAccountIds: readonly string[] = []) {
    this.rolledBackAccounts = new Set(rolledBackAccountIds);
  }

  async isRollbackEnabled(accountId: string): Promise<boolean> {
    return this.rolledBackAccounts.has(accountId);
  }
}
