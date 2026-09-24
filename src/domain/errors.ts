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
  constructor(jobId: string) {
    super(`Delivery job not found: ${jobId}`);
  }
}

export class DuplicateDeliveryJobError extends Error {
  constructor(accountId: string, briefId: string, type: string) {
    super(`Delivery job already exists for account ${accountId}, brief ${briefId}, type ${type}`);
  }
}

export class DuplicateDeliveryAttemptError extends Error {
  constructor(deliveryJobId: string, attemptNumber: number) {
    super(`Delivery attempt ${attemptNumber} already exists for job ${deliveryJobId}`);
  }
}

export class DeliveryJobDeleteRestrictedError extends Error {
  constructor(deliveryJobId: string, attemptCount: number) {
    super(
      `Cannot delete delivery job ${deliveryJobId}: foreign key constraint restrict prevents deletion with ${attemptCount} existing delivery attempts`,
    );
  }
}
