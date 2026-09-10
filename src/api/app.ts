import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { DrainDlqProcessor } from "../application/drain-dlq-processor";
import { JobRecordService } from "../application/job-record-service";
import { AccountRetryBudgetRegistry } from "../application/account-retry-budget";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";

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

export interface AppDependencies {
  jobRecords: JobRecordService;
  delivery: DeliveryOrchestrator;
  drainDlq: DrainDlqProcessor;
  accountId: string;
}

export function createAppDependencies(
  accountId = "tessera-demo-account",
  budgets = new AccountRetryBudgetRegistry(),
): AppDependencies {
  const jobRepository = new InMemoryJobRepository();
  const jobRecords = new JobRecordService(jobRepository, undefined, budgets);
  return {
    jobRecords,
    delivery: new DeliveryOrchestrator(jobRecords),
    drainDlq: new DrainDlqProcessor(jobRecords),
    accountId,
  };
}

export function createApp(deps: AppDependencies = createAppDependencies()) {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);

      if (req.method === "GET" && parts[0] === "briefs" && parts[2] === "jobs" && parts[1]) {
        const status = url.searchParams.get("status") ?? undefined;
        const payload = await deps.jobRecords.listJobsResponse(parts[1], status);
        return Response.json(payload);
      }

      if (req.method === "POST" && parts[0] === "briefs" && parts[2] === "drain-dlq" && parts[1]) {
        const result = await deps.drainDlq.process(parts[1], deps.accountId);
        return Response.json(result);
      }

      if (req.method === "POST" && url.pathname === "/deliver") {
        const body = (await req.json()) as DeliverBody;
        const result = await deps.delivery.deliver({
          accountId: deps.accountId,
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
    },
  };
}
