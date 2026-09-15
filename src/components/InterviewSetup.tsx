import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { useShallow } from "zustand/react/shallow";
import { AlertTriangle, Copy, Mic, RefreshCw } from "./icons";
import { Button } from "./ui/button";
import {
  INTERVIEW_USER_DATA_WARNING_TOKENS,
  estimateInterviewTokens,
  getInterviewUserDataMaxLength,
} from "../helpers/interviewContext";
import { readInterviewSettings } from "../helpers/interviewSettings";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { getCloudModel, getLocalModel, getProviderDisplayName } from "../models/ModelRegistry";
import { selectResolvedLLMConfig, useSettingsStore } from "../stores/settingsStore";
import type { InferenceMode } from "../types/electron";

interface CaptureSource {
  id: string;
  name: string;
}

interface InterviewSetupProps {
  onOpenModelSettings?: () => void;
}

const MODE_LABEL_KEYS: Record<InferenceMode, string> = {
  openwhispr: "agentMode.settings.modes.openwhispr",
  providers: "agentMode.settings.modes.providers",
  local: "agentMode.settings.modes.local",
  "self-hosted": "agentMode.settings.modes.selfHosted",
  enterprise: "agentMode.settings.modes.enterprise",
};

export default function InterviewSetup({ onOpenModelSettings }: InterviewSetupProps) {
  const { t } = useTranslation();
  // Resolved exactly as the Interview window resolves it (interviewInference.ts),
  // so the model named here is the one that answers.
  const chatModel = useSettingsStore(
    useShallow((settings) => selectResolvedLLMConfig(settings, "chatIntelligence"))
  );
  const modeLabel = t(MODE_LABEL_KEYS[chatModel.mode]);
  const modelName =
    chatModel.mode === "openwhispr"
      ? modeLabel
      : getCloudModel(chatModel.model, chatModel.provider)?.name ||
        getLocalModel(chatModel.model)?.name ||
        chatModel.model;
  const modelSource =
    chatModel.mode === "openwhispr"
      ? ""
      : chatModel.mode === "providers"
        ? getProviderDisplayName(chatModel.provider)
        : modeLabel;
  const [captureSources, setCaptureSources] = useState<CaptureSource[]>([]);
  const [captureSourceId, setCaptureSourceId] = useState("");
  const [phoneRemoteUrl, setPhoneRemoteUrl] = useState("");
  const [phoneRemoteError, setPhoneRemoteError] = useState("");
  const { copyText } = useCopyFeedback(phoneRemoteUrl);
  const [userData, setUserData] = useLocalStorage("interviewUserData", "");
  const [error, setError] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const userDataTokens = estimateInterviewTokens(userData);
  const userDataMaxLength = getInterviewUserDataMaxLength(
    readInterviewSettings().contextBudgetTokens
  );

  const refreshCaptureSources = useCallback(async () => {
    setError("");
    try {
      const result = await window.electronAPI?.listInterviewCaptureSources?.();
      if (!result?.success) {
        setCaptureSources([]);
        setError(result?.error || t("interviewSetup.errors.listWindows"));
        return;
      }
      setCaptureSources(result.sources);
      setCaptureSourceId((current) =>
        result.sources.some((source) => source.id === current)
          ? current
          : (result.sources[0]?.id ?? "")
      );
    } catch (reason) {
      setCaptureSources([]);
      setError(reason instanceof Error ? reason.message : t("interviewSetup.errors.listWindows"));
    }
  }, [t]);

  useEffect(() => {
    void refreshCaptureSources();
  }, [refreshCaptureSources]);

  useEffect(() => {
    let active = true;
    void window.electronAPI
      ?.getInterviewPhoneRemote?.()
      .then((result) => {
        if (!active) return;
        if (result?.success && result.url) {
          setPhoneRemoteUrl(result.url);
          setPhoneRemoteError("");
          return;
        }
        setPhoneRemoteUrl("");
        setPhoneRemoteError(result?.error || t("interviewPhoneRemote.unavailable"));
      })
      .catch(() => {
        if (!active) return;
        setPhoneRemoteUrl("");
        setPhoneRemoteError(t("interviewPhoneRemote.unavailable"));
      });
    return () => {
      active = false;
    };
  }, [t]);

  const startInterview = async () => {
    setError("");
    setIsStarting(true);
    try {
      const result = await window.electronAPI?.openInterviewWindow?.({
        captureSourceId,
        userData,
      });
      if (!result?.success) {
        setError(result?.error || t("interviewSetup.errors.openFailed"));
        return;
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("interviewSetup.errors.openFailed"));
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("interviewSetup.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("interviewSetup.description")}</p>
      </div>

      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="grid gap-5 md:grid-cols-2">
          <label className="min-w-0">
            <span className="mb-2 block text-sm font-medium text-foreground">
              {t("interviewSetup.captureWindow")}
            </span>
            <div className="flex gap-2">
              <select
                value={captureSourceId}
                onChange={(event) => setCaptureSourceId(event.target.value)}
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                {captureSources.length === 0 && (
                  <option value="">{t("interviewSetup.noWindows")}</option>
                )}
                {captureSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="icon"
                onClick={() => void refreshCaptureSources()}
                title={t("interviewSetup.refreshWindows")}
                aria-label={t("interviewSetup.refreshWindows")}
              >
                <RefreshCw size={15} />
              </Button>
            </div>
          </label>

          <div className="min-w-0">
            <span className="mb-2 block text-sm font-medium text-foreground">
              {t("interviewPhoneRemote.urlLabel")}
            </span>
            <div className="flex min-h-9 items-start gap-3">
              {phoneRemoteUrl ? (
                <>
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <code
                      className="min-w-0 flex-1 select-all truncate rounded-md border border-input bg-muted px-3 py-2 text-xs text-foreground"
                      title={phoneRemoteUrl}
                    >
                      {phoneRemoteUrl}
                    </code>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => void copyText(phoneRemoteUrl)}
                      title={t("common.copy")}
                      aria-label={t("common.copy")}
                    >
                      <Copy size={15} />
                    </Button>
                  </div>
                  <QRCodeSVG
                    value={phoneRemoteUrl}
                    size={72}
                    level="L"
                    marginSize={4}
                    title={t("interviewPhoneRemote.urlLabel")}
                    className="h-[72px] w-[72px] shrink-0 rounded-md"
                  />
                </>
              ) : (
                <span className="truncate text-xs text-muted-foreground">
                  {phoneRemoteError || t("common.loading")}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2.5">
          <div className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">
              {t("interviewSetup.aiModel")}
              <span className="ms-2 font-normal text-muted-foreground">
                {modelName || t("interviewSetup.modelNotSelected")}
                {modelSource && ` · ${modelSource}`}
              </span>
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t("interviewSetup.aiModelSameAsChat")}
            </span>
          </div>
          {onOpenModelSettings && (
            <Button variant="outline" size="sm" onClick={onOpenModelSettings}>
              {t("interviewSetup.changeModel")}
            </Button>
          )}
        </div>

        <label className="mt-5 block">
          <span className="text-sm font-medium text-foreground">
            {t("interviewSetup.userData")}
          </span>
          <span className="ms-2 text-xs text-muted-foreground">
            {t("interviewSetup.savedOnDevice")}
          </span>
          <textarea
            dir="auto"
            value={userData}
            onChange={(event) => setUserData(event.target.value)}
            placeholder={t("interviewSetup.userDataPlaceholder")}
            maxLength={userDataMaxLength}
            rows={5}
            className="mt-2 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
          />
          {userDataTokens > INTERVIEW_USER_DATA_WARNING_TOKENS && (
            <span className="mt-1.5 flex items-start gap-1.5 text-xs text-warning">
              <AlertTriangle size={13} className="mt-px shrink-0" />
              {t("interviewSetup.userDataLarge", {
                tokens: userDataTokens.toLocaleString(),
                limit: INTERVIEW_USER_DATA_WARNING_TOKENS.toLocaleString(),
              })}
            </span>
          )}
        </label>

        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

        <div className="mt-5 flex justify-end">
          <Button
            onClick={() => void startInterview()}
            disabled={isStarting || !captureSourceId}
            className="gap-2"
          >
            <Mic size={15} />
            {isStarting ? t("interviewSetup.starting") : t("interviewSetup.start")}
          </Button>
        </div>
      </div>
    </div>
  );
}
