import type { DeliveryRollbackFlag } from "../../domain/delivery-rollback-flag";

// Every account's rollback window is open unless it is explicitly closed.
export class StaticDeliveryRollbackFlag implements DeliveryRollbackFlag {
  private readonly closedAccountIds: ReadonlySet<string>;

  constructor(closedAccountIds: Iterable<string> = []) {
    this.closedAccountIds = new Set(closedAccountIds);
  }

  async isRollbackWindowOpen(accountId: string): Promise<boolean> {
    return !this.closedAccountIds.has(accountId);
  }
}
