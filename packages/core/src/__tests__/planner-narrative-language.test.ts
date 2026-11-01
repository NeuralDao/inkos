import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { PlannerAgent } from "../agents/planner.js";
import { createLLMClient } from "../llm/provider.js";
import type { BookConfig } from "../models/book.js";
import { createInitialRuntimeState } from "../state/runtime-state-store.js";

it("plans in Russian for a Russian narrative while preserving operational language and identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-planner-narrative-language-"));
  const bookDir = join(root, "book");
  const requests: Array<{ messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const name = body.tools[0].function.name;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{
      id: "chapter-plan", type: "function", function: { name, arguments: JSON.stringify({
        goal: "Ирина должна выяснить, кто заменил страницу.",
        body: "- Она сверяет подписи.\n- Находит следы подмены в журнале.",
        threadRefs: ["hook:ledger-page-4"],
      }) },
    }] } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await createInitialRuntimeState({ bookDir, language: "en" });
    await mkdir(join(bookDir, "story", "outline"), { recursive: true });
    await writeFile(join(bookDir, "story", "outline", "story_frame.md"), "# Рамка\nИрина ищет подменённую страницу.");
    await writeFile(join(bookDir, "story", "outline", "volume_map.md"), "# План\nИрина проверяет архив.");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind a TCP port.");
    const client = createLLMClient({
      service: "custom", provider: "openai", configSource: "studio", model: "fixture", apiKey: "fixture",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiFormat: "chat", stream: false, thinkingBudget: 0, temperature: 0,
    });
    const book: BookConfig = {
      id: "book", title: "Подменённая страница", genre: "mystery", platform: "other", status: "active",
      language: "en", narrativeLanguage: "ru", targetChapters: 3, chapterWordCount: 1200,
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    };
    const result = await new PlannerAgent({ client, model: "fixture", projectRoot: root })
      .planChapter({ book, bookDir, chapterNumber: 1 });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages.find(message => message.role === "system")?.content)
      .toContain("goal and body, must be written in Russian");
    expect(requests[0]!.messages.find(message => message.role === "user")?.content)
      .toContain("Write the goal and readable chapter plan in Russian");
    expect(result.memo.threadRefs).toEqual(["hook:ledger-page-4"]);
    expect(result.intentMarkdown).toContain("# План главы 1");
    expect(result.intentMarkdown).toContain("### Связанные линии\n- hook:ledger-page-4");
    expect(await readFile(result.runtimePath, "utf8")).toBe(result.intentMarkdown);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
