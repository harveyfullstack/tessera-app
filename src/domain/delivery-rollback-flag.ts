// Per-account rollback flag for the delivery_jobs / delivery_attempts split.
// When enabled for an account, execution writes keep the legacy jobs-row
// behavior.
export interface DeliveryRollbackFlag {
  isRollbackEnabled(accountId: string): Promise<boolean>;
}
