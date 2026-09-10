export interface RollbackFeatureFlag {
  isEnabled(accountId: string): boolean;
}
