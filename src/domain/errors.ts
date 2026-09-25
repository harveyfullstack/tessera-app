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

export class JobDeadLetteredError extends Error {
  constructor(jobId: string) {
    super(`Delivery is in the dead letter queue: ${jobId}`);
  }
}

export class DeliveryRollbackUnavailableError extends Error {
  constructor(accountId: string) {
    super(`Rollback is unavailable for account: ${accountId}`);
  }
}
