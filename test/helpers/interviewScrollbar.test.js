const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/interviewScrollbar.ts");

test("the Interview scrollbar hides while the content fits", async () => {
  const { resolveInterviewScrollbarThumb } = await load();
  assert.equal(
    resolveInterviewScrollbarThumb({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 }, 280),
    null
  );
});

test("the Interview scrollbar thumb mirrors the visible share and position", async () => {
  const { resolveInterviewScrollbarThumb } = await load();
  // 300 of 1200px visible → a quarter-height thumb; halfway scrolled → halfway along its travel.
  assert.deepEqual(
    resolveInterviewScrollbarThumb({ scrollTop: 450, scrollHeight: 1200, clientHeight: 300 }, 400),
    { size: 100, offset: 150 }
  );
});

test("a long transcript keeps the thumb large enough to grab", async () => {
  const { resolveInterviewScrollbarThumb, INTERVIEW_SCROLLBAR_MIN_THUMB } = await load();
  assert.deepEqual(
    resolveInterviewScrollbarThumb(
      { scrollTop: 99_700, scrollHeight: 100_000, clientHeight: 300 },
      400
    ),
    { size: INTERVIEW_SCROLLBAR_MIN_THUMB, offset: 400 - INTERVIEW_SCROLLBAR_MIN_THUMB }
  );
});

test("dragging the thumb maps its travel back onto the scroll range", async () => {
  const { resolveInterviewScrollTop } = await load();
  const metrics = { scrollTop: 0, scrollHeight: 1200, clientHeight: 300 };
  assert.equal(resolveInterviewScrollTop(150, metrics, 400), 450);
  assert.equal(resolveInterviewScrollTop(-40, metrics, 400), 0);
  assert.equal(resolveInterviewScrollTop(999, metrics, 400), 900);
});

test("new content is followed only while the view sits at the bottom", async () => {
  const { isInterviewScrolledToBottom } = await load();
  assert.equal(
    isInterviewScrolledToBottom({ scrollTop: 900, scrollHeight: 1200, clientHeight: 300 }),
    true
  );
  assert.equal(
    isInterviewScrolledToBottom({ scrollTop: 890, scrollHeight: 1200, clientHeight: 300 }),
    true
  );
  assert.equal(
    isInterviewScrolledToBottom({ scrollTop: 600, scrollHeight: 1200, clientHeight: 300 }),
    false
  );
});

test("a jump to the bottom that more content overtook keeps following", async () => {
  const { resolveInterviewFollow } = await load();
  // Jumped from 600 to 900, but the content grew to 1400 before the scroll event fired.
  assert.equal(
    resolveInterviewFollow(true, 600, { scrollTop: 900, scrollHeight: 1400, clientHeight: 300 }),
    true
  );
});

test("scrolling up detaches the view and returning to the bottom re-attaches it", async () => {
  const { resolveInterviewFollow } = await load();
  assert.equal(
    resolveInterviewFollow(true, 900, { scrollTop: 700, scrollHeight: 1200, clientHeight: 300 }),
    false
  );
  assert.equal(
    resolveInterviewFollow(false, 300, { scrollTop: 500, scrollHeight: 1200, clientHeight: 300 }),
    false
  );
  assert.equal(
    resolveInterviewFollow(false, 700, { scrollTop: 900, scrollHeight: 1200, clientHeight: 300 }),
    true
  );
});
