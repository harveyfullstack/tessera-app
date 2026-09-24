export interface DeliveryRollbackFlags {
  isRollbackEnabled(accountId: string): boolean;
}

export class NoRollbackFlags implements DeliveryRollbackFlags {
  isRollbackEnabled(_accountId: string): boolean {
    return false;
  }
}

export class AccountRollbackFlags implements DeliveryRollbackFlags {
  constructor(private readonly rolledBackAccountIds: ReadonlySet<string>) {}

  isRollbackEnabled(accountId: string): boolean {
    return this.rolledBackAccountIds.has(accountId);
  }
}
