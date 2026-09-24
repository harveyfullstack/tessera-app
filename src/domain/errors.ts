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

export class AttemptNumberConflictError extends Error {
  constructor(deliveryJobId: string, attemptNumber: number) {
    super(`Attempt ${attemptNumber} already exists for delivery job: ${deliveryJobId}`);
  }
}

export class NoRunningAttemptError extends Error {
  constructor(deliveryJobId: string) {
    super(`No running attempt to finish for delivery job: ${deliveryJobId}`);
  }
}

export class DeliveryAttemptMutationError extends Error {}
