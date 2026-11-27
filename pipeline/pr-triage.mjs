import { clangModules, classifyModules } from "./modules.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const DECISIVE_REVIEWS = new Set(["approved", "changes-requested", "dismissed"]);
const sameLogin = (left, right) => left.toLowerCase() === right.toLowerCase();

function effectiveReviews(events) {
  const reviews = new Map();
  for (const event of events) {
    if (event.kind === "review" && !event.isBot && DECISIVE_REVIEWS.has(event.reviewState)) {
      const login = event.actor.toLowerCase();
      reviews.delete(login);
      reviews.set(login, event);
    }
  }
  return [...reviews.values()].filter((event) => event.reviewState !== "dismissed");
}

function reviewStatus(reviews, headSha, reviewsComplete) {
  if (!reviewsComplete) return "unknown";
  const current = reviews.filter((review) => review.commitSha === headSha);
  if (current.some((review) => review.reviewState === "changes-requested")) {
    return "changes-requested";
  }
  return current.some((review) => review.reviewState === "approved")
    ? "approved"
    : "review-required";
}

function checkStatus(checks, complete) {
  if (checks.some((check) => check.status === "failing")) return "failing";
  if (!complete || checks.some((check) => check.status === "unknown")) return "unknown";
  if (checks.some((check) => check.status === "pending")) return "pending";
  return "passing";
}

function suggestReviewers(pr, moduleIds, history, modules, limit) {
  const excluded = new Set([pr.author, ...pr.requestedReviewers
    .filter((reviewer) => reviewer.kind === "user").map((reviewer) => reviewer.login)]
    .map((login) => login.toLowerCase()));
  const touched = new Set(pr.paths);
  const candidates = new Map();
  for (const record of history) {
    const login = record.login.toLowerCase();
    if (record.isBot || excluded.has(login) || record.prId === pr.id) continue;
    const exactPath = record.paths.some((path) => touched.has(path));
    const sharedModule = classifyModules(record, modules).some((id) => moduleIds.includes(id));
    if (!exactPath && !sharedModule) continue;

    if (!candidates.has(login)) candidates.set(login, new Map());
    const reviews = candidates.get(login);
    const previous = reviews.get(record.prId);
    if (!previous || (exactPath && !previous.exactPath)
        || (exactPath === previous.exactPath && record.url < previous.url)) {
      reviews.set(record.prId, { exactPath, url: record.url });
    }
  }
  return [...candidates].map(([login, pulls]) => {
    const reviews = [...pulls.values()];
    const exactCount = reviews.filter((review) => review.exactPath).length;
    const reason = `Reviewed ${reviews.length} related PR(s), including ${exactCount} touching the same files.`;
    return { login, reason, exactCount, count: reviews.length,
      evidenceUrls: [...new Set(reviews.map((review) => review.url))].sort() };
  }).sort((left, right) => right.exactCount - left.exactCount || right.count - left.count
    || left.login.localeCompare(right.login))
    .slice(0, limit)
    .map(({ login, reason, evidenceUrls }) => ({ login, reason, evidenceUrls }));
}

