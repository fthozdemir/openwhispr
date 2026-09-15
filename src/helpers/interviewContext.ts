import type { StartRecordingArgs, TranscriptSegment } from "../stores/meetingRecordingStore";

export type InterviewAnswerMode = "conversation" | "screenshot" | "screenshot-conversation";

export interface ParsedInterviewResponse {
  question: string;
  answer: string;
}

export function buildInterviewRecordingArgs(
  noteId: number,
  noteTitle: string,
  seedSegments: TranscriptSegment[] = []
): StartRecordingArgs {
  return {
    noteId,
    noteTitle,
    folderId: null,
    seedSegments,
    diarizationEnabled: false,
    autoEndEligible: false,
  };
}

export function getUncompactedInterviewSegments(
  segments: TranscriptSegment[],
  compactedIds: ReadonlySet<string>
): TranscriptSegment[] {
  return segments.filter((segment) => !compactedIds.has(segment.id));
}

export function mergeCompactedInterviewSegmentIds(
  compactedIds: ReadonlySet<string>,
  snapshotIds: string[]
): Set<string> {
  return new Set([...compactedIds, ...snapshotIds]);
}

const RESPONSE_PROTOCOL = `Return exactly this streaming-friendly format:
QUESTION: <the question you identified, on one line>
ANSWER:
<the answer in Markdown>
Do not add text before QUESTION or use a different format.`;

export function buildInterviewSystemPrompt(prompt: string): string {
  return `${prompt.trim()}\n\n${RESPONSE_PROTOCOL}`;
}

export function formatInterviewTranscript(
  segments: TranscriptSegment[],
  micPartial = "",
  systemPartial = ""
): string {
  const lines = segments
    .filter((segment) => segment.text.trim().length > 0)
    .map((segment) => `${segment.source === "mic" ? "You" : "Others"}: ${segment.text.trim()}`);

  if (micPartial.trim()) lines.push(`You [partial]: ${micPartial.trim()}`);
  if (systemPartial.trim()) lines.push(`Others [partial]: ${systemPartial.trim()}`);
  return lines.join("\n");
}

export function buildInterviewRequest({
  mode,
  userData,
  previousAnswers = "",
  compactedHistory,
  liveTranscript,
}: {
  mode: InterviewAnswerMode;
  userData: string;
  previousAnswers?: string;
  compactedHistory: string;
  liveTranscript: string;
}): string {
  const sections: string[] = [];
  if (userData.trim()) sections.push(`<user_data>\n${userData.trim()}\n</user_data>`);

  // Screenshot-only interviews have no transcript, so this list is their only record of
  // what was asked before: it rides along in every mode.
  if (previousAnswers.trim()) {
    sections.push(
      `<previous_questions_and_answers>\n${previousAnswers.trim()}\n</previous_questions_and_answers>`
    );
  }

  if (mode !== "screenshot") {
    if (compactedHistory.trim()) {
      sections.push(`<compacted_history>\n${compactedHistory.trim()}\n</compacted_history>`);
    }
    sections.push(`<live_meeting>\n${liveTranscript.trim()}\n</live_meeting>`);
  }

  const sourceInstruction =
    mode === "conversation"
      ? "Identify the current interview question from the meeting context and answer it."
      : mode === "screenshot"
        ? "Identify the interview question from the attached screenshot and answer it."
        : "Identify the current interview question using the attached screenshot and meeting context, then answer it.";
  const followUpInstruction = previousAnswers.trim()
    ? "\nPrevious questions and the answers suggested for them are context for follow-up questions. Answer only the current question."
    : "";

  sections.push(`<task>\n${sourceInstruction}${followUpInstruction}\n</task>`);
  return sections.join("\n\n");
}

export function parseInterviewResponse(raw: string): ParsedInterviewResponse {
  const questionMatch = raw.match(/(?:^|\n)QUESTION:\s*/i);
  const answerMatch = raw.match(/(?:^|\n)ANSWER:\s*/i);

  if (!questionMatch) return { question: "Identifying question…", answer: raw.trim() };

  const questionStart = (questionMatch.index ?? 0) + questionMatch[0].length;
  if (!answerMatch || (answerMatch.index ?? 0) < questionStart) {
    return { question: raw.slice(questionStart).trim() || "Identifying question…", answer: "" };
  }

  const answerStart = (answerMatch.index ?? 0) + answerMatch[0].length;
  return {
    question: raw.slice(questionStart, answerMatch.index).trim() || "Interview question",
    answer: raw.slice(answerStart).trim(),
  };
}

