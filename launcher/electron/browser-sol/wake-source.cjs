const fs = require("node:fs");

const SOURCE_SCHEMA = "any-clerk-automatic-review-wakes/v1";

function count(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Any-Clerk wake source field ${field} is invalid`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readWakeSource(filePath, projectKey, { readFileSync = fs.readFileSync, statSync = fs.statSync } = {}) {
  if (typeof filePath !== "string" || !filePath) throw new Error("Any-Clerk wake source path is required");
  if (typeof projectKey !== "string" || !projectKey) throw new Error("Any-Clerk project key is required");
  let stat;
  let document;
  try {
    stat = statSync(filePath);
    document = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    return {
      status: "unavailable",
      message: "Any-Clerk automatic wake state is unavailable",
      sourcePath: filePath,
      errorCode: error?.code || "invalid-source",
    };
  }
  if (!document || typeof document !== "object" || document.schema_version !== SOURCE_SCHEMA) {
    return {
      status: "unavailable",
      message: "Any-Clerk automatic wake state has an unsupported schema",
      sourcePath: filePath,
      errorCode: "unsupported-schema",
    };
  }
  const record = document.projects?.[projectKey];
  if (!record || typeof record !== "object") {
    return {
      status: "unavailable",
      message: "The configured EvoDevo project is not present in Any-Clerk wake state",
      sourcePath: filePath,
      errorCode: "project-missing",
    };
  }
  try {
    const providerCount = count(record.provider_count, "provider_count");
    const queuedProviderCount = count(record.queued_count, "queued_count");
    const previousProviderCount = count(record.previous_provider_count, "previous_provider_count");
    const previousQueuedProviderCount = count(record.previous_queued_count, "previous_queued_count");
    const waveId = optionalString(record.wave_id);
    const settlementId = optionalString(record.settlement_id);
    const settlement = settlementId && document.settlements && typeof document.settlements === "object"
      ? document.settlements[settlementId]
      : null;
    const settlementMatchesProject = Boolean(
      settlement
      && typeof settlement === "object"
      && settlement.project_key === projectKey
      && (!settlement.wave_id || settlement.wave_id === waveId),
    );
    return {
      status: "ready",
      sourcePath: filePath,
      sourceMtimeMs: Number.isFinite(stat?.mtimeMs) ? stat.mtimeMs : null,
      sourceSize: Number.isInteger(stat?.size) ? stat.size : null,
      projectKey,
      providerCount,
      queuedProviderCount,
      previousProviderCount,
      previousQueuedProviderCount,
      unfinished: providerCount + queuedProviderCount,
      previousUnfinished: previousProviderCount + previousQueuedProviderCount,
      waveId,
      settlementId: settlementMatchesProject ? settlementId : null,
      settledAt: optionalString(record.settled_at)
        || optionalString(settlement?.created_at),
    };
  } catch (error) {
    return {
      status: "unavailable",
      message: "Any-Clerk automatic wake state contains invalid counts",
      sourcePath: filePath,
      errorCode: "invalid-counts",
    };
  }
}

module.exports = {
  SOURCE_SCHEMA,
  readWakeSource,
};