export function triagePr(input, {
  now, inactivityDays = 180, modules = clangModules, reviewerHistory = [], reviewerLimit = 3,
}) {
  const pr = { paths: [], labels: [], events: [], checks: [], requestedReviewers: [], ...input };
  const moduleIds = classifyModules(pr, modules);
  if (moduleIds.length === 0) return null;

  const { id, title, url, author, createdAt, headSha, requestedReviewers } = pr;
  const events = [...pr.events].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const human = events.filter((event) => !event.isBot);
  const lastHuman = human.at(-1);
  const lastBot = events.findLast((event) => event.isBot);
  const latestReview = effectiveReviews(events);
  const approval = latestReview.findLast((review) => review.reviewState === "approved"
    && review.commitSha);
  const latestApproval = approval ? { commitSha: approval.commitSha, approvedAt: approval.at } : null;
  const knownDistance = approval && pr.commitsAheadBySha?.[approval.commitSha];
  const commitsSinceApproval = !approval ? null : approval.commitSha === headSha ? 0
    : Number.isSafeInteger(knownDistance) && knownDistance > 0 ? knownDistance : null;

  const requiredChecks = pr.checks.filter((check) => check.commitSha === headSha && check.required)
    .map(({ name, status, commitSha, url }) => ({ name, status, commitSha, url: url ?? null }));
  const headReview = { status: reviewStatus(latestReview, headSha, pr.reviewsComplete), commitSha: headSha };
  const headCi = { status: checkStatus(requiredChecks, pr.requiredChecksComplete), commitSha: headSha };

  const changes = latestReview.findLast((review) => review.reviewState === "changes-requested");
  const authorPush = human.findLast((event) => event.kind === "commit" && event.commitSha === headSha
    && sameLogin(event.actor, author));
  const mergeHelp = human.findLast((event) => event.kind === "comment" && event.mergeHelpRequested
    && sameLogin(event.actor, author));
  const signals = [];

  if (approval && (!changes || Date.parse(approval.at) > Date.parse(changes.at))
      && headReview.status !== "changes-requested") {
    const approvalReason = commitsSinceApproval === 0 ? "A review approved the current HEAD."
      : commitsSinceApproval === null ? "A review approved an earlier revision. Its distance from HEAD is unknown."
        : `A review approved an earlier revision; HEAD is ${commitsSinceApproval} commit(s) ahead.`;
    signals.push({ queue: "approved-follow-up", priority: 100, reason: approvalReason,
      urls: [approval.url, authorPush?.url] });
  }
  const reviewedHeadAfterPush = authorPush && human.some((event) => event.kind === "review"
    && event.commitSha === headSha && Date.parse(event.at) >= Date.parse(authorPush.at));
  if (changes && authorPush && changes.commitSha && changes.commitSha !== headSha
      && Date.parse(authorPush.at) > Date.parse(changes.at) && !reviewedHeadAfterPush) {
    signals.push({ queue: "awaiting-rereview", priority: 75,
      reason: "The author pushed the current HEAD after a request for changes.",
      urls: [changes.url, authorPush.url] });
  }
  if (pr.reviewsComplete && !human.some((event) => event.kind === "review")) {
    signals.push({ queue: "awaiting-first-review", priority: 50,
      reason: "No human review is recorded.", urls: [url] });
  }
  if (Date.parse(now) - Date.parse(lastHuman?.at ?? createdAt) >= inactivityDays * DAY_MS) {
    signals.push({ queue: "long-inactive", priority: 25,
      reason: `No human activity for at least ${inactivityDays} days.`, urls: [lastHuman?.url ?? url] });
  }
  const reasons = signals.map((signal) => signal.reason);
  if (mergeHelp) reasons.push("The author asked for help merging.");

  return {
    id, title, url, author, createdAt, headSha, moduleIds, requestedReviewers,
    headReview, headCi, latestApproval, commitsSinceApproval, requiredChecks,
    lastHumanActivityAt: lastHuman?.at ?? null,
    lastBotActivityAt: lastBot?.at ?? null,
    mergeability: pr.mergeability ?? "unknown",
    unresolvedDiscussionCount: pr.unresolvedDiscussionCount ?? null,
    unresolvedDiscussionUrls: pr.unresolvedDiscussionUrls ?? [],
    mergeHelpRequested: Boolean(mergeHelp),
    queues: signals.map((signal) => signal.queue),
    priority: Math.max(0, ...signals.map((signal) => signal.priority)),
    reason: reasons.join(" ") || "No triage queue matched the available evidence.",
    reasonEvidenceUrls: [...new Set([...signals.flatMap((signal) => signal.urls), mergeHelp?.url]
      .filter(Boolean))],
    suggestedReviewers: suggestReviewers(pr, moduleIds, reviewerHistory, modules, reviewerLimit),
    touchedPaths: [...new Set(pr.paths)].sort(),
    timeline: events.map(({ at, kind, actor, isBot, description, url, commitSha }) => ({
      at, kind, actor, isBot, description, url, commitSha: commitSha ?? null,
    })),
  };
}
