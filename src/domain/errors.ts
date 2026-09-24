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

export class DeliverySchemaMigrationError extends Error {
  constructor(message: string) {
    super(message);
  }
}
