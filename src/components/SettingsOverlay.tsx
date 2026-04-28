import React, { useState, useEffect } from 'react';
import packageJson from '../../package.json';
import {
    X, Mic, Speaker, Monitor, Keyboard, User, LifeBuoy, LogOut, Upload,
    ArrowUp, ArrowDown, ArrowLeft, ArrowRight,
    Camera, RotateCcw, Eye, Layout, MessageSquare, Crop,
    ChevronDown, ChevronUp, Check, BadgeCheck, Power, Palette, Calendar, Ghost, Sun, Moon, RefreshCw, Info, Globe, FlaskConical, Terminal, Settings, Activity, ExternalLink, Trash2,
    Sparkles, Pencil, Briefcase, Building2, Search, MapPin, CheckCircle, HelpCircle, Zap, SlidersHorizontal, MousePointerClick
} from 'lucide-react';
import { analytics } from '../lib/analytics/analytics.service';
import { AboutSection } from './AboutSection';
import { AIProvidersSettings } from './settings/AIProvidersSettings';
import { AudioConfigSection } from './settings/AudioConfigSection';
import { GeneralSettingsSection } from './settings/GeneralSettingsSection';
import { SpeechProviderSection } from './settings/SpeechProviderSection';
import { CalendarSettingsSection } from './settings/CalendarSettingsSection';
import { SettingsSidebar } from './settings/SettingsSidebar';
import { motion, AnimatePresence } from 'framer-motion';
import { useShortcuts } from '../hooks/useShortcuts';
import { KeyRecorder } from './ui/KeyRecorder';
import { ProfileVisualizer } from '../premium';
import icon from './icon.png';

// ---------------------------------------------------------------------------
// MockupNativelyInterface — fake in-meeting widget for the opacity preview
// ---------------------------------------------------------------------------
const MockupNativelyInterface = ({ opacity }: { opacity: number }) => (
    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none bg-transparent">
        {/* NativelyInterface Widget — opacity controlled by the slider */}
        <div
            id="mockup-natively-interface"
            style={{ opacity, transition: 'opacity 75ms ease' }}
            className="flex flex-col items-center pointer-events-none -mt-56"
        >
            {/* TopPill Replica */}
            <div className="flex justify-center mb-2 select-none z-50">
                <div className="flex items-center gap-2 rounded-full bg-[#1E1E1E]/80 backdrop-blur-md border border-white/10 shadow-lg shadow-black/20 pl-1.5 pr-1.5 py-1.5">
                    <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center overflow-hidden">
                        <img
                            src={icon}
                            alt="Natively"
                            className="w-[24px] h-[24px] object-contain opacity-90 scale-105"
                            draggable="false"
                        />
                    </div>
                    <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 text-[12px] font-medium text-slate-200 border border-white/0">
                        <ChevronUp className="w-3.5 h-3.5 opacity-70" />
                        <span className="opacity-80 tracking-wide">Hide</span>
                    </div>
                    <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-white">
                        <div className="w-3.5 h-3.5 rounded-[3px] bg-red-400 opacity-80" />
                    </div>
                </div>
            </div>

            {/* Main Interface Window Replica */}
            <div className="relative w-[600px] max-w-full bg-[#1E1E1E]/95 backdrop-blur-2xl border border-white/10 shadow-2xl shadow-black/40 rounded-[24px] overflow-hidden flex flex-col pt-2 pb-3">
                
                {/* Rolling Transcript Bar */}
                <div className="w-full flex justify-center py-2 px-4 border-b border-white/5 bg-[#1E1E1E]/50 mb-1">
                    <p className="text-[13px] text-white/90 truncate max-w-[90%] font-medium">
                        <span className="text-blue-400 mr-2 font-semibold">Interviewer</span>
                        <span className="opacity-80">So how would you optimize the current algorithm?</span>
                    </p>
                </div>

                {/* Chat History Mock */}
                <div className="flex-1 overflow-y-auto px-4 py-2 space-y-3">
                    <div className="flex justify-start">
                        <div className="max-w-[85%] px-4 py-3 text-[14px] leading-relaxed text-slate-200 font-normal">
                            <span className="font-semibold text-emerald-400 block mb-1">Suggestion</span>
                            A good approach would be to use a hash map to cache the intermediate results, which brings the time complexity down from O(n²) to O(n).
                        </div>
                    </div>
                </div>

                {/* Quick Actions */}
                <div className="flex flex-nowrap justify-center items-center gap-1.5 px-4 pb-3 pt-3">
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium text-slate-400 bg-white/5 border border-white/0 shrink-0">
                        <Pencil className="w-3 h-3 opacity-70" /> What to answer?
                    </div>
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium text-slate-400 bg-white/5 border border-white/0 shrink-0">
                        <MessageSquare className="w-3 h-3 opacity-70" /> Shorten
                    </div>
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium text-slate-400 bg-white/5 border border-white/0 shrink-0">
                        <RefreshCw className="w-3 h-3 opacity-70" /> Recap
                    </div>
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium text-slate-400 bg-white/5 border border-white/0 shrink-0">
                        <HelpCircle className="w-3 h-3 opacity-70" /> Follow Up Question
                    </div>
                    <div className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium bg-white/5 text-slate-400 min-w-[74px] shrink-0">
                        <Zap className="w-3 h-3 opacity-70" /> Answer
                    </div>
                </div>

                {/* Input Area */}
                <div className="px-3">
                    <div className="relative group">
                        <div className="w-full bg-[#1E1E1E] border border-white/5 rounded-xl pl-3 pr-10 py-2.5 h-[38px] flex items-center">
                            <span className="text-[13px] text-slate-500">Ask anything on screen or conversation</span>
                        </div>
                    </div>

                    {/* Bottom Row */}
                    <div className="flex items-center justify-between mt-3 px-0.5">
                        <div className="flex items-center gap-1.5">
                            <div className="flex items-center gap-2 px-3 py-1.5 border border-white/10 rounded-lg text-xs font-medium w-[140px] bg-black/20 text-white/70">
                                <span className="truncate min-w-0 flex-1">Gemini 3 Flash</span>
                                <ChevronDown size={14} className="shrink-0" />
                            </div>
                            <div className="w-px h-3 bg-white/10 mx-1" />
                            <div className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 bg-white/5">
                                <SlidersHorizontal className="w-3.5 h-3.5" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
);

interface CustomSelectProps {
    label: string;
    icon: React.ReactNode;
    value: string;
    options: MediaDeviceInfo[];
    onChange: (value: string) => void;
    placeholder?: string;
}

