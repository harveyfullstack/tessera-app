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

export class AttemptNumberContentionError extends Error {
  constructor(deliveryJobId: string, tries: number) {
    super(`Could not allocate an attempt number for delivery job ${deliveryJobId} after ${tries} tries`);
  }
}

export class PilotAccountLimitError extends Error {
  constructor(limit: number, received: number) {
    super(`Delivery split pilot allows at most ${limit} accounts, received ${received}`);
  }
}
