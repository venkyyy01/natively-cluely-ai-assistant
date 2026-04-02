import { render, screen } from '@testing-library/react';
import React from 'react';
import { SpeechProviderSection } from '../../src/components/settings/SpeechProviderSection';

const ProviderSelect = ({ value, onChange, options }: any) => (
  <select aria-label="Speech Provider" value={value} onChange={(event) => onChange(event.target.value)}>
    {options.map((option: any) => (
      <option key={option.id} value={option.id}>
        {option.label}
      </option>
    ))}
  </select>
);

const CustomSelect = ({ value, onChange, options }: any) => (
  <select aria-label="Language" value={value} onChange={(event) => onChange(event.target.value)}>
    {options.map((option: any) => (
      <option key={option.id ?? option} value={option.id ?? option}>
        {option.label ?? option}
      </option>
    ))}
  </select>
);

function buildProps(overrides: Partial<React.ComponentProps<typeof SpeechProviderSection>> = {}): React.ComponentProps<typeof SpeechProviderSection> {
  return {
    sttProvider: 'deepgram',
    ProviderSelect,
    googleServiceAccountPath: null,
    hasStoredSttGroqKey: false,
    hasStoredSttOpenaiKey: false,
    hasStoredDeepgramKey: true,
    hasStoredElevenLabsKey: false,
    hasStoredAzureKey: false,
    hasStoredIbmWatsonKey: false,
    hasStoredSonioxKey: false,
    groqSttModel: 'whisper-large-v3-turbo',
    setGroqSttModel: jest.fn(),
    setGoogleServiceAccountPath: jest.fn(),
    sttGroqKey: '',
    sttOpenaiKey: '',
    sttDeepgramKey: '',
    sttElevenLabsKey: '',
    sttAzureKey: '',
    sttIbmKey: '',
    sttSonioxKey: '',
    setSttGroqKey: jest.fn(),
    setSttOpenaiKey: jest.fn(),
    setSttDeepgramKey: jest.fn(),
    setSttElevenLabsKey: jest.fn(),
    setSttAzureKey: jest.fn(),
    setSttIbmKey: jest.fn(),
    setSttSonioxKey: jest.fn(),
    sttSaving: false,
    sttSaved: false,
    handleRemoveSttKey: jest.fn(),
    sttAzureRegion: 'eastus',
    setSttAzureRegion: jest.fn(),
    sttTestStatus: 'idle',
    sttTestError: '',
    recognitionLanguage: 'english-us',
    selectedSttGroup: 'English',
    languageGroups: ['English'],
    currentGroupVariants: [],
    CustomSelect,
    handleSttProviderChange: jest.fn(),
    handleSttKeySubmit: jest.fn(),
    handleTestSttConnection: jest.fn(),
    handleGroupChange: jest.fn(),
    handleLanguageChange: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  (window as any).electronAPI = {
    openExternal: jest.fn(),
    setAzureRegion: jest.fn(),
    selectServiceAccount: jest.fn(),
  };
});

afterEach(() => {
  delete (window as any).electronAPI;
});

test('shows a masked placeholder for saved Deepgram STT keys after restart', () => {
  render(<SpeechProviderSection {...buildProps()} />);

  expect(screen.getByPlaceholderText('••••••••••••')).toBeInTheDocument();
  expect(screen.getByTitle('Remove API Key')).toBeInTheDocument();
});

test('does not show saved-key affordances when the active STT provider has no stored key', () => {
  render(
    <SpeechProviderSection
      {...buildProps({
        hasStoredDeepgramKey: false,
      })}
    />,
  );

  expect(screen.getByPlaceholderText('Enter API key')).toBeInTheDocument();
  expect(screen.queryByTitle('Remove API Key')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Test Connection' })).toBeDisabled();
});
