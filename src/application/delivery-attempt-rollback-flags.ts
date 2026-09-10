export interface DeliveryAttemptRollbackFlags {
  isRollbackEnabled(accountId: string): boolean;
}

export class InMemoryDeliveryAttemptRollbackFlags implements DeliveryAttemptRollbackFlags {
  private readonly enabledAccounts = new Set<string>();

  enable(accountId: string): void {
    this.enabledAccounts.add(accountId);
  }

  disable(accountId: string): void {
    this.enabledAccounts.delete(accountId);
  }

  isRollbackEnabled(accountId: string): boolean {
    return this.enabledAccounts.has(accountId);
  }
}
