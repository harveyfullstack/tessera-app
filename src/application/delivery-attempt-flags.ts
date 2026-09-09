export interface DeliveryAttemptFlagSource {
  isRollbackEnabled(): boolean;
}

export const DELIVERY_ATTEMPTS_ROLLBACK_ENV = "DELIVERY_ATTEMPTS_ROLLBACK";

export function isDeliveryAttemptsRollbackEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[DELIVERY_ATTEMPTS_ROLLBACK_ENV] ?? "";
  return value === "1" || value.toLowerCase() === "true";
}

export const envDeliveryAttemptFlags: DeliveryAttemptFlagSource = {
  isRollbackEnabled: () => isDeliveryAttemptsRollbackEnabled(),
};
