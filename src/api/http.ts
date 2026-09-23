import { JobRecordService } from "../application/job-record-service";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";
import { createHttpHandler } from "./http-handler";

const jobRecords = new JobRecordService(new InMemoryJobRepository());

export const server = Bun.serve({
  port: Number(process.env.PORT ?? "8787"),
  fetch: createHttpHandler(jobRecords, "tessera-demo-account"),
});
