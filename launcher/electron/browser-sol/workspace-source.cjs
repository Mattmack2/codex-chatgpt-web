const fs = require("node:fs");

const SOURCE_SCHEMA = "any-clerk-automatic-review-wakes/v1";

function nonNegativeCount(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Any-Clerk wake source field ${field} is invalid`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unavailable(sourcePath, message, errorCode) {
  return {
    status: "unavailable",
    sourcePath,
    message,
    errorCode: errorCode || "invalid-source",
    projectKey: null,
    providerCount: 0,
    queuedProviderCount: 0,
    unfinished: 0,
    waveId: null,
    settlementId: null,
    settledAt: null,
  };
}

function readWakeSource(
  filePath,
  projectKey,
  { readFileSync = fs.readFileSync, statSync = fs.statSync } = {},
) {
  if (typeof filePath !== "string" || !filePath) throw new Error("Any-Clerk wake source path is required");
  if (typeof projectKey !== "string" || !projectKey) throw new Error("Any-Clerk project key is required");

  let document;
  let stat = null;
  try {
    stat = statSync(filePath);
    document = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    return unavailable(
      filePath,
      "Any-Clerk automatic wake state is unavailable",
      error?.code || "invalid-source",
    );
  }

  if (!document || typeof document !== "object" || document.schema_version !== SOURCE_SCHEMA) {
    return unavailable(
      filePath,
      "Any-Clerk automatic wake state has an unsupported schema",
      "unsupported-schema",
    );
  }
  const record = document.projects?.[projectKey];
  if (!record || typeof record !== "object") {
    return unavailable(
      filePath,
      "The configured Browser Sol project is not present in Any-Clerk wake state",
      "project-missing",
    );
  }

  try {
    const providerCount = nonNegativeCount(record.provider_count, "provider_count");
    const queuedProviderCount = nonNegativeCount(record.queued_count, "queued_count");
    const unfinished = providerCount + queuedProviderCount;
    const waveId = optionalString(record.wave_id);
    const candidateSettlementId = optionalString(record.settlement_id);
    const settlement = candidateSettlementId && document.settlements && typeof document.settlements === "object"
      ? document.settlements[candidateSettlementId]
      : null;
    const settlementMatches = Boolean(
      unfinished === 0
      && candidateSettlementId
      && settlement
      && typeof settlement === "object"
      && settlement.project_key === projectKey
      && (!settlement.wave_id || settlement.wave_id === waveId)
      && settlement.settlement_id === candidateSettlementId
      && settlement.provider_count_after === 0
      && (settlement.queued_count_after === undefined || settlement.queued_count_after === 0),
    );

    return {
      status: "ready",
      sourcePath: filePath,
      sourceMtimeMs: Number.isFinite(stat?.mtimeMs) ? stat.mtimeMs : null,
      sourceSize: Number.isInteger(stat?.size) ? stat.size : null,
      projectKey,
      providerCount,
      queuedProviderCount,
      unfinished,
      activeInvocationIds: Array.isArray(record.active_invocation_ids)
        ? record.active_invocation_ids.filter(value => typeof value === "string")
        : [],
      waveId,
      // This is authoritative only when Any-Clerk has published a matching
      // settlement record for the current zero-work state.  No transition is
      // reconstructed from the previous counts here.
      settlementId: settlementMatches ? candidateSettlementId : null,
      settledAt: settlementMatches
        ? optionalString(record.settled_at) || optionalString(settlement.created_at)
        : null,
      settlementRecorded: settlementMatches,
    };
  } catch (error) {
    return unavailable(
      filePath,
      "Any-Clerk automatic wake state contains invalid counts",
      error?.code || "invalid-counts",
    );
  }
}

module.exports = {
  SOURCE_SCHEMA,
  readWakeSource,
};
