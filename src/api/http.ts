import { createHttpApp } from "./routes";

const app = createHttpApp();

export const server = Bun.serve({
  port: Number(process.env.PORT ?? "8787"),
  fetch: (req) => app.fetch(req),
});
