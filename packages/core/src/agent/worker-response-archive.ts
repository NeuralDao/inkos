import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";

export interface WorkerResponseArchiveContext {
  readonly projectRoot: string;
  readonly workId?: string;
  readonly role: string;
}

export interface WorkerResponseArchiveOutcome {
  readonly stage: "schema" | "domain";
  readonly status: "passed" | "failed";
  readonly code?: string;
  readonly message?: string;
}

function pathPart(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

function rolePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60) || "worker";
}

/** Save a raw assistant response before any caller or validator consumes it. */
export async function archiveWorkerResponse(input: {
  readonly context: WorkerResponseArchiveContext;
  readonly model: Model<Api>;
  readonly response: AssistantMessage | { readonly type: "tool_call"; readonly id: string; readonly name: string; readonly arguments: unknown };
  readonly attempt: number;
}): Promise<string> {
  const workPath = pathPart(input.context.workId ?? "unbound-work");
  const directory = join(input.context.projectRoot, ".inkos", "agent-runs", workPath, "worker-responses");
  await mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(directory, `${timestamp}-${rolePart(input.context.role)}-${randomUUID()}.json`);
  const envelope = {
    schemaVersion: 1,
    receivedAt: new Date().toISOString(),
    workId: input.context.workId ?? null,
    agentRole: input.context.role,
    attempt: input.attempt,
    model: { id: input.model.id, provider: input.model.provider, api: input.model.api },
    validation: { status: "received_before_processing", stages: [] },
    response: input.response,
  };
  await writeFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return filePath;
}

/** Attach the host's validation result after the original response is durable. */
export async function markWorkerResponseArchive(path: string, outcome: WorkerResponseArchiveOutcome): Promise<void> {
  const document = JSON.parse(await readFile(path, "utf8")) as {
    validation?: { status?: string; stages?: WorkerResponseArchiveOutcome[] };
  };
  document.validation = { status: "checked", stages: [...(document.validation?.stages ?? []), outcome] };
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}
