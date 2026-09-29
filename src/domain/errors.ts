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

export class UnexpectedJobTypeError extends Error {
  constructor(jobId: string, expected: string, actual: string) {
    super(`Job ${jobId} has type ${actual}, expected ${expected}`);
  }
}
