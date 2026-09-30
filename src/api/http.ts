import { createHttpHandler } from "./handler";
import { DeliveryOrchestrator } from "../application/delivery-orchestrator";
import { JobRecordService } from "../application/job-record-service";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";

const jobRepository = new InMemoryJobRepository();
const jobRecords = new JobRecordService(jobRepository);
const delivery = new DeliveryOrchestrator(jobRecords);


export const server = Bun.serve({
  port: Number(process.env.PORT ?? "8787"),
  fetch: createHttpHandler(jobRecords, delivery),
});
