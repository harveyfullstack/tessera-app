export class DeliveryRollbackFlags {
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