const INTERVIEW_CHARS_PER_TOKEN = 3;

export const estimateInterviewTokens = (text: string): number =>
  Math.ceil(text.length / INTERVIEW_CHARS_PER_TOKEN);

export const INTERVIEW_USER_DATA_WARNING_TOKENS = 16_000;
const USER_DATA_BUDGET_SHARE = 0.6;

export function getInterviewUserDataMaxLength(contextBudgetTokens: number): number {
  return Math.floor(contextBudgetTokens * USER_DATA_BUDGET_SHARE) * INTERVIEW_CHARS_PER_TOKEN;
}

const PREVIOUS_ANSWERS_BUDGET_SHARE = 0.2;

export interface InterviewAnswerRecord {
  raw: string;
  isStreaming: boolean;
  cancelled?: boolean;
  error?: string;
}

// Compaction never shrinks this list, so it keeps the newest exchanges that fit its share:
// a follow-up leans on the latest ones. The newest always rides along, however long.
export function formatPreviousInterviewAnswers(
  answers: InterviewAnswerRecord[],
  contextBudgetTokens: number
): string {
  const entries = answers
    .filter((answer) => !answer.isStreaming && !answer.cancelled && !answer.error)
    .map((answer) => parseInterviewResponse(answer.raw))
    .filter((parsed) => parsed.answer)
    .map(
      (parsed, index) =>
        `Question ${index + 1}: ${parsed.question}\nAnswer ${index + 1}:\n${parsed.answer}`
    );

  const budgetTokens = Math.floor(contextBudgetTokens * PREVIOUS_ANSWERS_BUDGET_SHARE);
  const kept: string[] = [];
  let usedTokens = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const tokens = estimateInterviewTokens(entries[index]);
    if (kept.length > 0 && usedTokens + tokens > budgetTokens) break;
    kept.unshift(entries[index]);
    usedTokens += tokens;
  }
  return kept.join("\n\n");
}

const COMPACTION_TRIGGER_SHARE = 0.8;

// Only the conversation counts: user data and the system prompt ride along unchanged,
// so compaction cannot shrink them and counting them would re-trigger it on every segment.
export function shouldCompactInterviewContext({
  compactedHistory,
  liveTranscript,
  contextBudgetTokens,
}: {
  compactedHistory: string;
  liveTranscript: string;
  contextBudgetTokens: number;
}): boolean {
  const threshold = Math.floor(contextBudgetTokens * COMPACTION_TRIGGER_SHARE);
  return estimateInterviewTokens([compactedHistory, liveTranscript].join("\n")) >= threshold;
}

// The prompt asks for the target share. maxTokens only stops a runaway summary and stays at
// half the trigger, so even a full-length summary cannot re-trigger compaction by itself.
const COMPACTION_TARGET_SHARE = 0.2;
const COMPACTION_MAX_OUTPUT_SHARE = 0.4;

export function buildInterviewCompactionRequest({
  previousSummary,
  transcript,
  contextBudgetTokens,
}: {
  previousSummary: string;
  transcript: string;
  contextBudgetTokens: number;
}): { systemPrompt: string; input: string; maxTokens: number } {
  const targetTokens = Math.floor(contextBudgetTokens * COMPACTION_TARGET_SHARE);
  const systemPrompt = `Compact interview history without losing facts needed to answer future questions.
Preserve questions, candidate answers, corrections, decisions, technical details, names, numbers, and unresolved points.
Keep speaker attribution as You and Others. Do not answer the interview. Output only the compacted history.
Aim for about ${targetTokens} tokens; go beyond that only when needed to keep these facts.`;
  const input = [
    previousSummary.trim()
      ? `<previous_summary>\n${previousSummary.trim()}\n</previous_summary>`
      : "",
    `<new_transcript>\n${transcript.trim()}\n</new_transcript>`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    systemPrompt,
    input,
    maxTokens: Math.floor(contextBudgetTokens * COMPACTION_MAX_OUTPUT_SHARE),
  };
}
