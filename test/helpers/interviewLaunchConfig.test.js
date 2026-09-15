const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  MAX_INTERVIEW_USER_DATA_LENGTH,
  normalizeInterviewLaunchConfig,
} = require("../../src/helpers/interviewLaunchConfig");

const root = path.join(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("normalizes an Interview launch config without persisting extra fields", () => {
  assert.deepEqual(
    normalizeInterviewLaunchConfig({
      captureSourceId: "  screen:42  ",
      userData: "candidate context",
      systemPrompt: "must not cross the launch IPC",
    }),
    {
      captureSourceId: "screen:42",
      userData: "candidate context",
    }
  );
});

test("rejects missing capture sources and bounds user data", () => {
  assert.equal(normalizeInterviewLaunchConfig(null), null);
  assert.equal(normalizeInterviewLaunchConfig({ captureSourceId: " " }), null);

  const normalized = normalizeInterviewLaunchConfig({
    captureSourceId: "window:1",
    userData: "x".repeat(MAX_INTERVIEW_USER_DATA_LENGTH + 10),
  });
  assert.equal(normalized.userData.length, MAX_INTERVIEW_USER_DATA_LENGTH);
});

test("routes Interview through setup and keeps launch data in the main-process bridge", () => {
  const controlPanel = read("src/components/ControlPanel.tsx");
  const setup = read("src/components/InterviewSetup.tsx");
  const interviewWindow = read("src/components/InterviewWindow.tsx");
  const preload = read("preload.js");
  const handlers = read("src/helpers/ipcHandlers.js");
  const windowManager = read("src/helpers/windowManager.js");

  assert.match(controlPanel, /activeView === "interview"/u);
  assert.match(controlPanel, /<InterviewSetup\b[\s\S]*?onOpenModelSettings[\s\S]*?\/>/u);
  // The setup names the model the Interview window answers with.
  assert.match(setup, /selectResolvedLLMConfig\(settings, "chatIntelligence"\)/u);
  assert.match(setup, /import \{ QRCodeSVG \} from "qrcode\.react"/u);
  assert.match(setup, /<QRCodeSVG[\s\S]*value=\{phoneRemoteUrl\}/u);
  assert.match(interviewWindow, /logger\.info\("Interview answer generated"/u);
  assert.doesNotMatch(controlPanel, /view === "interview"[\s\S]{0,160}openInterviewWindow/u);
  assert.match(preload, /openInterviewWindow: \(launchConfig\)/u);
  assert.match(preload, /getInterviewLaunchConfig/u);
  assert.match(handlers, /createInterviewWindow\(launchConfig\)/u);
  assert.match(handlers, /getInterviewLaunchConfig\(\)/u);
  assert.match(windowManager, /this\._interviewLaunchConfig = normalizedLaunchConfig/u);
  assert.match(windowManager, /this\._interviewLaunchConfig = null/u);
});
