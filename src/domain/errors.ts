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

export class DeliveryJobNotFoundError extends Error {
  constructor(deliveryJobId: string) {
    super(`Delivery job not found: ${deliveryJobId}`);
  }
}

export class DeliveryAttemptConflictError extends Error {
  constructor(deliveryJobId: string, attemptNumber: number) {
    super(`Delivery attempt ${attemptNumber} already exists for delivery job: ${deliveryJobId}`);
  }
}
