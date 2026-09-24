import { DeliveryExhaustedError, JobAlreadyRunningError } from "../domain/errors";
import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { JobRecordService } from "../application/job-record-service";

interface DeliverBody {
  briefId: string;
  customerId: string;
  subscriptionId: string;
  endpointUrl: string;
  eventType: string;
  payloadHash: string;
  workerId: string;
  simulateFailure?: boolean;
}

export function createHttpHandler(jobRecords: JobRecordService, accountId: string) {
  const delivery = new DeliveryOrchestrator(jobRecords);
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const match = /^\/briefs\/([^/]+)\/jobs$/.exec(url.pathname);
    if (req.method === "GET" && match) {
      const briefId = decodeURIComponent(match[1]!);
      await jobRecords.drainDeadLetters(accountId, briefId);
      const dlq = await jobRecords.deadLetterSummary(accountId, briefId);
      const rows = await jobRecords.listByBrief(briefId, new Date(), accountId);
      const ids = new Set(dlq.endpoints.map((endpoint) => endpoint.deliveryJobId));
      const jobs = url.searchParams.get("status") === "dlq" ? rows.filter((job) => ids.has(job.id)) : rows;
      return Response.json({ jobs, dlq });
    }
    if (req.method === "POST" && url.pathname === "/deliver") {
      const body = await req.json() as DeliverBody;
      try {
        const job = await delivery.deliver({ ...body, accountId, simulateFailure: body.simulateFailure ?? false });
        return Response.json({ job });
      } catch (error) {
        if (error instanceof DeliveryExhaustedError || error instanceof JobAlreadyRunningError) {
          return Response.json({ error: error.message }, { status: 409 });
        }
        throw error;
      }
    }
    return new Response("Not found", { status: 404 });
  };
}
