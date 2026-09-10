export interface DeliverySplitFlags {
  /** When true, execution writes mutate the legacy jobs row and skip delivery_attempts. */
  isRollbackEnabled(accountId: string): boolean;
}

export class InMemoryDeliverySplitFlags implements DeliverySplitFlags {
  private readonly rollbackAccounts = new Set<string>();

  enableRollback(accountId: string): void {
    this.rollbackAccounts.add(accountId);
  }

  disableRollback(accountId: string): void {
    this.rollbackAccounts.delete(accountId);
  }

  isRollbackEnabled(accountId: string): boolean {
    return this.rollbackAccounts.has(accountId);
  }
}