const CustomSelect: React.FC<CustomSelectProps> = ({ label, icon, value, options, onChange, placeholder = "Select device" }) => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const selectedLabel = options.find(o => o.deviceId === value)?.label || placeholder;

    return (
        <div className="bg-bg-card rounded-xl p-4 border border-border-subtle" ref={containerRef}>
            {label && (
                <div className="flex items-center gap-2 mb-3">
                    <span className="text-text-secondary">{icon}</span>
                    <label className="text-xs font-medium text-text-primary uppercase tracking-wide">{label}</label>
                </div>
            )}

            <div className="relative">
                <button
                    onClick={() => setIsOpen(!isOpen)}
                    className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2.5 text-sm text-text-primary flex items-center justify-between hover:bg-bg-elevated transition-colors"
                >
                    <span className="truncate pr-4">{selectedLabel}</span>
                    <ChevronDown size={14} className={`text-text-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </button>

                {isOpen && (
                    <div className="absolute top-full left-0 w-full mt-1 bg-bg-elevated border border-border-subtle rounded-lg shadow-xl z-50 max-h-48 overflow-y-auto animated fadeIn">
                        <div className="p-1 space-y-0.5">
                            {options.map((device) => (
                                <button
                                    key={device.deviceId}
                                    onClick={() => {
                                        onChange(device.deviceId);
                                        setIsOpen(false);
                                    }}
                                    className={`w-full text-left px-3 py-2 text-sm rounded-md flex items-center justify-between group transition-colors ${value === device.deviceId ? 'bg-bg-input hover:bg-bg-elevated text-text-primary' : 'text-text-secondary hover:bg-bg-input hover:text-text-primary'}`}
                                >
                                    <span className="truncate">{device.label || `Device ${device.deviceId.slice(0, 5)}...`}</span>
                                    {value === device.deviceId && <Check size={14} className="text-accent-primary" />}
                                </button>
                            ))}
                            {options.length === 0 && (
                                <div className="px-3 py-2 text-sm text-gray-500 italic">No devices found</div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

interface ProviderOption {
    id: string;
    label: string;
    badge?: string | null;
    recommended?: boolean;
    desc: string;
    color: string;
    icon: React.ReactNode;
}

interface ProviderSelectProps {
    value: string;
    options: ProviderOption[];
    onChange: (value: string) => void;
}

type SttProvider = 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox';
type NonGoogleSttProvider = Exclude<SttProvider, 'google'>;

const ProviderSelect: React.FC<ProviderSelectProps> = ({ value, options, onChange }) => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const selected = options.find(o => o.id === value);

    const getBadgeStyle = (color?: string) => {
        switch (color) {
            case 'blue': return 'bg-blue-500/10 text-blue-500 border-blue-500/20';
            case 'orange': return 'bg-orange-500/10 text-orange-500 border-orange-500/20';
            case 'purple': return 'bg-purple-500/10 text-purple-500 border-purple-500/20';
            case 'teal': return 'bg-teal-500/10 text-teal-500 border-teal-500/20';
            case 'cyan': return 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20';
            case 'indigo': return 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20';
            case 'green': return 'bg-green-500/10 text-green-500 border-green-500/20';
            default: return 'bg-gray-500/10 text-gray-500 border-gray-500/20';
        }
    };

    const getIconStyle = (color?: string, isSelectedItem: boolean = false) => {
        if (isSelectedItem) return 'bg-accent-primary text-white shadow-sm';
        // For unselected items in list or trigger
        switch (color) {
            case 'blue': return 'bg-blue-500/10 text-blue-600';
            case 'orange': return 'bg-orange-500/10 text-orange-600';
            case 'purple': return 'bg-purple-500/10 text-purple-600';
            case 'teal': return 'bg-teal-500/10 text-teal-600';
            case 'cyan': return 'bg-cyan-500/10 text-cyan-600';
            case 'indigo': return 'bg-indigo-500/10 text-indigo-600';
            case 'green': return 'bg-green-500/10 text-green-600';
            default: return 'bg-gray-500/10 text-gray-600';
        }
    };

    return (
        <div ref={containerRef} className="relative z-20 font-sans">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={`w-full group bg-bg-input border border-border-subtle hover:border-border-muted shadow-sm rounded-xl p-2.5 pr-3.5 flex items-center justify-between transition-all duration-200 outline-none focus:ring-2 focus:ring-accent-primary/20 ${isOpen ? 'ring-2 ring-accent-primary/20 border-accent-primary/50' : 'hover:shadow-md'}`}
            >
                {selected ? (
                    <div className="flex items-center gap-3 overflow-hidden">
                        <div className={`w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0 transition-all duration-300 ${getIconStyle(selected.color)}`}>
                            {selected.icon}
                        </div>
                        <div className="min-w-0 flex-1 text-left">
                            <div className="flex items-center gap-2">
                                <span className="text-[13px] font-semibold text-text-primary truncate leading-tight">{selected.label}</span>
                                {selected.badge && <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wide ml-2 ${getBadgeStyle(selected.badge === 'Saved' ? 'green' : selected.color)}`}>{selected.badge}</span>}
                                {selected.recommended && <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wide ml-2 ${getBadgeStyle(selected.color)}`}>Recommended</span>}
                            </div>
                            {/* Short description for trigger */}
                            <span className="text-[11px] text-text-tertiary truncate block leading-tight mt-0.5">{selected.desc}</span>
                        </div>
                    </div>
                ) : <span className="text-text-secondary px-2 text-sm">Select Provider</span>}
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-text-tertiary transition-transform duration-300 group-hover:bg-bg-surface ${isOpen ? 'rotate-180 bg-bg-surface text-text-primary' : ''}`}>
                    <ChevronDown size={14} strokeWidth={2.5} />
                </div>
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: 4, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 4, scale: 0.98 }}
                        transition={{ duration: 0.15, ease: "easeOut" }}
                        className="absolute top-full left-0 w-full mt-2 bg-bg-elevated/90 backdrop-blur-xl border border-white/5 rounded-xl shadow-2xl overflow-hidden ring-1 ring-black/5"
                    >
                        <div className="max-h-[320px] overflow-y-auto p-1.5 space-y-0.5 custom-scrollbar">
                            {options.map(option => {
                                const isSelected = value === option.id;
                                return (
                                    <button
                                        key={option.id}
                                        onClick={() => { onChange(option.id); setIsOpen(false); }}
                                        className={`w-full rounded-[10px] p-2 flex items-center gap-3 transition-all duration-200 group relative ${isSelected ? 'bg-white/10 shadow-inner' : 'hover:bg-white/5'}`}
                                    >
                                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-transform duration-200 ${isSelected ? 'scale-100' : 'scale-95 group-hover:scale-100'} ${getIconStyle(option.color, false)}`}>
                                            {option.icon}
                                        </div>
                                        <div className="flex-1 min-w-0 text-left">
                                            <div className="flex items-center justify-between mb-0.5">
                                                <div className="flex items-center gap-2">
                                                    <span className={`text-[13px] font-medium transition-colors ${isSelected ? 'text-white' : 'text-text-primary'}`}>{option.label}</span>
                                                    {option.badge && <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wide ${getBadgeStyle(option.badge === 'Saved' ? 'green' : option.color)}`}>{option.badge}</span>}
                                                    {option.recommended && <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wide ${getBadgeStyle(option.color)}`}>Recommended</span>}
                                                </div>
                                                {isSelected && <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }}><Check size={14} className="text-accent-primary" strokeWidth={3} /></motion.div>}
                                            </div>
                                            <span className={`text-[11px] block truncate transition-colors ${isSelected ? 'text-white/70' : 'text-text-tertiary'}`}>{option.desc}</span>
                                        </div>
                                        {/* Hover Indicator */}
                                        {!isSelected && <div className="absolute inset-0 rounded-[10px] ring-1 ring-inset ring-white/0 group-hover:ring-white/5 pointer-events-none" />}
                                    </button>
                                );
                            })}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

interface SettingsOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    initialTab?: string;
}

const SettingsOverlay: React.FC<SettingsOverlayProps> = ({ isOpen, onClose, initialTab = 'general' }) => {
    const [activeTab, setActiveTab] = useState(initialTab);
    
    // Sync active tab when modal opens
    useEffect(() => {
        if (isOpen && initialTab) {
            setActiveTab(initialTab);
            
            // Proactively load profile data if starting on profile tab
            if (initialTab === 'profile') {
                window.electronAPI?.profileGetStatus?.().then(setProfileStatus).catch(() => { });
                window.electronAPI?.profileGetProfile?.().then(setProfileData).catch(() => { });
            }
        }
    }, [isOpen, initialTab]);
    
const { shortcuts, updateShortcut, resetShortcuts } = useShortcuts();
const globalShortcutAlternates: Record<string, string> = {
    toggleVisibility: 'Alt: F13',
    takeScreenshot: 'Alt: F14',
    selectiveScreenshot: 'Alt: F15',
    toggleClickthrough: 'Alt: Cmd+Option+Shift+M',
};
  const [isUndetectable, setIsUndetectable] = useState(false);
  const [disguiseMode, setDisguiseMode] = useState<'terminal' | 'settings' | 'activity' | 'none'>('none');
const [openOnLogin, setOpenOnLogin] = useState(false);
const [accelerationModeEnabled, setAccelerationModeEnabled] = useState(false);
const [consciousModeEnabled, setConsciousModeEnabled] = useState(false);
const [themeMode, setThemeMode] = useState<'system' | 'light' | 'dark'>('system');
const [isThemeDropdownOpen, setIsThemeDropdownOpen] = useState(false);
const [isAiLangDropdownOpen, setIsAiLangDropdownOpen] = useState(false);
const [generalSettingsError, setGeneralSettingsError] = useState('');
const [overlayClickthroughEnabled, setOverlayClickthroughEnabled] = useState(() => localStorage.getItem('natively_overlay_clickthrough') === 'true');
const themeDropdownRef = React.useRef<HTMLDivElement>(null);
const aiLangDropdownRef = React.useRef<HTMLDivElement>(null);

    // Profile Engine State
    const [profileStatus, setProfileStatus] = useState<{
        hasProfile: boolean;
        profileMode: boolean;
        name?: string;
        role?: string;
        totalExperienceYears?: number;
    }>({ hasProfile: false, profileMode: false });
    const [profileUploading, setProfileUploading] = useState(false);
    const [profileError, setProfileError] = useState('');
    const [profileData, setProfileData] = useState<any>(null);
    const [isPremiumModalOpen, setIsPremiumModalOpen] = useState(false);
    const isPremium = true; // All features unlocked
    const [jdUploading, setJdUploading] = useState(false);
    const [jdError, setJdError] = useState('');
    const [companyResearching, setCompanyResearching] = useState(false);
    const [companyDossier, setCompanyDossier] = useState<any>(null);
    const [googleSearchApiKey, setGoogleSearchApiKey] = useState('');
    const [googleSearchCseId, setGoogleSearchCseId] = useState('');
    const [hasStoredGoogleSearchKey, setHasStoredGoogleSearchKey] = useState(false);
    const [hasStoredGoogleSearchCseId, setHasStoredGoogleSearchCseId] = useState(false);
    const [googleSearchSaving, setGoogleSearchSaving] = useState(false);

// Close dropdown when clicking outside
// Sync with global state changes
useEffect(() => {
if (isOpen) {
// Fetch true initial state from main process
window.electronAPI?.getUndetectable?.().then(setIsUndetectable).catch(() => { });
window.electronAPI?.getDisguise?.().then(setDisguiseMode).catch(() => { });
window.electronAPI?.getAccelerationMode?.().then((result) => {
if (result.success) {
setAccelerationModeEnabled(result.data.enabled);
}
}).catch(() => { });
window.electronAPI?.getConsciousMode?.().then((result) => {
if (result.success) {
setConsciousModeEnabled(result.data.enabled);
}
}).catch(() => { });
}
}, [isOpen]);

useEffect(() => {
if (window.electronAPI?.onUndetectableChanged) {
const unsubscribe = window.electronAPI.onUndetectableChanged((newState: boolean) => {
setIsUndetectable(newState);
});
return () => unsubscribe();
}
}, []);

useEffect(() => {
if (window.electronAPI?.onAccelerationModeChanged) {
const unsubscribe = window.electronAPI.onAccelerationModeChanged((newState: boolean) => {
setAccelerationModeEnabled(newState);
});
return () => unsubscribe();
}
}, []);

useEffect(() => {
if (window.electronAPI?.onConsciousModeChanged) {
const unsubscribe = window.electronAPI.onConsciousModeChanged((newState: boolean) => {
setConsciousModeEnabled(newState);
});
return () => unsubscribe();
}
}, []);

useEffect(() => {
if (window.electronAPI?.onDisguiseChanged) {
const unsubscribe = window.electronAPI.onDisguiseChanged((newMode: any) => {
setDisguiseMode(newMode);
});
return () => unsubscribe();
}
}, []);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (themeDropdownRef.current && !themeDropdownRef.current.contains(event.target as Node)) {
                setIsThemeDropdownOpen(false);
            }
            if (aiLangDropdownRef.current && !aiLangDropdownRef.current.contains(event.target as Node)) {
                setIsAiLangDropdownOpen(false);
            }
        };

        if (isThemeDropdownOpen || isAiLangDropdownOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isThemeDropdownOpen, isAiLangDropdownOpen]);

    const [showTranscript, setShowTranscript] = useState(() => {
        const stored = localStorage.getItem('natively_interviewer_transcript');
        return stored !== 'false';
    });

    // Recognition Language
    const [recognitionLanguage, setRecognitionLanguage] = useState('');
    const [selectedSttGroup, setSelectedSttGroup] = useState('');
    const [availableLanguages, setAvailableLanguages] = useState<Record<string, any>>({});
    const [languageOptions, setLanguageOptions] = useState<any[]>([]);

    // AI Response Language
    const [aiResponseLanguage, setAiResponseLanguage] = useState('English');
    const [availableAiLanguages, setAvailableAiLanguages] = useState<any[]>([]);

    // Overlay Opacity state
    const [overlayOpacity, setOverlayOpacity] = useState<number>(() => {
        const stored = localStorage.getItem('natively_overlay_opacity');
        if (!stored) return 0.65;
        const parsed = parseFloat(stored);
        return !isNaN(parsed) && parsed >= 0.15 && parsed <= 1.0 ? parsed : 0.65;
    });

    // Live preview state — true while the user is holding down the slider
    const [isPreviewingOpacity, setIsPreviewingOpacity] = useState(false);

    // Ref to hold the latest opacity value without triggering renders during drag
    const latestOpacityRef = React.useRef(overlayOpacity);

    const showGeneralSettingsError = React.useCallback((message: string) => {
        setGeneralSettingsError(message);
        window.setTimeout(() => {
            setGeneralSettingsError(current => current === message ? '' : current);
        }, 4000);
    }, []);

    const handleOpacityChange = (val: number) => {
        // DOM-direct updates for 0-lag 60fps drag (bypasses React reconciliation)
        const percentText = `${Math.round(val * 100)}%`;
        document.querySelectorAll('.opacity-percent-label').forEach(el => el.textContent = percentText);
        const mockWrapper = document.getElementById('mockup-natively-interface');
        if (mockWrapper) mockWrapper.style.opacity = String(val);
        latestOpacityRef.current = val;
        
        // Broadcast IPC in real-time so actual meeting overlay tracks slider instantly
        // (safe to do at 60fps, does not trigger React renders)
        window.electronAPI?.setOverlayOpacity?.(val);
    };

    // Bug fix #3: keep latestOpacityRef in sync when overlayOpacity changes outside of a drag
    // (e.g. on first mount, or if another part of code updates it)
    useEffect(() => {
        latestOpacityRef.current = overlayOpacity;
    }, [overlayOpacity]);

    // Bug fix #3 (close-during-drag): if the overlay closes while the user is still dragging,
    // restore all DOM state so nothing is left in a broken state.
    useEffect(() => {
        if (!isOpen && isPreviewingOpacity) {
            stopPreviewingOpacity();
        }
    }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

    const startPreviewingOpacity = () => {
        // Bug fix #5: guard against rapid repeated calls (double pointerDown / touch events)
        if (isPreviewingOpacity) return;

        // Direct DOM mutation for sub-millisecond instant hide (bypassing slow React tree diffs)
        document.body.classList.add('disable-transitions');
        
        const backdrop = document.getElementById('settings-backdrop');
        const wrapper = document.getElementById('settings-panel-wrapper');
        const panel = document.getElementById('settings-panel');
        const card = document.getElementById('opacity-slider-card');
        const mockup = document.getElementById('settings-mockup-wrapper');
        const launcher = document.getElementById('launcher-container');

        if (backdrop) {
            backdrop.style.backgroundColor = 'transparent';
            backdrop.style.backdropFilter = 'none';
            backdrop.style.transition = 'none';
        }
        if (wrapper) {
            wrapper.style.backgroundColor = 'transparent';
            wrapper.style.border = 'none';
            wrapper.style.boxShadow = 'none';
        }
        if (panel) {
            panel.style.visibility = 'hidden';
        }
        if (launcher) {
            launcher.style.visibility = 'hidden';
        }
        
        if (card) {
            card.style.visibility = 'visible';
            card.style.position = 'relative';
            card.style.zIndex = '9999';
        }
        if (mockup) {
            mockup.style.opacity = '1';
        }

        setIsPreviewingOpacity(true);
    };

    const stopPreviewingOpacity = () => {
        // Direct DOM restoration
        document.body.classList.remove('disable-transitions');
        const backdrop = document.getElementById('settings-backdrop');
        const wrapper = document.getElementById('settings-panel-wrapper');
        const panel = document.getElementById('settings-panel');
        const card = document.getElementById('opacity-slider-card');
        const mockup = document.getElementById('settings-mockup-wrapper');
        const launcher = document.getElementById('launcher-container');

        if (backdrop) {
            backdrop.style.backgroundColor = '';
            backdrop.style.backdropFilter = '';
            backdrop.style.transition = '';
        }
        if (wrapper) {
            wrapper.style.backgroundColor = '';
            wrapper.style.border = '';
            wrapper.style.boxShadow = '';
        }
        if (panel) {
            panel.style.visibility = '';
        }
        if (launcher) {
            launcher.style.visibility = '';
        }

        if (card) {
            card.style.visibility = '';
            card.style.position = '';
            card.style.zIndex = '';
        }
        if (mockup) {
            // Bug fix #4: restore mockup to hidden (opacity 0) rather than leaving it visible
            mockup.style.opacity = '0';
        }

        setIsPreviewingOpacity(false);
        // Sync final dragged value back to React state (persists to localStorage + IPC via useEffect)
        setOverlayOpacity(latestOpacityRef.current);
    };

    useEffect(() => {
        const timeoutId = setTimeout(() => {
            localStorage.setItem('natively_overlay_opacity', String(overlayOpacity));
            window.electronAPI?.setOverlayOpacity?.(overlayOpacity);
        }, 150);
        return () => clearTimeout(timeoutId);
    }, [overlayOpacity]);

    useEffect(() => {
        localStorage.setItem('natively_overlay_clickthrough', String(overlayClickthroughEnabled));
        window.electronAPI?.setOverlayClickthrough?.(overlayClickthroughEnabled).catch(() => {
            showGeneralSettingsError('Unable to update overlay clickthrough.');
        });
    }, [overlayClickthroughEnabled, showGeneralSettingsError]);

    useEffect(() => {
        const unsubscribe = window.electronAPI?.onOverlayClickthroughChanged?.((enabled) => {
            setOverlayClickthroughEnabled(enabled);
        });
        return () => unsubscribe?.();
    }, []);

    useEffect(() => {
        const loadLanguages = async () => {
            if (window.electronAPI?.getRecognitionLanguages) {
                const langs = await window.electronAPI.getRecognitionLanguages();
                setAvailableLanguages(langs);

                // Load stored preference or auto-detect
                const storedStt = await window.electronAPI.getSttLanguage();
                let currentLangKey = storedStt;

                if (!currentLangKey) {
                    const systemLocale = navigator.language;
                    // Try to find exact match or primary match
                    const match = Object.entries(langs).find(([_, config]: [string, any]) =>
                        config.bcp47 === systemLocale ||
                        config.iso639 === systemLocale ||
                        (config.alternates && config.alternates.includes(systemLocale))
                    );

                    currentLangKey = match ? match[0] : 'english-us';

                    // Save the auto-detected default
                    if (window.electronAPI?.setRecognitionLanguage) {
                        window.electronAPI.setRecognitionLanguage(currentLangKey);
                    }
                }

                setRecognitionLanguage(currentLangKey);

                // Initialize Group based on current language
                if (langs[currentLangKey]) {
                    setSelectedSttGroup(langs[currentLangKey].group);
                } else {
                    setSelectedSttGroup('English');
                }
            }

            if (window.electronAPI?.getAiResponseLanguages) {
                const aiLangs = await window.electronAPI.getAiResponseLanguages();
                // Sort: English first, then alphabetical
                const sortedAiLangs = [...aiLangs].sort((a, b) => {
                    if (a.label === 'English') return -1;
                    if (b.label === 'English') return 1;
                    return a.label.localeCompare(b.label);
                });
                setAvailableAiLanguages(sortedAiLangs);

                const storedAi = await window.electronAPI.getAiResponseLanguage();
                setAiResponseLanguage(storedAi || 'English');
            }
        };
        loadLanguages();
    }, []);

    const handleLanguageChange = async (key: string) => {
        setRecognitionLanguage(key);
        if (availableLanguages[key]) {
            setSelectedSttGroup(availableLanguages[key].group);
        }
        if (window.electronAPI?.setRecognitionLanguage) {
            await window.electronAPI.setRecognitionLanguage(key);
        }
    };

    const handleGroupChange = (group: string) => {
        setSelectedSttGroup(group);
        // Find default variant for this group (first one)
        const firstVariant = Object.entries(availableLanguages).find(([_, lang]) => lang.group === group);
        if (firstVariant) {
            handleLanguageChange(firstVariant[0]);
        }
    };

    // Helper to get unique groups
    const languageGroups = Array.from(new Set(Object.values(availableLanguages).map((l: any) => l.group)))
        .sort((a, b) => {
            if (a === 'English') return -1;
            if (b === 'English') return 1;
            return a.localeCompare(b);
        });

    // Helper to get variants for current group
    const currentGroupVariants = Object.entries(availableLanguages)

        .filter(([_, lang]) => lang.group === selectedSttGroup)
        .map(([key, lang]) => ({
            deviceId: key,
            label: lang.label,
            kind: 'audioinput' as MediaDeviceKind,
            groupId: '',
            toJSON: () => ({})
        }));

    const handleAiLanguageChange = async (key: string) => {
        setAiResponseLanguage(key);
        if (window.electronAPI?.setAiResponseLanguage) {
            await window.electronAPI.setAiResponseLanguage(key);
        }
    };


    // Sync transcript setting
    useEffect(() => {
        const handleStorage = () => {
            const stored = localStorage.getItem('natively_interviewer_transcript');
            setShowTranscript(stored !== 'false');
        };
        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, []);

    // Theme Handlers
    const handleSetTheme = async (mode: 'system' | 'light' | 'dark') => {
        setThemeMode(mode);
        if (window.electronAPI?.setThemeMode) {
            await window.electronAPI.setThemeMode(mode);
        }
    };

    // Audio Settings
    const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
    const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
    const [selectedInput, setSelectedInput] = useState('');
    const [selectedOutput, setSelectedOutput] = useState('');
    const [useExperimentalSck, setUseExperimentalSck] = useState(false);

    // STT Provider settings
    const [sttProvider, setSttProvider] = useState<SttProvider>('google');
    const [groqSttModel, setGroqSttModel] = useState('whisper-large-v3-turbo');
    const [sttGroqKey, setSttGroqKey] = useState('');
    const [sttOpenaiKey, setSttOpenaiKey] = useState('');
    const [sttDeepgramKey, setSttDeepgramKey] = useState('');
    const [sttElevenLabsKey, setSttElevenLabsKey] = useState('');
    const [sttAzureKey, setSttAzureKey] = useState('');
    const [sttAzureRegion, setSttAzureRegion] = useState('eastus');
    const [sttIbmKey, setSttIbmKey] = useState('');
    const [sttTestStatus, setSttTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
    const [sttTestError, setSttTestError] = useState('');
    const [sttSaving, setSttSaving] = useState(false);
    const [sttSaved, setSttSaved] = useState(false);
    const [googleServiceAccountPath, setGoogleServiceAccountPath] = useState<string | null>(null);
    const [hasStoredSttGroqKey, setHasStoredSttGroqKey] = useState(false);
    const [hasStoredSttOpenaiKey, setHasStoredSttOpenaiKey] = useState(false);
    const [hasStoredDeepgramKey, setHasStoredDeepgramKey] = useState(false);
    const [hasStoredElevenLabsKey, setHasStoredElevenLabsKey] = useState(false);
    const [hasStoredAzureKey, setHasStoredAzureKey] = useState(false);
    const [hasStoredIbmWatsonKey, setHasStoredIbmWatsonKey] = useState(false);
    const [sttSonioxKey, setSttSonioxKey] = useState('');
    const [hasStoredSonioxKey, setHasStoredSonioxKey] = useState(false);
    const [isSttDropdownOpen, setIsSttDropdownOpen] = useState(false);
    const sttDropdownRef = React.useRef<HTMLDivElement>(null);
    const sttRequestIdRef = React.useRef(0);
    const sttStatusTimerRef = React.useRef<number | null>(null);
    const sttSavedTimerRef = React.useRef<number | null>(null);
    const sttProviderRef = React.useRef(sttProvider);
    const sttSaveInFlightRef = React.useRef<null | { requestId: number; provider: string }>(null);
    const sttTestInFlightRef = React.useRef<null | { requestId: number; provider: string }>(null);

    const nextSttRequestId = React.useCallback(() => {
        sttRequestIdRef.current += 1;
        return sttRequestIdRef.current;
    }, []);

    const isCurrentSttRequest = React.useCallback((requestId: number) => {
        return sttRequestIdRef.current === requestId;
    }, []);

    const clearSttTimers = React.useCallback(() => {
        if (sttStatusTimerRef.current) {
            window.clearTimeout(sttStatusTimerRef.current);
            sttStatusTimerRef.current = null;
        }
        if (sttSavedTimerRef.current) {
            window.clearTimeout(sttSavedTimerRef.current);
            sttSavedTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        sttProviderRef.current = sttProvider;
    }, [sttProvider]);

    const getSttProviderErrorMessage = React.useCallback((error: unknown) => {
        if (typeof error === 'string' && error.trim()) {
            return error;
        }
        if (error && typeof error === 'object' && 'message' in error) {
            const message = (error as { message?: unknown }).message;
            if (typeof message === 'string' && message.trim()) {
                return message;
            }
        }
        return 'Failed to update STT provider';
    }, []);

    const persistSttProvider = React.useCallback(async (provider: SttProvider) => {
        // @ts-ignore
        const result = await window.electronAPI?.setSttProvider?.(provider);
        if (!result?.success) {
            throw new Error(getSttProviderErrorMessage(result?.error));
        }
    }, [getSttProviderErrorMessage]);

    const hasConfiguredSttProvider = React.useCallback((provider: SttProvider) => {
        if (provider === 'google') {
            return Boolean(googleServiceAccountPath?.trim());
        }

        const storedProviderKeys: Record<NonGoogleSttProvider, boolean> = {
            groq: hasStoredSttGroqKey,
            openai: hasStoredSttOpenaiKey,
            deepgram: hasStoredDeepgramKey,
            elevenlabs: hasStoredElevenLabsKey,
            azure: hasStoredAzureKey,
            ibmwatson: hasStoredIbmWatsonKey,
            soniox: hasStoredSonioxKey,
        };

        return storedProviderKeys[provider];
    }, [
        googleServiceAccountPath,
        hasStoredAzureKey,
        hasStoredDeepgramKey,
        hasStoredElevenLabsKey,
        hasStoredIbmWatsonKey,
        hasStoredSonioxKey,
        hasStoredSttGroqKey,
        hasStoredSttOpenaiKey,
    ]);

    const handleGoogleServiceAccountSelected = React.useCallback(async (filePath: string) => {
        setGoogleServiceAccountPath(filePath);
        if (sttProviderRef.current !== 'google') {
            return;
        }

        try {
            await persistSttProvider('google');
        } catch (e) {
            console.error('Failed to activate Google STT provider:', e);
            setSttTestStatus('error');
            setSttTestError(getSttProviderErrorMessage(e));
        }
    }, [getSttProviderErrorMessage, persistSttProvider]);

    const isCurrentSttProviderRequest = React.useCallback((requestId: number, provider: string) => {
        return isCurrentSttRequest(requestId) && sttProviderRef.current === provider;
    }, [isCurrentSttRequest]);

    const scheduleSttStatusReset = React.useCallback(() => {
        if (sttStatusTimerRef.current) {
            window.clearTimeout(sttStatusTimerRef.current);
        }
        sttStatusTimerRef.current = window.setTimeout(() => {
            setSttTestStatus('idle');
            sttStatusTimerRef.current = null;
        }, 3000);
    }, []);

    const scheduleSttSavedReset = React.useCallback(() => {
        if (sttSavedTimerRef.current) {
            window.clearTimeout(sttSavedTimerRef.current);
        }
        sttSavedTimerRef.current = window.setTimeout(() => {
            setSttSaved(false);
            sttSavedTimerRef.current = null;
        }, 2000);
    }, []);

    // Close STT dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (sttDropdownRef.current && !sttDropdownRef.current.contains(event.target as Node)) {
                setIsSttDropdownOpen(false);
            }
        };
        if (isSttDropdownOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isSttDropdownOpen]);

    useEffect(() => {
        return () => {
            clearSttTimers();
            sttRequestIdRef.current += 1;
        };
    }, [clearSttTimers]);

    // Load STT settings on mount
    useEffect(() => {
        const loadSttSettings = async () => {
            try {
                // @ts-ignore
                const creds = await window.electronAPI?.getStoredCredentials?.();
                if (creds) {
                    setSttProvider(creds.sttProvider || 'google');
                    if (creds.groqSttModel) setGroqSttModel(creds.groqSttModel);
                    setGoogleServiceAccountPath(creds.googleServiceAccountPath);
                    setHasStoredSttGroqKey(creds.hasSttGroqKey);
                    setHasStoredSttOpenaiKey(creds.hasSttOpenaiKey);
                    setHasStoredDeepgramKey(creds.hasDeepgramKey);
                    setHasStoredElevenLabsKey(creds.hasElevenLabsKey);
                    setHasStoredAzureKey(creds.hasAzureKey);
                    if (creds.azureRegion) setSttAzureRegion(creds.azureRegion);
                    setHasStoredIbmWatsonKey(creds.hasIbmWatsonKey);
                    setHasStoredSonioxKey(creds.hasSonioxKey || false);
                    setHasStoredGoogleSearchKey(creds.hasGoogleSearchKey || false);
                    setHasStoredGoogleSearchCseId(creds.hasGoogleSearchCseId || false);
                }
            } catch (e) {
                console.error('Failed to load STT settings:', e);
            }
        };
        if (isOpen) loadSttSettings();
    }, [isOpen]);

    const handleSttProviderChange = async (provider: SttProvider) => {
        const previousProvider = sttProvider;
        nextSttRequestId();
        sttSaveInFlightRef.current = null;
        sttTestInFlightRef.current = null;
        clearSttTimers();
        setSttProvider(provider);
        setIsSttDropdownOpen(false);
        setSttTestStatus('idle');
        setSttTestError('');
        setSttSaving(false);
        setSttSaved(false);

        // The dropdown also controls which credential editor is visible, so keep
        // the local selection even before the provider is ready to be activated.
        if (!hasConfiguredSttProvider(provider)) {
            return;
        }

        try {
            await persistSttProvider(provider);
        } catch (e) {
            console.error('Failed to set STT provider:', e);
            setSttProvider(previousProvider);
        }
    };

    const handleSttKeySubmit = async (provider: NonGoogleSttProvider, key: string) => {
        if (!key.trim()) return;
        if (sttTestInFlightRef.current?.provider === provider) return;
        if (sttSaveInFlightRef.current?.provider === provider) return;

        const requestId = nextSttRequestId();
        sttSaveInFlightRef.current = { requestId, provider };
        clearSttTimers();

        // Auto-test before saving
        setSttSaving(true);
        setSttTestStatus('testing');
        setSttTestError('');

        try {
            // @ts-ignore
            const testResult = await window.electronAPI?.testSttConnection?.(
                provider,
                key.trim(),
                provider === 'azure' ? sttAzureRegion : undefined
            );

            if (!isCurrentSttProviderRequest(requestId, provider)) return;

            if (!testResult?.success) {
                setSttTestStatus('error');
                setSttTestError(testResult?.error || 'Validation failed. Key not saved.');
                return; // Stop save
            }

            // If success, proceed to save
            setSttTestStatus('success');
            scheduleSttStatusReset();

            let saveResult: { success: boolean; error?: string } | undefined;
            if (provider === 'groq') {
                // @ts-ignore
                saveResult = await window.electronAPI?.setGroqSttApiKey?.(key.trim());
            } else if (provider === 'openai') {
                // @ts-ignore
                saveResult = await window.electronAPI?.setOpenAiSttApiKey?.(key.trim());
            } else if (provider === 'elevenlabs') {
                // @ts-ignore
                saveResult = await window.electronAPI?.setElevenLabsApiKey?.(key.trim());
            } else if (provider === 'azure') {
                // @ts-ignore
                saveResult = await window.electronAPI?.setAzureApiKey?.(key.trim());
            } else if (provider === 'ibmwatson') {
                // @ts-ignore
                saveResult = await window.electronAPI?.setIbmWatsonApiKey?.(key.trim());
            } else if (provider === 'soniox') {
                // @ts-ignore
                saveResult = await window.electronAPI?.setSonioxApiKey?.(key.trim());
            } else {
                // @ts-ignore
                saveResult = await window.electronAPI?.setDeepgramApiKey?.(key.trim());
            }

            if (!saveResult?.success) {
                throw new Error(saveResult?.error || 'Failed to save API key');
            }

            if (!isCurrentSttProviderRequest(requestId, provider)) return;

            if (provider === 'groq') setHasStoredSttGroqKey(true);
            else if (provider === 'openai') setHasStoredSttOpenaiKey(true);
            else if (provider === 'elevenlabs') setHasStoredElevenLabsKey(true);
            else if (provider === 'azure') setHasStoredAzureKey(true);
            else if (provider === 'ibmwatson') setHasStoredIbmWatsonKey(true);
            else if (provider === 'soniox') setHasStoredSonioxKey(true);
            else setHasStoredDeepgramKey(true);

            if (sttProviderRef.current === provider) {
                await persistSttProvider(provider);
                if (!isCurrentSttProviderRequest(requestId, provider)) return;
            }

            setSttSaved(true);
            scheduleSttSavedReset();
        } catch (e: any) {
            if (!isCurrentSttProviderRequest(requestId, provider)) return;
            console.error(`Failed to save ${provider} STT key:`, e);
            setSttTestStatus('error');
            setSttTestError(e.message || 'Validation failed');
        } finally {
            if (sttSaveInFlightRef.current?.requestId === requestId) {
                sttSaveInFlightRef.current = null;
            }
            if (isCurrentSttProviderRequest(requestId, provider)) {
                setSttSaving(false);
            }
        }
    };

    const handleRemoveSttKey = async (provider: 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox') => {
        if (!confirm(`Are you sure you want to remove the ${provider === 'ibmwatson' ? 'IBM Watson' : provider.charAt(0).toUpperCase() + provider.slice(1)} API key?`)) return;

        try {
            if (provider === 'groq') {
                // @ts-ignore
                await window.electronAPI?.setGroqSttApiKey?.('');
                setSttGroqKey('');
                setHasStoredSttGroqKey(false);
            } else if (provider === 'openai') {
                // @ts-ignore
                await window.electronAPI?.setOpenAiSttApiKey?.('');
                setSttOpenaiKey('');
                setHasStoredSttOpenaiKey(false);
            } else if (provider === 'elevenlabs') {
                // @ts-ignore
                await window.electronAPI?.setElevenLabsApiKey?.('');
                setSttElevenLabsKey('');
                setHasStoredElevenLabsKey(false);
            } else if (provider === 'azure') {
                // @ts-ignore
                await window.electronAPI?.setAzureApiKey?.('');
                setSttAzureKey('');
                setHasStoredAzureKey(false);
            } else if (provider === 'ibmwatson') {
                // @ts-ignore
                await window.electronAPI?.setIbmWatsonApiKey?.('');
                setSttIbmKey('');
                setHasStoredIbmWatsonKey(false);
            } else if (provider === 'soniox') {
                // @ts-ignore
                await window.electronAPI?.setSonioxApiKey?.('');
                setSttSonioxKey('');
                setHasStoredSonioxKey(false);
            } else {
                // @ts-ignore
                await window.electronAPI?.setDeepgramApiKey?.('');
                setSttDeepgramKey('');
                setHasStoredDeepgramKey(false);
            }
        } catch (e) {
            console.error(`Failed to remove ${provider} STT key:`, e);
        }
    };

    const handleRemoveGoogleSearchKey = async (type: 'apikey' | 'cseid') => {
        if (!confirm(`Are you sure you want to remove the Google Search ${type === 'apikey' ? 'API Key' : 'CSE ID'}?`)) return;

        try {
            if (type === 'apikey') {
                await window.electronAPI?.setGoogleSearchApiKey?.('');
                setGoogleSearchApiKey('');
                setHasStoredGoogleSearchKey(false);
            } else {
                await window.electronAPI?.setGoogleSearchCseId?.('');
                setGoogleSearchCseId('');
                setHasStoredGoogleSearchCseId(false);
            }
        } catch (e) {
            console.error(`Failed to remove Google Search ${type}:`, e);
        }
    };

    const handleTestSttConnection = async () => {
        if (sttProvider === 'google') return;
        if (sttSaveInFlightRef.current?.provider === sttProvider) return;
        if (sttTestInFlightRef.current?.provider === sttProvider) return;
        const requestId = nextSttRequestId();
        clearSttTimers();
        const providerUnderTest = sttProvider;
        sttTestInFlightRef.current = { requestId, provider: providerUnderTest };
        const keyMap: Record<string, string> = {
            groq: sttGroqKey, openai: sttOpenaiKey, deepgram: sttDeepgramKey,
            elevenlabs: sttElevenLabsKey, azure: sttAzureKey, ibmwatson: sttIbmKey,
            soniox: sttSonioxKey,
        };
        const keyToTest = keyMap[providerUnderTest] || '';
        if (!keyToTest.trim()) {
            setSttTestStatus('error');
            setSttTestError('Please enter an API key first');
            return;
        }

        setSttTestStatus('testing');
        setSttTestError('');
        try {
            // @ts-ignore
            const result = await window.electronAPI?.testSttConnection?.(
                providerUnderTest,
                keyToTest.trim(),
                providerUnderTest === 'azure' ? sttAzureRegion : undefined
            );

            if (!isCurrentSttProviderRequest(requestId, providerUnderTest)) return;

            if (result?.success) {
                setSttTestStatus('success');
                scheduleSttStatusReset();
            } else {
                setSttTestStatus('error');
                setSttTestError(result?.error || 'Connection failed');
            }
        } catch (e: any) {
            if (!isCurrentSttProviderRequest(requestId, providerUnderTest)) return;
            setSttTestStatus('error');
            setSttTestError(e.message || 'Test failed');
        } finally {
            if (sttTestInFlightRef.current?.requestId === requestId) {
                sttTestInFlightRef.current = null;
            }
        }
    };


    const [calendarStatus, setCalendarStatus] = useState<{ connected: boolean; email?: string }>({ connected: false });
    const [isCalendarsLoading, setIsCalendarsLoading] = useState(false);

    const audioContextRef = React.useRef<AudioContext | null>(null);
    const analyserRef = React.useRef<AnalyserNode | null>(null);
    const sourceRef = React.useRef<MediaStreamAudioSourceNode | null>(null);
    const rafRef = React.useRef<number | null>(null);
    const streamRef = React.useRef<MediaStream | null>(null);
    const micLevelBarRef = React.useRef<HTMLDivElement | null>(null);

    const updateMicLevelBar = React.useCallback((level: number) => {
        if (micLevelBarRef.current) {
            micLevelBarRef.current.style.width = `${Math.max(0, Math.min(100, level))}%`;
        }
    }, []);

    const handleTestSound = async () => {
        try {
            const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
            if (!AudioContext) {
                console.error("Web Audio API not supported");
                return;
            }

            const ctx = new AudioContext();
            if (ctx.state === 'suspended') {
                await ctx.resume();
            }

            const oscillator = ctx.createOscillator();
            const gainNode = ctx.createGain();
            oscillator.connect(gainNode);
            gainNode.connect(ctx.destination);
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(523.25, ctx.currentTime);
            gainNode.gain.setValueAtTime(0.5, ctx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 1.0);

            if (selectedOutput && (ctx as any).setSinkId) {
                try {
                    await (ctx as any).setSinkId(selectedOutput);
                } catch (e) {
                    console.warn("Error setting sink for AudioContext", e);
                }
            }

            oscillator.start();
            oscillator.stop(ctx.currentTime + 1.0);
        } catch (e) {
    console.error("Error playing test sound", e);
    }
  };

  // Load stored credentials on mount

  useEffect(() => {
    if (isOpen) {
      // Load detectable status
            if (window.electronAPI?.getUndetectable) {
                window.electronAPI.getUndetectable().then(setIsUndetectable);
            }
            if (window.electronAPI?.getOpenAtLogin) {
                window.electronAPI.getOpenAtLogin().then(setOpenOnLogin);
            }
            if (window.electronAPI?.getThemeMode) {
                window.electronAPI.getThemeMode().then(({ mode }) => setThemeMode(mode));
            }

            // Load settings
            const loadDevices = async () => {
                try {
                    const [inputs, outputs] = await Promise.all([
                        // @ts-ignore
                        window.electronAPI?.getInputDevices() || Promise.resolve([]),
                        // @ts-ignore
                        window.electronAPI?.getOutputDevices() || Promise.resolve([])
                    ]);

                    // Map to shape compatible with CustomSelect (which expects MediaDeviceInfo-like objects)
                    const formatDevices = (devs: any[]) => devs.map(d => ({
                        deviceId: d.id,
                        label: d.name,
                        kind: 'audioinput' as MediaDeviceKind,
                        groupId: '',
                        toJSON: () => d
                    }));

                    setInputDevices(formatDevices(inputs));
                    setOutputDevices(formatDevices(outputs));

                    // Load saved preferences
                    const savedInput = localStorage.getItem('preferredInputDeviceId');
                    const savedOutput = localStorage.getItem('preferredOutputDeviceId');

                    if (savedInput && inputs.find((d: any) => d.id === savedInput)) {
                        setSelectedInput(savedInput);
                    } else if (inputs.length > 0 && !selectedInput) {
                        setSelectedInput(inputs[0].id);
                    }

                    if (savedOutput && outputs.find((d: any) => d.id === savedOutput)) {
                        setSelectedOutput(savedOutput);
                    } else if (outputs.length > 0 && !selectedOutput) {
                        setSelectedOutput(outputs[0].id);
                    }
                } catch (e) {
                    console.error("Error loading native devices:", e);
                }
            };
            loadDevices();

            // Load Experimental SCK pref
            const savedSck = localStorage.getItem('useExperimentalSckBackend') === 'true';
            setUseExperimentalSck(savedSck);

            // Load Calendar Status
            if (window.electronAPI?.getCalendarStatus) {
                window.electronAPI.getCalendarStatus().then(setCalendarStatus);
            }
        }
    }, [isOpen, selectedInput, selectedOutput]); // Re-run if isOpen changes, or if selected devices are cleared

    // Effect for real-time audio level monitoring
    useEffect(() => {
        if (isOpen && activeTab === 'audio') {
            let mounted = true;

            const startAudio = async () => {
                try {
                    // Cleanup previous audio context if it exists
                    if (audioContextRef.current) {
                        audioContextRef.current.close();
                    }

                    const stream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            deviceId: selectedInput ? { exact: selectedInput } : undefined
                        }
                    });

                    streamRef.current = stream;

                    if (!mounted) return;

                    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
                    const analyser = audioContext.createAnalyser();
                    const source = audioContext.createMediaStreamSource(stream);

                    analyser.fftSize = 256;
                    source.connect(analyser);

                    audioContextRef.current = audioContext;
                    analyserRef.current = analyser;
                    sourceRef.current = source;

                    const dataArray = new Uint8Array(analyser.frequencyBinCount);
                    let smoothLevel = 0;

                    const updateLevel = () => {
                        if (!mounted || !analyserRef.current) return;
                        // Use Time Domain Data for accurate volume (waveform) instead of frequency
                        analyserRef.current.getByteTimeDomainData(dataArray);

                        let sum = 0;
                        for (let i = 0; i < dataArray.length; i++) {
                            // Convert 0-255 to -1 to 1 range
                            const value = (dataArray[i] - 128) / 128;
                            sum += value * value;
                        }

                        // Calculate RMS
                        const rms = Math.sqrt(sum / dataArray.length);

                        // Convert to simpler 0-100 range with some boost
                        // RMS is usually very small (0.01 - 0.5 for normal speech)
                        // Logarithmic scaling feels more natural for volume
                        const db = 20 * Math.log10(rms);
                        // Approximate mapping: -60dB (silence) to 0dB (max) -> 0 to 100
                        const targetLevel = Math.max(0, Math.min(100, (db + 60) * 2));

                        // Apply smoothing
                        if (targetLevel > smoothLevel) {
                            smoothLevel = smoothLevel * 0.7 + targetLevel * 0.3; // Fast attack
                        } else {
                            smoothLevel = smoothLevel * 0.95 + targetLevel * 0.05; // Slow decay
                        }

                        updateMicLevelBar(smoothLevel);

                        rafRef.current = requestAnimationFrame(updateLevel);
                    };

                    updateLevel();
                } catch (error) {
                    console.error("Error accessing microphone:", error);
                    updateMicLevelBar(0);
                }
            };

            startAudio();

            return () => {
                mounted = false;
                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                if (sourceRef.current) sourceRef.current.disconnect();
                if (audioContextRef.current) {
                    audioContextRef.current.close();
                    audioContextRef.current = null;
                }
                if (streamRef.current) {
                    streamRef.current.getTracks().forEach(track => track.stop());
                    streamRef.current = null;
                }
                updateMicLevelBar(0);
            };
        } else {
            // Cleanup when closing tab or overlay or switching away from audio tab
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            if (sourceRef.current) sourceRef.current.disconnect(); // Disconnect source as well
            if (audioContextRef.current) {
                audioContextRef.current.close();
                audioContextRef.current = null;
            }
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
                streamRef.current = null;
            }
            updateMicLevelBar(0);
        }
    }, [isOpen, activeTab, selectedInput, updateMicLevelBar]);

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    id="settings-backdrop"
                    className={`fixed inset-0 z-50 flex items-center justify-center p-8 transition-colors duration-150 ${isPreviewingOpacity ? 'bg-transparent backdrop-blur-none' : 'bg-black/60 backdrop-blur-sm'}`}
                >
                    <motion.div
                        id="settings-panel-wrapper"
                        initial={{ scale: 0.94, opacity: 0, y: 20 }}
                        animate={{ scale: 1, opacity: 1, y: 0 }}
                        exit={{ scale: 0.94, opacity: 0, y: 20 }}
                        transition={{ 
                            type: "spring", 
                            stiffness: 400, 
                            damping: 32,
                            mass: 1
                        }}
                        className="bg-bg-elevated w-full max-w-4xl h-[80vh] rounded-2xl border border-border-subtle shadow-2xl overflow-hidden relative"
                    >
                        <div 
                            id="settings-panel" 
                            className="flex w-full h-full"
                            style={{ visibility: isPreviewingOpacity ? 'hidden' : 'visible' }}
                        >
                        <SettingsSidebar
                            activeTab={activeTab}
                            setActiveTab={setActiveTab}
                            onClose={onClose}
                            onProfileOpen={() => {
                                window.electronAPI?.profileGetStatus?.().then(setProfileStatus).catch(() => { });
                                window.electronAPI?.profileGetProfile?.().then(setProfileData).catch(() => { });
                            }}
                        />

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto bg-bg-main p-8">
{activeTab === 'general' && (
<GeneralSettingsSection
isUndetectable={isUndetectable}
setIsUndetectable={setIsUndetectable}
openOnLogin={openOnLogin}
setOpenOnLogin={setOpenOnLogin}
showTranscript={showTranscript}
setShowTranscript={setShowTranscript}
generalSettingsError={generalSettingsError}
themeMode={themeMode}
isThemeDropdownOpen={isThemeDropdownOpen}
setIsThemeDropdownOpen={setIsThemeDropdownOpen}
themeDropdownRef={themeDropdownRef}
handleSetTheme={handleSetTheme}
aiResponseLanguage={aiResponseLanguage}
isAiLangDropdownOpen={isAiLangDropdownOpen}
setIsAiLangDropdownOpen={setIsAiLangDropdownOpen}
aiLangDropdownRef={aiLangDropdownRef}
availableAiLanguages={availableAiLanguages}
handleAiLanguageChange={handleAiLanguageChange}
              overlayOpacity={overlayOpacity}
              overlayClickthroughEnabled={overlayClickthroughEnabled}
              handleOpacityChange={handleOpacityChange}
              setOverlayClickthroughEnabled={setOverlayClickthroughEnabled}
              startPreviewingOpacity={startPreviewingOpacity}
              stopPreviewingOpacity={stopPreviewingOpacity}
              isPreviewingOpacity={isPreviewingOpacity}
              disguiseMode={disguiseMode}
              setDisguiseMode={setDisguiseMode}
              showGeneralSettingsError={showGeneralSettingsError}
              accelerationModeEnabled={accelerationModeEnabled}
              setAccelerationModeEnabled={setAccelerationModeEnabled}
              consciousModeEnabled={consciousModeEnabled}
              setConsciousModeEnabled={setConsciousModeEnabled}
            />
        )}
                            {activeTab === 'profile' && (
                                <div className="space-y-6 animated fadeIn">
                                    {/* Introduction */}
                                    <div className="mb-5">
                                            <div className="flex items-center gap-2">
                                                <h3 className="text-sm font-bold text-text-primary">Professional Identity</h3>
                                                <span className="bg-yellow-500/10 text-yellow-500 text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide">BETA</span>
                                            </div>
                                        <p className="text-xs text-text-secondary mb-2">
                                            This engine constructs an intelligent representation of your career history.
                                        </p>
                                    </div>

                                    {/* Intelligence Graph Hero Card */}
                                    <div className="bg-bg-item-surface rounded-xl border border-border-subtle flex flex-col justify-between overflow-hidden">
                                        <div className="flex flex-col justify-between min-h-[160px]">

                                            {/* Header */}
                                            <div className="p-5 pb-4">
                                                <div className="flex items-center justify-between">
                                                    <div className="flex items-center gap-4">
                                                        <div className="w-10 h-10 rounded-full bg-bg-input border border-border-subtle flex items-center justify-center text-text-primary shadow-sm hover:scale-105 transition-transform duration-300">
                                                            <span className="font-bold text-sm tracking-tight">
                                                                {profileData?.identity?.name ? profileData.identity.name.charAt(0).toUpperCase() : 'U'}
                                                            </span>
                                                        </div>
                                                        <div>
                                                            <h4 className="text-sm font-bold text-text-primary tracking-tight">
                                                                {profileData?.identity?.name || 'Identity Node Inactive'}
                                                            </h4>
                                                            <p className="text-xs text-text-secondary mt-0.5 tracking-wide">
                                                                {profileData?.identity?.email || 'Upload a resume to begin mapping.'}
                                                            </p>
                                                        </div>
                                                    </div>

                                                    <div className="flex items-center gap-3">
                                                        {profileStatus.hasProfile && (
                                                            <button
                                                                onClick={async () => {
                                                                    if (!confirm('Are you sure you want to delete your mapped persona? This will destroy all structured timeline data.')) return;
                                                                    try {
                                                                        await window.electronAPI?.profileDelete?.();
                                                                        setProfileStatus({ hasProfile: false, profileMode: false });
                                                                        setProfileData(null);
                                                                    } catch (e) { console.error('Failed to delete profile:', e); }
                                                                }}
                                                                className="text-[12px] font-medium text-text-tertiary hover:text-red-500 transition-colors px-3 py-1.5 rounded-full hover:bg-red-500/10"
                                                            >
                                                                Disconnect
                                                            </button>
                                                        )}

                                                        {/* High-fidelity Toggle */}
                                                        <div className={`flex items-center gap-2 bg-bg-input px-3 py-1.5 rounded-full border border-border-subtle`}>
                                                            <span className="text-xs font-medium text-text-secondary">Persona Engine</span>
                                                            <div
                                                                onClick={async () => {
                                                                    if (!profileStatus.hasProfile) return;
                                                                    const newState = !profileStatus.profileMode;
                                                                    try {
                                                                        await window.electronAPI?.profileSetMode?.(newState);
                                                                        setProfileStatus(prev => ({ ...prev, profileMode: newState }));
                                                                    } catch (e) {
                                                                        console.error('Failed to toggle profile mode:', e);
                                                                    }
                                                                }}
                                                                className={`w-9 h-5 rounded-full relative transition-colors ${(!profileStatus.hasProfile) ? 'opacity-40 cursor-not-allowed bg-bg-toggle-switch' : profileStatus.profileMode ? 'bg-accent-primary' : 'bg-bg-toggle-switch border border-border-muted'}`}
                                                            >
                                                                <div className={`absolute top-1 left-1 w-3 h-3 rounded-full bg-white transition-transform ${profileStatus.profileMode ? 'translate-x-4' : 'translate-x-0'}`} />
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Data Metrics & Extracted Skills */}
                                            <div className="p-5 pt-0 mt-auto">
                                                <div className="flex items-center justify-between bg-bg-item-surface dark:bg-[#1A1A1A] border border-border-subtle py-4 px-6 rounded-2xl shadow-sm">
                                                    <div className="flex flex-col items-center justify-center flex-1">
                                                        <span className="text-[20px] font-bold text-text-primary tracking-tight leading-none mb-1">{profileData?.experienceCount || 0}</span>
                                                        <div className="flex items-center gap-1.5">
                                                            <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]" />
                                                            <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-widest">Experience</span>
                                                        </div>
                                                    </div>

                                                    <div className="h-8 w-px bg-border-subtle/60" />

                                                    <div className="flex flex-col items-center justify-center flex-1">
                                                        <span className="text-[20px] font-bold text-text-primary tracking-tight leading-none mb-1">{profileData?.projectCount || 0}</span>
                                                        <div className="flex items-center gap-1.5">
                                                            <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.4)]" />
                                                            <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-widest">Projects</span>
                                                        </div>
                                                    </div>

                                                    <div className="h-8 w-px bg-border-subtle/60" />

                                                    <div className="flex flex-col items-center justify-center flex-1">
                                                        <span className="text-[20px] font-bold text-text-primary tracking-tight leading-none mb-1">{profileData?.nodeCount || 0}</span>
                                                        <div className="flex items-center gap-1.5">
                                                            <div className="w-1.5 h-1.5 rounded-full bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.4)]" />
                                                            <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-widest">Nodes</span>
                                                        </div>
                                                    </div>
                                                </div>

                                                {profileData?.skills && profileData.skills.length > 0 && (
                                                    <div className="mt-5">
                                                        <div className="text-[10px] font-bold text-text-primary uppercase tracking-wide mb-2">
                                                            Top Skills
                                                        </div>
                                                        <div className="flex flex-wrap gap-1.5">
                                                            {profileData.skills.slice(0, 15).map((skill: string, i: number) => (
                                                                <span key={i} className="text-[10px] font-medium text-text-secondary px-2 py-1 rounded-md border border-border-subtle bg-bg-input">
                                                                    {skill}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Upload Area */}
                                    <div className="mt-5">
                                        <div className={`bg-bg-item-surface rounded-xl border transition-all ${profileUploading ? 'border-accent-primary/50 ring-1 ring-accent-primary/20' : 'border-border-subtle'}`}>
                                            <div className="p-5 flex items-center justify-between">
                                                <div className="flex items-center gap-4 min-w-0">
                                                    <div className="w-10 h-10 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center text-text-tertiary shrink-0">
                                                        {profileUploading ? <RefreshCw size={20} className="animate-spin text-accent-primary" /> : <Upload size={20} />}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <h4 className="text-sm font-bold text-text-primary mb-0.5 truncate pr-4">
                                                            {profileStatus.hasProfile ? 'Overwrite Source Document' : 'Initialize Knowledge Base'}
                                                        </h4>
                                                        {profileUploading ? (
                                                            <div className="flex items-center gap-2">
                                                                <div className="h-[4px] w-[100px] bg-bg-input rounded-full overflow-hidden">
                                                                    <div className="h-full bg-accent-primary rounded-full animate-pulse" style={{ width: '50%' }} />
                                                                </div>
                                                                <span className="text-[10px] text-text-secondary tracking-wide">Processing structural semantics...</span>
                                                            </div>
                                                        ) : (
                                                            <p className="text-xs text-text-secondary truncate pr-4">
                                                                Provide a resume file to seed the intelligence engine.
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>

                                                <button
                                                    onClick={async () => {
                                                        setProfileError('');
                                                        try {
                                                            const fileResult = await window.electronAPI?.profileSelectFile?.();
                                                            if (fileResult?.cancelled || !fileResult?.filePath) return;

                                                            setProfileUploading(true);
                                                            const result = await window.electronAPI?.profileUploadResume?.(fileResult.filePath);
                                                            if (result?.success) {
                                                                const status = await window.electronAPI?.profileGetStatus?.();
                                                                if (status) setProfileStatus(status);
                                                                const data = await window.electronAPI?.profileGetProfile?.();
                                                                if (data) setProfileData(data);
                                                            } else {
                                                                setProfileError(result?.error || 'Upload failed');
                                                            }
                                                        } catch (e: any) {
                                                            setProfileError(e.message || 'Upload failed');
                                                        } finally {
                                                            setProfileUploading(false);
                                                        }
                                                    }}
                                                    disabled={profileUploading}
                                                    className={`px-4 py-2 rounded-full text-xs font-medium transition-all whitespace-nowrap shrink-0 ${profileUploading ? 'bg-bg-input text-text-tertiary cursor-wait border border-border-subtle' : 'bg-text-primary text-bg-main hover:opacity-90 shadow-sm'}`}
                                                >
                                                    {profileUploading ? 'Ingesting...' : 'Select File'}
                                                </button>
                                            </div>

                                            {profileError && (
                                                <div className="px-5 pb-4">
                                                    <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-2 text-[11px] text-red-500 font-medium">
                                                        <X size={12} /> {profileError}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* JD Upload Card */}
                                    <div className="mt-5">
                                        <div className={`rounded-xl transition-all border ${jdUploading ? 'border-blue-500/50 ring-1 ring-blue-500/20 bg-bg-item-surface' : profileData?.hasActiveJD ? 'border-blue-500/30 bg-blue-500/5' : 'border-border-subtle bg-bg-item-surface'}`}>
                                            <div className="p-5 flex items-center justify-between">
                                                <div className="flex items-center gap-4 min-w-0">
                                                    <div className="w-10 h-10 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center text-text-tertiary shrink-0">
                                                        {jdUploading ? <RefreshCw size={20} className="animate-spin text-blue-500" /> : <Briefcase size={20} />}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <h4 className="text-sm font-bold text-text-primary mb-0.5 truncate pr-4">
                                                            {profileData?.hasActiveJD ? `${profileData.activeJD?.title} @ ${profileData.activeJD?.company}` : 'Upload Job Description'}
                                                        </h4>
                                                        {jdUploading ? (
                                                            <div className="flex items-center gap-2">
                                                                <div className="h-[4px] w-[100px] bg-bg-input rounded-full overflow-hidden">
                                                                    <div className="h-full bg-blue-500 rounded-full animate-pulse" style={{ width: '50%' }} />
                                                                </div>
                                                                <span className="text-[10px] text-text-secondary tracking-wide">Parsing JD structure...</span>
                                                            </div>
                                                        ) : profileData?.hasActiveJD ? (
                                                            <div className="flex items-center gap-3">
                                                                <span className="text-[9px] font-bold text-blue-500 px-1.5 py-0.5 bg-blue-500/10 rounded uppercase tracking-wide border border-blue-500/20">
                                                                    {profileData.activeJD?.level || 'mid'}-level
                                                                </span>
                                                                <div className="flex gap-1.5">
                                                                    {profileData.activeJD?.technologies?.slice(0, 3).map((t: string, i: number) => (
                                                                        <span key={i} className="text-[10px] text-text-secondary">{t}</span>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <p className="text-xs text-text-secondary">
                                                                Upload a JD to enable persona tuning and company research.
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-2 shrink-0">
                                                    {profileData?.hasActiveJD && (
                                                        <button
                                                            onClick={async () => {
                                                                await window.electronAPI?.profileDeleteJD?.();
                                                                const data = await window.electronAPI?.profileGetProfile?.();
                                                                if (data) setProfileData(data);
                                                                setCompanyDossier(null);
                                                            }}
                                                            className="px-2.5 py-2 rounded-full text-xs text-text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-all border border-transparent hover:border-red-500/20"
                                                        >
                                                            <Trash2 size={14} />
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={async () => {
                                                            setJdError('');
                                                            try {
                                                                const fileResult = await window.electronAPI?.profileSelectFile?.();
                                                                if (fileResult?.cancelled || !fileResult?.filePath) return;

                                                                setJdUploading(true);
                                                                const result = await window.electronAPI?.profileUploadJD?.(fileResult.filePath);
                                                                if (result?.success) {
                                                                    const data = await window.electronAPI?.profileGetProfile?.();
                                                                    if (data) setProfileData(data);
                                                                } else {
                                                                    setJdError(result?.error || 'JD upload failed');
                                                                }
                                                            } catch (e: any) {
                                                                setJdError(e.message || 'JD upload failed');
                                                            } finally {
                                                                setJdUploading(false);
                                                            }
                                                        }}
                                                        disabled={jdUploading}
                                                        className={`px-4 py-2 rounded-full text-xs font-medium transition-all whitespace-nowrap shrink-0 ${jdUploading ? 'bg-bg-input text-text-tertiary cursor-wait border border-border-subtle' : 'bg-blue-600 text-white hover:bg-blue-500 shadow-sm'}`}
                                                    >
                                                        {jdUploading ? 'Parsing...' : profileData?.hasActiveJD ? 'Replace JD' : 'Upload JD'}
                                                    </button>
                                                </div>
                                            </div>

                                            {jdError && (
                                                <div className="px-5 pb-4">
                                                    <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-2 text-[11px] text-red-500 font-medium">
                                                        <X size={12} /> {jdError}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* Google Search API Card */}
                                    <div className="mt-5">
                                        <div className="bg-bg-item-surface rounded-xl border border-border-subtle">
                                            <div className="p-5">
                                                <div className="flex items-center gap-4 mb-4">
                                                    <div className="w-10 h-10 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center text-emerald-500 shrink-0">
                                                        <Globe size={20} />
                                                    </div>
                                                    <div>
                                                        <div className="flex items-center gap-2">
                                                            <h4 className="text-sm font-bold text-text-primary">Google Search API</h4>
                                                            {hasStoredGoogleSearchKey && hasStoredGoogleSearchCseId && (
                                                                <span className="text-[9px] font-bold text-emerald-500 px-1.5 py-0.5 bg-emerald-500/10 rounded-full border border-emerald-500/20 uppercase tracking-wide">Connected</span>
                                                            )}
                                                        </div>
                                                        <p className="text-[11px] text-text-secondary mt-0.5">
                                                            Powers live web search for company research.
                                                        </p>
                                                    </div>
                                                </div>

                                                <div className="space-y-3">
                                                    <div>
                                                        <div className="flex justify-between items-center mb-1.5">
                                                            <label className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide block">API Key</label>
                                                            {hasStoredGoogleSearchKey && (
                                                                <button
                                                                    onClick={() => handleRemoveGoogleSearchKey('apikey')}
                                                                    className="text-[10px] flex items-center gap-1 text-red-400 hover:text-red-300 transition-colors bg-red-500/10 hover:bg-red-500/20 px-1.5 py-0.5 rounded"
                                                                    title="Remove API Key"
                                                                >
                                                                    <Trash2 size={10} strokeWidth={2} /> Remove
                                                                </button>
                                                            )}
                                                        </div>
                                                        <input
                                                            type="password"
                                                            value={googleSearchApiKey}
                                                            onChange={(e) => setGoogleSearchApiKey(e.target.value)}
                                                            placeholder={hasStoredGoogleSearchKey ? '••••••••••••' : 'Enter Google API key'}
                                                            className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all"
                                                        />
                                                    </div>
                                                    <div>
                                                        <div className="flex justify-between items-center mb-1.5">
                                                            <label className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide block">Custom Search Engine ID</label>
                                                            {hasStoredGoogleSearchCseId && (
                                                                <button
                                                                    onClick={() => handleRemoveGoogleSearchKey('cseid')}
                                                                    className="text-[10px] flex items-center gap-1 text-red-400 hover:text-red-300 transition-colors bg-red-500/10 hover:bg-red-500/20 px-1.5 py-0.5 rounded"
                                                                    title="Remove CSE ID"
                                                                >
                                                                    <Trash2 size={10} strokeWidth={2} /> Remove
                                                                </button>
                                                            )}
                                                        </div>
                                                        <input
                                                            type="text"
                                                            value={googleSearchCseId}
                                                            onChange={(e) => setGoogleSearchCseId(e.target.value)}
                                                            placeholder={hasStoredGoogleSearchCseId ? '••••••••••••' : 'Enter CSE ID (cx)'}
                                                            className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all"
                                                        />
                                                    </div>
                                                    <button
                                                        onClick={async () => {
                                                            if (!googleSearchApiKey.trim() && !googleSearchCseId.trim()) return;
                                                            setGoogleSearchSaving(true);
                                                            try {
                                                                if (googleSearchApiKey.trim()) {
                                                                    await window.electronAPI?.setGoogleSearchApiKey?.(googleSearchApiKey.trim());
                                                                    setHasStoredGoogleSearchKey(true);
                                                                    setGoogleSearchApiKey('');
                                                                }
                                                                if (googleSearchCseId.trim()) {
                                                                    await window.electronAPI?.setGoogleSearchCseId?.(googleSearchCseId.trim());
                                                                    setHasStoredGoogleSearchCseId(true);
                                                                    setGoogleSearchCseId('');
                                                                }
                                                            } catch (e) {
                                                                console.error('Failed to save Google Search keys:', e);
                                                            } finally {
                                                                setGoogleSearchSaving(false);
                                                            }
                                                        }}
                                                        disabled={googleSearchSaving || (!googleSearchApiKey.trim() && !googleSearchCseId.trim())}
                                                        className={`w-full px-4 py-2 rounded-lg text-xs font-medium transition-all ${googleSearchSaving ? 'bg-bg-input text-text-tertiary cursor-wait' : (!googleSearchApiKey.trim() && !googleSearchCseId.trim()) ? 'bg-bg-input text-text-tertiary cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-500 shadow-sm'}`}
                                                    >
                                                        {googleSearchSaving ? 'Saving...' : 'Save Credentials'}
                                                    </button>
                                                </div>

                                                <div className="mt-3 flex items-start gap-2 px-3 py-2.5 bg-bg-input/50 rounded-lg">
                                                    <Info size={12} className="text-text-tertiary shrink-0 mt-0.5" />
                                                    <p className="text-[10px] text-text-tertiary leading-relaxed">
                                                        If not provided, LLM general knowledge is used for company research, which may be outdated. Get your API key from the <span className="text-emerald-500/80 hover:text-emerald-400 underline underline-offset-2" onClick={() => window.electronAPI?.openExternal?.('https://console.cloud.google.com/apis/credentials')}>Google Cloud Console</span> and create a Custom Search Engine at <span className="text-emerald-500/80 hover:text-emerald-400 underline underline-offset-2" onClick={() => window.electronAPI?.openExternal?.('https://cse.google.com/cse/create/new')}>cse.google.com</span>.
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Company Research Section */}
                                    {profileData?.hasActiveJD && profileData?.activeJD?.company && (
                                        <div className="mt-5">
                                            <div className="bg-bg-item-surface rounded-xl border border-border-subtle p-5">
                                                <div className="flex items-center justify-between mb-4">
                                                    <div className="flex items-center gap-4">
                                                        <div className="w-10 h-10 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center text-purple-500">
                                                            <Building2 size={20} />
                                                        </div>
                                                        <div>
                                                            <h4 className="text-sm font-bold text-text-primary">
                                                                Company Intel: <span className="text-purple-400">{profileData.activeJD.company}</span>
                                                            </h4>
                                                            <p className="text-[11px] text-text-secondary mt-0.5">
                                                                {companyDossier ? 'Research complete' : 'Run research to get hiring strategy, salaries & competitors'}
                                                            </p>
                                                        </div>
                                                    </div>

                                                    <button
                                                        onClick={async () => {
                                                            setCompanyResearching(true);
                                                            try {
                                                                const result = await window.electronAPI?.profileResearchCompany?.(profileData.activeJD.company);
                                                                if (result?.success && result.dossier) {
                                                                    setCompanyDossier(result.dossier);
                                                                }
                                                            } catch (e) {
                                                                console.error('Research failed:', e);
                                                            } finally {
                                                                setCompanyResearching(false);
                                                            }
                                                        }}
                                                        disabled={companyResearching}
                                                        className={`px-4 py-2 rounded-full text-xs font-medium transition-all flex items-center gap-2 ${companyResearching ? 'bg-bg-input text-text-tertiary cursor-wait border border-border-subtle' : 'bg-purple-600/10 text-purple-500 hover:bg-purple-600/20 border border-purple-500/20'}`}
                                                    >
                                                        {companyResearching ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
                                                        {companyResearching ? 'Researching...' : companyDossier ? 'Refresh' : 'Research Now'}
                                                    </button>
                                                </div>

                                                {/* Dossier Results */}
                                                {companyDossier && (
                                                    <div className="space-y-4 border-t border-border-subtle pt-4 mt-2">
                                                        {companyDossier.hiring_strategy && (
                                                            <div>
                                                                <div className="text-[10px] font-bold text-text-primary uppercase tracking-wide mb-1">Hiring Strategy</div>
                                                                <p className="text-xs text-text-secondary leading-relaxed bg-bg-input p-3 rounded-lg">{companyDossier.hiring_strategy}</p>
                                                            </div>
                                                        )}

                                                        {companyDossier.interview_focus && (
                                                            <div>
                                                                <div className="text-[10px] font-bold text-text-primary uppercase tracking-wide mb-1">Interview Focus</div>
                                                                <p className="text-xs text-text-secondary leading-relaxed bg-bg-input p-3 rounded-lg">{companyDossier.interview_focus}</p>
                                                            </div>
                                                        )}

                                                        {companyDossier.salary_estimates?.length > 0 && (
                                                            <div>
                                                                <div className="text-[10px] font-bold text-text-primary uppercase tracking-wide mb-1">Salary Estimates</div>
                                                                <div className="space-y-2 bg-bg-input p-3 rounded-lg">
                                                                    {companyDossier.salary_estimates.map((s: any, i: number) => (
                                                                        <div key={i} className="flex items-center justify-between pb-2 mb-2 border-b border-border-subtle last:border-0 last:pb-0 last:mb-0">
                                                                            <span className="text-xs text-text-primary font-medium">{s.title} <span className="text-text-tertiary">({s.location})</span></span>
                                                                            <div className="flex items-center gap-2">
                                                                                <span className="text-xs font-bold text-green-400">
                                                                                    {s.currency} {s.min?.toLocaleString()} - {s.max?.toLocaleString()}
                                                                                </span>
                                                                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${s.confidence === 'high' ? 'bg-green-500/10 text-green-500 border-green-500/20' : s.confidence === 'medium' ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20' : 'bg-red-500/10 text-red-500 border-red-500/20'}`}>
                                                                                    {s.confidence.toUpperCase()}
                                                                                </span>
                                                                            </div>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        )}

                                                        {companyDossier.competitors?.length > 0 && (
                                                            <div>
                                                                <div className="text-[10px] font-bold text-text-primary uppercase tracking-wide mb-2">Competitors</div>
                                                                <div className="flex flex-wrap gap-2">
                                                                    {companyDossier.competitors.map((c: string, i: number) => (
                                                                        <span key={i} className="text-[11px] text-text-secondary px-2.5 py-1 rounded-full bg-bg-input flex items-center gap-1.5">
                                                                            <Building2 size={10} className="text-text-tertiary" /> {c}
                                                                        </span>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        )}

                                                        {companyDossier.sources?.length > 0 && (
                                                            <div className="text-[10px] text-text-tertiary mt-2">
                                                                Sources: {companyDossier.sources.filter(Boolean).length} references
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                    <ProfileVisualizer profileData={profileData} />


                                </div>
                            )}
                            {activeTab === 'ai-providers' && (
                                <AIProvidersSettings />
                            )}
                            {activeTab === 'keybinds' && (
                                <div className="space-y-5 animated fadeIn select-text pb-4">
                                    <div className="flex items-start justify-between">
                                        <div>
                                            <h3 className="text-lg font-bold text-text-primary mb-1">Keyboard shortcuts</h3>
                                            <p className="text-xs text-text-secondary">Natively works with these easy to remember commands.</p>
                                        </div>
                                        <button
                                            onClick={resetShortcuts}
                                            className="flex items-center gap-2 px-4 py-1.5 rounded-full border border-border-subtle bg-bg-subtle/30 hover:bg-bg-subtle hover:border-green-500/30 transition-all duration-200 text-xs font-medium text-text-secondary hover:text-green-500 active:scale-95 mt-1"
                                        >
                                            <RotateCcw size={13} strokeWidth={2.5} />
                                            Restore Default
                                        </button>
                                    </div>

                                    <div className="grid gap-6">
                                        {/* General Category */}
                                        <div>
                                            <h4 className="text-sm font-bold text-text-primary mb-3">General</h4>
                                            <div className="space-y-1">
                                                <div className="flex items-center justify-between py-1.5 group">
                                                    <div className="flex items-center gap-3">
                                                        <span className="text-text-tertiary group-hover:text-text-primary transition-colors w-5 flex justify-center"><Eye size={14} /></span>
                                                        <div className="flex flex-col">
                                                            <span className="text-sm text-text-secondary font-medium group-hover:text-text-primary transition-colors">Toggle Visibility</span>
                                                            <span className="text-[11px] text-text-tertiary">{globalShortcutAlternates.toggleVisibility}</span>
                                                        </div>
                                                    </div>
                                                    <KeyRecorder
                                                        currentKeys={shortcuts.toggleVisibility}
                                                        onSave={(keys) => updateShortcut('toggleVisibility', keys)}
                                                    />
                                                </div>
                                                <div className="flex items-center justify-between py-1.5 group">
                                                    <div className="flex items-center gap-3">
                                                        <span className="text-text-tertiary group-hover:text-text-primary transition-colors w-5 flex justify-center"><MessageSquare size={14} /></span>
                                                        <span className="text-sm text-text-secondary font-medium group-hover:text-text-primary transition-colors">Process Screenshots</span>
                                                    </div>
                                                    <KeyRecorder
                                                        currentKeys={shortcuts.processScreenshots}
                                                        onSave={(keys) => updateShortcut('processScreenshots', keys)}
                                                    />
                                                </div>
                                                <div className="flex items-center justify-between py-1.5 group">
                                                    <div className="flex items-center gap-3">
                                                        <span className="text-text-tertiary group-hover:text-text-primary transition-colors w-5 flex justify-center"><RotateCcw size={14} /></span>
                                                        <span className="text-sm text-text-secondary font-medium group-hover:text-text-primary transition-colors">Reset / Cancel</span>
                                                    </div>
                                                    <KeyRecorder
                                                        currentKeys={shortcuts.resetCancel}
                                                        onSave={(keys) => updateShortcut('resetCancel', keys)}
                                                    />
                                                </div>
                                                <div className="flex items-center justify-between py-1.5 group">
                                                    <div className="flex items-center gap-3">
                                                        <span className="text-text-tertiary group-hover:text-text-primary transition-colors w-5 flex justify-center"><Camera size={14} /></span>
                                                        <div className="flex flex-col">
                                                            <span className="text-sm text-text-secondary font-medium group-hover:text-text-primary transition-colors">Take Screenshot</span>
                                                            <span className="text-[11px] text-text-tertiary">{globalShortcutAlternates.takeScreenshot}</span>
                                                        </div>
                                                    </div>
                                                    <KeyRecorder
                                                        currentKeys={shortcuts.takeScreenshot}
                                                        onSave={(keys) => updateShortcut('takeScreenshot', keys)}
                                                    />
                                                </div>
                                                <div className="flex items-center justify-between py-1.5 group">
                                                    <div className="flex items-center gap-3">
                                                        <span className="text-text-tertiary group-hover:text-text-primary transition-colors w-5 flex justify-center"><Crop size={14} /></span>
                                                        <div className="flex flex-col">
                                                            <span className="text-sm text-text-secondary font-medium group-hover:text-text-primary transition-colors">Selective Screenshot</span>
                                                            <span className="text-[11px] text-text-tertiary">{globalShortcutAlternates.selectiveScreenshot}</span>
                                                        </div>
                                                    </div>
                                                    <KeyRecorder
                                                        currentKeys={shortcuts.selectiveScreenshot}
                                                        onSave={(keys) => updateShortcut('selectiveScreenshot', keys)}
                                                    />
                                                </div>
                                                <div className="flex items-center justify-between py-1.5 group">
                                                    <div className="flex items-center gap-3">
                                                        <span className="text-text-tertiary group-hover:text-text-primary transition-colors w-5 flex justify-center"><MousePointerClick size={14} /></span>
                                                        <div className="flex flex-col">
                                                            <span className="text-sm text-text-secondary font-medium group-hover:text-text-primary transition-colors">Toggle Clickthrough</span>
                                                            <span className="text-[11px] text-text-tertiary">{globalShortcutAlternates.toggleClickthrough}</span>
                                                        </div>
                                                    </div>
                                                    <div className="px-2.5 py-1 rounded-md border border-border-subtle text-[11px] text-text-tertiary bg-bg-subtle/30">
                                                        Global only
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Chat Category */}
                                        <div>
                                            <div className="mb-3">
                                                <h4 className="text-sm font-bold text-text-primary">Chat</h4>
                                            </div>
                                            <div className="space-y-1">
                                                {[
                                                    { id: 'whatToAnswer', label: 'What to Answer', icon: <Sparkles size={14} /> },
                                                    { id: 'shorten', label: 'Shorten', icon: <Pencil size={14} /> },
                                                    { id: 'followUp', label: 'Follow Up', icon: <MessageSquare size={14} /> },
                                                    { id: 'recap', label: 'Get Recap', icon: <RefreshCw size={14} /> },
                                                    { id: 'answer', label: 'Answer / Record', icon: <Mic size={14} /> },
                                                    { id: 'scrollUp', label: 'Scroll Up', icon: <ArrowUp size={14} /> },
                                                    { id: 'scrollDown', label: 'Scroll Down', icon: <ArrowDown size={14} /> },
                                                ].map((item, i) => (
                                                    <div key={i} className="flex items-center justify-between py-1.5 group">
                                                        <div className="flex items-center gap-3">
                                                            <span className="text-text-tertiary group-hover:text-text-primary transition-colors w-5 flex justify-center">{item.icon}</span>
                                                            <span className="text-sm text-text-secondary font-medium group-hover:text-text-primary transition-colors">{item.label}</span>
                                                        </div>
                                                        <KeyRecorder
                                                            currentKeys={shortcuts[item.id as keyof typeof shortcuts]}
                                                            onSave={(keys) => updateShortcut(item.id as any, keys)}
                                                        />
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Window Category */}
                                        <div>
                                            <h4 className="text-sm font-bold text-text-primary mb-3">Window</h4>
                                            <div className="space-y-1">
                                                    {[
                                                    { id: 'moveWindowUp', label: 'Move Window Up', icon: <ArrowUp size={14} /> },
                                                    { id: 'moveWindowDown', label: 'Move Window Down', icon: <ArrowDown size={14} /> },
                                                    { id: 'moveWindowLeft', label: 'Move Window Left', icon: <ArrowLeft size={14} /> },
                                                    { id: 'moveWindowRight', label: 'Move Window Right', icon: <ArrowRight size={14} /> }
                                                ].map((item, i) => (
                                                    <div key={i} className="flex items-center justify-between py-1.5 group">
                                                        <div className="flex items-center gap-3">
                                                            <span className="text-text-tertiary group-hover:text-text-primary transition-colors w-5 flex justify-center">{item.icon}</span>
                                                            <span className="text-sm text-text-secondary font-medium group-hover:text-text-primary transition-colors">{item.label}</span>
                                                        </div>
                                                        <KeyRecorder
                                                            currentKeys={shortcuts[item.id as keyof typeof shortcuts]}
                                                            onSave={(keys) => updateShortcut(item.id as any, keys)}
                                                        />
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === 'audio' && (
                                <div className="space-y-6 animated fadeIn">
                                    <SpeechProviderSection
                                        sttProvider={sttProvider}
                                        ProviderSelect={ProviderSelect}
                                        googleServiceAccountPath={googleServiceAccountPath}
                                        hasStoredSttGroqKey={hasStoredSttGroqKey}
                                        hasStoredSttOpenaiKey={hasStoredSttOpenaiKey}
                                        hasStoredDeepgramKey={hasStoredDeepgramKey}
                                        hasStoredElevenLabsKey={hasStoredElevenLabsKey}
                                        hasStoredAzureKey={hasStoredAzureKey}
                                        hasStoredIbmWatsonKey={hasStoredIbmWatsonKey}
                                        hasStoredSonioxKey={hasStoredSonioxKey}
                                        groqSttModel={groqSttModel}
                                        setGroqSttModel={setGroqSttModel}
                                        handleGoogleServiceAccountSelected={handleGoogleServiceAccountSelected}
                                        sttGroqKey={sttGroqKey}
                                        sttOpenaiKey={sttOpenaiKey}
                                        sttDeepgramKey={sttDeepgramKey}
                                        sttElevenLabsKey={sttElevenLabsKey}
                                        sttAzureKey={sttAzureKey}
                                        sttIbmKey={sttIbmKey}
                                        sttSonioxKey={sttSonioxKey}
                                        setSttGroqKey={setSttGroqKey}
                                        setSttOpenaiKey={setSttOpenaiKey}
                                        setSttDeepgramKey={setSttDeepgramKey}
                                        setSttElevenLabsKey={setSttElevenLabsKey}
                                        setSttAzureKey={setSttAzureKey}
                                        setSttIbmKey={setSttIbmKey}
                                        setSttSonioxKey={setSttSonioxKey}
                                        sttSaving={sttSaving}
                                        sttSaved={sttSaved}
                                        handleRemoveSttKey={handleRemoveSttKey}
                                        sttAzureRegion={sttAzureRegion}
                                        setSttAzureRegion={setSttAzureRegion}
                                        sttTestStatus={sttTestStatus}
                                        sttTestError={sttTestError}
                                        recognitionLanguage={recognitionLanguage}
                                        selectedSttGroup={selectedSttGroup}
                                        languageGroups={languageGroups}
                                        currentGroupVariants={currentGroupVariants}
                                        CustomSelect={CustomSelect}
                                        handleSttProviderChange={handleSttProviderChange}
                                        handleSttKeySubmit={handleSttKeySubmit}
                                        handleTestSttConnection={handleTestSttConnection}
                                        handleGroupChange={handleGroupChange}
                                        handleLanguageChange={handleLanguageChange}
                                    />

                                    <div className="h-px bg-border-subtle" />

                                    <AudioConfigSection
                                        CustomSelect={CustomSelect}
                                        inputDevices={inputDevices}
                                        outputDevices={outputDevices}
                                        selectedInput={selectedInput}
                                        selectedOutput={selectedOutput}
                                        onInputChange={(id) => {
                                            setSelectedInput(id);
                                            localStorage.setItem('preferredInputDeviceId', id);
                                        }}
                                        onOutputChange={(id) => {
                                            setSelectedOutput(id);
                                            localStorage.setItem('preferredOutputDeviceId', id);
                                        }}
                                        micLevelBarRef={micLevelBarRef}
                                        selectedOutputSupportsSink={Boolean(selectedOutput)}
                                        onTestSound={handleTestSound}
                                        useExperimentalSck={useExperimentalSck}
                                        onToggleExperimentalSck={() => {
                                            const newState = !useExperimentalSck;
                                            setUseExperimentalSck(newState);
                                            window.localStorage.setItem('useExperimentalSckBackend', newState ? 'true' : 'false');
                                        }}
                                    />
                                </div>
                            )}


                            {activeTab === 'calendar' && (
                                <CalendarSettingsSection
                                    calendarStatus={calendarStatus}
                                    isCalendarsLoading={isCalendarsLoading}
                                    setIsCalendarsLoading={setIsCalendarsLoading}
                                    setCalendarStatus={setCalendarStatus}
                                />
                            )}

                            {activeTab === 'about' && (
                                <AboutSection setActiveTab={setActiveTab} />
                            )}
                        </div>
                    </div>
                    </motion.div>
                </motion.div>
            )
            }


            {/* ------------------------------------------------------------------ */}
            {/* Live Preview — mockup sits below the z-50 modal                    */}
            {/* ------------------------------------------------------------------ */}
            {/* ------------------------------------------------------------------ */}
            {/* Live Preview — mockup sits below the z-50 modal                    */}
            {/* ALWAYS MOUNTED to prevent React AnimatePresence lag spikes         */}
            {/* ------------------------------------------------------------------ */}
            <div
                id="settings-mockup-wrapper"
                className="fixed inset-0 z-[49] pointer-events-none transition-opacity duration-150"
                style={{ opacity: isPreviewingOpacity ? 1 : 0 }}
            >
                <MockupNativelyInterface opacity={overlayOpacity} />
            </div>
        </AnimatePresence >
    );
};

export default SettingsOverlay;
