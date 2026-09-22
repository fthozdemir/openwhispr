import ReasoningService, { type AgentStreamChunk } from "../services/ReasoningService";
import { providerSupportsImages } from "../services/ai/inferenceProviders";
import { resolveChatStreamingInference } from "./dictationAgentInference.js";
import { buildInterviewCompactionRequest } from "./interviewContext";
import { getSettings, type SettingsState } from "../stores/settingsStore";

export interface InterviewScreenshot {
  data: string;
  mediaType: string;
}

export const INTERVIEW_SCREENSHOT_UNSUPPORTED_ERROR =
  "The selected Chat Intelligence provider cannot send images.";

// The model's vision support is the user's to verify (Interview setup warns
// about it); only a provider whose client cannot carry images blocks screenshots.
function resolveInference(settings: SettingsState, hasScreenshot: boolean) {
  return resolveChatStreamingInference(settings, {
    inferenceScope: "chatIntelligence",
    hasScreenContext: hasScreenshot,
    isProviderImageWired: providerSupportsImages,
    requireModelVision: false,
  });
}

export function interviewCanSendScreenshot(settings: SettingsState = getSettings()): boolean {
  return resolveInference(settings, true).attachScreenContext;
}

export async function* streamInterviewAnswer({
  systemPrompt,
  request,
  screenshot,
}: {
  systemPrompt: string;
  request: string;
  screenshot?: InterviewScreenshot | null;
}): AsyncGenerator<AgentStreamChunk, void, unknown> {
  const settings = getSettings();
  const { config, attachScreenContext } = resolveInference(settings, !!screenshot);
  if (screenshot && !attachScreenContext) {
    throw new Error(INTERVIEW_SCREENSHOT_UNSUPPORTED_ERROR);
  }

  const isCloud = config.mode === "openwhispr" && settings.isSignedIn;
  const isLan = config.mode === "self-hosted" && !!config.remoteUrl;
  const isCustom = config.mode === "providers" && config.provider === "custom";
  const userContent =
    screenshot && !isCloud
      ? [
          { type: "text", text: request },
          { type: "image", image: screenshot.data, mediaType: screenshot.mediaType },
        ]
      : request;
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  if (isCloud) {
    yield* ReasoningService.processTextStreamingCloud(messages, {
      systemPrompt,
      ...(screenshot ? { screenContext: screenshot } : {}),
    });
    return;
  }

  yield* ReasoningService.processTextStreamingAI(messages, config.model, config.provider, {
    systemPrompt,
    inferenceScope: "chatIntelligence",
    lanUrl: isLan ? config.remoteUrl : undefined,
    baseUrl: isCustom ? config.cloudBaseUrl : undefined,
    customApiKey: isCustom || isLan ? config.customApiKey : undefined,
    disableThinking: config.disableThinking,
  });
}

export async function compactInterviewHistory({
  previousSummary,
  transcript,
  contextBudgetTokens,
}: {
  previousSummary: string;
  transcript: string;
  contextBudgetTokens: number;
}): Promise<string> {
  const settings = getSettings();
  const { config } = resolveInference(settings, false);
  const isCloud = config.mode === "openwhispr" && settings.isSignedIn;
  const isLan = config.mode === "self-hosted" && !!config.remoteUrl;
  const isCustom = config.mode === "providers" && config.provider === "custom";
  const provider = isCloud ? "openwhispr" : isLan ? "lan" : config.provider;
  const { systemPrompt, input, maxTokens } = buildInterviewCompactionRequest({
    previousSummary,
    transcript,
    contextBudgetTokens,
  });

  return ReasoningService.processText(input, config.model, null, {
    provider,
    systemPrompt,
    inferenceScope: "chatIntelligence",
    requiresAgent: true,
    lanUrl: isLan ? config.remoteUrl : undefined,
    baseUrl: isCustom ? config.cloudBaseUrl : undefined,
    customApiKey: isCustom || isLan ? config.customApiKey : undefined,
    disableThinking: config.disableThinking,
    maxTokens,
    // A cut-off summary would silently replace the segments it covers; failing keeps them for a retry.
    requireCompleteOutput: true,
  });
}

export function cancelInterviewAnswer(): void {
  ReasoningService.cancelActiveStream();
}
