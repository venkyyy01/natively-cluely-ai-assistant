import React, { useEffect, useState, useMemo } from 'react'
import { QueryClient, QueryClientProvider } from 'react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle } from 'lucide-react'
import { ErrorBoundary } from './components/ErrorBoundary'
import Launcher from './components/Launcher'
import ModelSelectorWindow from './components/ModelSelectorWindow'
import NativelyInterface from './components/NativelyInterface'
import SettingsOverlay from './components/SettingsOverlay'
import SettingsPopup from './components/SettingsPopup'
import StartupSequence from './components/StartupSequence'
import { ToastProvider, ToastViewport } from './components/ui/toast'
import {
  getCurrentEnvironment,
  getProfileToasterThresholdMs,
  getWindowAnalyticsPlan,
  resolveWindowContext,
  shouldListenForOverlayOpacity,
  type AppWindowContext,
} from './appBootstrap'
import { analytics } from './lib/analytics/analytics.service'
import { getElectronAPI, getOptionalElectronMethod, requireElectronMethod } from './lib/electronApi'

const queryClient = new QueryClient()

const AppProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <QueryClientProvider client={queryClient}>
    <ToastProvider>
      {children}
      <ToastViewport />
    </ToastProvider>
  </QueryClientProvider>
)

const RendererStartupFallback: React.FC<{ errorMessage: string }> = ({ errorMessage }) => (
  <div className="flex h-full min-h-0 w-full items-center justify-center bg-[#050505] px-6">
    <div className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#111111] p-6 text-left shadow-2xl">
      <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#8A8A8A]">Startup Error</p>
      <h1 className="mt-3 text-2xl font-semibold text-white">Renderer startup failed</h1>
      <p className="mt-3 text-sm leading-6 text-[#B5B5B5]">
        The Electron preload bridge did not initialize, so the UI cannot finish booting. Restart the app.
        If this keeps happening, the preload script or startup shell is failing before the renderer is ready.
      </p>
      <code className="mt-4 block overflow-x-auto rounded-2xl border border-[#ff3333]/20 bg-[#1A1A1A] px-4 py-3 text-xs text-[#ff7b7b]">
        {errorMessage}
      </code>
    </div>
  </div>
)

const getStoredAudioDeviceId = (storageKey: string, fallback = 'default'): string => {
  const value = localStorage.getItem(storageKey)?.trim()
  return value && value.length > 0 ? value : fallback
}

type MeetingAudioBannerProps = {
  message: string
  title: string
  variant: 'overlay' | 'launcher'
  onDismiss: () => void
}

type PrivacyShieldState = {
  active: boolean
  reason: string | null
}

type PrivacyShieldWindowContentProps = {
  variant: 'overlay' | 'launcher'
  onEndMeeting?: () => Promise<void>
}

