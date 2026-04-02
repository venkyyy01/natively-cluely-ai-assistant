import React from 'react';
import { Check, ExternalLink, Globe, Info, MapPin, Mic, RefreshCw, Upload } from 'lucide-react';
import { getElectronAPI } from '../../lib/electronApi';

interface SpeechProviderSectionProps {
  sttProvider: string;
  ProviderSelect: React.FC<any>;
  googleServiceAccountPath: string | null;
  hasStoredSttGroqKey: boolean;
  hasStoredSttOpenaiKey: boolean;
  hasStoredDeepgramKey: boolean;
  hasStoredElevenLabsKey: boolean;
  hasStoredAzureKey: boolean;
  hasStoredIbmWatsonKey: boolean;
  hasStoredSonioxKey: boolean;
  groqSttModel: string;
  setGroqSttModel: (value: string) => void;
  setGoogleServiceAccountPath: (value: string) => void;
  sttGroqKey: string;
  sttOpenaiKey: string;
  sttDeepgramKey: string;
  sttElevenLabsKey: string;
  sttAzureKey: string;
  sttIbmKey: string;
  sttSonioxKey: string;
  setSttGroqKey: (value: string) => void;
  setSttOpenaiKey: (value: string) => void;
  setSttDeepgramKey: (value: string) => void;
  setSttElevenLabsKey: (value: string) => void;
  setSttAzureKey: (value: string) => void;
  setSttIbmKey: (value: string) => void;
  setSttSonioxKey: (value: string) => void;
  sttSaving: boolean;
  sttSaved: boolean;
  handleRemoveSttKey?: (provider: any) => void;
  sttAzureRegion: string;
  setSttAzureRegion: (value: string) => void;
  sttTestStatus: 'idle' | 'testing' | 'success' | 'error';
  sttTestError: string;
  recognitionLanguage: string;
  selectedSttGroup: string;
  languageGroups: string[];
  currentGroupVariants: MediaDeviceInfo[];
  CustomSelect: React.FC<any>;
  handleSttProviderChange: (provider: any) => void;
  handleSttKeySubmit: (provider: any, key: string) => void;
  handleTestSttConnection: () => void;
  handleGroupChange: (value: string) => void;
  handleLanguageChange: (value: string) => void;
}

