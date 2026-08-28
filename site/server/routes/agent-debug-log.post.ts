import { appendFileSync } from "node:fs";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const line = typeof body === "string" ? body : JSON.stringify(body);
  appendFileSync("/opt/cursor/logs/debug.log", `${line.trim()}\n`);
  setResponseStatus(event, 204);
  return null;
});
