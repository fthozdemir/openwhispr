import ReasoningService, { type AgentStreamChunk } from "../services/ReasoningService";
import { providerSupportsImages } from "../services/ai/inferenceProviders";
import { resolveChatStreamingInference } from "./dictationAgentInference.js";
import { buildInterviewCompactionRequest } from "./interviewContext";
import { getSettings } from "../stores/settingsStore";

export interface InterviewScreenshot {
  data: string;
  mediaType: string;
}

function resolveInference(hasScreenshot: boolean) {
  const settings = getSettings();
  const resolution = resolveChatStreamingInference(settings, {
    inferenceScope: "chatIntelligence",
    hasScreenContext: hasScreenshot,
    isProviderImageWired: providerSupportsImages,
  });
  return { settings, ...resolution };
}

export function interviewModelSupportsScreenshot(): boolean {
  return resolveInference(true).attachScreenContext;
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
  const { settings, config, attachScreenContext } = resolveInference(!!screenshot);
  if (screenshot && !attachScreenContext) {
    throw new Error("Selected Chat Intelligence model does not support images.");
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
  const { settings, config } = resolveInference(false);
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
