const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/interviewContext.ts");

test("Interview transcript uses the existing mic and system source split", async () => {
  const { formatInterviewTranscript } = await load();
  const transcript = formatInterviewTranscript(
    [
      { id: "1", source: "system", text: "Tell me about yourself." },
      { id: "2", source: "mic", text: "I build desktop products." },
    ],
    "I also",
    ""
  );

  assert.equal(
    transcript,
    "Others: Tell me about yourself.\nYou: I build desktop products.\nYou [partial]: I also"
  );
});

test("Interview recording reuses meeting capture with diarization disabled", async () => {
  const { buildInterviewRecordingArgs } = await load();

  assert.deepEqual(buildInterviewRecordingArgs(42, "Interview"), {
    noteId: 42,
    noteTitle: "Interview",
    folderId: null,
    seedSegments: [],
    diarizationEnabled: false,
    autoEndEligible: false,
  });
});

test("continuing an interview seeds the recording with the previous transcript", async () => {
  const { buildInterviewRecordingArgs } = await load();
  const previous = [{ id: "1", source: "system", text: "Tell me about yourself." }];

  assert.equal(buildInterviewRecordingArgs(42, "Interview", previous).seedSegments, previous);
});

test("compaction commits only its segment snapshot", async () => {
  const { getUncompactedInterviewSegments, mergeCompactedInterviewSegmentIds } = await load();
  const segments = [
    { id: "old", source: "system", text: "Earlier question" },
    { id: "snapshot", source: "mic", text: "Earlier answer" },
    { id: "new", source: "system", text: "New question" },
  ];
  const compactedBefore = new Set(["old"]);
  const compactedAfter = mergeCompactedInterviewSegmentIds(compactedBefore, ["snapshot"]);

  assert.deepEqual(
    getUncompactedInterviewSegments(segments, compactedAfter).map((segment) => segment.id),
    ["new"]
  );
  assert.deepEqual([...compactedBefore], ["old"]);
});

test("screenshot-only requests exclude meeting history but keep user data", async () => {
  const { buildInterviewRequest } = await load();
  const request = buildInterviewRequest({
    mode: "screenshot",
    userData: "Senior engineer",
    compactedHistory: "old meeting",
    liveTranscript: "new meeting",
  });

  assert.match(request, /Senior engineer/);
  assert.doesNotMatch(request, /old meeting|new meeting/);
  assert.match(request, /attached screenshot/);
});

test("combined requests carry compacted and live conversation context", async () => {
  const { buildInterviewRequest } = await load();
  const request = buildInterviewRequest({
    mode: "screenshot-conversation",
    userData: "",
    compactedHistory: "Earlier context",
    liveTranscript: "Others: Current question",
  });

  assert.match(request, /Earlier context/);
  assert.match(request, /Others: Current question/);
  assert.match(request, /attached screenshot and meeting context/);
});

test("previous answers list only completed exchanges, numbered in order", async () => {
  const { formatPreviousInterviewAnswers } = await load();
  const list = formatPreviousInterviewAnswers(
    [
      { raw: "QUESTION: Why this role?\nANSWER:\nBecause it fits.", isStreaming: false },
      { raw: "QUESTION: Cancelled one\nANSWER:\nPartial", isStreaming: false, cancelled: true },
      { raw: "QUESTION: Failed one\nANSWER:\nx", isStreaming: false, error: "boom" },
      { raw: "QUESTION: Two sum?\nANSWER:\nUse a hash map.", isStreaming: false },
      { raw: "QUESTION: Streaming one\nANSWER:\nSo far", isStreaming: true },
    ],
    64_000
  );

  assert.equal(
    list,
    "Question 1: Why this role?\nAnswer 1:\nBecause it fits.\n\nQuestion 2: Two sum?\nAnswer 2:\nUse a hash map."
  );
});

test("previous answers keep the newest exchanges within their budget share", async () => {
  const { formatPreviousInterviewAnswers } = await load();
  const answer = (n, length) => ({
    raw: `QUESTION: Q${n}\nANSWER:\n${"x".repeat(length)}`,
    isStreaming: false,
  });

  // 20% of 1000 tokens fits three ~59-token entries, not four.
  const list = formatPreviousInterviewAnswers([1, 2, 3, 4].map((n) => answer(n, 150)), 1000);
  assert.doesNotMatch(list, /Question 1:/);
  assert.match(list, /^Question 2: Q2/);
  assert.match(list, /Question 4: Q4/);

  const oversized = formatPreviousInterviewAnswers([answer(1, 150), answer(2, 5000)], 1000);
  assert.match(oversized, /^Question 2: Q2/);
  assert.doesNotMatch(oversized, /Question 1:/);
});

