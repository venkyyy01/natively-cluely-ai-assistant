import React from 'react';
import packageJson from '../../../package.json';
import {
  Activity,
  BadgeCheck,
  Brain,
  Check,
  ChevronDown,
  MousePointerClick,
  Eye,
  Ghost,
  Globe,
  Layout,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  Power,
  Settings,
  Sun,
  Terminal,
  Zap,
} from 'lucide-react';
import { analytics } from '../../lib/analytics/analytics.service';
import { requireElectronMethod } from '../../lib/electronApi';

const DISGUISE_OPTIONS: Array<{
  id: 'none' | 'terminal' | 'settings' | 'activity';
  label: string;
  icon: React.ReactNode;
}> = [
  { id: 'none', label: 'None (Default)', icon: <Layout size={14} /> },
  { id: 'terminal', label: 'Terminal', icon: <Terminal size={14} /> },
  { id: 'settings', label: 'System Settings', icon: <Settings size={14} /> },
  { id: 'activity', label: 'Activity Monitor', icon: <Activity size={14} /> },
];

interface GeneralSettingsSectionProps {
isUndetectable: boolean;
setIsUndetectable: (value: boolean) => void;
openOnLogin: boolean;
setOpenOnLogin: (value: boolean) => void;
showTranscript: boolean;
setShowTranscript: (value: boolean) => void;
generalSettingsError: string;
themeMode: 'system' | 'light' | 'dark';
isThemeDropdownOpen: boolean;
setIsThemeDropdownOpen: (open: boolean) => void;
themeDropdownRef: React.RefObject<HTMLDivElement>;
handleSetTheme: (mode: 'system' | 'light' | 'dark') => void | Promise<void>;
aiResponseLanguage: string;
isAiLangDropdownOpen: boolean;
setIsAiLangDropdownOpen: (open: boolean) => void;
aiLangDropdownRef: React.RefObject<HTMLDivElement>;
availableAiLanguages: Array<{ code: string; label: string }>;
handleAiLanguageChange: (code: string) => void | Promise<void>;
  overlayOpacity: number;
  overlayClickthroughEnabled: boolean;
  handleOpacityChange: (value: number) => void;
  setOverlayClickthroughEnabled: (value: boolean) => void;
  startPreviewingOpacity: () => void;
stopPreviewingOpacity: () => void;
isPreviewingOpacity: boolean;
  disguiseMode: 'none' | 'terminal' | 'settings' | 'activity';
  setDisguiseMode: (mode: 'none' | 'terminal' | 'settings' | 'activity') => void;
  showGeneralSettingsError: (message: string) => void;
  accelerationModeEnabled: boolean;
  setAccelerationModeEnabled: (value: boolean) => void;
  consciousModeEnabled: boolean;
  setConsciousModeEnabled: (value: boolean) => void;
}

