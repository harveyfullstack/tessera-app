export class JobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Job not found: ${jobId}`);
  }
}

export class JobAlreadyRunningError extends Error {
  constructor(jobId: string) {
    super(`Delivery is already running for job: ${jobId}`);
  }
}

export class DeliveryAttemptConflictError extends Error {
  constructor(deliveryJobId: string, attemptNumber: number) {
    super(`Delivery attempt ${attemptNumber} already exists for job: ${deliveryJobId}`);
  }
}
