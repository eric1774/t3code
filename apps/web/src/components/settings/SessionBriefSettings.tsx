import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { resolvePastedPath } from "@t3tools/shared/path";

import { DraftInput } from "../ui/draft-input";
import { SettingsRow, SettingResetButton, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const LOG_PATH_PLACEHOLDER = "C:\\…\\13-Session Briefs\\Session-Briefs-Log.json";

export function SessionBriefSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["sessionBriefLogPath"]);

  return (
    <SettingsSection id="session-brief" title="Session brief">
      <SettingsRow
        serverScoped
        settingKeys={["sessionBriefLogPath"]}
        {...searchableSetting("session-brief-log-path")}
        description="Verified brief entries are appended here (Session-Briefs-Log.json). Leave empty to keep briefs without logging."
        resetAction={
          settings.sessionBriefLogPath !== DEFAULT_UNIFIED_SETTINGS.sessionBriefLogPath ? (
            <SettingResetButton
              label="session brief log file"
              onClick={() =>
                updateSettings({
                  sessionBriefLogPath: DEFAULT_UNIFIED_SETTINGS.sessionBriefLogPath,
                })
              }
            />
          ) : null
        }
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={mixed ? "" : settings.sessionBriefLogPath}
            onCommit={(next) => updateSettings({ sessionBriefLogPath: next })}
            normalizeDraft={resolvePastedPath}
            placeholder={mixed ? "Mixed" : LOG_PATH_PLACEHOLDER}
            spellCheck={false}
            aria-label="Session brief log file"
          />
        }
      />
    </SettingsSection>
  );
}