const MeetingAudioBanner: React.FC<MeetingAudioBannerProps> = ({ message, title, variant, onDismiss }) => {
  const motionProps = variant === 'overlay'
    ? {
        initial: { opacity: 0, y: -12, scale: 0.98 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: -8, scale: 0.98 },
        className: 'absolute left-3 right-3 top-3 z-50',
        containerClassName: 'rounded-2xl border border-[#ff3333]/35 bg-[#1A1A1A]/95 px-4 py-3 shadow-2xl backdrop-blur-md',
      }
    : {
        initial: { opacity: 0, y: 16, scale: 0.98 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: 8, scale: 0.98 },
        className: 'pointer-events-none absolute left-6 right-6 top-6 z-40',
        containerClassName: 'pointer-events-auto rounded-2xl border border-[#ff3333]/35 bg-[#1A1A1A]/96 px-5 py-4 shadow-2xl backdrop-blur-md',
      }

  return (
    <motion.div
      initial={motionProps.initial}
      animate={motionProps.animate}
      exit={motionProps.exit}
      className={motionProps.className}
    >
      <div className={motionProps.containerClassName}>
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-[#ff3333]" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[#F4F4F4]">{title}</p>
            <p className="mt-1 text-xs leading-relaxed text-[#B8B8B8]">{message}</p>
          </div>
          <button
            onClick={onDismiss}
            className="text-xs font-medium text-[#A0A0A0] transition-colors hover:text-white"
          >
            Dismiss
          </button>
        </div>
      </div>
    </motion.div>
  )
}

export const PrivacyShieldWindowContent: React.FC<PrivacyShieldWindowContentProps> = ({ variant, onEndMeeting }) => {
  const isOverlay = variant === 'overlay'

  return (
    <ErrorBoundary context="PrivacyShield">
      <div
        className={`flex h-full min-h-0 w-full items-center justify-center ${isOverlay ? 'bg-black' : 'bg-black'}`}
        onClick={isOverlay && onEndMeeting ? () => { void onEndMeeting() } : undefined}
        role={isOverlay && onEndMeeting ? 'button' : undefined}
        tabIndex={isOverlay && onEndMeeting ? 0 : undefined}
      />
    </ErrorBoundary>
  )
}

type OverlayWindowContentProps = {
  meetingAudioError: string | null
  overlayOpacity: number
  onClearMeetingAudioError: () => void
  onEndMeeting: () => Promise<void>
}

const OverlayWindowContent: React.FC<OverlayWindowContentProps> = ({
  meetingAudioError,
  overlayOpacity,
  onClearMeetingAudioError,
  onEndMeeting,
}) => (
  <ErrorBoundary context="Overlay">
    <div className="w-full relative bg-transparent">
      <AppProviders>
        <AnimatePresence>
          {meetingAudioError && (
            <MeetingAudioBanner
              message={meetingAudioError}
              title="Audio startup failed"
              variant="overlay"
              onDismiss={onClearMeetingAudioError}
            />
          )}
        </AnimatePresence>
        <div style={{ opacity: overlayOpacity, transition: 'opacity 75ms ease' }}>
          <NativelyInterface onEndMeeting={onEndMeeting} />
        </div>
      </AppProviders>
    </div>
  </ErrorBoundary>
)

type LauncherWindowContentProps = {
  incompatibleWarning: { count: number; oldProvider: string; newProvider: string } | null
  isDefaultLauncherWindow: boolean
  isSettingsOpen: boolean
  meetingAudioError: string | null
  ollamaPullMessage: string
  ollamaPullPercent: number
  ollamaPullStatus: 'idle' | 'downloading' | 'complete' | 'failed'
  settingsInitialTab: string
  showStartup: boolean
  onClearIncompatibleWarning: () => void
  onClearMeetingAudioError: () => void
  onOpenSettings: (tab?: string) => void
  onPageChange: (isMainView: boolean) => void
  onReindex: () => Promise<void>
  onSetShowStartup: (show: boolean) => void
  onStartMeeting: () => Promise<void>
  onToggleSettings: (open: boolean) => void
}

const LauncherWindowContent: React.FC<LauncherWindowContentProps> = ({
  incompatibleWarning,
  isDefaultLauncherWindow,
  isSettingsOpen,
  meetingAudioError,
  ollamaPullMessage,
  ollamaPullPercent,
  ollamaPullStatus,
  settingsInitialTab,
  showStartup,
  onClearIncompatibleWarning,
  onClearMeetingAudioError,
  onOpenSettings,
  onPageChange,
  onReindex,
  onSetShowStartup,
  onStartMeeting,
  onToggleSettings,
}) => (
  <ErrorBoundary context="Launcher">
    <div className="h-full min-h-0 w-full relative">
      <AnimatePresence>
        {showStartup ? (
          <motion.div
            key="startup"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.1, pointerEvents: 'none', transition: { duration: 0.6, ease: 'easeInOut' } }}
          >
            <StartupSequence onComplete={() => onSetShowStartup(false)} />
          </motion.div>
        ) : (
          <motion.div
            key="main"
            className="h-full w-full"
            initial={{ opacity: 0, scale: 0.98, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{
              duration: 0.8,
              ease: [0.19, 1, 0.22, 1],
              delay: 0.1,
            }}
          >
            <AppProviders>
              <AnimatePresence>
                {meetingAudioError && (
                  <MeetingAudioBanner
                    message={meetingAudioError}
                    title="Audio setup needs attention"
                    variant="launcher"
                    onDismiss={onClearMeetingAudioError}
                  />
                )}
              </AnimatePresence>
              <div id="launcher-container" className="h-full w-full relative">
                <AnimatePresence>
                  {meetingAudioError && (
                    <MeetingAudioBanner
                      message={meetingAudioError}
                      title="Audio setup needs attention"
                      variant="launcher"
                      onDismiss={onClearMeetingAudioError}
                    />
                  )}
                </AnimatePresence>
                <Launcher
                  onStartMeeting={onStartMeeting}
                  onOpenSettings={onOpenSettings}
                  onPageChange={onPageChange}
                  ollamaPullStatus={ollamaPullStatus}
                  ollamaPullPercent={ollamaPullPercent}
                  ollamaPullMessage={ollamaPullMessage}
                />
              </div>
              <SettingsOverlay
                isOpen={isSettingsOpen}
                onClose={() => onToggleSettings(false)}
                initialTab={settingsInitialTab}
              />
            </AppProviders>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {incompatibleWarning && isDefaultLauncherWindow && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="fixed bottom-6 right-6 z-50 pointer-events-auto"
          >
            <div className="bg-[#1A1A1A] border border-[#ff3333]/30 shadow-2xl rounded-2xl p-5 max-w-[340px] flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-[#ff3333] shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-[#E0E0E0] font-medium text-sm">Provider Changed</h3>
                  <p className="text-[#A0A0A0] text-xs mt-1 leading-relaxed">
                    {incompatibleWarning.count} meetings used your previous AI provider ({incompatibleWarning.oldProvider}) and won't appear in search results under {incompatibleWarning.newProvider}.
                  </p>
                </div>
              </div>
              <div className="flex gap-2 mt-1 justify-end">
                <button
                  onClick={onClearIncompatibleWarning}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-[#A0A0A0] hover:text-white hover:bg-white/5 transition-colors"
                >
                  Dismiss
                </button>
                <button
                  onClick={onReindex}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#ff3333]/10 text-[#ff3333] hover:bg-[#ff3333]/20 transition-colors"
                >
                  Re-index automatically
                </button>
              </div>
            </div>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  </ErrorBoundary>
)

const useWindowAnalytics = ({ kind, isDefaultLauncherWindow }: AppWindowContext) => {
  useEffect(() => {
    const analyticsPlan = getWindowAnalyticsPlan({ kind, isDefaultLauncherWindow })

    analytics.initAnalytics()

    if (analyticsPlan.trackAppLifecycle) {
      analytics.trackAppOpen()
    }

    if (analyticsPlan.trackAssistantLifecycle) {
      analytics.trackAssistantStart()
    }

    const handleUnload = () => {
      if (analyticsPlan.trackAssistantLifecycle) {
        analytics.trackAssistantStop()
      }

      if (analyticsPlan.trackAppLifecycle) {
        analytics.trackAppClose()
      }
    }

    window.addEventListener('beforeunload', handleUnload)

    return () => {
      window.removeEventListener('beforeunload', handleUnload)
    }
  }, [kind, isDefaultLauncherWindow])
}

const App: React.FC = () => {
  const windowContext = useMemo(() => resolveWindowContext(window.location.search), [])
  const { kind: windowKind, isDefaultLauncherWindow } = windowContext

  useWindowAnalytics(windowContext)

  const { api: electronAPI, error: electronBridgeError } = useMemo(() => {
    try {
      return {
        api: getElectronAPI(),
        error: null as Error | null,
      }
    } catch (error) {
      return {
        api: null,
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }, [])

  const [showStartup, setShowStartup] = useState(true)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState('general')
  const [overlayOpacity, setOverlayOpacity] = useState<number>(() => {
    const stored = localStorage.getItem('natively_overlay_opacity')
    return stored ? parseFloat(stored) : 0.65
  })

  const [isLauncherMainView, setIsLauncherMainView] = useState(true)

  const [isProcessingMeeting, setIsProcessingMeeting] = useState<boolean>(false)

  const [ollamaPullStatus, setOllamaPullStatus] = useState<'idle' | 'downloading' | 'complete' | 'failed'>('idle')
  const [ollamaPullPercent, setOllamaPullPercent] = useState<number>(0)
  const [ollamaPullMessage, setOllamaPullMessage] = useState<string>('')

  const [incompatibleWarning, setIncompatibleWarning] = useState<{ count: number; oldProvider: string; newProvider: string } | null>(null)
  const [meetingAudioError, setMeetingAudioError] = useState<string | null>(null)
  const [privacyShieldState, setPrivacyShieldState] = useState<PrivacyShieldState>({ active: false, reason: null })

  useEffect(() => {
    if (!electronAPI) {
      return
    }

    localStorage.removeItem('useLegacyAudioBackend')

    const removeMeetingsListener = electronAPI.onMeetingsUpdated(() => {
      console.log('[App.tsx] Meetings updated (processing finished)')
      setIsProcessingMeeting(false)
    })

    let removeProgress: (() => void) | undefined
    let removeComplete: (() => void) | undefined
    if (electronAPI.onOllamaPullProgress && electronAPI.onOllamaPullComplete) {
      removeProgress = electronAPI.onOllamaPullProgress((data) => {
        setOllamaPullStatus('downloading')
        setOllamaPullPercent(data.percent || 0)
        setOllamaPullMessage(data.status || 'Downloading...')
      })

      removeComplete = electronAPI.onOllamaPullComplete(() => {
        setOllamaPullStatus('complete')
        setOllamaPullMessage('Local AI memory ready')
        setOllamaPullPercent(100)
        setTimeout(() => setOllamaPullStatus('idle'), 3000)
      })
    }

    let removeWarning: (() => void) | undefined
    if (electronAPI.onIncompatibleProviderWarning) {
      removeWarning = electronAPI.onIncompatibleProviderWarning((data) => {
        setIncompatibleWarning(data)
      })
    }

    let removeMeetingAudioError: (() => void) | undefined
    if (electronAPI.onMeetingAudioError) {
      removeMeetingAudioError = electronAPI.onMeetingAudioError((message) => {
        setMeetingAudioError(message)
      })
    }

    electronAPI.getPrivacyShieldState?.().then((state) => {
      setPrivacyShieldState(state)
    }).catch(() => {})

    const removePrivacyShieldListener = electronAPI.onPrivacyShieldChanged?.((state) => {
      setPrivacyShieldState(state)
    })

    return () => {
      if (removeMeetingsListener) removeMeetingsListener()
      if (removeProgress) removeProgress()
      if (removeComplete) removeComplete()
      if (removeWarning) removeWarning()
      if (removeMeetingAudioError) removeMeetingAudioError()
      if (removePrivacyShieldListener) removePrivacyShieldListener()
    }
  }, [electronAPI])

  useEffect(() => {
    if (!electronAPI || !shouldListenForOverlayOpacity(windowContext)) return

    const removeOpacityListener = electronAPI.onOverlayOpacityChanged?.((opacity) => {
      setOverlayOpacity(opacity)
    })

    return () => {
      if (removeOpacityListener) removeOpacityListener()
    }
  }, [electronAPI, windowKind])

  const handleReindex = async () => {
    const reindexIncompatibleMeetings = getOptionalElectronMethod('reindexIncompatibleMeetings')
    if (reindexIncompatibleMeetings) {
      setIncompatibleWarning(null)
      await reindexIncompatibleMeetings()
    }
  }

  const handleStartMeeting = async () => {
    if (!electronAPI) {
      setMeetingAudioError(electronBridgeError?.message ?? 'Electron API bridge is unavailable')
      return
    }

    try {
      setMeetingAudioError(null)
      localStorage.setItem('natively_last_meeting_start', Date.now().toString())
      const inputDeviceId = getStoredAudioDeviceId('preferredInputDeviceId')
      let outputDeviceId = getStoredAudioDeviceId('preferredOutputDeviceId')
      const useExperimentalSck = localStorage.getItem('useExperimentalSckBackend') === 'true'

      if (useExperimentalSck) {
        console.log('[App] Using ScreenCaptureKit backend (Experimental).')
        outputDeviceId = 'sck'
      } else {
        console.log('[App] Using CoreAudio backend (Default).')
      }

      const startMeeting = requireElectronMethod('startMeeting')

      const result = await startMeeting({
        audio: { inputDeviceId, outputDeviceId }
      })

      if (result.success) {
        analytics.trackMeetingStarted()
        await electronAPI.setWindowMode('overlay')
      } else {
        console.error('Failed to start meeting:', result.error)
        setMeetingAudioError(result.error || 'Audio pipeline failed to start.')
      }
    } catch (err) {
      console.error('Failed to start meeting:', err)
      setMeetingAudioError(err instanceof Error ? err.message : 'Audio pipeline failed to start.')
    }
  }

  const handleEndMeeting = async () => {
    if (!electronAPI) {
      return
    }

    console.log('[App.tsx] handleEndMeeting triggered')
    analytics.trackMeetingEnded()
    setIsProcessingMeeting(true)
    setMeetingAudioError(null)

    try {
      await electronAPI.endMeeting()
      console.log('[App.tsx] endMeeting IPC completed')

      const startStr = localStorage.getItem('natively_last_meeting_start')
      if (startStr) {
        const duration = Date.now() - parseInt(startStr, 10)
        const threshold = getProfileToasterThresholdMs(getCurrentEnvironment())

        if (duration >= threshold) {
          localStorage.setItem('natively_show_profile_toaster', 'true')
        }
        localStorage.removeItem('natively_last_meeting_start')
      }

      await electronAPI.setWindowMode('launcher')
    } catch (err) {
      console.error('Failed to end meeting:', err)
      electronAPI.setWindowMode('launcher')
    }
  }

  if (!electronAPI) {
    return (
      <RendererStartupFallback
        errorMessage={electronBridgeError?.message ?? 'Electron API bridge is unavailable'}
      />
    )
  }

  if (windowKind === 'settings') {
    return (
      <ErrorBoundary context="SettingsPopup">
        <div className="h-full min-h-0 w-full">
          <AppProviders>
            <SettingsPopup />
          </AppProviders>
        </div>
      </ErrorBoundary>
    )
  }

  if (windowKind === 'model-selector') {
    return (
      <ErrorBoundary context="ModelSelector">
        <div className="h-full min-h-0 w-full overflow-hidden">
          <AppProviders>
            <ModelSelectorWindow />
          </AppProviders>
        </div>
      </ErrorBoundary>
    )
  }

  if (windowKind === 'overlay') {
    if (privacyShieldState.active) {
      return <PrivacyShieldWindowContent variant="overlay" onEndMeeting={handleEndMeeting} />
    }

    return (
      <OverlayWindowContent
        meetingAudioError={meetingAudioError}
        overlayOpacity={overlayOpacity}
        onClearMeetingAudioError={() => setMeetingAudioError(null)}
        onEndMeeting={handleEndMeeting}
      />
    )
  }

  if (privacyShieldState.active) {
    return <PrivacyShieldWindowContent variant="launcher" />
  }

  return (
    <LauncherWindowContent
      incompatibleWarning={incompatibleWarning}
      isDefaultLauncherWindow={isDefaultLauncherWindow}
      isSettingsOpen={isSettingsOpen}
      meetingAudioError={meetingAudioError}
      ollamaPullMessage={ollamaPullMessage}
      ollamaPullPercent={ollamaPullPercent}
      ollamaPullStatus={ollamaPullStatus}
      settingsInitialTab={settingsInitialTab}
      showStartup={showStartup}
      onClearIncompatibleWarning={() => setIncompatibleWarning(null)}
      onClearMeetingAudioError={() => setMeetingAudioError(null)}
      onOpenSettings={(tab = 'general') => {
        setSettingsInitialTab(tab)
        setIsSettingsOpen(true)
      }}
      onPageChange={setIsLauncherMainView}
      onReindex={handleReindex}
      onSetShowStartup={setShowStartup}
      onStartMeeting={handleStartMeeting}
      onToggleSettings={setIsSettingsOpen}
    />
  )
}

export default App
