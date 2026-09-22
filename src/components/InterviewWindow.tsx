import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MarkdownRenderer } from "./ui/MarkdownRenderer";
import { Button } from "./ui/button";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageSquare,
  MessageSquareText,
  Monitor,
  Play,
  Square,
  X,
} from "./icons";
import InterviewScrollArea from "./InterviewScrollArea";
import MeetingRecordingMount from "./MeetingRecordingMount";
import {
  startRecording,
  stopRecording,
  useMeetingRecordingStore,
  type StartRecordingArgs,
  type TranscriptSegment,
} from "../stores/meetingRecordingStore";
import {
  buildInterviewRequest,
  buildInterviewRecordingArgs,
  buildInterviewSystemPrompt,
  formatInterviewTranscript,
  formatPreviousInterviewAnswers,
  getUncompactedInterviewSegments,
  mergeCompactedInterviewSegmentIds,
  parseInterviewResponse,
  shouldCompactInterviewContext,
  type InterviewAnswerMode,
} from "../helpers/interviewContext";
import {
  INTERVIEW_SCREENSHOT_UNSUPPORTED_ERROR,
  cancelInterviewAnswer,
  compactInterviewHistory,
  interviewCanSendScreenshot,
  streamInterviewAnswer,
} from "../helpers/interviewInference";
import { readInterviewSettings, type InterviewSettings } from "../helpers/interviewSettings";
import { getSettings, selectResolvedLLMConfig } from "../stores/settingsStore";
import { useAuth } from "../hooks/useAuth";
import { usePolicySnapshot } from "../hooks/usePolicy";
import { useLocalStorage } from "../hooks/useLocalStorage";
import logger from "../utils/logger";

interface InterviewAnswer {
  id: string;
  mode: InterviewAnswerMode;
  raw: string;
  isStreaming: boolean;
  cancelled?: boolean;
  error?: string;
}

const actionLabels: Record<InterviewAnswerMode, string> = {
  conversation: "Conversation",
  screenshot: "Screenshot",
  "screenshot-conversation": "Screenshot + Conversation",
};

const answerActions = [
  { mode: "conversation", Icon: MessageSquare },
  { mode: "screenshot", Icon: Monitor },
  { mode: "screenshot-conversation", Icon: MessageSquareText },
] as const;

// Where the window catches the pointer. Everywhere else, clicks and wheel events
// reach the app beneath (macOS, see setInterviewWindowInteractivity).
const INTERVIEW_HIT_SELECTOR = "button, [data-interview-hit]";

const buildNoteTitle = (startedAt: number) =>
  `Interview - ${new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(startedAt)}`;

function buildNoteContent({
  startedAt,
  endedAt,
  provider,
  model,
  answers,
}: {
  startedAt: number;
  endedAt?: number | null;
  provider: string;
  model: string;
  answers: InterviewAnswer[];
}) {
  const metadata = [
    "# Interview Session",
    "",
    `- Started: ${new Date(startedAt).toISOString()}`,
    ...(endedAt ? [`- Ended: ${new Date(endedAt).toISOString()}`] : []),
    `- Provider: ${provider || "Unknown"}`,
    `- Model: ${model || "Provider default"}`,
  ];
  const completedAnswers = answers.filter((answer) => !answer.cancelled && !answer.error);
  if (completedAnswers.length === 0) return metadata.join("\n");

  return [
    ...metadata,
    "",
    "# Questions and Answers",
    ...completedAnswers.flatMap((answer) => {
      const parsed = parseInterviewResponse(answer.raw);
      return ["", `## ${parsed.question}`, "", parsed.answer || answer.raw];
    }),
  ].join("\n");
}

// Resolves to why the recording is not running, or "" once it is.
async function startInterviewRecording(
  args: StartRecordingArgs,
  failMessage: string
): Promise<string> {
  try {
    await startRecording(args);
    const { isRecording, error } = useMeetingRecordingStore.getState();
    return isRecording ? "" : error || failMessage;
  } catch (reason) {
    return reason instanceof Error ? reason.message : failMessage;
  }
}