export const SpeechProviderSection: React.FC<SpeechProviderSectionProps> = (props) => {
  const electronAPI = getElectronAPI();
  const {
    sttProvider,
    ProviderSelect,
    googleServiceAccountPath,
    hasStoredSttGroqKey,
    hasStoredSttOpenaiKey,
    hasStoredDeepgramKey,
    hasStoredElevenLabsKey,
    hasStoredAzureKey,
    hasStoredIbmWatsonKey,
    hasStoredSonioxKey,
    groqSttModel,
    setGroqSttModel,
    setGoogleServiceAccountPath,
    sttGroqKey,
    sttOpenaiKey,
    sttDeepgramKey,
    sttElevenLabsKey,
    sttAzureKey,
    sttIbmKey,
    sttSonioxKey,
    setSttGroqKey,
    setSttOpenaiKey,
    setSttDeepgramKey,
    setSttElevenLabsKey,
    setSttAzureKey,
    setSttIbmKey,
    setSttSonioxKey,
    sttSaving,
    sttSaved,
    handleRemoveSttKey,
    sttAzureRegion,
    setSttAzureRegion,
    sttTestStatus,
    sttTestError,
    recognitionLanguage,
    selectedSttGroup,
    languageGroups,
    currentGroupVariants,
    CustomSelect,
    handleSttProviderChange,
    handleSttKeySubmit,
    handleTestSttConnection,
    handleGroupChange,
    handleLanguageChange,
  } = props;

  const keyMap: Record<string, string> = {
    groq: sttGroqKey,
    openai: sttOpenaiKey,
    deepgram: sttDeepgramKey,
    elevenlabs: sttElevenLabsKey,
    azure: sttAzureKey,
    ibmwatson: sttIbmKey,
    soniox: sttSonioxKey,
  };

  const storedKeyMap: Record<string, boolean> = {
    groq: hasStoredSttGroqKey,
    openai: hasStoredSttOpenaiKey,
    deepgram: hasStoredDeepgramKey,
    elevenlabs: hasStoredElevenLabsKey,
    azure: hasStoredAzureKey,
    ibmwatson: hasStoredIbmWatsonKey,
    soniox: hasStoredSonioxKey,
  };

  const hasStoredKeyForProvider = storedKeyMap[sttProvider] || false;
  const currentKeyValue = keyMap[sttProvider] || '';
  const keyPlaceholder = hasStoredKeyForProvider ? '••••••••••••' : 'Enter API key';
  const canTestConnection = Boolean(currentKeyValue.trim() || hasStoredKeyForProvider);

  return (
    <>
      <div>
        <h3 className="text-lg font-bold text-text-primary mb-1">Speech Provider</h3>
        <p className="text-xs text-text-secondary mb-5">Choose the engine that transcribes audio to text.</p>

        <div className="space-y-4">
          <div className="bg-bg-card rounded-xl border border-border-subtle p-4 space-y-3">
            <label className="text-xs font-medium text-text-secondary block">Speech Provider</label>
            <div className="relative">
              <ProviderSelect
                value={sttProvider}
                onChange={(val: any) => handleSttProviderChange(val)}
                options={[
                  { id: 'google', label: 'Google Cloud', badge: googleServiceAccountPath ? 'Saved' : null, recommended: true, desc: 'gRPC streaming via Service Account', color: 'blue', icon: <Mic size={14} /> },
                  { id: 'groq', label: 'Groq Whisper', badge: hasStoredSttGroqKey ? 'Saved' : null, recommended: true, desc: 'Ultra-fast REST transcription', color: 'orange', icon: <Mic size={14} /> },
                  { id: 'openai', label: 'OpenAI Whisper', badge: hasStoredSttOpenaiKey ? 'Saved' : null, desc: 'OpenAI-compatible Whisper API', color: 'green', icon: <Mic size={14} /> },
                  { id: 'deepgram', label: 'Deepgram Nova-3', badge: hasStoredDeepgramKey ? 'Saved' : null, recommended: true, desc: 'High-accuracy REST transcription', color: 'purple', icon: <Mic size={14} /> },
                  { id: 'elevenlabs', label: 'ElevenLabs Scribe', badge: hasStoredElevenLabsKey ? 'Saved' : null, desc: 'Scribe v2 Realtime API', color: 'teal', icon: <Mic size={14} /> },
                  { id: 'azure', label: 'Azure Speech', badge: hasStoredAzureKey ? 'Saved' : null, desc: 'Microsoft Cognitive Services STT', color: 'cyan', icon: <Mic size={14} /> },
                  { id: 'ibmwatson', label: 'IBM Watson', badge: hasStoredIbmWatsonKey ? 'Saved' : null, desc: 'IBM Watson cloud STT service', color: 'indigo', icon: <Mic size={14} /> },
                  { id: 'soniox', label: 'Soniox', badge: hasStoredSonioxKey ? 'Saved' : null, recommended: true, desc: '60+ languages, multilingual, domain context', color: 'cyan', icon: <Mic size={14} /> },
                ]}
              />
            </div>
          </div>

          {sttProvider === 'groq' && (
            <div className="bg-bg-card rounded-xl border border-border-subtle p-4">
              <label className="text-xs font-medium text-text-secondary mb-2.5 block">Whisper Model</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: 'whisper-large-v3-turbo', label: 'V3 Turbo', desc: 'Fastest' },
                  { id: 'whisper-large-v3', label: 'V3', desc: 'Most Accurate' },
                ].map((m) => (
                  <button
                    key={m.id}
                    onClick={async () => {
                      setGroqSttModel(m.id);
                      try {
                        await electronAPI.setGroqSttModel(m.id);
                      } catch (e) {
                        console.error('Failed to set Groq model:', e);
                      }
                    }}
                    className={`rounded-lg px-3 py-2.5 text-left transition-all duration-200 ease-in-out active:scale-[0.98] ${groqSttModel === m.id ? 'bg-blue-600 text-white shadow-md' : 'bg-bg-input hover:bg-bg-elevated text-text-primary'}`}
                  >
                    <span className="text-sm font-medium block">{m.label}</span>
                    <span className={`text-[11px] transition-colors ${groqSttModel === m.id ? 'text-white/70' : 'text-text-tertiary'}`}>{m.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {sttProvider === 'google' && (
            <div className="bg-bg-card rounded-xl border border-border-subtle p-4">
              <label className="text-xs font-medium text-text-secondary mb-2 block">Service Account JSON</label>
              <div className="flex gap-2">
                <div className="flex-1 bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary font-mono truncate">
                  {googleServiceAccountPath ? <span className="text-text-primary">{googleServiceAccountPath.split('/').pop()}</span> : <span className="text-text-tertiary italic">No file selected</span>}
                </div>
                <button
                  onClick={async () => {
                    const result = await electronAPI.selectServiceAccount();
                    if (result?.success && result.path) {
                      setGoogleServiceAccountPath(result.path);
                    }
                  }}
                  className="px-3 py-2 bg-bg-input hover:bg-bg-elevated border border-border-subtle rounded-lg text-xs font-medium text-text-primary transition-colors flex items-center gap-2"
                >
                  <Upload size={14} /> Select File
                </button>
              </div>
              <p className="text-[10px] text-text-tertiary mt-2">Required for Google Cloud Speech-to-Text.</p>
            </div>
          )}

          {sttProvider !== 'google' && (
            <div className="bg-bg-card rounded-xl border border-border-subtle p-4 space-y-3">
              <label className="text-xs font-medium text-text-secondary block">
                {sttProvider === 'groq' ? 'Groq' : sttProvider === 'openai' ? 'OpenAI STT' : sttProvider === 'elevenlabs' ? 'ElevenLabs' : sttProvider === 'azure' ? 'Azure' : sttProvider === 'ibmwatson' ? 'IBM Watson' : sttProvider === 'soniox' ? 'Soniox' : 'Deepgram'} API Key
              </label>
              {sttProvider === 'openai' && <p className="text-[10px] text-text-tertiary mb-1.5">This key is separate from your main AI Provider key.</p>}
              <div className="flex gap-2">
                <input
                  type="password"
                  value={currentKeyValue}
                  placeholder={keyPlaceholder}
                  onChange={(e) => {
                    if (sttProvider === 'groq') setSttGroqKey(e.target.value);
                    else if (sttProvider === 'openai') setSttOpenaiKey(e.target.value);
                    else if (sttProvider === 'elevenlabs') setSttElevenLabsKey(e.target.value);
                    else if (sttProvider === 'azure') setSttAzureKey(e.target.value);
                    else if (sttProvider === 'ibmwatson') setSttIbmKey(e.target.value);
                    else if (sttProvider === 'soniox') setSttSonioxKey(e.target.value);
                    else setSttDeepgramKey(e.target.value);
                  }}
                  className="flex-1 bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary transition-colors"
                />
                <button
                  onClick={() => handleSttKeySubmit(sttProvider as any, currentKeyValue)}
                  disabled={sttSaving || !currentKeyValue.trim()}
                  className={`px-5 py-2.5 rounded-lg text-xs font-medium transition-colors ${sttSaved ? 'bg-green-500/20 text-green-400' : 'bg-bg-input hover:bg-bg-input/80 border border-border-subtle text-text-primary disabled:opacity-50'}`}
                >
                  {sttSaved ? <span className="flex items-center gap-1.5"><Check size={13} /> Saved</span> : 'Save'}
                </button>
                {handleRemoveSttKey && hasStoredKeyForProvider && (
                  <button
                    onClick={() => handleRemoveSttKey(sttProvider as any)}
                    className="px-2.5 py-2.5 rounded-lg text-xs font-medium text-text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-all"
                    title="Remove API Key"
                  >
                    Remove
                  </button>
                )}
              </div>

              {sttProvider === 'azure' && (
                <div>
                  <label className="text-xs font-medium text-text-secondary mb-1.5 block">Azure Region</label>
                  <div className="flex gap-2">
                    <input value={sttAzureRegion} onChange={(e) => setSttAzureRegion(e.target.value)} className="flex-1 bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary" />
                    <button onClick={() => electronAPI.setAzureRegion(sttAzureRegion.trim())} className="px-4 py-2 bg-bg-input hover:bg-bg-elevated border border-border-subtle rounded-lg text-xs font-medium text-text-primary transition-colors">Save</button>
                  </div>
                  <p className="text-[10px] text-text-tertiary">e.g. eastus, westeurope, westus2</p>
                </div>
              )}

              <div className="flex items-center gap-3">
                <button onClick={handleTestSttConnection} disabled={sttTestStatus === 'testing' || !canTestConnection} className="text-xs bg-bg-input hover:bg-bg-elevated text-text-primary px-3 py-1.5 rounded-md transition-colors flex items-center gap-2 disabled:opacity-50">
                  {sttTestStatus === 'testing' ? <><RefreshCw size={12} className="animate-spin" /> Testing...</> : sttTestStatus === 'success' ? <><Check size={12} className="text-green-500" /> Connected</> : <>Test Connection</>}
                </button>
                <button
                  onClick={() => {
                    const urls: Record<string, string> = {
                      groq: 'https://console.groq.com/keys',
                      openai: 'https://platform.openai.com/api-keys',
                      deepgram: 'https://console.deepgram.com',
                      elevenlabs: 'https://elevenlabs.io/app/settings/api-keys',
                      azure: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeech',
                      ibmwatson: 'https://cloud.ibm.com/catalog/services/speech-to-text',
                    };
                    if (urls[sttProvider]) electronAPI.openExternal(urls[sttProvider]);
                  }}
                  className="text-xs text-text-tertiary hover:text-text-primary flex items-center gap-1 transition-colors ml-1"
                  title="Get API Key"
                >
                  <ExternalLink size={12} />
                </button>
                {sttTestStatus === 'error' && <span className="text-xs text-red-400">{sttTestError}</span>}
              </div>
            </div>
          )}

          <CustomSelect
            label="Language"
            icon={<Globe size={14} />}
            value={selectedSttGroup}
            options={languageGroups.map(g => ({ deviceId: g, label: g, kind: 'audioinput' as MediaDeviceKind, groupId: '', toJSON: () => ({}) }))}
            onChange={handleGroupChange}
            placeholder="Select Language"
          />

          {currentGroupVariants.length > 1 && (
            <div className="mt-3 animated fadeIn">
              <CustomSelect
                label="Accent / Region"
                icon={<MapPin size={14} />}
                value={recognitionLanguage}
                options={currentGroupVariants}
                onChange={handleLanguageChange}
                placeholder="Select Region"
              />
            </div>
          )}

          <div className="flex gap-2 items-center mt-2 px-1">
            <Info size={14} className="text-text-secondary shrink-0" />
            <p className="text-xs text-text-secondary">Select the primary language being spoken in the meeting.</p>
          </div>
        </div>
      </div>
    </>
  );
};
