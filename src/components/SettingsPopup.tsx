import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Brain, MessageSquare, Camera, Zap, User } from 'lucide-react';
import { useShortcuts } from '../hooks/useShortcuts';
import { analytics } from '../lib/analytics/analytics.service';
import { SESSION_MENU_TOGGLE_ORDER } from '../lib/consciousModeSettings';

const SettingsPopup = () => {
    const { shortcuts } = useShortcuts();
    const [isUndetectable, setIsUndetectable] = useState(false);
    const [useGroqFastText, setUseGroqFastText] = useState(() => {
        return localStorage.getItem('natively_groq_fast_text') === 'true';
    });
    const [profileMode, setProfileMode] = useState(false);
    const [hasProfile, setHasProfile] = useState(false);
    const [consciousModeEnabled, setConsciousModeEnabled] = useState(false);
    const isPremium = true; // All features unlocked

    const isFirstRender = React.useRef(true);

    const [hasStoredKey, setHasStoredKey] = useState<Record<string, boolean>>({});

    // Load credentials func
    const loadCredentials = async () => {
        try {
            // @ts-ignore
            const creds = await window.electronAPI?.getStoredCredentials?.();
            if (creds) {
                setHasStoredKey({
                    gemini: creds.hasGeminiKey,
                    groq: creds.hasGroqKey,
                    openai: creds.hasOpenaiKey,
                    claude: creds.hasClaudeKey
                });
            }
        } catch (e) {
            console.error("Failed to load settings:", e);
        }
    };

    // Load Initial Data and refresh on focus
    useEffect(() => {
        loadCredentials();
        const handleFocus = () => loadCredentials();
        window.addEventListener('focus', handleFocus);

        // Load profile status
        const loadProfile = async () => {
            try {
                // @ts-ignore
                const status = await window.electronAPI?.profileGetStatus?.();
                if (status) {
                    setHasProfile(status.hasProfile);
                    setProfileMode(status.profileMode);
                }
            } catch (e) { console.warn('[SettingsPopup] Failed to load profile status:', e); }

        };
        loadProfile();

        return () => window.removeEventListener('focus', handleFocus);
    }, []);

    // Fetch initial undetectable state from main process (source of truth)
    useEffect(() => {
        if (window.electronAPI?.getUndetectable) {
            window.electronAPI.getUndetectable().then((state: boolean) => {
                setIsUndetectable(state);
            });
        }
    }, []);

    // One-way listener: receive state changes from main process, never echo back
    useEffect(() => {
        if (window.electronAPI?.onUndetectableChanged) {
            const unsubscribe = window.electronAPI.onUndetectableChanged((newState: boolean) => {
                setIsUndetectable(newState);
                localStorage.setItem('natively_undetectable', String(newState));
            });
            return () => unsubscribe();
        }
    }, []);

    useEffect(() => {
        // Listen for changes from other windows (2-way sync)
        if (window.electronAPI?.onGroqFastTextChanged) {
            const unsubscribe = window.electronAPI.onGroqFastTextChanged((enabled: boolean) => {
                setUseGroqFastText(enabled);
                localStorage.setItem('natively_groq_fast_text', String(enabled));
            });
            return () => unsubscribe();
        }
    }, []);

    useEffect(() => {
        let cancelled = false;

        if (window.electronAPI?.getConsciousMode) {
            window.electronAPI.getConsciousMode().then((result) => {
                if (!cancelled && result.success) {
                    setConsciousModeEnabled(result.data.enabled);
                }
            }).catch((error) => {
                console.warn('[SettingsPopup] Failed to load Conscious Mode:', error);
            });
        }

        if (window.electronAPI?.onConsciousModeChanged) {
            const unsubscribe = window.electronAPI.onConsciousModeChanged((enabled: boolean) => {
                setConsciousModeEnabled(enabled);
            });
            return () => {
                cancelled = true;
                unsubscribe();
            };
        }

        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        // Skip initial render to avoid unnecessary IPC calls
        if (isFirstRender.current) {
            isFirstRender.current = false;
            // Ensure backend is synced on mount (even if no change)
            try {
                // @ts-ignore
                window.electronAPI?.invoke('set-groq-fast-text-mode', useGroqFastText);
            } catch (e) {
                console.error(e);
            }
            return;
        }

        // Apply Groq Text Mode
        localStorage.setItem('natively_groq_fast_text', String(useGroqFastText));
        try {
            // @ts-ignore - electronAPI not typed in this file yet
            window.electronAPI?.invoke('set-groq-fast-text-mode', useGroqFastText);
        } catch (e) {
            console.error(e);
        }
    }, [useGroqFastText]);

    const [showTranscript, setShowTranscript] = useState(() => {
        const stored = localStorage.getItem('natively_interviewer_transcript');
        return stored !== 'false'; // Default to true if not set
    });

    useEffect(() => {
        const handleStorage = () => {
            const stored = localStorage.getItem('natively_interviewer_transcript');
            setShowTranscript(stored !== 'false');
        };

        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, []);

    const contentRef = useRef<HTMLDivElement>(null);

    // Auto-resize Window
    useLayoutEffect(() => {
        if (!contentRef.current) return;

        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const rect = entry.target.getBoundingClientRect();
                // Send exact dimensions to Electron
                try {
                    // @ts-ignore
                    window.electronAPI?.updateContentDimensions({
                        width: Math.ceil(rect.width),
                        height: Math.ceil(rect.height)
                    });
                } catch (e) {
                    console.warn("Failed to update dimensions", e);
                }
            }
        });

        observer.observe(contentRef.current);
        return () => observer.disconnect();
    }, []);

    return (
        <div className="w-fit h-fit bg-transparent flex flex-col">
            <div ref={contentRef} className="w-[200px] bg-[#1E1E1E]/80 backdrop-blur-md border border-white/10 rounded-[16px] overflow-hidden shadow-2xl shadow-black/40 px-2 pt-2 pb-2 flex flex-col animate-scale-in origin-top-left justify-between">

                {/* Undetectability */}
                <div className="flex items-center justify-between px-3 py-2 hover:bg-white/5 rounded-lg transition-colors duration-200 group cursor-default">
                    <div className="flex items-center gap-3">
                        <CustomGhost
                            className={`w-4 h-4 transition-colors ${isUndetectable ? 'text-white' : 'text-slate-500 group-hover:text-slate-300'}`}
                            fill={isUndetectable ? "currentColor" : "none"}
                            stroke={isUndetectable ? "none" : "currentColor"}
                            eyeColor={isUndetectable ? "black" : "white"}
                        />
                        <span className={`text-[12px] font-medium transition-colors ${isUndetectable ? 'text-white' : 'text-slate-400 group-hover:text-slate-200'}`}>{isUndetectable ? 'Undetectable' : 'Detectable'}</span>
                    </div>
                    <button
                        onClick={() => {
                            const newState = !isUndetectable;
                            setIsUndetectable(newState);
                            localStorage.setItem('natively_undetectable', String(newState));
                            window.electronAPI?.setUndetectable(newState);
                        }}
                        className={`w-[30px] h-[18px] rounded-full p-[1.5px] transition-all duration-300 ease-spring active:scale-[0.92] ${isUndetectable ? 'bg-white shadow-[0_2px_8px_rgba(255,255,255,0.2)]' : 'bg-white/10'}`}
                    >
                        <div className={`w-[15px] h-[15px] rounded-full bg-black shadow-sm transition-transform duration-300 ease-spring ${isUndetectable ? 'translate-x-[12px]' : 'translate-x-0'}`} />
                    </button>
                </div>


                {/* Groq (Fast Text) Toggle */}
                <div className={`flex items-center justify-between px-3 py-2 rounded-lg transition-colors duration-200 group ${hasStoredKey.groq === false ? 'opacity-50 grayscale cursor-not-allowed' : 'hover:bg-white/5 cursor-default'}`} title={hasStoredKey.groq === false ? "Requires Groq API Key to be configured in Settings" : ""}>
                    <div className="flex items-center gap-3">
                        <Zap
                            className={`w-4 h-4 transition-colors ${useGroqFastText ? 'text-orange-500' : 'text-slate-500 group-hover:text-slate-300'}`}
                            fill={useGroqFastText ? "currentColor" : "none"}
                        />
                        <span className={`text-[12px] font-medium transition-colors ${useGroqFastText ? 'text-white' : 'text-slate-400 group-hover:text-slate-200'}`}>{SESSION_MENU_TOGGLE_ORDER[0]}</span>
                    </div>
                    <button
                        onClick={() => {
                            if (hasStoredKey.groq === false) return; // Prevent clicking
                            setUseGroqFastText(!useGroqFastText);
                        }}
                        className={`w-[30px] h-[18px] rounded-full p-[1.5px] transition-all duration-300 ease-spring active:scale-[0.92] ${useGroqFastText ? 'bg-orange-500 shadow-[0_2px_10px_rgba(249,115,22,0.3)]' : 'bg-white/10'}`}
                        disabled={hasStoredKey.groq === false}
                    >
                        <div className={`w-[15px] h-[15px] rounded-full bg-black shadow-sm transition-transform duration-300 ease-spring ${useGroqFastText ? 'translate-x-[12px]' : 'translate-x-0'}`} />
                    </button>
                </div>

                {/* Interviewer Transcript Toggle */}
                <div className="flex items-center justify-between px-3 py-2 hover:bg-white/5 rounded-lg transition-colors duration-200 group cursor-default">
                    <div className="flex items-center gap-3">
                        <MessageSquare
                            className={`w-3.5 h-3.5 transition-colors ${showTranscript ? 'text-emerald-400' : 'text-slate-500 group-hover:text-slate-300'}`}
                            fill={showTranscript ? "currentColor" : "none"}
                        />
                        <span className={`text-[12px] font-medium transition-colors ${showTranscript ? 'text-white' : 'text-slate-400 group-hover:text-slate-200'}`}>{SESSION_MENU_TOGGLE_ORDER[1]}</span>
                    </div>
                    <button
                        onClick={() => {
                            const newState = !showTranscript;
                            setShowTranscript(newState);
                            localStorage.setItem('natively_interviewer_transcript', String(newState));
                            // Dispatch event for same-window listeners
                            window.dispatchEvent(new Event('storage'));
                        }}
                        className={`w-[30px] h-[18px] rounded-full p-[1.5px] transition-all duration-300 ease-spring active:scale-[0.92] ${showTranscript ? 'bg-emerald-500 shadow-[0_2px_10px_rgba(16,185,129,0.3)]' : 'bg-white/10'}`}
                    >
                        <div className={`w-[15px] h-[15px] rounded-full bg-black shadow-sm transition-transform duration-300 ease-spring ${showTranscript ? 'translate-x-[12px]' : 'translate-x-0'}`} />
                    </button>
                </div>

                <div className="flex items-center justify-between px-3 py-2 hover:bg-white/5 rounded-lg transition-colors duration-200 group cursor-default">
                    <div className="flex items-center gap-3">
                        <Brain
                            className={`w-3.5 h-3.5 transition-colors ${consciousModeEnabled ? 'text-violet-400' : 'text-slate-500 group-hover:text-slate-300'}`}
                            fill={consciousModeEnabled ? 'currentColor' : 'none'}
                        />
                        <span className={`text-[12px] font-medium transition-colors ${consciousModeEnabled ? 'text-white' : 'text-slate-400 group-hover:text-slate-200'}`}>{SESSION_MENU_TOGGLE_ORDER[2]}</span>
                    </div>
                    <button
                        onClick={async () => {
                            const nextState = !consciousModeEnabled;
                            setConsciousModeEnabled(nextState);

                            try {
                                const result = await window.electronAPI?.setConsciousMode(nextState);
                                if (!result?.success) {
                                    throw new Error(result?.error?.message || 'Unable to persist Conscious Mode');
                                }

                                setConsciousModeEnabled(result.data.enabled);
                                analytics.trackConsciousModeSelected(result.data.enabled);
                            } catch (error) {
                                console.error('[SettingsPopup] Failed to toggle Conscious Mode:', error);
                                setConsciousModeEnabled(!nextState);
                            }
                        }}
                        className={`w-[30px] h-[18px] rounded-full p-[1.5px] transition-all duration-300 ease-spring active:scale-[0.92] ${consciousModeEnabled ? 'bg-violet-500 shadow-[0_2px_10px_rgba(139,92,246,0.35)]' : 'bg-white/10'}`}
                    >
                        <div className={`w-[15px] h-[15px] rounded-full bg-black shadow-sm transition-transform duration-300 ease-spring ${consciousModeEnabled ? 'translate-x-[12px]' : 'translate-x-0'}`} />
                    </button>
                </div>

                {/* Profile Mode Toggle */}
                {hasProfile && (
                    <div className={`flex items-center justify-between px-3 py-2 rounded-lg transition-colors duration-200 group hover:bg-white/5 cursor-default`}>
                        <div className="flex items-center gap-3">
                            <User
                                className={`w-3.5 h-3.5 transition-colors ${profileMode ? 'text-accent-primary' : 'text-slate-500 group-hover:text-slate-300'}`}
                                fill={profileMode ? "currentColor" : "none"}
                            />
                            <span className={`text-[12px] font-medium transition-colors ${profileMode ? 'text-white' : 'text-slate-400 group-hover:text-slate-200'}`}>Profile Mode</span>
                        </div>
                        <button
                            onClick={async () => {
                                const newState = !profileMode;
                                setProfileMode(newState);
                                try {
                                    // @ts-ignore
                                    await window.electronAPI?.profileSetMode?.(newState);
                                } catch (e) { console.error(e); }
                            }}
                            className={`w-[30px] h-[18px] rounded-full p-[1.5px] transition-all duration-300 ease-spring active:scale-[0.92] ${profileMode ? 'bg-accent-primary shadow-[0_2px_10px_rgba(var(--color-accent-primary),0.3)]' : 'bg-white/10'}`}
                        >
                            <div className={`w-[15px] h-[15px] rounded-full bg-black shadow-sm transition-transform duration-300 ease-spring ${profileMode ? 'translate-x-[12px]' : 'translate-x-0'}`} />
                        </button>
                    </div>
                )}

                <div className="h-px bg-white/[0.04] my-0.5 mx-2" />

                {/* Show/Hide Natively */}
                <div className="flex items-center justify-between px-3 py-2 hover:bg-white/5 rounded-lg transition-colors duration-200 group interaction-base interaction-press">
                    <div className="flex items-center gap-3">
                        <MessageSquare className="w-3.5 h-3.5 text-slate-500 group-hover:text-slate-300 transition-colors" />
                        <span className="text-[12px] text-slate-400 group-hover:text-slate-200 transition-colors">Show/Hide</span>
                    </div>
                    <div className="flex gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                        {/* Dynamic Keys for Toggle Visibility */}
                        {(shortcuts.toggleVisibility || ['⌘', '⌥', '⇧', 'V']).map((key, index) => (
                            <div key={index} className="px-1.5 py-0.5 rounded border border-white/10 bg-white/5 text-[10px] text-slate-500 font-medium min-w-[20px] text-center">
                                {key}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Screenshot */}
                <div className="flex items-center justify-between px-3 py-2 hover:bg-white/5 rounded-lg transition-colors duration-200 group interaction-base interaction-press">
                    <div className="flex items-center gap-3">
                        <Camera className="w-3.5 h-3.5 text-slate-500 group-hover:text-slate-300 transition-colors" />
                        <span className="text-[12px] text-slate-400 group-hover:text-slate-200 transition-colors">Screenshot</span>
                    </div>
                    <div className="flex gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                        {/* Dynamic Keys for Take Screenshot */}
                        {(shortcuts.takeScreenshot || ['⌘', '⌥', '⇧', 'S']).map((key, index) => (
                            <div key={index} className="px-1.5 py-0.5 rounded border border-white/10 bg-white/5 text-[10px] text-slate-500 font-medium min-w-[20px] text-center">
                                {key}
                            </div>
                        ))}
                    </div>
                </div>



            </div>
        </div>
    );
};

// Custom Ghost with dynamic eye color support
const CustomGhost = ({ className, fill, stroke, eyeColor }: { className?: string, fill?: string, stroke?: string, eyeColor?: string }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill={fill || "none"}
        stroke={stroke || "currentColor"}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
    >
        {/* Body */}
        <path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" />
        {/* Eyes - No stroke, just fill */}
        <path
            d="M9 10h.01 M15 10h.01"
            stroke={eyeColor || "currentColor"}
            strokeWidth="2.5" // Slightly bolder for visibility
            fill="none"
        />
    </svg>
);

export default SettingsPopup;
