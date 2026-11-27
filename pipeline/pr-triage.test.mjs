import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyModules } from "./modules.mjs";
import { triagePr } from "./pr-triage.mjs";

const headSha = "a".repeat(40);
const oldSha = "b".repeat(40);
const url = "https://llvm.example.invalid/pull/10";
const touchedPath = "clang/lib/Sema/SemaDecl.cpp";
const now = "2026-11-27T00:00:00Z";

function event(day, kind, actor, commitSha, extra) {
  return {
    at: `2026-11-${day}T00:00:00Z`,
    kind, actor, commitSha, isBot: false, description: kind, url: `${url}#event-${day}`,
    ...extra,
  };
}

const review = (day, commitSha, reviewState, extra) =>
  event(day, "review", "reviewer", commitSha, { reviewState, ...extra });
const check = (status, commitSha, required = true) => ({
  name: `test-${status}`, status, commitSha, required,
});

function triage(overrides, options) {
  return triagePr({
    id: 10, title: "Sema change", author: "author", createdAt: "2026-03-01T00:00:00Z",
    headSha, url, paths: [touchedPath], reviewsComplete: true,
    ...overrides,
  }, { now, ...options });
}

test("classifies one PR across path- and label-based modules", () => {
  assert.deepEqual(classifyModules({ paths: [touchedPath], labels: [" Clang: AST "] }),
    ["clang-sema", "clang-ast"]);
  assert.deepEqual(classifyModules({ paths: ["clang/test/SemaTemplate/example.cpp"] }),
    ["clang-sema"]);
  assert.deepEqual(classifyModules({ paths: ["clang/lib/SemaTools/tool.cpp"] }), []);
  assert.equal(triage({ paths: [] }), null);
});

test("keeps an approval on an old SHA separate from review on HEAD", () => {
  const approval = review("02", oldSha, "approved");
  const push = event("03", "commit", "author", headSha);
  const options = { events: [push, approval], commitsAheadBySha: { [oldSha]: 2 } };
  const pr = triage(options);
  assert.deepEqual(pr.headReview, { status: "review-required", commitSha: headSha });
  assert.deepEqual(pr.latestApproval, { commitSha: oldSha, approvedAt: approval.at });
  assert.equal(pr.commitsSinceApproval, 2);
  assert.equal(triage({ ...options, commitsAheadBySha: {} }).commitsSinceApproval, null);
  assert.equal(triage({ ...options, commitsAheadBySha: { [oldSha]: 0 } }).commitsSinceApproval, null);
  assert.deepEqual(pr.queues, ["approved-follow-up"]);
  assert.deepEqual(pr.reasonEvidenceUrls, [approval.url, push.url]);
  assert.match(pr.reason, /2 commit/);
  assert.deepEqual(pr.timeline.map((entry) => entry.at), [approval.at, push.at]);
});

test("uses current approval and does not promote a dismissed or bot review", () => {
  const approval = review("02", headSha, "approved");
  assert.equal(triage({ events: [approval] }).headReview.status, "approved");
  assert.equal(triage({ events: [approval] }).commitsSinceApproval, 0);
  assert.equal(triage({ events: [approval], reviewsComplete: false }).headReview.status, "unknown");
  const dismissed = review("03", headSha, "dismissed");
  const bot = review("04", headSha, "approved", { isBot: true });
  const pr = triage({ events: [approval, dismissed, bot] });
  assert.equal(pr.latestApproval, null);
  assert.equal(pr.headReview.status, "review-required");
  assert.deepEqual(pr.queues, []);
});

test("awaits re-review only after the author pushes HEAD and until a human reviews it", () => {
  const changes = review("02", oldSha, "changes-requested");
  const push = event("03", "commit", "Author", headSha);
  const bot = review("04", headSha, "commented", { isBot: true });
  const pr = triage({ events: [push, changes, bot] });
  assert.deepEqual(pr.queues, ["awaiting-rereview"]);
  assert.deepEqual(pr.reasonEvidenceUrls, [changes.url, push.url]);
  assert.deepEqual(triage({ events: [changes, push, review("05", headSha, "commented")] }).queues, []);
  assert.deepEqual(triage({ events: [{ ...push, at: changes.at }, changes] }).queues, []);
  assert.deepEqual(triage({ events: [changes, { ...push, actor: "maintainer" }] }).queues, []);
});

test("ignores bot activity for first review and inactivity", () => {
  const human = { ...event("01", "comment", "author", null), at: "2026-04-01T00:00:00Z" };
  const bot = event("26", "label", "automation", null, { isBot: true });
  const pr = triage({ events: [bot, human] });
  assert.deepEqual(pr.queues, ["awaiting-first-review", "long-inactive"]);
  assert.equal(pr.lastHumanActivityAt, human.at);
  assert.equal(pr.lastBotActivityAt, bot.at);
  assert.equal(triage({ events: [], reviewsComplete: false }).queues.includes("awaiting-first-review"), false);
});

test("binds CI to required observations on HEAD and preserves unknown coverage", () => {
  const checks = [check("failing", oldSha), check("failing", headSha, false), check("passing", headSha)];
  const pr = triage({ checks, requiredChecksComplete: false });
  assert.deepEqual(pr.headCi, { status: "unknown", commitSha: headSha });
  assert.deepEqual(pr.requiredChecks, [{ name: "test-passing", status: "passing", commitSha: headSha, url: null }]);
  assert.equal(triage({ checks, requiredChecksComplete: true }).headCi.status, "passing");
  assert.equal(triage({ checks: [check("failing", headSha)] }).headCi.status, "failing");
  assert.equal(triage({ checks: [check("pending", headSha)], requiredChecksComplete: true }).headCi.status, "pending");
  assert.equal(triage({ checks: [check("unknown", headSha)], requiredChecksComplete: true }).headCi.status, "unknown");
});

test("ranks unique historical PR reviews and excludes bots, the author and requested users", () => {
  const record = (prId, login, paths, isBot = false) => ({
    prId, login, paths, isBot, url: `https://llvm.example.invalid/pull/${prId}#review`,
  });
  const exact = record(15, "ExactUser", [touchedPath]);
  const reviewerHistory = [
    record(11, "module-user", ["clang/lib/Sema/SemaExpr.cpp"]),
    record(12, "module-user", ["clang/lib/Sema/SemaExpr.cpp"]),
    record(13, "author", [touchedPath]),
    record(14, "asked", [touchedPath]),
    exact, { ...exact, login: "exactuser", url: exact.url + "-later" },
    record(16, "bot", [touchedPath], true), record(10, "same-pr", [touchedPath]),
    record(17, "unrelated", ["llvm/lib/Support/File.cpp"]),
  ];
  const requestedReviewers = [{ login: "Asked", kind: "user", response: "pending" }];
  const pr = triage({ requestedReviewers }, { reviewerHistory });
  assert.deepEqual(pr.requestedReviewers, requestedReviewers);
  assert.deepEqual(pr.suggestedReviewers.map((reviewer) => reviewer.login), ["exactuser", "module-user"]);
  assert.deepEqual(pr.suggestedReviewers[0].evidenceUrls, [exact.url]);
  assert.match(pr.suggestedReviewers[0].reason, /1 related PR/);
});
