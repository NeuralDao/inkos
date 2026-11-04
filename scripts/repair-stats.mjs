#!/usr/bin/env node
// Repair-rate report over a workspace harness database.
//
// Answers the question "is the pipeline healing itself, or is it hiding a
// broken prompt?" — per failure code and per role, from recorded evidence.
// Read-only: opens the database with node:sqlite, no writes.
//
// Usage: node scripts/repair-stats.mjs [--workspace <dir>] [--json]
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const opt = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const asJson = args.includes("--json");
const workspace = resolve(opt("--workspace") ?? process.cwd());
const database = join(workspace, ".inkos", "harness.sqlite");

if (!existsSync(database)) {
  console.error(`no harness database at ${database}`);
  process.exit(2);
}

const db = new DatabaseSync(database, { readOnly: true });
const rows = db.prepare("select type, payload_json from creative_episode_events order by seq").all();
db.close();

const invalid = new Map();
const repairs = new Map();
const refusals = new Map();
let repairGranted = 0;
let repairRefused = 0;

const bump = (map, key, field) => {
  const entry = map.get(key) ?? { [field]: 0 };
  entry[field] += 1;
  map.set(key, entry);
};

for (const row of rows) {
  let payload = {};
  try { payload = JSON.parse(row.payload_json ?? "{}"); } catch { payload = {}; }
  const role = payload.resultTool ?? payload.agent ?? payload.role ?? "?";
  if (row.type === "worker-result-invalid") {
    bump(invalid, `${payload.code ?? "?"}|${role}`, "count");
  } else if (row.type === "worker-repair-granted") {
    repairGranted += 1;
    bump(repairs, `${payload.code ?? "?"}|${role}`, "count");
  } else if (row.type === "worker-repair-refused") {
    repairRefused += 1;
    const key = `${payload.reason ?? "?"}|${payload.code ?? "?"}`;
    bump(refusals, key, "count");
  }
}

const table = map => [...map.entries()]
  .map(([key, value]) => ({ key, count: value.count }))
  .sort((left, right) => right.count - left.count);

const totalRejections = table(invalid).reduce((sum, item) => sum + item.count, 0);
const attempts = repairGranted + repairRefused;
const report = {
  workspace,
  events: rows.length,
  rejections: totalRejections,
  repair: {
    attempts,
    granted: repairGranted,
    refused: repairRefused,
    // Share of rejections that were handed back to the model.
    grantRate: totalRejections === 0 ? null : Number((repairGranted / totalRejections).toFixed(3)),
  },
  rejectionsByCodeAndRole: table(invalid),
  repairsByCodeAndRole: table(repairs),
  refusalsByReasonAndCode: table(refusals),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`workspace: ${report.workspace}`);
  console.log(`rejections: ${report.rejections}, repair attempts: ${attempts} (granted ${repairGranted}, refused ${repairRefused}), grant rate: ${report.repair.grantRate ?? "n/a"}`);
  console.log("\nrejections by code | role");
  for (const item of report.rejectionsByCodeAndRole) console.log(`  ${item.count}\t${item.key}`);
  if (report.refusalsByReasonAndCode.length > 0) {
    console.log("\nrepair refusals by reason | code");
    for (const item of report.refusalsByReasonAndCode) console.log(`  ${item.count}\t${item.key}`);
  }
}
