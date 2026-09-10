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
  constructor(
    readonly accountId: string,
    readonly briefId: string,
    readonly type: string,
  ) {
    super(`Delivery job already exists for ${accountId}/${briefId}/${type}`);
  }
}
