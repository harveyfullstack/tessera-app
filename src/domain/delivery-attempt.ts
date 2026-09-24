export type TerminalAttemptStatus = "completed" | "failed" | "cancelled";

export type DeliveryAttemptStatus = "running" | TerminalAttemptStatus;

// One row is one execution of a delivery job (delivery_attempts).
export interface DeliveryAttempt {
  id: string;
  deliveryJobId: string;
  attemptNumber: number;
  workerId?: string | undefined;
  status: DeliveryAttemptStatus;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
  startedAt: Date;
  completedAt?: Date | undefined;
}

export interface NewDeliveryAttempt {
  deliveryJobId: string;
  attemptNumber: number;
  workerId?: string | undefined;
  status: DeliveryAttemptStatus;
}
