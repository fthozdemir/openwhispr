import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "../ui/input";
import { HotkeyInput } from "../ui/HotkeyInput";
import { SectionHeader, SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import {
  INTERVIEW_CONTEXT_BUDGET_MAX_TOKENS,
  INTERVIEW_CONTEXT_BUDGET_MIN_TOKENS,
  readInterviewSettings,
  writeInterviewSetting,
  type InterviewSettings as InterviewSettingsValue,
} from "../../helpers/interviewSettings";

export default function InterviewSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(readInterviewSettings);

  const update = <K extends keyof InterviewSettingsValue>(
    key: K,
    value: InterviewSettingsValue[K]
  ) => {
    setSettings((current) => ({ ...current, [key]: value }));
    writeInterviewSetting(key, value);
  };

  const validateHotkey = (currentKey: keyof InterviewSettingsValue) => (hotkey: string) => {
    const duplicate = (
      ["conversationHotkey", "screenshotHotkey", "screenshotConversationHotkey"] as const
    ).some((key) => key !== currentKey && settings[key] === hotkey);
    return duplicate ? t("settingsPage.interview.shortcutInUse") : null;
  };

  return (
    <div className="space-y-6">
      <div>
        <SectionHeader
          title={t("settingsPage.interview.systemPromptTitle")}
          description={t("settingsPage.interview.systemPromptDescription")}
        />
        <textarea
          dir="auto"
          value={settings.systemPrompt}
          onChange={(event) => update("systemPrompt", event.target.value)}
          rows={9}
          className="w-full resize-y rounded-md border border-border/70 bg-transparent px-3 py-2 text-xs leading-relaxed focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </div>

      <div>
        <SectionHeader
          title={t("settingsPage.interview.compactionTitle")}
          description={t("settingsPage.interview.compactionDescription")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.interview.contextBudget")}
              description={t("settingsPage.interview.contextBudgetDescription")}
            >
              <Input
                type="number"
                min={INTERVIEW_CONTEXT_BUDGET_MIN_TOKENS}
                max={INTERVIEW_CONTEXT_BUDGET_MAX_TOKENS}
                value={settings.contextBudgetTokens}
                onChange={(event) => update("contextBudgetTokens", Number(event.target.value))}
                className="h-8 w-28 text-xs"
              />
            </SettingsRow>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>

      <div>
        <SectionHeader
          title={t("settingsPage.interview.shortcutsTitle")}
          description={t("settingsPage.interview.shortcutsDescription")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow label={t("settingsPage.interview.conversationShortcut")}>
              <HotkeyInput
                value={settings.conversationHotkey}
                onChange={(hotkey) => update("conversationHotkey", hotkey)}
                onClear={() => update("conversationHotkey", "")}
                validate={validateHotkey("conversationHotkey")}
              />
            </SettingsRow>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <SettingsRow label={t("settingsPage.interview.screenshotShortcut")}>
              <HotkeyInput
                value={settings.screenshotHotkey}
                onChange={(hotkey) => update("screenshotHotkey", hotkey)}
                onClear={() => update("screenshotHotkey", "")}
                validate={validateHotkey("screenshotHotkey")}
              />
            </SettingsRow>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <SettingsRow label={t("settingsPage.interview.screenshotConversationShortcut")}>
              <HotkeyInput
                value={settings.screenshotConversationHotkey}
                onChange={(hotkey) => update("screenshotConversationHotkey", hotkey)}
                onClear={() => update("screenshotConversationHotkey", "")}
                validate={validateHotkey("screenshotConversationHotkey")}
              />
            </SettingsRow>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>

      <div>
        <SectionHeader
          title={t("settingsPage.interview.windowTitle")}
          description={t("settingsPage.interview.windowDescription")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow label={t("settingsPage.interview.backgroundOpacity")}>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={settings.backgroundOpacity}
                  onChange={(event) => update("backgroundOpacity", Number(event.target.value))}
                  aria-label={t("settingsPage.interview.backgroundOpacity")}
                  className="w-40 accent-primary"
                />
                <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                  {settings.backgroundOpacity}%
                </span>
              </div>
            </SettingsRow>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>
    </div>
  );
}
