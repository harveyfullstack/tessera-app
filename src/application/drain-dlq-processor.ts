import { JobRecordService } from "./job-record-service";
import type { JobRecord } from "../domain/job";

/** The drain_dlq work item targets an existing dispatch job, never a new endpoint key. */
export class DrainDlqProcessor {
  readonly type = "drain_dlq" as const;

  constructor(private readonly jobRecords: JobRecordService) {}

  async process(jobId: string): Promise<JobRecord> {
    return this.jobRecords.drainDlq(jobId);
  }
}