// Screen deltas, not client ones: the window travels with the pointer.
async function trackWindowPointerDrag(
  event: React.PointerEvent<HTMLButtonElement>,
  apply: (bounds: Electron.Rectangle, deltaX: number, deltaY: number) => void
) {
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  const startX = event.screenX;
  const startY = event.screenY;
  const bounds = await window.electronAPI?.getInterviewWindowBounds?.();
  if (!bounds) return;
  const move = (moveEvent: PointerEvent) => {
    // A quick click can release before the bounds arrive, and its pointerup
    // is gone: a plain hover must not keep dragging the window.
    if (moveEvent.buttons === 0) {
      end();
      return;
    }
    apply(bounds, moveEvent.screenX - startX, moveEvent.screenY - startY);
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

const beginMove = (event: React.PointerEvent<HTMLButtonElement>) =>
  trackWindowPointerDrag(event, (bounds, deltaX, deltaY) => {
    void window.electronAPI?.moveInterviewWindow?.(bounds.x + deltaX, bounds.y + deltaY);
  });

const beginResize = (event: React.PointerEvent<HTMLButtonElement>) =>
  trackWindowPointerDrag(event, (bounds, deltaX, deltaY) => {
    void window.electronAPI?.resizeInterviewWindow?.(bounds.width + deltaX, bounds.height + deltaY);
  });

// Memoized: while one answer streams, the others keep their object and skip
// re-parsing their markdown on every token and partial transcript.
const InterviewAnswerCard = memo(function InterviewAnswerCard({
  answer,
}: {
  answer: InterviewAnswer;
}) {
  const parsed = parseInterviewResponse(answer.raw);
  return (
    <article className="rounded-md border border-white/10 bg-black/25 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-white/35">
          {actionLabels[answer.mode]}
        </span>
        {answer.cancelled && <span className="text-[10px] text-amber-300/70">Cancelled</span>}
      </div>
      <h3 className="text-sm font-semibold leading-relaxed text-white">{parsed.question}</h3>
      {answer.error ? (
        <p className="mt-2 text-sm text-red-300">{answer.error}</p>
      ) : parsed.answer ? (
        <MarkdownRenderer
          content={parsed.answer}
          className="mt-2 text-sm leading-relaxed text-white/80 [&_li:not(:last-child)]:mb-2.5 [&_pre]:bg-black/35"
        />
      ) : (
        <p className="mt-2 text-sm text-white/35">Waiting for answer…</p>
      )}
    </article>
  );
});

export default function InterviewWindow() {
  const { t } = useTranslation();
  useAuth();
  usePolicySnapshot();

  const isRecording = useMeetingRecordingStore((state) => state.isRecording);
  const recordingNoteId = useMeetingRecordingStore((state) => state.recordingNoteId);
  const segments = useMeetingRecordingStore((state) => state.segments);
  const micPartial = useMeetingRecordingStore((state) => state.micPartial);
  const systemPartial = useMeetingRecordingStore((state) => state.systemPartial);
  const meetingError = useMeetingRecordingStore((state) => state.error);
  const [settings, setSettings] = useState<InterviewSettings>(readInterviewSettings);
  const [answers, setAnswers] = useState<InterviewAnswer[]>([]);
  const [answerState, setAnswerState] = useState<"idle" | "capturing" | "thinking" | "streaming">(
    "idle"
  );
  const [error, setError] = useState("");
  const [isCompacting, setIsCompacting] = useState(false);
  const [answerScrollRequest, setAnswerScrollRequest] = useState(0);
  const noteIdRef = useRef<number | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const sessionModelRef = useRef<{ provider: string; model: string } | null>(null);
  const noteWriteRef = useRef<Promise<void>>(Promise.resolve());
  const answersRef = useRef<InterviewAnswer[]>([]);
  const compactedHistoryRef = useRef("");
  const compactedSegmentIdsRef = useRef(new Set<string>());
  const compactionRunningRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const answerGenerationRef = useRef(0);
  const closeRunningRef = useRef(false);
  // Set once from the setup screen before the recording starts, and never edited here.
  const launchConfigRef = useRef<{ captureSourceId: string; userData: string } | null>(null);
  const [liveConversationCollapsed, setLiveConversationCollapsed] = useLocalStorage(
    "interviewLiveConversationCollapsed",
    false
  );

  const setAnswerList = useCallback((next: InterviewAnswer[]) => {
    answersRef.current = next;
    setAnswers(next);
  }, []);

  const modelMetadata = useCallback(() => {
    const config = selectResolvedLLMConfig(getSettings(), "chatIntelligence");
    return {
      provider: config.mode === "openwhispr" ? "OpenWhispr Cloud" : config.provider,
      model: config.model,
    };
  }, []);

  const persistAnswers = useCallback(
    async (next: InterviewAnswer[], endedAt?: number | null) => {
      const noteId = noteIdRef.current;
      const startedAt = startedAtRef.current;
      if (noteId == null || startedAt == null) return;
      const metadata = sessionModelRef.current ?? modelMetadata();
      const content = buildNoteContent({ startedAt, endedAt, ...metadata, answers: next });
      noteWriteRef.current = noteWriteRef.current
        .catch(() => undefined)
        .then(async () => {
          await window.electronAPI.updateNote(noteId, { content });
        });
      await noteWriteRef.current;
    },
    [modelMetadata]
  );

  useEffect(() => {
    const previousBody = document.body.style.background;
    const previousRoot = document.documentElement.style.background;
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
    return () => {
      document.body.style.background = previousBody;
      document.documentElement.style.background = previousRoot;
    };
  }, []);

  useEffect(() => {
    const refresh = () => setSettings(readInterviewSettings());
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, []);

  useEffect(() => {
    void window.electronAPI
      ?.registerInterviewHotkeys?.({
        conversation: settings.conversationHotkey,
        screenshot: settings.screenshotHotkey,
        screenshotConversation: settings.screenshotConversationHotkey,
      })
      .then((result) => {
        if (result && !result.success) setError(result.error || "Interview shortcuts failed.");
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : "Interview shortcuts failed.");
      });
  }, [
    settings.conversationHotkey,
    settings.screenshotConversationHotkey,
    settings.screenshotHotkey,
  ]);

  useEffect(() => {
    let capturing = false;
    const setCapturing = (next: boolean) => {
      if (next === capturing) return;
      capturing = next;
      void window.electronAPI?.setInterviewWindowInteractivity?.(next);
    };
    // A pressed button is a drag in progress (scrollbar thumb, resize corner)
    // that has to keep its events after the pointer leaves the control.
    const updateCapture = (event: MouseEvent) => {
      if (event.buttons !== 0) return;
      // A mousemove already targets what is under the pointer; a mouseup still
      // targets the control that captured the drag, so it hit-tests again.
      const target =
        event.type === "mouseup"
          ? document.elementFromPoint(event.clientX, event.clientY)
          : event.target;
      setCapturing(target instanceof Element && Boolean(target.closest(INTERVIEW_HIT_SELECTOR)));
    };
    const release = (event: MouseEvent) => {
      if (event.buttons === 0) setCapturing(false);
    };
    window.addEventListener("mousemove", updateCapture);
    window.addEventListener("mouseup", updateCapture);
    document.documentElement.addEventListener("mouseleave", release);
    return () => {
      window.removeEventListener("mousemove", updateCapture);
      window.removeEventListener("mouseup", updateCapture);
      document.documentElement.removeEventListener("mouseleave", release);
      if (capturing) void window.electronAPI?.setInterviewWindowInteractivity?.(false);
    };
  }, []);

  const startInterview = useCallback(async () => {
    setError("");
    try {
      const startedAt = Date.now();
      const metadata = modelMetadata();
      const title = buildNoteTitle(startedAt);
      const result = await window.electronAPI.saveNote(
        title,
        buildNoteContent({ startedAt, ...metadata, answers: [] }),
        "meeting"
      );
      if (!result.success || !result.note) {
        setError("Could not create the meeting note.");
        return;
      }

      noteIdRef.current = result.note.id;
      startedAtRef.current = startedAt;
      sessionModelRef.current = metadata;
      sessionGenerationRef.current += 1;
      compactedSegmentIdsRef.current = new Set();
      compactedHistoryRef.current = "";
      setAnswerList([]);
      await window.electronAPI.updateNote(result.note.id, {
        diarization_enabled: 0,
      });
      const failure = await startInterviewRecording(
        buildInterviewRecordingArgs(result.note.id, title),
        "Interview recording could not start."
      );
      if (failure) setError(failure);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Interview recording could not start.");
    }
  }, [modelMetadata, setAnswerList]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const config = await window.electronAPI?.getInterviewLaunchConfig?.();
        if (!active || launchConfigRef.current) return;
        if (!config) {
          setError(t("interviewSetup.errors.missingSetup"));
          return;
        }

        launchConfigRef.current = config;
        await startInterview();
      } catch (reason) {
        if (!active) return;
        setError(
          reason instanceof Error ? reason.message : t("interviewSetup.errors.missingSetup")
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [startInterview, t]);

  const stopInterview = useCallback(async () => {
    answerGenerationRef.current += 1;
    cancelInterviewAnswer();
    setAnswerState("idle");
    const finalAnswers = answersRef.current.map((item) =>
      item.isStreaming ? { ...item, isStreaming: false, cancelled: true } : item
    );
    setAnswerList(finalAnswers);
    const stoppedAt = Date.now();
    try {
      if (useMeetingRecordingStore.getState().isRecording) await stopRecording();
      await persistAnswers(finalAnswers, stoppedAt);
      return true;
    } catch {
      setError("The interview stopped, but its questions and answers could not be saved.");
      return false;
    } finally {
      sessionGenerationRef.current += 1;
    }
  }, [persistAnswers, setAnswerList]);

  const continueInterview = useCallback(async () => {
    const noteId = noteIdRef.current;
    const startedAt = startedAtRef.current;
    if (noteId == null || startedAt == null) return;
    setError("");
    // Seeding keeps the earlier transcript live, so compacted context and answers stay valid.
    const { segments: previousSegments } = useMeetingRecordingStore.getState();
    const failure = await startInterviewRecording(
      buildInterviewRecordingArgs(noteId, buildNoteTitle(startedAt), previousSegments),
      "Interview recording could not continue."
    );
    if (failure) setError(failure);
  }, []);

  const executeAnswer = useCallback(
    async (mode: InterviewAnswerMode) => {
      if (!useMeetingRecordingStore.getState().isRecording) {
        setError("Start the interview before requesting an answer.");
        return;
      }

      setError("");
      // The answers jump to the bottom now, before a capture or the first token.
      setAnswerScrollRequest((count) => count + 1);
      const generation = ++answerGenerationRef.current;
      cancelInterviewAnswer();
      const cancelledAnswers = answersRef.current.map((item) =>
        item.isStreaming ? { ...item, isStreaming: false, cancelled: true } : item
      );
      if (cancelledAnswers.some((item, index) => item !== answersRef.current[index])) {
        setAnswerList(cancelledAnswers);
      }
      setAnswerState("idle");
      const state = useMeetingRecordingStore.getState();
      const tail = getUncompactedInterviewSegments(state.segments, compactedSegmentIdsRef.current);
      const liveTranscript = formatInterviewTranscript(tail, state.micPartial, state.systemPartial);

      let screenshot = null;
      if (mode !== "conversation") {
        const captureSourceId = launchConfigRef.current?.captureSourceId;
        if (!captureSourceId) {
          setError("Select a window to capture.");
          return;
        }
        if (!interviewCanSendScreenshot()) {
          setError(INTERVIEW_SCREENSHOT_UNSUPPORTED_ERROR);
          return;
        }
        setAnswerState("capturing");
        let capture;
        try {
          capture = await window.electronAPI?.captureInterviewSource?.(captureSourceId);
        } catch (reason) {
          if (generation !== answerGenerationRef.current) return;
          setAnswerState("idle");
          setError(reason instanceof Error ? reason.message : "Could not capture the window.");
          return;
        }
        if (generation !== answerGenerationRef.current) return;
        if (!capture?.success || !capture.image) {
          setAnswerState("idle");
          setError(capture?.error || "Could not capture the selected window.");
          return;
        }
        screenshot = capture.image;
      }

      const currentSettings = readInterviewSettings();
      const request = buildInterviewRequest({
        mode,
        userData: launchConfigRef.current?.userData ?? "",
        // Read before the new answer joins the list, so the pending one is never included.
        previousAnswers: formatPreviousInterviewAnswers(
          answersRef.current,
          currentSettings.contextBudgetTokens
        ),
        compactedHistory: compactedHistoryRef.current,
        liveTranscript,
      });
      const answer: InterviewAnswer = {
        id: crypto.randomUUID(),
        mode,
        raw: "",
        isStreaming: true,
      };
      const nextAnswers = answersRef.current.concat(answer);
      setAnswerList(nextAnswers);
      setAnswerState("thinking");

      try {
        for await (const chunk of streamInterviewAnswer({
          systemPrompt: buildInterviewSystemPrompt(currentSettings.systemPrompt),
          request,
          screenshot,
        })) {
          if (generation !== answerGenerationRef.current) return;
          if (chunk.type !== "content") continue;
          setAnswerState("streaming");
          const updated = answersRef.current.map((item) =>
            item.id === answer.id ? { ...item, raw: item.raw + chunk.text } : item
          );
          setAnswerList(updated);
        }

        if (generation !== answerGenerationRef.current) return;
        const completed = answersRef.current.map((item) =>
          item.id === answer.id ? { ...item, isStreaming: false } : item
        );
        setAnswerList(completed);
        setAnswerState("idle");
        logger.info("Interview answer generated", { action: mode }, "interview");
        try {
          await persistAnswers(completed);
        } catch {
          setError("The answer was generated, but it could not be saved to the meeting note.");
        }
      } catch (reason) {
        if (generation !== answerGenerationRef.current) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        const failed = answersRef.current.map((item) =>
          item.id === answer.id ? { ...item, isStreaming: false, error: message } : item
        );
        setAnswerList(failed);
        setAnswerState("idle");
        setError(message);
      }
    },
    [persistAnswers, setAnswerList]
  );

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onInterviewAction?.((action) => {
      void executeAnswer(action);
    });
    return () => unsubscribe?.();
  }, [executeAnswer]);

  const closeWindow = useCallback(async () => {
    if (closeRunningRef.current) return;
    closeRunningRef.current = true;
    try {
      const saved = await stopInterview();
      if (!saved) return;
      await window.electronAPI?.closeInterviewWindow?.();
    } finally {
      closeRunningRef.current = false;
    }
  }, [stopInterview]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onInterviewCloseRequested?.(() => {
      void closeWindow();
    });
    return () => unsubscribe?.();
  }, [closeWindow]);

  useEffect(() => {
    if (!isRecording || compactionRunningRef.current || segments.length === 0) return;
    const tail = getUncompactedInterviewSegments(segments, compactedSegmentIdsRef.current);
    if (tail.length === 0) return;
    const tailText = formatInterviewTranscript(tail);
    if (
      !shouldCompactInterviewContext({
        compactedHistory: compactedHistoryRef.current,
        liveTranscript: tailText,
        contextBudgetTokens: settings.contextBudgetTokens,
      })
    ) {
      return;
    }

    const sessionGeneration = sessionGenerationRef.current;
    const snapshotIds = tail.map((segment) => segment.id);
    compactionRunningRef.current = true;
    setIsCompacting(true);
    void compactInterviewHistory({
      previousSummary: compactedHistoryRef.current,
      transcript: tailText,
      contextBudgetTokens: settings.contextBudgetTokens,
    })
      .then((summary) => {
        if (sessionGeneration !== sessionGenerationRef.current || !summary.trim()) return;
        compactedSegmentIdsRef.current = mergeCompactedInterviewSegmentIds(
          compactedSegmentIdsRef.current,
          snapshotIds
        );
        compactedHistoryRef.current = summary.trim();
      })
      .catch(() => {
        // Keep the previous summary and full tail. A later segment retries without data loss.
      })
      .finally(() => {
        compactionRunningRef.current = false;
        setIsCompacting(false);
      });
  }, [isRecording, segments, settings]);

  const transcriptRows = useMemo(
    () => [
      ...segments,
      ...(micPartial
        ? [{ id: "mic-partial", text: micPartial, source: "mic" as const, partial: true }]
        : []),
      ...(systemPartial
        ? [{ id: "system-partial", text: systemPartial, source: "system" as const, partial: true }]
        : []),
    ],
    [micPartial, segments, systemPartial]
  );

  return (
    <div className="interview-window h-screen bg-transparent p-3 text-foreground">
      <MeetingRecordingMount />
      <div
        className="relative flex h-full flex-col overflow-hidden rounded-xl border border-white/15 shadow-2xl"
        style={{ backgroundColor: `rgba(0, 0, 0, ${settings.backgroundOpacity / 100})` }}
      >
        <header
          className="flex h-11 shrink-0 items-center gap-3 border-b border-white/10 px-3"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          data-interview-hit
        >
          <button
            type="button"
            onPointerDown={(event) => void beginMove(event)}
            className="-ml-1 flex h-7 w-6 cursor-grab items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white active:cursor-grabbing"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            aria-label={t("interviewWindow.moveWindow")}
          >
            <span className="grid grid-cols-2 gap-[3px]">
              {Array.from({ length: 6 }, (_, index) => (
                <span key={index} className="h-[3px] w-[3px] rounded-full bg-current" />
              ))}
            </span>
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${isRecording ? "bg-red-500" : "bg-white/30"}`}
            />
            <span className="shrink-0 text-sm font-semibold text-white">Interview Mode</span>
            {isCompacting && (
              <span className="min-w-0 truncate text-[11px] text-white/45">
                Compacting context…
              </span>
            )}
          </div>
          {isRecording || recordingNoteId == null ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={!isRecording}
              onClick={() => void stopInterview()}
              className="h-7 gap-2 text-xs"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <Square size={10} fill="currentColor" /> {t("interviewSetup.stop")}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void continueInterview()}
              className="h-7 gap-2 text-xs"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <Play size={10} fill="currentColor" /> {t("interviewSetup.continue")}
            </Button>
          )}
          <button
            type="button"
            onClick={() => void closeWindow()}
            className="rounded-md p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            aria-label="Close Interview Mode"
          >
            <X size={15} />
          </button>
        </header>

        <main
          className={`grid min-h-0 flex-1 gap-3 p-3 ${
            liveConversationCollapsed ? "grid-cols-[2.25rem_minmax(0,1fr)]" : "grid-cols-2"
          }`}
        >
          {liveConversationCollapsed ? (
            <button
              type="button"
              onClick={() => setLiveConversationCollapsed(false)}
              className="flex min-h-0 flex-col items-center overflow-hidden rounded-lg border border-white/10 bg-black/20 text-white/60 transition-colors hover:bg-white/5 hover:text-white"
              aria-label={t("interviewWindow.expandLiveConversation")}
            >
              <span className="flex h-9 shrink-0 items-center">
                <ChevronRight size={14} />
              </span>
              <span className="whitespace-nowrap text-xs font-semibold [writing-mode:vertical-rl]">
                {t("interviewWindow.liveConversation")}
              </span>
            </button>
          ) : (
            <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-black/20">
              <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-white/10 pl-1.5 pr-3">
                <button
                  type="button"
                  onClick={() => setLiveConversationCollapsed(true)}
                  className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white"
                  aria-label={t("interviewWindow.collapseLiveConversation")}
                >
                  <ChevronLeft size={14} />
                </button>
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-white/75">
                  {t("interviewWindow.liveConversation")}
                </span>
                {/* Each row already names its speaker, so a narrow column drops the legend. */}
                <span className="hidden shrink-0 text-[10px] text-white/35 sm:inline">
                  You / Others
                </span>
              </div>
              <InterviewScrollArea contentClassName="space-y-2">
                {transcriptRows.length === 0 ? (
                  <p className="text-xs text-white/35">Conversation will appear here.</p>
                ) : (
                  transcriptRows.map((segment: TranscriptSegment & { partial?: boolean }) => (
                    <div key={segment.id} className={segment.partial ? "opacity-55" : ""}>
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-white/40">
                        {segment.source === "mic" ? "You" : "Others"}
                        {segment.partial ? " · partial" : ""}
                      </span>
                      <p className="mt-0.5 text-xs leading-relaxed text-white/85">{segment.text}</p>
                    </div>
                  ))
                )}
              </InterviewScrollArea>
            </section>
          )}

          <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-black/20">
            <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3">
              <span className="min-w-0 truncate text-xs font-semibold text-white/75">
                Questions and answers
              </span>
              {answerState !== "idle" && (
                <span className="flex shrink-0 items-center gap-1 text-[10px] text-white/40">
                  <Loader2 size={10} className="animate-spin" /> {answerState}
                </span>
              )}
            </div>
            <InterviewScrollArea
              contentClassName="space-y-3"
              scrollbarSide="left"
              followContent="always"
              scrollToBottomKey={answerScrollRequest}
            >
              {answers.length === 0 ? (
                <p className="text-sm text-white/35">Generated answers will remain here.</p>
              ) : (
                answers.map((answer) => <InterviewAnswerCard key={answer.id} answer={answer} />)
              )}
            </InterviewScrollArea>
          </section>
        </main>

        <footer className="shrink-0 border-t border-white/10 px-3 py-3">
          {(error || meetingError) && (
            <p className="mb-2 text-xs text-red-300">{error || meetingError}</p>
          )}
          {/* Disabled buttons drop pointer events, so the row catches the pointer
              itself: a click on a greyed-out action never lands on the app beneath. */}
          {/* Labels truncate as the window narrows and give way to icons alone
              below 520px, where even a truncated label no longer reads. */}
          <div className="grid grid-cols-3 gap-2" data-interview-hit>
            {answerActions.map(({ mode, Icon }) => (
              <Button
                key={mode}
                variant="secondary"
                disabled={!isRecording || answerState === "capturing"}
                onClick={() => void executeAnswer(mode)}
                className="h-9 min-w-0 gap-2 text-xs"
                aria-label={actionLabels[mode]}
                title={actionLabels[mode]}
              >
                <Icon size={14} />
                <span className="hidden truncate min-[520px]:inline">{actionLabels[mode]}</span>
              </Button>
            ))}
          </div>
        </footer>
        <button
          type="button"
          onPointerDown={(event) => void beginResize(event)}
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize text-white/35 hover:text-white/70"
          aria-label="Resize Interview window"
        >
          <span className="absolute bottom-1 right-1 h-2 w-2 border-b border-r border-current" />
        </button>
      </div>
    </div>
  );
}
