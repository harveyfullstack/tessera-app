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

export class DuplicateIntentError extends Error {
  constructor(accountId: string, briefId: string, type: string) {
    super(`Delivery job already exists for (${accountId}, ${briefId}, ${type})`);
  }
}

export class DuplicateAttemptError extends Error {
  constructor(deliveryJobId: string, attemptNumber: number) {
    super(`Delivery attempt ${attemptNumber} already exists for job ${deliveryJobId}`);
  }
}
