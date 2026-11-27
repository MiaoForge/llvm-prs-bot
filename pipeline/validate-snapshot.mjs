import { deepStrictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schemaDir = new URL("../schemas/", import.meta.url);
const mockDir = fileURLToPath(new URL("../data/", import.meta.url));
const schemaNames = ["common", "summary", "prs-index", "issues-index", "pr", "issue"];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}

const schemas = Object.fromEntries(schemaNames.map((name) => [
  name, readJson(new URL(`${name}.schema.json`, schemaDir)),
]));

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const schema of Object.values(schemas)) {
  ajv.addSchema(schema);
}
const validators = Object.fromEntries(schemaNames.map((name) => [
  name, ajv.getSchema(schemas[name].$id),
]));

function requireThat(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function same(actual, expected, context) {
  try {
    deepStrictEqual(actual, expected);
  } catch (error) {
    throw new Error(`${context}\n${error.message}`);
  }
}

function pickFields(object, fields) {
  return Object.fromEntries(fields.map((field) => [field, object[field]]));
}

function countItems(prs, issues) {
  const { prQueue, issueConclusion } = schemas.common.$defs;
  const prQueues = Object.fromEntries(prQueue.enum.map((queue) => [queue, 0]));
  const issueConclusions = Object.fromEntries(
    issueConclusion.enum.map((conclusion) => [conclusion, 0]),
  );
  for (const pr of prs.values()) {
    for (const queue of pr.queues) {
      prQueues[queue]++;
    }
  }
  let generatedByFuzzer = 0;
  for (const issue of issues.values()) {
    issueConclusions[issue.conclusion]++;
    if (issue.source === "generated-by-fuzzer") {
      generatedByFuzzer++;
    }
  }
  return { prTotal: prs.size, issueTotal: issues.size, prQueues, issueConclusions, generatedByFuzzer };
}

function validatePr(pr, path) {
  for (const observation of [pr.headReview, pr.headCi, ...pr.requiredChecks]) {
    requireThat(observation.commitSha === pr.headSha, `${path}: HEAD evidence SHA mismatch`);
  }
  if (pr.latestApproval === null) {
    requireThat(pr.commitsSinceApproval === null, `${path}: commit distance requires an approval`);
  } else if (pr.latestApproval.commitSha === pr.headSha) {
    requireThat(pr.commitsSinceApproval === 0, `${path}: HEAD approval requires zero new commits`);
  }
}

function validateIssue(issue, path) {
  same(issue.fixStatus, issue.fixAttribution.status, `${path}: fix attribution and status disagree`);
  for (const side of ["baseline", "trunk"]) {
    const run = issue.runs[side];
    const preview = run === null ? null : pickFields(run, ["compilerVersion", "outcome"]);
    same(issue[side], preview, `${path}: ${side} preview and run disagree`);
  }

  const hasRepro = Object.values(pickFields(issue.repro, [
    "sourceCode", "compileArgs", "expectedBehavior",
  ])).every((value) => value !== null);
  const baselineReproduced = issue.baseline?.outcome === "reported-symptom";
  const trunkOutcome = issue.trunk?.outcome;
  const conclusive = hasRepro && baselineReproduced;
  const missingSignature = issue.kind === "crash" && issue.source === "generated-by-fuzzer"
    && issue.crashSignature === null;
  const missing = issue.missingEvidence;
  if (issue.conclusion === "insufficient-evidence") {
    requireThat(missing.length > 0, `${path}: insufficient evidence requires a reason`);
    for (const [absent, reason] of [
      [issue.repro.sourceCode === null, "source-code"],
      [issue.repro.compileArgs === null, "compile-arguments"],
      [issue.repro.expectedBehavior === null, "expected-behavior"],
      [issue.baseline === null, "baseline-run"],
      [issue.baseline !== null && !baselineReproduced, "baseline-symptom"],
      [issue.trunk === null, "trunk-run"],
      [trunkOutcome === "unknown" || trunkOutcome === "different-behavior", "trunk-outcome"],
      [missingSignature, "crash-signature"],
    ]) {
      requireThat(!absent || missing.includes(reason), `${path}: missingEvidence must include ${reason}`);
    }
    return;
  }
  const expected = issue.conclusion === "close-candidate" ? "expected-behavior" : "reported-symptom";
  requireThat(conclusive && trunkOutcome === expected,
    `${path}: ${issue.conclusion} requires a reproducing baseline and ${expected} on trunk`);
  requireThat(missing.length === 0 && !missingSignature,
    `${path}: a conclusive result requires complete evidence`);
  requireThat(issue.lastVerifiedAt !== null, `${path}: a conclusive result requires a verification time`);
}

function validateSnapshot(dir) {
  function checked(path, schemaName) {
    const data = readJson(path);
    const validate = validators[schemaName];
    requireThat(validate(data), `${path}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`);
    return data;
  }

  const summary = checked(join(dir, "summary.json"), "summary");
  const { schemaVersion, snapshotId, snapshotRoot } = summary;
  requireThat(snapshotRoot === `snapshots/${snapshotId}/`, "summary.json: snapshotRoot and snapshotId disagree");
  const root = join(dir, snapshotRoot);
  function checkedShard(relativePath, schemaName) {
    const path = join(root, relativePath);
    const shard = checked(path, schemaName);
    requireThat(shard.schemaVersion === schemaVersion && shard.snapshotId === snapshotId,
      `${path}: shard belongs to another snapshot`);
    return shard;
  }

  const allItems = { pr: new Map(), issue: new Map() };
  const modules = new Set();
  for (const module of summary.modules) {
    requireThat(!modules.has(module.id), `summary.json: duplicate module ${module.id}`);
    modules.add(module.id);

    const moduleItems = { pr: new Map(), issue: new Map() };
    for (const [kind, indexName, validateDetail] of [
      ["pr", "prs-index", validatePr],
      ["issue", "issues-index", validateIssue],
    ]) {
      const indexPath = `modules/${module.id}/${indexName}.json`;
      const index = checkedShard(indexPath, indexName);
      requireThat(index.moduleId === module.id, `${indexPath}: module ID mismatch`);
      const indexFields = Object.keys(schemas.common.$defs[`${kind}ListFields`].properties);
      for (const row of index.items) {
        const context = `${indexPath}: item ${row.id}`;
        requireThat(!moduleItems[kind].has(row.id), `${context}: duplicate ID`);
        requireThat(row.moduleIds.includes(module.id), `${context}: missing current module membership`);

        if (!allItems[kind].has(row.id)) {
          const detailPath = `items/${kind}-${row.id}.json`;
          const detail = checkedShard(detailPath, kind);
          validateDetail(detail, detailPath);
          allItems[kind].set(row.id, { detail, indexedModules: [] });
        }
        const record = allItems[kind].get(row.id);
        same(row, pickFields(record.detail, indexFields), `${context}: index and detail disagree`);
        record.indexedModules.push(module.id);
        moduleItems[kind].set(row.id, row);
      }
    }
    same(module.counts, countItems(moduleItems.pr, moduleItems.issue), `Module ${module.id}: counts disagree`);
  }

  function uniqueRows(kind) {
    const rows = new Map();
    for (const [id, { detail, indexedModules }] of allItems[kind]) {
      same(indexedModules.sort(), [...detail.moduleIds].sort(), `${kind}-${id}: listed modules disagree`);
      rows.set(id, detail);
    }
    return rows;
  }
  const kpis = countItems(uniqueRows("pr"), uniqueRows("issue"));
  same(summary.kpis, kpis, "summary.json: global KPIs disagree");
  return { snapshotId, modules: modules.size, ...kpis };
}

try {
  requireThat(process.argv.length <= 3, "Usage: node validate-snapshot.mjs [data-directory]");
  const result = validateSnapshot(process.argv[2] ?? mockDir);
  console.log(`Validated ${result.snapshotId}: ${result.modules} modules, `
    + `${result.prTotal} unique PRs, ${result.issueTotal} unique issues `
    + `(${result.generatedByFuzzer} generated by fuzzer).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
