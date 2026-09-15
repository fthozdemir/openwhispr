// The most user data the setup screen accepts: 60% of the 200k maximum context budget
// at 3 characters per token (see getInterviewUserDataMaxLength).
const MAX_INTERVIEW_USER_DATA_LENGTH = 360_000;

/**
 * Keep the renderer-to-main Interview launch contract narrow and in-memory.
 * Sensitive user data is accepted only as a string; the main process never
 * persists it (the setup screen keeps the user's copy in local storage).
 */
function normalizeInterviewLaunchConfig(value) {
  if (!value || typeof value !== "object") return null;

  const captureSourceId =
    typeof value.captureSourceId === "string" ? value.captureSourceId.trim() : "";
  if (!captureSourceId) return null;

  const userData = typeof value.userData === "string" ? value.userData : "";
  return {
    captureSourceId,
    userData: userData.slice(0, MAX_INTERVIEW_USER_DATA_LENGTH),
  };
}

module.exports = {
  MAX_INTERVIEW_USER_DATA_LENGTH,
  normalizeInterviewLaunchConfig,
};
