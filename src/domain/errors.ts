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

export class DeliveryExhaustedError extends Error {
  constructor(jobId: string) {
    super(`Delivery retry budget exhausted for job: ${jobId}`);
  }
}
