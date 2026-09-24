import type { DlqDrainProcessor, DlqEndpoint } from "../application/dlq-drain-processor";
import type { JobRecordService } from "../application/job-record-service";
import type { JobRecord } from "../domain/job";

export interface BriefJobsBody {
  jobs: JobRecord[];
  dlq: {
    count: number;
    endpoints: Array<Pick<DlqEndpoint, "endpointUrl" | "bodies">>;
  };
}

function jobKey(job: JobRecord): string {
  return `${job.accountId}\0${job.metadata.endpointUrl}`;
}

export function briefIdFromJobsPath(pathname: string): string | null {
  const parts = pathname.split("/");
  if (parts.length === 4 && parts[1] === "briefs" && parts[2] && parts[3] === "jobs") {
    return parts[2];
  }
  return null;
}

export async function loadBriefJobs(
  briefId: string,
  status: string | null,
  jobRecords: JobRecordService,
  dlqDrain: DlqDrainProcessor,
): Promise<BriefJobsBody> {
  const endpoints = await dlqDrain.endpointsPastBudget(briefId);
  const bound = new Set(endpoints.map((endpoint) => `${endpoint.accountId}\0${endpoint.endpointUrl}`));
  const rows = await jobRecords.listByBrief(briefId);
  const jobs = status === "dlq" ? rows.filter((job) => bound.has(jobKey(job))) : rows;
  return {
    jobs,
    dlq: {
      count: endpoints.length,
      endpoints: endpoints.map((endpoint) => ({
        endpointUrl: endpoint.endpointUrl,
        bodies: endpoint.bodies,
      })),
    },
  };
}
