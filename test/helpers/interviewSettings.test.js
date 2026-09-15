const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/interviewSettings.ts");

function withStoredValues(values, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key) => values[key] ?? null },
  });
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
}

test("Interview background opacity keeps the current look by default and stays within 0-100", async () => {
  const { INTERVIEW_SETTING_KEYS, readInterviewSettings } = await load();
  const read = (stored) =>
    withStoredValues(
      stored === undefined ? {} : { [INTERVIEW_SETTING_KEYS.backgroundOpacity]: stored },
      () => readInterviewSettings().backgroundOpacity
    );

  assert.equal(read(undefined), 45);
  assert.equal(read("80"), 80);
  assert.equal(read("150"), 100);
  assert.equal(read("-5"), 0);
  assert.equal(read("dark"), 45);
});
