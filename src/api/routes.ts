import { AccountRetryBudget } from "../application/account-retry-budget";
import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { DrainDlqProcessor } from "../application/drain-dlq-processor";
import { JobRecordService } from "../application/job-record-service";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";

export interface DeliverBody {
  briefId: string;
  customerId: string;
  subscriptionId: string;
  endpointUrl: string;
  eventType: string;
  payloadHash: string;
  workerId: string;
  simulateFailure?: boolean;
}

export interface HttpApp {
  jobRecords: JobRecordService;
  delivery: DeliveryOrchestrator;
  drainDlq: DrainDlqProcessor;
  budgets: AccountRetryBudget;
  accountId: string;
  fetch: (req: Request) => Promise<Response>;
}

export function createHttpApp(
  accountId = "tessera-demo-account",
  budgets: AccountRetryBudget = new AccountRetryBudget(),
): HttpApp {
  const jobRepository = new InMemoryJobRepository();
  const jobRecords = new JobRecordService(jobRepository);
  const drainDlq = new DrainDlqProcessor(jobRecords, budgets);
  const delivery = new DeliveryOrchestrator(jobRecords, drainDlq);

  return {
    jobRecords,
    delivery,
    drainDlq,
    budgets,
    accountId,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname.startsWith("/briefs/")) {
        const [, briefs, briefId, jobs] = url.pathname.split("/");
        if (briefs === "briefs" && briefId && jobs === "jobs") {
          const statusFilter = url.searchParams.get("status");
          const rows = await jobRecords.listByBrief(briefId);
          const dlq = await drainDlq.collectDlq(accountId, briefId);
          const visible = [];

          for (const job of rows) {
            if (statusFilter === "dlq" && !(await drainDlq.isDlqBound(accountId, job))) {
              continue;
            }

            visible.push({
              ...job,
              displayStatus: await jobRecords.displayStatus(job),
            });
          }

          return Response.json({ jobs: visible, dlq });
        }
      }

      if (req.method === "POST" && url.pathname === "/deliver") {
        const body = (await req.json()) as DeliverBody;
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
    },
  };
}