export const GeneralSettingsSection: React.FC<GeneralSettingsSectionProps> = ({
  isUndetectable,
  setIsUndetectable,
  openOnLogin,
  setOpenOnLogin,
  showTranscript,
  setShowTranscript,
  generalSettingsError,
  themeMode,
  isThemeDropdownOpen,
  setIsThemeDropdownOpen,
  themeDropdownRef,
  handleSetTheme,
  aiResponseLanguage,
  isAiLangDropdownOpen,
  setIsAiLangDropdownOpen,
  aiLangDropdownRef,
  availableAiLanguages,
  handleAiLanguageChange,
  overlayOpacity,
  overlayClickthroughEnabled,
  handleOpacityChange,
  setOverlayClickthroughEnabled,
  startPreviewingOpacity,
  stopPreviewingOpacity,
  isPreviewingOpacity,
  disguiseMode,
  setDisguiseMode,
  showGeneralSettingsError,
  accelerationModeEnabled,
  setAccelerationModeEnabled,
  consciousModeEnabled,
  setConsciousModeEnabled,
}) => {
  return (
    <div className="space-y-6 animated fadeIn">
      <div className="space-y-3.5">
        <div
          className={`bg-bg-item-surface rounded-xl p-5 border border-border-subtle flex items-center justify-between transition-all ${isUndetectable ? 'shadow-lg shadow-blue-500/10' : ''}`}
        >
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              {isUndetectable ? (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-text-primary"
                >
                  <path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" fill="currentColor" stroke="currentColor" />
                  <path d="M9 10h.01" stroke="var(--bg-item-surface)" strokeWidth="2.5" />
                  <path d="M15 10h.01" stroke="var(--bg-item-surface)" strokeWidth="2.5" />
                </svg>
              ) : (
                <Ghost size={18} className="text-text-primary" />
              )}
              <h3 className="text-lg font-bold text-text-primary">{isUndetectable ? 'Undetectable' : 'Detectable'}</h3>
            </div>
            <p className="text-xs text-text-secondary">
              Natively is currently {isUndetectable ? 'undetectable' : 'detectable'} by screen-sharing.{' '}
              <button className="text-blue-400 hover:underline">Supported apps here</button>
            </p>
          </div>
          <div
            onClick={async () => {
              const newState = !isUndetectable;
              setIsUndetectable(newState);
              try {
                const setUndetectable = requireElectronMethod('setUndetectable');
                const result = await setUndetectable(newState);
                if (!result?.success) {
                  throw new Error(result?.error || 'Unable to update stealth mode');
                }
                analytics.trackModeSelected(newState ? 'undetectable' : 'overlay');
              } catch (error: any) {
                setIsUndetectable(!newState);
                showGeneralSettingsError(error?.message || 'Unable to update stealth mode');
              }
            }}
            className={`w-11 h-6 rounded-full relative transition-colors ${isUndetectable ? 'bg-accent-primary' : 'bg-bg-toggle-switch border border-border-muted'}`}
          >
            <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${isUndetectable ? 'translate-x-5' : 'translate-x-0'}`} />
          </div>
        </div>

        <div>
          <h3 className="text-lg font-bold text-text-primary mb-1">General settings</h3>
          <p className="text-xs text-text-secondary mb-2">Customize how Natively works for you</p>

          <div className="space-y-4">
            {generalSettingsError && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {generalSettingsError}
              </div>
            )}

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-bg-item-surface rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary">
                  <Power size={20} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-text-primary">Open Natively when you log in</h3>
                  <p className="text-xs text-text-secondary mt-0.5">Natively will open automatically when you log in to your computer</p>
                </div>
              </div>
              <div
                onClick={async () => {
                  const newState = !openOnLogin;
                  setOpenOnLogin(newState);
                  try {
                    const result = await window.electronAPI?.setOpenAtLogin(newState);
                    if (!result?.success) {
                      throw new Error(result?.error || 'Unable to update login preference');
                    }
                  } catch (error: any) {
                    setOpenOnLogin(!newState);
                    showGeneralSettingsError(error?.message || 'Unable to update login preference');
                  }
                }}
                className={`w-11 h-6 rounded-full relative transition-colors ${openOnLogin ? 'bg-accent-primary' : 'bg-bg-toggle-switch border border-border-muted'}`}
              >
                <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${openOnLogin ? 'translate-x-5' : 'translate-x-0'}`} />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-bg-item-surface rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary">
                  <MessageSquare size={20} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-text-primary">Interviewer Transcript</h3>
                  <p className="text-xs text-text-secondary mt-0.5">Show real-time transcription of the interviewer</p>
                </div>
              </div>
<div
      onClick={() => {
        const newState = !showTranscript;
        setShowTranscript(newState);
        localStorage.setItem('natively_interviewer_transcript', String(newState));
        window.dispatchEvent(new Event('storage'));
      }}
      className={`w-11 h-6 rounded-full relative transition-colors ${showTranscript ? 'bg-accent-primary' : 'bg-bg-toggle-switch border border-border-muted'}`}
    >
      <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${showTranscript ? 'translate-x-5' : 'translate-x-0'}`} />
    </div>
  </div>

  <div className="flex items-center justify-between">
    <div className="flex items-center gap-4">
      <div className="w-10 h-10 bg-bg-item-surface rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary">
        <Zap size={20} />
      </div>
      <div>
        <h3 className="text-sm font-bold text-text-primary">Acceleration Mode</h3>
        <p className="text-xs text-text-secondary mt-0.5">Neural Engine acceleration for faster embeddings and context assembly (Apple Silicon)</p>
      </div>
    </div>
    <div
      onClick={async () => {
        const newState = !accelerationModeEnabled;
        setAccelerationModeEnabled(newState);
        try {
          const result = await window.electronAPI?.setAccelerationMode(newState);
          if (result && !result.success) {
            throw new Error(result.error?.message || 'Unable to update acceleration mode');
          }
        } catch (error: any) {
          setAccelerationModeEnabled(!newState);
          showGeneralSettingsError(error?.message || 'Unable to update acceleration mode');
        }
      }}
className={`w-11 h-6 rounded-full relative transition-colors ${accelerationModeEnabled ? 'bg-accent-primary' : 'bg-bg-toggle-switch border border-border-muted'}`}
>
<div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${accelerationModeEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
</div>
</div>

<div className="flex items-center justify-between">
<div className="flex items-center gap-4">
<div className="w-10 h-10 bg-bg-item-surface rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary">
<Brain size={20} />
</div>
<div>
<h3 className="text-sm font-bold text-text-primary">Conscious Mode</h3>
<p className="text-xs text-text-secondary mt-0.5">Phase-aware interview assistance with structured responses</p>
</div>
</div>
<div
onClick={async () => {
const newState = !consciousModeEnabled;
setConsciousModeEnabled(newState);
try {
const setConsciousMode = requireElectronMethod('setConsciousMode');
const result = await setConsciousMode(newState);
if (result && !result.success) {
throw new Error(result.error?.message || 'Unable to update conscious mode');
}
} catch (error: any) {
setConsciousModeEnabled(!newState);
showGeneralSettingsError(error?.message || 'Unable to update conscious mode');
}
}}
className={`w-11 h-6 rounded-full relative transition-colors ${consciousModeEnabled ? 'bg-accent-primary' : 'bg-bg-toggle-switch border border-border-muted'}`}
>
<div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${consciousModeEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
</div>
</div>

<div className="flex items-center justify-between">
<div className="flex items-center gap-4">
<div className="w-10 h-10 bg-bg-item-surface rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary">
<Palette size={20} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-text-primary">Theme</h3>
                  <p className="text-xs text-text-secondary mt-0.5">Customize how Natively looks on your device</p>
                </div>
              </div>

              <div className="relative" ref={themeDropdownRef}>
                <button
                  onClick={() => setIsThemeDropdownOpen(!isThemeDropdownOpen)}
                  className="bg-bg-component hover:bg-bg-elevated border border-border-subtle text-text-primary px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-2 min-w-[110px] justify-between"
                >
                  <div className="flex items-center gap-2 overflow-hidden">
                    <span className="text-text-secondary shrink-0">
                      {themeMode === 'system' && <Monitor size={14} />}
                      {themeMode === 'light' && <Sun size={14} />}
                      {themeMode === 'dark' && <Moon size={14} />}
                    </span>
                    <span className="capitalize text-ellipsis overflow-hidden whitespace-nowrap">{themeMode}</span>
                  </div>
                  <ChevronDown size={12} className={`shrink-0 transition-transform ${isThemeDropdownOpen ? 'rotate-180' : ''}`} />
                </button>

                {isThemeDropdownOpen && (
                  <div className="absolute right-0 top-full mt-1 min-w-full w-max bg-bg-elevated border border-border-subtle rounded-lg shadow-xl overflow-hidden z-20 p-1 animated fadeIn select-none">
                    {[
                      { mode: 'system', label: 'System', icon: <Monitor size={14} /> },
                      { mode: 'light', label: 'Light', icon: <Sun size={14} /> },
                      { mode: 'dark', label: 'Dark', icon: <Moon size={14} /> },
                    ].map((option) => (
                      <button
                        key={option.mode}
                        onClick={() => {
                          handleSetTheme(option.mode as 'system' | 'light' | 'dark');
                          setIsThemeDropdownOpen(false);
                        }}
                        className={`w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center gap-2 transition-colors ${themeMode === option.mode ? 'text-text-primary bg-bg-item-active/50' : 'text-text-secondary hover:bg-bg-input hover:text-text-primary'}`}
                      >
                        <span className={themeMode === option.mode ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'}>{option.icon}</span>
                        <span className="font-medium">{option.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-bg-item-surface rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary">
                  <Globe size={20} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-text-primary">AI Response Language</h3>
                  <p className="text-xs text-text-secondary mt-0.5">Language for AI suggestions and notes</p>
                </div>
              </div>

              <div className="relative" ref={aiLangDropdownRef}>
                <button
                  onClick={() => setIsAiLangDropdownOpen(!isAiLangDropdownOpen)}
                  className="bg-bg-component hover:bg-bg-elevated border border-border-subtle text-text-primary pl-4 pr-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-2 min-w-[110px] justify-between"
                >
                  <span className="capitalize text-ellipsis overflow-hidden whitespace-nowrap">{aiResponseLanguage}</span>
                  <ChevronDown size={12} className={`shrink-0 transition-transform ${isAiLangDropdownOpen ? 'rotate-180' : ''}`} />
                </button>

                {isAiLangDropdownOpen && (
                  <div className="absolute right-0 top-full mt-1 min-w-full w-max bg-bg-elevated border border-border-subtle rounded-lg shadow-xl overflow-hidden z-20 p-1 animated fadeIn select-none max-h-60 overflow-y-auto custom-scrollbar">
                    {availableAiLanguages.map((option) => (
                      <button
                        key={option.code}
                        onClick={() => {
                          handleAiLanguageChange(option.code);
                          setIsAiLangDropdownOpen(false);
                        }}
                        className={`w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center gap-2 transition-colors ${aiResponseLanguage === option.code ? 'text-text-primary bg-bg-item-active/50' : 'text-text-secondary hover:bg-bg-input hover:text-text-primary'}`}
                      >
                        <span className="font-medium">{option.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

<div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 bg-bg-item-surface rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary shrink-0">
            <BadgeCheck size={20} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-text-primary">Version</h3>
            <p className="text-xs text-text-secondary mt-0.5">Natively v{packageJson.version}</p>
          </div>
        </div>
      </div>

            <div
              id="opacity-slider-card"
              style={isPreviewingOpacity ? { visibility: 'visible', position: 'relative', zIndex: 9999 } : {}}
              className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle mt-4"
            >
              <div className="flex items-center justify-between mb-3">
                <label className="flex items-center gap-2 text-xs font-medium text-text-secondary uppercase tracking-wide">
                  <Eye size={13} className="text-text-secondary" />
                  Interface Opacity
                </label>
                <span className="opacity-percent-label text-xs font-semibold text-text-primary tabular-nums">{Math.round(overlayOpacity * 100)}%</span>
              </div>

              <input
                type="range"
                min={0.35}
                max={1.0}
                step={0.01}
                value={overlayOpacity}
                onChange={(e) => handleOpacityChange(parseFloat(e.target.value))}
                onPointerDown={startPreviewingOpacity}
                onPointerUp={stopPreviewingOpacity}
                onPointerCancel={stopPreviewingOpacity}
                onPointerLeave={stopPreviewingOpacity}
                className="w-full h-1.5 rounded-full appearance-none bg-bg-input accent-accent-primary cursor-pointer"
                style={{ WebkitAppearance: 'none' } as React.CSSProperties}
              />

              <div className="flex justify-between mt-1.5">
                <span className="text-[10px] text-text-tertiary">More Stealth</span>
                <span className="text-[10px] text-text-tertiary">Fully Visible</span>
              </div>

              <p className="text-xs text-text-tertiary mt-2">
                Controls the visibility of the in-meeting overlay. <span className="text-text-secondary">Hold the slider to preview.</span>
              </p>
            </div>

            <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle mt-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 bg-bg-component rounded-lg border border-border-subtle flex items-center justify-center text-text-tertiary shrink-0">
                    <MousePointerClick size={16} />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-text-primary">Overlay Clickthrough</h3>
                    <p className="text-xs text-text-secondary mt-0.5">
                      Let mouse clicks pass through the meeting overlay to the app underneath while keeping the overlay visible.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  aria-pressed={overlayClickthroughEnabled}
                  onClick={() => setOverlayClickthroughEnabled(!overlayClickthroughEnabled)}
                  className={`w-11 h-6 rounded-full relative transition-colors ${overlayClickthroughEnabled ? 'bg-accent-primary' : 'bg-bg-toggle-switch border border-border-muted'}`}
                >
                  <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${overlayClickthroughEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle">
        <div className="flex flex-col gap-1 mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-bold text-text-primary">Process Disguise</h3>
          </div>
          <p className="text-xs text-text-secondary">
            Disguise Natively as another application to prevent detection during screen sharing.
            <span className="block mt-1 text-text-tertiary">Select a disguise to be automatically applied when Undetectable mode is on.</span>
          </p>
        </div>

        <div className={`grid grid-cols-2 gap-3 ${isUndetectable ? 'opacity-50 pointer-events-none' : ''}`}>
          {isUndetectable && (
            <p className="col-span-2 text-xs text-yellow-500/80 -mt-1 mb-1">
              {'\u26A0\uFE0F'} Disable Undetectable mode first to change disguise.
            </p>
          )}
          {DISGUISE_OPTIONS.map((option) => (
            <button
              key={option.id}
              disabled={isUndetectable}
              onClick={() => {
                if (isUndetectable) return;
                setDisguiseMode(option.id);
                window.electronAPI?.setDisguise(option.id);
                analytics.trackModeSelected(`disguise_${option.id}`);
              }}
              className={`p-3 rounded-lg border text-left flex items-center gap-3 transition-all ${disguiseMode === option.id ? 'bg-accent-primary border-accent-primary text-white shadow-lg shadow-blue-500/20' : 'bg-bg-input border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-subtle-hover'} ${isUndetectable ? 'cursor-not-allowed' : ''}`}
            >
              <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${disguiseMode === option.id ? 'bg-white/20 text-white' : 'bg-bg-item-surface text-text-secondary'}`}>
                {option.icon}
              </div>
              <span className="text-xs font-medium">{option.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