test("screenshot requests carry previous answers for follow-up questions", async () => {
  const { buildInterviewRequest } = await load();
  const request = buildInterviewRequest({
    mode: "screenshot",
    userData: "",
    previousAnswers: "Question 1: Two sum?\nAnswer 1:\nUse a hash map.",
    compactedHistory: "old meeting",
    liveTranscript: "new meeting",
  });

  assert.match(
    request,
    /<previous_questions_and_answers>\nQuestion 1: Two sum\?\nAnswer 1:\nUse a hash map\.\n<\/previous_questions_and_answers>/
  );
  assert.match(request, /follow-up questions/);
  assert.doesNotMatch(request, /old meeting|new meeting/);
});

test("requests without previous answers add no follow-up section", async () => {
  const { buildInterviewRequest } = await load();
  const request = buildInterviewRequest({
    mode: "conversation",
    userData: "",
    compactedHistory: "",
    liveTranscript: "Others: First question",
  });

  assert.doesNotMatch(request, /previous_questions_and_answers|follow-up/);
});

test("streaming response parser exposes the question before the answer arrives", async () => {
  const { parseInterviewResponse } = await load();

  assert.deepEqual(parseInterviewResponse("QUESTION: Why this role?"), {
    question: "Why this role?",
    answer: "",
  });
  assert.deepEqual(parseInterviewResponse("QUESTION: Why this role?\nANSWER:\nBecause it fits."), {
    question: "Why this role?",
    answer: "Because it fits.",
  });
});

test("compaction threshold counts only the conversation, never static context", async () => {
  const { shouldCompactInterviewContext } = await load();
  const base = { compactedHistory: "", contextBudgetTokens: 100 };

  assert.equal(shouldCompactInterviewContext({ ...base, liveTranscript: "x".repeat(200) }), false);
  assert.equal(shouldCompactInterviewContext({ ...base, liveTranscript: "x".repeat(300) }), true);
  assert.equal(
    shouldCompactInterviewContext({
      ...base,
      compactedHistory: "x".repeat(150),
      liveTranscript: "x".repeat(150),
    }),
    true
  );
  assert.equal(
    shouldCompactInterviewContext({
      ...base,
      systemPrompt: "x".repeat(10_000),
      userData: "x".repeat(10_000),
      liveTranscript: "Others: Next question",
    }),
    false
  );
});

test("compaction summary size is a guideline derived from the context budget", async () => {
  const { buildInterviewCompactionRequest } = await load();
  const request = buildInterviewCompactionRequest({
    previousSummary: "Earlier summary",
    transcript: "Others: New question",
    contextBudgetTokens: 64_000,
  });

  assert.match(request.systemPrompt, /Aim for about 12800 tokens/);
  assert.match(request.input, /<previous_summary>\nEarlier summary\n<\/previous_summary>/);
  assert.match(request.input, /<new_transcript>\nOthers: New question\n<\/new_transcript>/);
  assert.equal(request.maxTokens, 25_600);
});

test("a finished summary cannot re-trigger compaction by itself", async () => {
  const { buildInterviewCompactionRequest, shouldCompactInterviewContext } = await load();

  for (const contextBudgetTokens of [24_000, 64_000, 200_000]) {
    const { maxTokens } = buildInterviewCompactionRequest({
      previousSummary: "",
      transcript: "Others: Question",
      contextBudgetTokens,
    });
    // Even at 5 characters per token, a full-length summary stays under the trigger.
    assert.equal(
      shouldCompactInterviewContext({
        compactedHistory: "x".repeat(maxTokens * 5),
        liveTranscript: "",
        contextBudgetTokens,
      }),
      false
    );
  }
});

test("user data may fill 60% of the context budget", async () => {
  const { estimateInterviewTokens, getInterviewUserDataMaxLength } = await load();
  const { MAX_INTERVIEW_USER_DATA_LENGTH } = require("../../src/helpers/interviewLaunchConfig");

  assert.equal(estimateInterviewTokens("x".repeat(getInterviewUserDataMaxLength(64_000))), 38_400);
  assert.equal(getInterviewUserDataMaxLength(200_000), MAX_INTERVIEW_USER_DATA_LENGTH);
});
