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

export class DuplicateDeliveryJobError extends Error {
  constructor(accountId: string, briefId: string, type: string) {
    super(`Delivery job already exists for account=${accountId} brief=${briefId} type=${type}`);
  }
}

export class DuplicateDeliveryAttemptError extends Error {
  constructor(deliveryJobId: string, attemptNumber: number) {
    super(`Delivery attempt already exists for job=${deliveryJobId} attempt=${attemptNumber}`);
  }
}
