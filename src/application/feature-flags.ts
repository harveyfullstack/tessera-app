export const DELIVERY_ATTEMPTS_ROLLBACK_FLAG = "delivery_attempts_rollback";

export interface FeatureFlagStore {
  isEnabled(flag: string): boolean;
}

export class EnvFeatureFlagStore implements FeatureFlagStore {
  isEnabled(flag: string): boolean {
    const key = flag.toUpperCase();
    const raw = process.env[key] ?? process.env[`FLAG_${key}`];
    return raw === "1" || raw === "true";
  }
}

export class StaticFeatureFlagStore implements FeatureFlagStore {
  constructor(private readonly enabled: ReadonlySet<string> = new Set()) {}

  isEnabled(flag: string): boolean {
    return this.enabled.has(flag);
  }
}
