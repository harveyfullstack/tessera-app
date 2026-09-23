// Per-account rollback flag for the delivery_jobs / delivery_attempts split.
// While an account's rollback window is open, the legacy execution columns on
// delivery_jobs (status, retry_count, ...) are still written alongside
// delivery_attempts, so the account can be rolled back to the old model and
// the old/new attempt-count parity check stays valid.
//
// Only DeliveryAttemptRpc may consult this flag.
export interface DeliveryRollbackFlag {
  isRollbackWindowOpen(accountId: string): Promise<boolean>;
}
