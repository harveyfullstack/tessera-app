import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { DrainDlqProcessor } from "../application/drain-dlq-processor";
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

export function createHttpHandler(
  jobRecords: JobRecordService,
  accountId: string,
  drain = new DrainDlqProcessor(jobRecords),
) {
  const delivery = new DeliveryOrchestrator(jobRecords);
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const jobsPath = /^\/briefs\/([^/]+)\/jobs$/.exec(url.pathname);
    if (req.method === "GET" && jobsPath?.[1]) {
      const rows = await jobRecords.listByBrief(jobsPath[1], accountId);
      const dlq = await drain.summarize(rows);
      const status = url.searchParams.get("status");
      const projected = rows.map((job) => ({ ...job, status: JobRecordService.displayStatus(job) }));
      return Response.json({ jobs: status ? projected.filter((job) => job.status === status) : projected, dlq });
    }

    const drainPath = /^\/briefs\/([^/]+)\/drain-dlq$/.exec(url.pathname);
    if (req.method === "POST" && drainPath?.[1]) {
      const body: unknown = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || !("workerId" in body) ||
        typeof body.workerId !== "string" || !body.workerId.trim()) {
        return Response.json({ error: "workerId is required" }, { status: 400 });
      }
      const job = await drain.process(accountId, drainPath[1], body.workerId);
      return Response.json({ job });
    }

    if (req.method === "POST" && url.pathname === "/deliver") {
      const body = await req.json() as DeliverBody;
      const result = await delivery.deliver({
        accountId,
        briefId: body.briefId,
        customerId: body.customerId,
        subscriptionId: body.subscriptionId,
        endpointUrl: body.endpointUrl,
        eventType: body.eventType,
        payloadHash: body.payloadHash,
        workerId: body.workerId,
        simulateFailure: body.simulateFailure ?? false,
      });
      return Response.json({ job: result });
    }
    return new Response("Not found", { status: 404 });
  };
}
