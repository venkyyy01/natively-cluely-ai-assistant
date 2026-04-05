import React, { useState, useEffect, useRef, useLayoutEffect, useCallback, useMemo } from 'react';
import {
    Sparkles,
    Pencil,
    MessageSquare,
    RefreshCw,
    Settings,
    ArrowUp,
    ArrowRight,
    HelpCircle,
    ChevronUp,
    ChevronDown,

    CornerDownLeft,
    Mic,
    MicOff,
    Image,
    Camera,
    X,
    LogOut,
    Zap,
    Edit3,
    SlidersHorizontal,
    Ghost,
    Link,
    Code,
    Copy,
    Check
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
// import { ModelSelector } from './ui/ModelSelector'; // REMOVED
import TopPill from './ui/TopPill';
import RollingTranscript from './ui/RollingTranscript';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { getElectronAPI } from '../lib/electronApi';
import { analytics, detectProviderType } from '../lib/analytics/analytics.service';
import { useShortcuts } from '../hooks/useShortcuts';
import { useHumanSpeedAutoScroll } from '../hooks/useHumanSpeedAutoScroll';
import {
    classifyAssistRender,
    ConsciousModeAnswer,
    parseConsciousModeAnswer,
} from '../lib/consciousMode';
import {
    classifyConsciousModeQuestion,
    createEmptyConsciousModeResponse,
    type ReasoningThread,
} from '../../electron/ConsciousMode';

interface Message {
    id: string;
    role: 'user' | 'system' | 'interviewer';
    text: string;
    createdAt: number;
    isStreaming?: boolean;
    hasScreenshot?: boolean;
    screenshotPreview?: string;
    isCode?: boolean;
    intent?: string;
}

const MAX_ROLLING_TRANSCRIPT_CHARS = 1200;
const MIN_OVERLAY_WIDTH = 420;
const MAX_OVERLAY_WIDTH = 960;
const MIN_CHAT_HEIGHT = 260;
const MAX_CHAT_HEIGHT = 760;
type ResizeDirection = 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

function appendRollingTranscript(existing: string, nextSegment: string): string {
    const addition = nextSegment.trim();
    if (!addition) return existing;

    const combined = existing ? `${existing}  ·  ${addition}` : addition;
    if (combined.length <= MAX_ROLLING_TRANSCRIPT_CHARS) {
        return combined;
    }

    return combined.slice(combined.length - MAX_ROLLING_TRANSCRIPT_CHARS);
}

function createMessage(message: Omit<Message, 'createdAt'>): Message {
    return {
        ...message,
        createdAt: Date.now(),
    };
}

function prependMessage(prev: Message[], message: Omit<Message, 'createdAt'>): Message[] {
    return [createMessage(message), ...prev];
}

function updateTopMessage(
    prev: Message[],
    predicate: (message: Message) => boolean,
    updater: (message: Message) => Message
): Message[] {
    const [latestMessage, ...rest] = prev;
    if (!latestMessage || !predicate(latestMessage)) {
        return prev;
    }

    return [updater(latestMessage), ...rest];
}

function prependOrUpdateTopMessage(
    prev: Message[],
    predicate: (message: Message) => boolean,
    updater: (message: Message) => Message,
    fallbackMessage: Omit<Message, 'createdAt'>
): Message[] {
    const updatedMessages = updateTopMessage(prev, predicate, updater);
    if (updatedMessages !== prev) {
        return updatedMessages;
    }

    return prependMessage(prev, fallbackMessage);
}

function replaceTopStreamingPlaceholder(prev: Message[], message: Omit<Message, 'createdAt'>): Message[] {
    const [latestMessage, ...rest] = prev;
    if (latestMessage && latestMessage.isStreaming && latestMessage.text === '') {
        return [createMessage(message), ...rest];
    }

    return prependMessage(prev, message);
}

interface NativelyInterfaceProps {
    onEndMeeting?: () => void;
}

const NativelyInterface: React.FC<NativelyInterfaceProps> = ({ onEndMeeting }) => {
    const electronAPI = useMemo(() => getElectronAPI(), []);
    const [isExpanded, setIsExpanded] = useState(true);
    const [inputValue, setInputValue] = useState('');
    const { shortcuts, isShortcutPressed } = useShortcuts();
    const [messages, setMessages] = useState<Message[]>([]);
    const [isConnected, setIsConnected] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [conversationContext, setConversationContext] = useState<string>('');
    const [isManualRecording, setIsManualRecording] = useState(false);
    const isRecordingRef = useRef(false);  // Ref to track recording state (avoids stale closure)
    const [manualTranscript, setManualTranscript] = useState('');
    const manualTranscriptRef = useRef<string>('');
    const [showTranscript, setShowTranscript] = useState(() => {
        const stored = localStorage.getItem('natively_interviewer_transcript');
        return stored !== 'false';
    });

    // Analytics State
    const requestStartTimeRef = useRef<number | null>(null);

    // Sync transcript setting
    useEffect(() => {
        const handleStorage = () => {
            const stored = localStorage.getItem('natively_interviewer_transcript');
            setShowTranscript(stored !== 'false');
        };
        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, []);

    const [rollingTranscript, setRollingTranscript] = useState('');  // For interviewer rolling text bar
    const [isInterviewerSpeaking, setIsInterviewerSpeaking] = useState(false);  // Track if actively speaking
    const rollingTranscriptCommittedRef = useRef('');
    const [voiceInput, setVoiceInput] = useState('');  // Accumulated user voice input
    const voiceInputRef = useRef<string>('');  // Ref for capturing in async handlers
    const textInputRef = useRef<HTMLInputElement>(null); // Ref for input focus

    const contentRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const activeConsciousThreadRef = useRef<ReasoningThread | null>(null);
    // const settingsButtonRef = useRef<HTMLButtonElement>(null);

    // Latent Context State (Screenshots attached but not sent)
    const [attachedContext, setAttachedContext] = useState<Array<{ path: string, preview: string }>>([]);

    // Settings State with Persistence
    const [isUndetectable, setIsUndetectable] = useState(false);
    const [panelWidth, setPanelWidth] = useState(() => {
        const stored = localStorage.getItem('natively_overlay_width');
        const parsed = stored ? Number(stored) : 600;
        return Number.isFinite(parsed) ? Math.min(MAX_OVERLAY_WIDTH, Math.max(MIN_OVERLAY_WIDTH, parsed)) : 600;
    });
    const [chatViewportHeight, setChatViewportHeight] = useState(() => {
        const stored = localStorage.getItem('natively_overlay_chat_height');
        const parsed = stored ? Number(stored) : 450;
        return Number.isFinite(parsed) ? Math.min(MAX_CHAT_HEIGHT, Math.max(MIN_CHAT_HEIGHT, parsed)) : 450;
    });
    const [isResizing, setIsResizing] = useState(false);
    const [hideChatHidesWidget, setHideChatHidesWidget] = useState(() => {
        const stored = localStorage.getItem('natively_hideChatHidesWidget');
        return stored ? stored === 'true' : true;
    });
    const resizeStartRef = useRef<{ x: number; y: number; width: number; height: number; direction: ResizeDirection; windowX: number; windowY: number } | null>(null);

    // Model Selection State
    const [currentModel, setCurrentModel] = useState<string>('gemini-3-flash-preview');
    const [modelFallbackNotice, setModelFallbackNotice] = useState<string>('');

    useEffect(() => {
        // Load the persisted default model (not the runtime model)
        // Each new meeting starts with the default from settings
        if (window.electronAPI?.getDefaultModel) {
            window.electronAPI.getDefaultModel()
                .then((result: any) => {
                    if (result && result.model) {
                        setCurrentModel(result.model);
                        // Also set the runtime model to the default
                        window.electronAPI.setModel(result.model).catch(() => { });
                    }
                })
                .catch((err: any) => console.error("Failed to fetch default model:", err));
        }
    }, []);

    const handleModelSelect = (modelId: string) => {
        setCurrentModel(modelId);
        // Session-only: update runtime but don't persist as default
        window.electronAPI.setModel(modelId)
            .catch((err: any) => console.error("Failed to set model:", err));
    };

    // Listen for default model changes from Settings
    useEffect(() => {
        if (!window.electronAPI?.onModelChanged) return;
        const unsubscribe = window.electronAPI.onModelChanged((modelId: string) => {
            setCurrentModel(prev => prev === modelId ? prev : modelId);
        });
        return () => unsubscribe();
    }, []);

    useEffect(() => {
        if (!window.electronAPI?.onModelFallback) return;
        const unsubscribe = window.electronAPI.onModelFallback(({ previousModel, fallbackModel }) => {
            setCurrentModel(fallbackModel);
            setModelFallbackNotice(`Selected model unavailable. Switched from ${previousModel} to ${fallbackModel}.`);
        });
        return () => unsubscribe();
    }, []);

    useEffect(() => {
        if (!modelFallbackNotice) return;
        const timer = setTimeout(() => setModelFallbackNotice(''), 6000);
        return () => clearTimeout(timer);
    }, [modelFallbackNotice]);

    // Global State Sync
    useEffect(() => {
        // Fetch initial state
        if (window.electronAPI?.getUndetectable) {
            window.electronAPI.getUndetectable().then(setIsUndetectable);
        }

        if (window.electronAPI?.onUndetectableChanged) {
            const unsubscribe = window.electronAPI.onUndetectableChanged((state) => {
                setIsUndetectable(state);
            });
            return () => unsubscribe();
        }
    }, []);

    // Persist Settings
    useEffect(() => {
        localStorage.setItem('natively_undetectable', String(isUndetectable));
        localStorage.setItem('natively_hideChatHidesWidget', String(hideChatHidesWidget));
    }, [isUndetectable, hideChatHidesWidget]);

    // Auto-resize Window
    useLayoutEffect(() => {
        if (!contentRef.current) return;

        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                // Use getBoundingClientRect to get the exact rendered size including padding
                const rect = entry.target.getBoundingClientRect();

                // Send exact dimensions to Electron
                // Removed buffer to ensure tight fit
                console.log('[NativelyInterface] ResizeObserver:', Math.ceil(rect.width), Math.ceil(rect.height));
                window.electronAPI?.updateContentDimensions({
                    width: Math.ceil(rect.width),
                    height: Math.ceil(rect.height)
                });
            }
        });

        observer.observe(contentRef.current);
        return () => observer.disconnect();
    }, []);

    // Force resize when attachedContext changes (screenshots added/removed)
    useEffect(() => {
        if (!contentRef.current) return;
        // Let the DOM settle, then measure and push new dimensions
        requestAnimationFrame(() => {
            if (!contentRef.current) return;
            const rect = contentRef.current.getBoundingClientRect();
            window.electronAPI?.updateContentDimensions({
                width: Math.ceil(rect.width),
                height: Math.ceil(rect.height)
            });
        });
    }, [attachedContext]);

    // Force initial sizing safety check
    useEffect(() => {
        const timer = setTimeout(() => {
            if (contentRef.current) {
                const rect = contentRef.current.getBoundingClientRect();
                window.electronAPI?.updateContentDimensions({
                    width: Math.ceil(rect.width),
                    height: Math.ceil(rect.height)
                });
            }
        }, 600);
        return () => clearTimeout(timer);
    }, []);

    const latestReadableMessage = messages.find(msg => msg.role === 'system') || null;

    useHumanSpeedAutoScroll({
        enabled: isExpanded,
        containerRef: scrollContainerRef,
        latestMessage: latestReadableMessage ? {
            id: latestReadableMessage.id,
            role: latestReadableMessage.role,
            content: latestReadableMessage.text,
            isStreaming: latestReadableMessage.isStreaming,
        } : null,
        eligibleRoles: ['system'],
    });

    // Build conversation context from messages
    useEffect(() => {
        const context = messages
            .filter(m => m.role !== 'user' || !m.hasScreenshot)
            .map(m => `${m.role === 'interviewer' ? 'Interviewer' : m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
            .slice(-20)
            .join('\n');
        setConversationContext(context);
    }, [messages]);

    // Listen for settings window visibility changes
    useEffect(() => {
        if (!electronAPI.onSettingsVisibilityChange) return;
        const unsubscribe = electronAPI.onSettingsVisibilityChange((isVisible: boolean) => {
            setIsSettingsOpen(isVisible);
        });
        return () => unsubscribe();
    }, [electronAPI]);

    // Sync Window Visibility with Expanded State
    useEffect(() => {
        if (isExpanded) {
            electronAPI.showWindow();
        } else {
            // Slight delay to allow animation to clean up if needed, though immediate is safer for click-through
            // Using setTimeout to ensure the render cycle completes first
            // Increased to 400ms to allow "contract to bottom" exit animation to finish
            setTimeout(() => electronAPI.hideWindow(), 400);
        }
    }, [electronAPI, isExpanded]);

    // Keyboard shortcut to toggle expanded state (via Main Process)
    useEffect(() => {
        if (!window.electronAPI?.onToggleExpand) return;
        const unsubscribe = window.electronAPI.onToggleExpand(() => {
            setIsExpanded(prev => !prev);
        });
        return () => unsubscribe();
    }, []);

    // Session Reset Listener - Clears UI when a NEW meeting starts
    useEffect(() => {
        if (!window.electronAPI?.onSessionReset) return;
        const unsubscribe = window.electronAPI.onSessionReset(() => {
            console.log('[NativelyInterface] Resetting session state...');
            setMessages([]);
            setInputValue('');
            setAttachedContext([]);
            setManualTranscript('');
            setVoiceInput('');
            voiceInputRef.current = '';
            manualTranscriptRef.current = '';
            rollingTranscriptCommittedRef.current = '';
            setRollingTranscript('');
            setIsInterviewerSpeaking(false);
            setIsProcessing(false);
            activeConsciousThreadRef.current = null;
            // Optionally reset connection status if needed, but connection persists

            // Track new conversation/session if applicable?
            // Actually 'app_opened' is global, 'assistant_started' is overlay.
            // Maybe 'conversation_started' event?
            analytics.trackConversationStarted();
        });
        return () => unsubscribe();
    }, []);


    const handleScreenshotAttach = (data: { path: string; preview: string }) => {
        setIsExpanded(true);
        setAttachedContext(prev => {
            // Prevent duplicates and cap at 5
            if (prev.some(s => s.path === data.path)) return prev;
            const updated = [...prev, data];
            return updated.slice(-5); // Keep last 5
        });
    };

    useEffect(() => {
        localStorage.setItem('natively_overlay_width', String(panelWidth));
        localStorage.setItem('natively_overlay_chat_height', String(chatViewportHeight));
    }, [panelWidth, chatViewportHeight]);

    useEffect(() => {
        const handlePointerMove = (event: MouseEvent) => {
            if (!resizeStartRef.current) return;
            const deltaX = event.clientX - resizeStartRef.current.x;
            const deltaY = event.clientY - resizeStartRef.current.y;
            const { direction, width, height, windowX, windowY } = resizeStartRef.current;

            const affectsLeft = direction === 'left' || direction === 'top-left' || direction === 'bottom-left';
            const affectsRight = direction === 'right' || direction === 'top-right' || direction === 'bottom-right';
            const affectsTop = direction === 'top' || direction === 'top-left' || direction === 'top-right';
            const affectsBottom = direction === 'bottom' || direction === 'bottom-left' || direction === 'bottom-right';

            let nextWidth = width;
            let nextHeight = height;
            let nextX = windowX;
            let nextY = windowY;

            if (affectsRight) {
                nextWidth = Math.min(MAX_OVERLAY_WIDTH, Math.max(MIN_OVERLAY_WIDTH, width + deltaX));
            }

            if (affectsLeft) {
                nextWidth = Math.min(MAX_OVERLAY_WIDTH, Math.max(MIN_OVERLAY_WIDTH, width - deltaX));
                nextX = windowX + (width - nextWidth);
            }

            if (affectsBottom) {
                nextHeight = Math.min(MAX_CHAT_HEIGHT, Math.max(MIN_CHAT_HEIGHT, height + deltaY));
            }

            if (affectsTop) {
                nextHeight = Math.min(MAX_CHAT_HEIGHT, Math.max(MIN_CHAT_HEIGHT, height - deltaY));
                nextY = windowY + (height - nextHeight);
            }

            setPanelWidth(nextWidth);
            setChatViewportHeight(nextHeight);
            window.electronAPI?.setOverlayBounds({ width: nextWidth, height: nextHeight, x: nextX, y: nextY }).catch(() => { });
        };

        const stopResize = () => {
            resizeStartRef.current = null;
            setIsResizing(false);
        };

        window.addEventListener('mousemove', handlePointerMove);
        window.addEventListener('mouseup', stopResize);
        return () => {
            window.removeEventListener('mousemove', handlePointerMove);
            window.removeEventListener('mouseup', stopResize);
        };
    }, []);

    const handleResizeStart = (direction: ResizeDirection) => (event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        resizeStartRef.current = {
            x: event.clientX,
            y: event.clientY,
            width: panelWidth,
            height: chatViewportHeight,
            direction,
            windowX: window.screenX,
            windowY: window.screenY
        };
        setIsExpanded(true);
        setIsResizing(true);
    };

    // Connect to Native Audio Backend
    useEffect(() => {
        const cleanups: (() => void)[] = [];

        // Connection Status
        window.electronAPI.getNativeAudioStatus().then((status) => {
            setIsConnected(status.connected);
        }).catch(() => setIsConnected(false));

        cleanups.push(window.electronAPI.onNativeAudioConnected(() => {
            setIsConnected(true);
        }));
        cleanups.push(window.electronAPI.onNativeAudioDisconnected(() => {
            setIsConnected(false);
        }));

        // Real-time Transcripts
        cleanups.push(window.electronAPI.onNativeAudioTranscript((transcript) => {
            // When Answer button is active, capture USER transcripts for voice input
            // Use ref to avoid stale closure issue
            if (isRecordingRef.current && transcript.speaker === 'user') {
                if (transcript.final) {
                    // Accumulate final transcripts
                    setVoiceInput(prev => {
                        const updated = prev + (prev ? ' ' : '') + transcript.text;
                        voiceInputRef.current = updated;
                        return updated;
                    });
                    setManualTranscript('');  // Clear partial preview
                    manualTranscriptRef.current = '';
                } else {
                    // Show live partial transcript
                    setManualTranscript(transcript.text);
                    manualTranscriptRef.current = transcript.text;
                }
                return;  // Don't add to messages while recording
            }

            // Ignore user mic transcripts when not recording
            // Only interviewer (system audio) transcripts should appear in chat
            if (transcript.speaker === 'user') {
                return;  // Skip user mic input - only relevant when Answer button is active
            }

            // Only show interviewer (system audio) transcripts in rolling bar
            if (transcript.speaker !== 'interviewer') {
                return;  // Safety check for any other speaker types
            }

            // Route to rolling transcript bar - accumulate text continuously
            setIsInterviewerSpeaking(!transcript.final);

            if (transcript.final) {
                // Append finalized text to accumulated transcript
                const committed = appendRollingTranscript(rollingTranscriptCommittedRef.current, transcript.text);
                rollingTranscriptCommittedRef.current = committed;
                setRollingTranscript(committed);

                // Clear speaking indicator after pause
                setTimeout(() => {
                    setIsInterviewerSpeaking(false);
                }, 3000);
            } else {
                // For partial transcripts, show the active utterance without mutating finalized history
                const committed = rollingTranscriptCommittedRef.current;
                setRollingTranscript(committed ? `${committed}  ·  ${transcript.text}` : transcript.text);
            }
        }));

        // AI Suggestions from native audio (legacy)
        cleanups.push(window.electronAPI.onSuggestionProcessingStart(() => {
            setIsProcessing(true);
            setIsExpanded(true);
        }));

        cleanups.push(window.electronAPI.onSuggestionGenerated((data) => {
            setIsProcessing(false);
            setMessages(prev => prependMessage(prev, {
                id: Date.now().toString(),
                role: 'system',
                text: data.suggestion
            }));
        }));

        cleanups.push(window.electronAPI.onSuggestionError((err) => {
            setIsProcessing(false);
            setMessages(prev => prependMessage(prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err.error}`
            }));
        }));



        cleanups.push(window.electronAPI.onIntelligenceSuggestedAnswerToken((data) => {
            setMessages(prev => prependOrUpdateTopMessage(
                prev,
                message => Boolean(message.isStreaming && message.intent === 'what_to_answer'),
                message => ({
                    ...message,
                    text: message.text + data.token
                }),
                {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.token,
                    intent: 'what_to_answer',
                    isStreaming: true
                }
            ));
        }));

        cleanups.push(window.electronAPI.onIntelligenceSuggestedAnswer((data) => {
            setIsProcessing(false);
            const threadRoute = classifyConsciousModeQuestion(data.question, activeConsciousThreadRef.current);
            const assistRender = classifyAssistRender({
                answerText: data.answer,
                threadAction: threadRoute.threadAction,
            });

            analytics.trackInterviewAssistRendered({
                ...assistRender,
                source_intent: 'what_to_answer',
            });

            if (assistRender.output_variant === 'conscious_mode') {
                const currentThread = activeConsciousThreadRef.current;
                const continuesThread = Boolean(threadRoute.threadAction === 'continue' && currentThread);

                activeConsciousThreadRef.current = {
                    rootQuestion: continuesThread && currentThread ? currentThread.rootQuestion : data.question,
                    lastQuestion: data.question,
                    response: createEmptyConsciousModeResponse(),
                    followUpCount: continuesThread && currentThread ? currentThread.followUpCount + 1 : 0,
                    updatedAt: Date.now(),
                };
            } else {
                activeConsciousThreadRef.current = null;
            }

            setMessages(prev => prependOrUpdateTopMessage(
                prev,
                message => Boolean(message.isStreaming && message.intent === 'what_to_answer'),
                message => ({
                    ...message,
                    text: data.answer,
                    isStreaming: false
                }),
                {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.answer,
                    intent: 'what_to_answer'
                }
            ));
        }));

        // STREAMING: Refinement
        cleanups.push(window.electronAPI.onIntelligenceRefinedAnswerToken((data) => {
            setMessages(prev => prependOrUpdateTopMessage(
                prev,
                message => Boolean(message.isStreaming && message.intent === data.intent),
                message => ({
                    ...message,
                    text: message.text + data.token
                }),
                {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.token,
                    intent: data.intent,
                    isStreaming: true
                }
            ));
        }));

        cleanups.push(window.electronAPI.onIntelligenceRefinedAnswer((data) => {
            setIsProcessing(false);
            setMessages(prev => prependOrUpdateTopMessage(
                prev,
                message => Boolean(message.isStreaming && message.intent === data.intent),
                message => ({
                    ...message,
                    text: data.answer,
                    isStreaming: false
                }),
                {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.answer,
                    intent: data.intent
                }
            ));
        }));

        // STREAMING: Recap
        cleanups.push(window.electronAPI.onIntelligenceRecapToken((data) => {
            setMessages(prev => prependOrUpdateTopMessage(
                prev,
                message => Boolean(message.isStreaming && message.intent === 'recap'),
                message => ({
                    ...message,
                    text: message.text + data.token
                }),
                {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.token,
                    intent: 'recap',
                    isStreaming: true
                }
            ));
        }));

        cleanups.push(window.electronAPI.onIntelligenceRecap((data) => {
            setIsProcessing(false);
            setMessages(prev => prependOrUpdateTopMessage(
                prev,
                message => Boolean(message.isStreaming && message.intent === 'recap'),
                message => ({
                    ...message,
                    text: data.summary,
                    isStreaming: false
                }),
                {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.summary,
                    intent: 'recap'
                }
            ));
        }));

        // STREAMING: Follow-Up Questions (Rendered as message? Or specific UI?)
        // Currently interface typically renders follow-up Qs as a message or button update.
        // Let's assume message for now based on existing 'follow_up_questions_update' handling
        // But wait, existing handle just sets state?
        // Let's check how 'follow_up_questions_update' was handled.
        // It was handled separate locally in this component maybe?
        // Ah, I need to see the existing listener for 'onIntelligenceFollowUpQuestionsUpdate'

        // Let's implemented token streaming for it anyway, likely it updates a message bubble 
        // OR it might update a specialized "Suggested Questions" area.
        // Assuming it's a message for consistency with "Copilot" approach.

        cleanups.push(window.electronAPI.onIntelligenceFollowUpQuestionsToken((data) => {
            setMessages(prev => prependOrUpdateTopMessage(
                prev,
                message => Boolean(message.isStreaming && message.intent === 'follow_up_questions'),
                message => ({
                    ...message,
                    text: message.text + data.token
                }),
                {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.token,
                    intent: 'follow_up_questions',
                    isStreaming: true
                }
            ));
        }));

        cleanups.push(window.electronAPI.onIntelligenceFollowUpQuestionsUpdate((data) => {
            // This event name is slightly different ('update' vs 'answer')
            setIsProcessing(false);
            setMessages(prev => prependOrUpdateTopMessage(
                prev,
                message => Boolean(message.isStreaming && message.intent === 'follow_up_questions'),
                message => ({
                    ...message,
                    text: data.questions,
                    isStreaming: false
                }),
                {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.questions,
                    intent: 'follow_up_questions'
                }
            ));
        }));

        cleanups.push(window.electronAPI.onIntelligenceManualResult((data) => {
            setIsProcessing(false);
            setMessages(prev => prependMessage(prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `🎯 **Answer:**\n\n${data.answer}`
            }));
        }));

        cleanups.push(window.electronAPI.onIntelligenceError((data) => {
            setIsProcessing(false);
            setMessages(prev => prependMessage(prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `❌ Error (${data.mode}): ${data.error}`
            }));
        }));
        // Screenshot taken - attach to chat input instead of auto-analyzing
        cleanups.push(electronAPI.onScreenshotTaken(handleScreenshotAttach));

        // Selective Screenshot (Latent Context)
        if (electronAPI.onScreenshotAttached) {
            cleanups.push(electronAPI.onScreenshotAttached(handleScreenshotAttach));
        }

        return () => cleanups.forEach(fn => fn());
    }, [electronAPI]);

    // Quick Actions - Updated to use new Intelligence APIs

    const handleCopy = useCallback((text: string) => {
        navigator.clipboard.writeText(text);
        analytics.trackCopyAnswer();
        // Optional: Trigger a small toast or state change for visual feedback
    }, [analytics]);

    const handleWhatToSay = useCallback(async () => {
        setIsExpanded(true);
        setIsProcessing(true);
        analytics.trackCommandExecuted('what_to_say');

        // Capture and clear attached image context
        const currentAttachments = attachedContext;
        if (currentAttachments.length > 0) {
            setAttachedContext([]);
            // Show the attached image in chat
            setMessages(prev => prependMessage(prev, {
                id: Date.now().toString(),
                role: 'user',
                text: 'What should I say about this?',
                hasScreenshot: true,
                screenshotPreview: currentAttachments[0].preview
            }));
        }

        setMessages(prev => prependMessage(prev, {
            id: Date.now().toString(),
            role: 'system',
            text: '',
            intent: 'what_to_answer',
            isStreaming: true
        }));

        try {
            // Pass imagePath if attached
            await window.electronAPI.generateWhatToSay(undefined, currentAttachments.length > 0 ? currentAttachments.map(s => s.path) : undefined);
        } catch (err) {
            setMessages(prev => replaceTopStreamingPlaceholder(prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err}`,
                intent: 'what_to_answer'
            }));
        } finally {
            setIsProcessing(false);
        }
    }, [attachedContext, setIsExpanded, setIsProcessing, setMessages, setAttachedContext, analytics]);

    const handleFollowUp = useCallback(async (intent: string = 'rephrase') => {
        setIsExpanded(true);
        setIsProcessing(true);
        analytics.trackCommandExecuted('follow_up_' + intent);

        setMessages(prev => prependMessage(prev, {
            id: Date.now().toString(),
            role: 'system',
            text: '',
            intent,
            isStreaming: true
        }));

        try {
            await window.electronAPI.generateFollowUp(intent);
        } catch (err) {
            setMessages(prev => replaceTopStreamingPlaceholder(prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err}`,
                intent
            }));
        } finally {
            setIsProcessing(false);
        }
    }, [setIsExpanded, setIsProcessing, setMessages, analytics]);

    const handleRecap = useCallback(async () => {
        setIsExpanded(true);
        setIsProcessing(true);
        analytics.trackCommandExecuted('recap');

        setMessages(prev => prependMessage(prev, {
            id: Date.now().toString(),
            role: 'system',
            text: '',
            intent: 'recap',
            isStreaming: true
        }));

        try {
            await window.electronAPI.generateRecap();
        } catch (err) {
            setMessages(prev => replaceTopStreamingPlaceholder(prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err}`,
                intent: 'recap'
            }));
        } finally {
            setIsProcessing(false);
        }
    }, [setIsExpanded, setIsProcessing, setMessages, analytics]);

    const handleFollowUpQuestions = useCallback(async () => {
        setIsExpanded(true);
        setIsProcessing(true);
        analytics.trackCommandExecuted('suggest_questions');

        setMessages(prev => prependMessage(prev, {
            id: Date.now().toString(),
            role: 'system',
            text: '',
            intent: 'follow_up_questions',
            isStreaming: true
        }));

        try {
            await window.electronAPI.generateFollowUpQuestions();
        } catch (err) {
            setMessages(prev => replaceTopStreamingPlaceholder(prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err}`,
                intent: 'follow_up_questions'
            }));
        } finally {
            setIsProcessing(false);
        }
    }, [setIsExpanded, setIsProcessing, setMessages, analytics]);


    // Setup Streaming Listeners
    useEffect(() => {
        const cleanups: (() => void)[] = [];

        // Stream Token
        cleanups.push(window.electronAPI.onGeminiStreamToken((token) => {
            setMessages(prev => updateTopMessage(
                prev,
                message => Boolean(message.isStreaming && message.role === 'system'),
                message => ({
                    ...message,
                    text: message.text + token,
                    isCode: (message.text + token).includes('```') || (message.text + token).includes('def ') || (message.text + token).includes('function ')
                })
            ));
        }));

        // Stream Done
        cleanups.push(window.electronAPI.onGeminiStreamDone(() => {
            setIsProcessing(false);

            // Calculate latency if we have a start time
            let latency = 0;
            if (requestStartTimeRef.current) {
                latency = Date.now() - requestStartTimeRef.current;
                requestStartTimeRef.current = null;
            }

            // Track Usage
            analytics.trackModelUsed({
                model_name: currentModel,
                provider_type: detectProviderType(currentModel),
                latency_ms: latency
            });

            setMessages(prev => updateTopMessage(
                prev,
                message => Boolean(message.isStreaming),
                message => ({
                    ...message,
                    isStreaming: false
                })
            ));
        }));

        // Stream Error
        cleanups.push(window.electronAPI.onGeminiStreamError((error) => {
            setIsProcessing(false);
            requestStartTimeRef.current = null; // Clear timer on error
            setMessages(prev => prependOrUpdateTopMessage(
                prev,
                message => Boolean(message.isStreaming),
                message => ({
                    ...message,
                    isStreaming: false,
                    text: message.text + `\n\n[Error: ${error}]`
                }),
                {
                    id: Date.now().toString(),
                    role: 'system',
                    text: `❌ Error: ${error}`
                }
            ));
        }));

        // JIT RAG Stream listeners (for live meeting RAG responses)
        if (window.electronAPI.onRAGStreamChunk) {
            cleanups.push(window.electronAPI.onRAGStreamChunk((data: { chunk: string }) => {
                setMessages(prev => updateTopMessage(
                    prev,
                    message => Boolean(message.isStreaming && message.role === 'system'),
                    message => ({
                        ...message,
                        text: message.text + data.chunk,
                        isCode: (message.text + data.chunk).includes('```')
                    })
                ));
            }));
        }

        if (window.electronAPI.onRAGStreamComplete) {
            cleanups.push(window.electronAPI.onRAGStreamComplete(() => {
                setIsProcessing(false);
                requestStartTimeRef.current = null;
                setMessages(prev => updateTopMessage(
                    prev,
                    message => Boolean(message.isStreaming),
                    message => ({
                        ...message,
                        isStreaming: false
                    })
                ));
            }));
        }

        if (window.electronAPI.onRAGStreamError) {
            cleanups.push(window.electronAPI.onRAGStreamError((data: { error: string }) => {
                setIsProcessing(false);
                requestStartTimeRef.current = null;
                setMessages(prev => updateTopMessage(
                    prev,
                    message => Boolean(message.isStreaming),
                    message => ({
                        ...message,
                        isStreaming: false,
                        text: message.text + `\n\n[RAG Error: ${data.error}]`
                    })
                ));
            }));
        }

        return () => cleanups.forEach(fn => fn());
    }, [currentModel]); // Ensure tracking captures correct model


    const handleAnswerNow = async () => {
        if (isManualRecording) {
            // Stop recording - send accumulated voice input to Gemini
            isRecordingRef.current = false;  // Update ref immediately
            setIsManualRecording(false);
            setManualTranscript('');  // Clear live preview

            // Send manual finalization signal to STT Providers
            window.electronAPI.finalizeMicSTT().catch(err => console.error('[NativelyInterface] Failed to send finalizeMicSTT:', err));
            const nativeAudioStatus = await window.electronAPI.getNativeAudioStatus().catch(() => ({ connected: false }));

            const currentAttachments = attachedContext;
            setAttachedContext([]); // Clear context immediately on send

            const question = (voiceInputRef.current + (manualTranscriptRef.current ? ' ' + manualTranscriptRef.current : '')).trim();
            setVoiceInput('');
            voiceInputRef.current = '';
            setManualTranscript('');
            manualTranscriptRef.current = '';

            if (!question && currentAttachments.length === 0) {
                // No voice input and no image
                setMessages(prev => prependMessage(prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: nativeAudioStatus.connected
                        ? '⚠️ No speech detected. Try speaking closer to your microphone.'
                        : '⚠️ Audio pipeline is disconnected. Start a meeting or fix audio setup before using Answer.'
                }));
                return;
            }

            // Show user's spoken question
            setMessages(prev => prependMessage(prev, {
                id: Date.now().toString(),
                role: 'user',
                text: question,
                hasScreenshot: currentAttachments.length > 0,
                screenshotPreview: currentAttachments[0]?.preview
            }));

            // Add placeholder for streaming response
            setMessages(prev => prependMessage(prev, {
                id: Date.now().toString(),
                role: 'system',
                text: '',
                isStreaming: true
            }));

            setIsProcessing(true);

            try {
                let prompt = '';

                if (currentAttachments.length > 0) {
                    // Image + Voice Context
                    prompt = `You are a helper. The user has provided a screenshot and a spoken question/command.
User said: "${question}"

Instructions:
1. Analyze the screenshot in the context of what the user said.
2. Provide a direct, helpful answer.
3. Be concise.`;
                } else {
                    // JIT RAG pre-flight: try to use indexed meeting context first
                    const ragResult = await window.electronAPI.ragQueryLive?.(question);
                    if (ragResult?.success) {
                        // JIT RAG handled it — response streamed via rag:stream-chunk events
                        return;
                    }

                    // Voice Only (Smart Extract) — fallback
                    prompt = `You are a real-time interview assistant. The user just repeated or paraphrased a question from their interviewer.
Instructions:
1. Extract the core question being asked
2. Provide a clear, concise, and professional answer that the user can say out loud
3. Keep the answer short enough to speak naturally: 1-3 short sentences for simple questions, 3 sentences max unless detail is explicitly requested
4. Cap non-code answers at roughly 70 words
5. Do NOT use bullet points, headings, or multiple long paragraphs
6. Do NOT include phrases like "The question is..." - just give the answer directly
7. Format for speaking out loud, not for reading

Provide only the answer, nothing else.`;
                }

                // Call Streaming API: message = question, context = instructions
                requestStartTimeRef.current = Date.now();
                await window.electronAPI.streamGeminiChat(
                    question,
                    currentAttachments.length > 0 ? currentAttachments.map(s => s.path) : undefined,
                    prompt,
                    { skipSystemPrompt: true }
                );

            } catch (err) {
                // Initial invocation failing (e.g. IPC error before stream starts)
                setIsProcessing(false);
                setMessages(prev => replaceTopStreamingPlaceholder(prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: `❌ Error starting stream: ${err}`
                }));
            }
        } else {
            const nativeAudioStatus = await window.electronAPI.getNativeAudioStatus().catch(() => ({ connected: false }));
            if (!nativeAudioStatus.connected) {
                setMessages(prev => prependMessage(prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: '⚠️ Audio pipeline is disconnected. Start a meeting or fix audio setup before using Answer.'
                }));
                return;
            }

            // Start recording - reset voice input state
            setVoiceInput('');
            voiceInputRef.current = '';
            setManualTranscript('');
            isRecordingRef.current = true;  // Update ref immediately
            setIsManualRecording(true);


            // Ensure native audio is connected
            try {
                // Native audio is now managed by main process
                // await window.electronAPI.invoke('native-audio-connect');
            } catch (err) {
                // Already connected, that's fine
            }
        }
    };

    const handleManualSubmit = async () => {
        if (!inputValue.trim() && attachedContext.length === 0) return;

        const userText = inputValue;
        const currentAttachments = attachedContext;

        // Clear inputs immediately
        setInputValue('');
        setAttachedContext([]);

        setMessages(prev => prependMessage(prev, {
            id: Date.now().toString(),
            role: 'user',
            text: userText || (currentAttachments.length > 0 ? 'Analyze this screenshot' : ''),
            hasScreenshot: currentAttachments.length > 0,
            screenshotPreview: currentAttachments[0]?.preview
        }));

        // Add placeholder for streaming response
        setMessages(prev => prependMessage(prev, {
            id: Date.now().toString(),
            role: 'system',
            text: '',
            intent: 'what_to_answer',
            isStreaming: true
        }));

        setIsExpanded(true);
        setIsProcessing(true);

        try {
            // JIT RAG pre-flight: try to use indexed meeting context first
            if (currentAttachments.length === 0) {
                const ragResult = await window.electronAPI.ragQueryLive?.(userText || '');
                if (ragResult?.success) {
                    // JIT RAG handled it — response streamed via rag:stream-chunk events
                    return;
                }
            }

            // Pass imagePath if attached, AND conversation context
            requestStartTimeRef.current = Date.now();
            await window.electronAPI.streamGeminiChat(
                userText || 'Analyze this screenshot',
                currentAttachments.length > 0 ? currentAttachments.map(s => s.path) : undefined,
                conversationContext,
                { useConsciousMode: true }
            );
        } catch (err) {
            setIsProcessing(false);
            setMessages(prev => replaceTopStreamingPlaceholder(prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `❌ Error starting stream: ${err}`
            }));
        }
    };

    const clearChat = () => {
        setMessages([]);
    };




    // 🚀 PERFORMANCE OPTIMIZATION: Memoize expensive message rendering to prevent unnecessary re-renders
    const renderMessageText = useCallback((msg: Message) => {
        if (msg.intent === 'what_to_answer') {
            const consciousModeAnswer = parseConsciousModeAnswer(msg.text);
            if (consciousModeAnswer) {
                return <ConsciousModeAnswer text={msg.text} isStreaming={msg.isStreaming} />;
            }

            if (msg.isStreaming) {
                return <ConsciousModeAnswer text={msg.text} isStreaming />;
            }
        }

        // Code-containing messages get special styling
        // We split by code blocks to keep the "Code Solution" UI intact for the code parts
        // But use ReactMarkdown for the text parts around it
        if (msg.isCode || (msg.role === 'system' && msg.text.includes('```'))) {
            const parts = msg.text.split(/(```[\s\S]*?```)/g);
            return (
                <div className="bg-white/5 border border-white/10 rounded-lg p-3 my-1">
                    <div className="flex items-center gap-2 mb-2 text-purple-300 font-semibold text-xs uppercase tracking-wide">
                        <Code className="w-3.5 h-3.5" />
                        <span>Code Solution</span>
                    </div>
                    <div className="space-y-2 text-slate-200 text-[15.25px] leading-[1.72]">
                        {parts.map((part, i) => {
                            if (part.startsWith('```')) {
                                const match = part.match(/```(\w+)?\n?([\s\S]*?)```/);
                                if (match) {
                                    const lang = match[1] || 'python';
                                    const code = match[2].trim();
                                    return (
                                        <div key={i} className="my-3 rounded-xl overflow-hidden border border-white/[0.08] shadow-lg bg-zinc-800/60 backdrop-blur-md">
                                            {/* Minimalist Apple Header */}
                                            <div className="bg-white/[0.04] px-3 py-1.5 border-b border-white/[0.08]">
                                                <span className="text-[10px] uppercase tracking-widest font-semibold text-white/40 font-mono">
                                                    {lang || 'CODE'}
                                                </span>
                                            </div>
                                            <div className="bg-transparent">
                                                <SyntaxHighlighter
                                                    language={lang}
                                                    style={vscDarkPlus}
                                                    customStyle={{
                                                        margin: 0,
                                                        borderRadius: 0,
                                                        fontSize: '15.25px',
                                                        lineHeight: '1.72',
                                                        background: 'transparent',
                                                        padding: '16px',
                                                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
                                                    }}
                                                    wrapLongLines={true}
                                                    showLineNumbers={true}
                                                    lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1.2em', color: 'rgba(255,255,255,0.2)', textAlign: 'right', fontSize: '12.75px' }}
                                                >
                                                    {code}
                                                </SyntaxHighlighter>
                                            </div>
                                        </div>
                                    );
                                }
                            }
                            // Regular text - Render with Markdown
                            return (
                                <div key={i} className="markdown-content">
                                    <ReactMarkdown
                                        remarkPlugins={[remarkGfm, remarkMath]}
                                        rehypePlugins={[rehypeKatex]}
                                        components={{
                                            p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0 whitespace-pre-wrap" {...props} />,
                                            strong: ({ node, ...props }: any) => <strong className="font-bold text-white" {...props} />,
                                            em: ({ node, ...props }: any) => <em className="italic text-slate-300" {...props} />,
                                            ul: ({ node, ...props }: any) => <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />,
                                            ol: ({ node, ...props }: any) => <ol className="list-decimal ml-4 mb-2 space-y-1" {...props} />,
                                            li: ({ node, ...props }: any) => <li className="pl-1" {...props} />,
                                            h1: ({ node, ...props }: any) => <h1 className="text-lg font-bold text-white mb-2 mt-3" {...props} />,
                                            h2: ({ node, ...props }: any) => <h2 className="text-base font-bold text-white mb-2 mt-3" {...props} />,
                                            h3: ({ node, ...props }: any) => <h3 className="text-sm font-bold text-white mb-1 mt-2" {...props} />,
                                            code: ({ node, ...props }: any) => <code className="bg-slate-700/50 rounded px-1 py-0.5 text-[15px] font-mono text-purple-200 whitespace-pre-wrap" {...props} />,
                                            blockquote: ({ node, ...props }: any) => <blockquote className="border-l-2 border-purple-500/50 pl-3 italic text-slate-400 my-2" {...props} />,
                                            a: ({ node, ...props }: any) => <a className="text-blue-400 hover:text-blue-300 hover:underline" target="_blank" rel="noopener noreferrer" {...props} />,
                                        }}
                                    >
                                        {part}
                                    </ReactMarkdown>
                                </div>
                            );
                        })}
                    </div>
                </div>
            );
        }

        // Custom Styled Labels (Shorten, Recap, Follow-up) - also use Markdown for content
        if (msg.intent === 'shorten') {
            return (
                <div className="bg-white/5 border border-white/10 rounded-lg p-3 my-1">
                    <div className="flex items-center gap-2 mb-2 text-cyan-300 font-semibold text-xs uppercase tracking-wide">
                        <MessageSquare className="w-3.5 h-3.5" />
                        <span>Shortened</span>
                    </div>
                    <div className="text-slate-200 text-[15.25px] leading-[1.72] markdown-content">
                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{
                            p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0" {...props} />,
                            strong: ({ node, ...props }: any) => <strong className="font-bold text-cyan-100" {...props} />,
                            ul: ({ node, ...props }: any) => <ul className="list-disc ml-4 mb-2" {...props} />,
                            li: ({ node, ...props }: any) => <li className="pl-1" {...props} />,
                            h1: ({ node, ...props }: any) => <h1 className="text-lg font-bold text-cyan-100 mb-2 mt-3" {...props} />,
                            h2: ({ node, ...props }: any) => <h2 className="text-base font-bold text-cyan-100 mb-2 mt-3" {...props} />,
                            h3: ({ node, ...props }: any) => <h3 className="text-sm font-bold text-cyan-100 mb-1 mt-2" {...props} />,
                            code: ({ node, ...props }: any) => <code className="bg-cyan-700/30 rounded px-1 py-0.5 text-[15px] font-mono text-cyan-200" {...props} />,
                            a: ({ node, ...props }: any) => <a className="underline hover:opacity-80" target="_blank" rel="noopener noreferrer" {...props} />,
                        }}>{msg.text}</ReactMarkdown>
                    </div>
                </div>
            );
        }

        if (msg.intent === 'recap') {
            return (
                <div className="bg-white/5 border border-white/10 rounded-lg p-3 my-1">
                    <div className="flex items-center gap-2 mb-2 text-emerald-300 font-semibold text-xs uppercase tracking-wide">
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Recap</span>
                    </div>
                    <div className="text-slate-200 text-[15.25px] leading-[1.72] markdown-content">
                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{
                            p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0" {...props} />,
                            strong: ({ node, ...props }: any) => <strong className="font-bold text-emerald-100" {...props} />,
                            ul: ({ node, ...props }: any) => <ul className="list-disc ml-4 mb-2" {...props} />,
                            li: ({ node, ...props }: any) => <li className="pl-1" {...props} />,
                            h1: ({ node, ...props }: any) => <h1 className="text-lg font-bold text-emerald-100 mb-2 mt-3" {...props} />,
                            h2: ({ node, ...props }: any) => <h2 className="text-base font-bold text-emerald-100 mb-2 mt-3" {...props} />,
                            h3: ({ node, ...props }: any) => <h3 className="text-sm font-bold text-emerald-100 mb-1 mt-2" {...props} />,
                            code: ({ node, ...props }: any) => <code className="bg-emerald-700/30 rounded px-1 py-0.5 text-[15px] font-mono text-emerald-200" {...props} />,
                            a: ({ node, ...props }: any) => <a className="underline hover:opacity-80" target="_blank" rel="noopener noreferrer" {...props} />,
                        }}>{msg.text}</ReactMarkdown>
                    </div>
                </div>
            );
        }

        if (msg.intent === 'follow_up') {
            return (
                <div className="bg-white/5 border border-white/10 rounded-lg p-3 my-1">
                    <div className="flex items-center gap-2 mb-2 text-yellow-300 font-semibold text-xs uppercase tracking-wide">
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Follow-Up</span>
                    </div>
                    <div className="text-slate-200 text-[15.25px] leading-[1.72] markdown-content">
                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{
                            p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0" {...props} />,
                            strong: ({ node, ...props }: any) => <strong className="font-bold text-yellow-100" {...props} />,
                            ul: ({ node, ...props }: any) => <ul className="list-disc ml-4 mb-2" {...props} />,
                            li: ({ node, ...props }: any) => <li className="pl-1" {...props} />,
                            h1: ({ node, ...props }: any) => <h1 className="text-lg font-bold text-yellow-100 mb-2 mt-3" {...props} />,
                            h2: ({ node, ...props }: any) => <h2 className="text-base font-bold text-yellow-100 mb-2 mt-3" {...props} />,
                            h3: ({ node, ...props }: any) => <h3 className="text-sm font-bold text-yellow-100 mb-1 mt-2" {...props} />,
                            code: ({ node, ...props }: any) => <code className="bg-yellow-700/30 rounded px-1 py-0.5 text-[15px] font-mono text-yellow-200" {...props} />,
                            a: ({ node, ...props }: any) => <a className="underline hover:opacity-80" target="_blank" rel="noopener noreferrer" {...props} />,
                        }}>{msg.text}</ReactMarkdown>
                    </div>
                </div>
            );
        }

        if (msg.intent === 'follow_up_questions') {
            return (
                <div className="bg-white/5 border border-white/10 rounded-lg p-3 my-1">
                    <div className="flex items-center gap-2 mb-2 text-orange-300 font-semibold text-xs uppercase tracking-wide">
                        <HelpCircle className="w-3.5 h-3.5" />
                        <span>Questions</span>
                    </div>
                    <div className="text-slate-200 text-[15.25px] leading-[1.72]">
                        {/* Extract bullet point list for questions */}
                        {msg.text.split('\n').filter(line => line.trim().startsWith('•')).map((question, i) => (
                            <div 
                                key={i}
                                className="mb-3 last:mb-0 p-2.5 bg-white/5 rounded-lg border border-white/5 hover:bg-white/10 cursor-pointer transition-colors"
                                onClick={() => {
                                    const questionText = question.replace(/^•\s*/, '');
                                    // Handle question click
                                    console.log('Question clicked:', questionText);
                                }}
                            >
                                <div className="flex items-start gap-2">
                                    <span className="text-orange-400 font-bold text-sm mt-0.5">Q:</span>
                                    <span className="text-slate-200 text-[15px] leading-relaxed">{question.replace(/^•\s*/, '')}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            );
        }

        // Follow-up questions as clickable pills
        if (msg.intent === 'follow_up_questions' && msg.role === 'system') {
            // Extract individual questions
            const questions = msg.text.split('\n').filter(line => line.trim().startsWith('•')).map(q => q.replace(/^•\s*/, ''));

            return (
                <div className="bg-white/5 border border-white/10 rounded-lg p-3 my-1">
                    <div className="flex items-center gap-2 mb-2 text-orange-300 font-semibold text-xs uppercase tracking-wide">
                        <HelpCircle className="w-3.5 h-3.5" />
                        <span>Follow-up Questions</span>
                    </div>
                    <div className="space-y-2">
                        {questions.map((question, i) => (
                            <button
                                key={i}
                                className="w-full text-left p-2.5 bg-white/5 rounded-lg border border-white/5 hover:bg-white/10 transition-colors group"
                                onClick={() => {
                                    // Handle question click - trigger what to say with this question
                                    console.log('Follow-up question clicked:', question);
                                }}
                            >
                                <div className="flex items-start gap-2">
                                    <span className="text-orange-400 font-bold text-sm mt-0.5">Q:</span>
                                    <span className="text-slate-200 text-[15px] leading-relaxed group-hover:text-white">{question}</span>
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            );
        }

        if (msg.intent === 'answer_now') {
            return (
                <div className="bg-white/5 border border-white/10 rounded-lg p-3 my-1">
                    <div className="flex items-center gap-2 mb-2 text-blue-300 font-semibold text-xs uppercase tracking-wide">
                        <ArrowUp className="w-3.5 h-3.5" />
                        <span>Answer Now</span>
                    </div>

                    <div className="text-slate-200 text-[15.25px] leading-[1.72] markdown-content">
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[rehypeKatex]}
                            components={{
                                p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0" {...props} />,
                                strong: ({ node, ...props }: any) => <strong className="font-bold text-emerald-100" {...props} />,
                                em: ({ node, ...props }: any) => <em className="italic text-emerald-200/80" {...props} />,
                                ul: ({ node, ...props }: any) => <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />,
                                ol: ({ node, ...props }: any) => <ol className="list-decimal ml-4 mb-2 space-y-1" {...props} />,
                                li: ({ node, ...props }: any) => <li className="pl-1" {...props} />,
                                h1: ({ node, ...props }: any) => <h1 className="text-lg font-bold text-emerald-100 mb-2 mt-3" {...props} />,
                                h2: ({ node, ...props }: any) => <h2 className="text-base font-bold text-emerald-100 mb-2 mt-3" {...props} />,
                                h3: ({ node, ...props }: any) => <h3 className="text-sm font-bold text-emerald-100 mb-1 mt-2" {...props} />,
                                code: ({ node, ...props }: any) => <code className="bg-emerald-700/30 rounded px-1 py-0.5 text-[15px] font-mono text-emerald-200" {...props} />,
                                blockquote: ({ node, ...props }: any) => <blockquote className="border-l-2 border-emerald-500/50 pl-3 italic text-emerald-300/70 my-2" {...props} />,
                                a: ({ node, ...props }: any) => <a className="underline hover:opacity-80" target="_blank" rel="noopener noreferrer" {...props} />,
                            }}
                        >
                            {msg.text}
                        </ReactMarkdown>
                    </div>
                </div>
            );
        }

        // Regular messages with Markdown support
        return (
            <div className="text-slate-200 text-[15.25px] leading-[1.72] markdown-content">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                    components={{
                        p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0" {...props} />,
                        strong: ({ node, ...props }: any) => <strong className="font-bold text-emerald-100" {...props} />,
                        em: ({ node, ...props }: any) => <em className="italic text-emerald-200/80" {...props} />,
                        ul: ({ node, ...props }: any) => <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />,
                        ol: ({ node, ...props }: any) => <ol className="list-decimal ml-4 mb-2 space-y-1" {...props} />,
                        li: ({ node, ...props }: any) => <li className="pl-1" {...props} />,
                        h1: ({ node, ...props }: any) => <h1 className="text-lg font-bold text-emerald-100 mb-2 mt-3" {...props} />,
                        h2: ({ node, ...props }: any) => <h2 className="text-base font-bold text-emerald-100 mb-2 mt-3" {...props} />,
                        h3: ({ node, ...props }: any) => <h3 className="text-sm font-bold text-emerald-100 mb-1 mt-2" {...props} />,
                        code: ({ node, ...props }: any) => <code className="bg-emerald-700/30 rounded px-1 py-0.5 text-[15px] font-mono text-emerald-200" {...props} />,
                        blockquote: ({ node, ...props }: any) => <blockquote className="border-l-2 border-emerald-500/50 pl-3 italic text-emerald-300/70 my-2" {...props} />,
                        a: ({ node, ...props }: any) => <a className="underline hover:opacity-80" target="_blank" rel="noopener noreferrer" {...props} />,
                    }}
                >
                    {msg.text}
                </ReactMarkdown>
            </div>
        );
    }, []); // No dependencies - this function is pure and uses only its msg parameter


    // Keyboard Shortcuts

    // Keyboard Shortcuts
    // We use a ref to hold the latest handlers to avoid re-binding the event listener on every render
    const handlersRef = useRef({
        handleWhatToSay,
        handleFollowUp,
        handleFollowUpQuestions,
        handleRecap,
        handleAnswerNow
    });

    // Update ref on every render so the event listener always access latest state/props
    handlersRef.current = {
        handleWhatToSay,
        handleFollowUp,
        handleFollowUpQuestions,
        handleRecap,
        handleAnswerNow
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const { handleWhatToSay, handleFollowUp, handleFollowUpQuestions, handleRecap, handleAnswerNow } = handlersRef.current;

            // Chat Shortcuts (Scope: Local to Chat/Overlay usually, but we allow them here if focused)
            if (isShortcutPressed(e, 'whatToAnswer')) {
                e.preventDefault();
                handleWhatToSay();
            } else if (isShortcutPressed(e, 'shorten')) {
                e.preventDefault();
                handleFollowUp('shorten');
            } else if (isShortcutPressed(e, 'followUp')) {
                e.preventDefault();
                handleFollowUpQuestions();
            } else if (isShortcutPressed(e, 'recap')) {
                e.preventDefault();
                handleRecap();
            } else if (isShortcutPressed(e, 'answer')) {
                e.preventDefault();
                handleAnswerNow();
            } else if (isShortcutPressed(e, 'scrollUp')) {
                e.preventDefault();
                scrollContainerRef.current?.scrollBy({ top: -100, behavior: 'smooth' });
            } else if (isShortcutPressed(e, 'scrollDown')) {
                e.preventDefault();
                scrollContainerRef.current?.scrollBy({ top: 100, behavior: 'smooth' });
            } else if (isShortcutPressed(e, 'moveWindowUp') || isShortcutPressed(e, 'moveWindowDown')) {
                // Prevent default scrolling when moving window
                e.preventDefault();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isShortcutPressed]);

    // General Global Shortcuts (Rebindable)
    // We listen here to handle them when the window is focused (renderer side)
    // Global shortcuts (when window blurred) are handled by Main process -> GlobalShortcuts
    // But Main process events might not reach here if we don't listen, or we want unified handling.
    // Actually, KeybindManager registers global shortcuts. If they are registered as global, 
    // Electron might consume them before they reach here?
    // 'toggle-app' is Global.
    // 'toggle-visibility' is NOT Global in default config (isGlobal: false), so it depends on focus.
    // So we MUST listen for them here.

    const generalHandlersRef = useRef({
        toggleVisibility: () => window.electronAPI.toggleWindow(),
        processScreenshots: handleWhatToSay,
        resetCancel: async () => {
            if (isProcessing) {
                setIsProcessing(false);
            } else {
                await window.electronAPI.resetIntelligence();
                setMessages([]);
                setAttachedContext([]);
                setInputValue('');
            }
        },
        takeScreenshot: async () => {
            try {
                const data = await window.electronAPI.takeScreenshot();
                if (data && data.path) {
                    handleScreenshotAttach(data as { path: string; preview: string });
                }
            } catch (err) {
                setMessages(prev => prependMessage(prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: 'Unable to capture screenshot. Check Screen Recording permission in macOS Settings and try again.'
                }));
                console.error("Error triggering screenshot:", err);
            }
        },
        selectiveScreenshot: async () => {
            try {
                const data = await window.electronAPI.takeSelectiveScreenshot();
                if (data && !data.cancelled && data.path) {
                    handleScreenshotAttach(data as { path: string; preview: string });
                }
            } catch (err) {
                setMessages(prev => prependMessage(prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: 'Unable to capture area screenshot. Check Screen Recording permission in macOS Settings and try again.'
                }));
                console.error("Error triggering selective screenshot:", err);
            }
        }
    });

    // Update ref
    generalHandlersRef.current = {
        toggleVisibility: () => window.electronAPI.toggleWindow(),
        processScreenshots: handleWhatToSay,
        resetCancel: async () => {
            if (isProcessing) {
                setIsProcessing(false);
            } else {
                await window.electronAPI.resetIntelligence();
                setMessages([]);
                setAttachedContext([]);
                setInputValue('');
            }
        },
        takeScreenshot: async () => {
            try {
                const data = await window.electronAPI.takeScreenshot();
                if (data && data.path) {
                    handleScreenshotAttach(data as { path: string; preview: string });
                }
            } catch (err) {
                setMessages(prev => prependMessage(prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: 'Unable to capture screenshot. Check Screen Recording permission in macOS Settings and try again.'
                }));
                console.error("Error triggering screenshot:", err);
            }
        },
        selectiveScreenshot: async () => {
            try {
                const data = await window.electronAPI.takeSelectiveScreenshot();
                if (data && !data.cancelled && data.path) {
                    handleScreenshotAttach(data as { path: string; preview: string });
                }
            } catch (err) {
                setMessages(prev => prependMessage(prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: 'Unable to capture area screenshot. Check Screen Recording permission in macOS Settings and try again.'
                }));
                console.error("Error triggering selective screenshot:", err);
            }
        }
    };

    useEffect(() => {
        const handleGeneralKeyDown = (e: KeyboardEvent) => {
            const handlers = generalHandlersRef.current;
            const target = e.target as HTMLElement;
            const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

            if (isShortcutPressed(e, 'toggleVisibility')) {
                // Always allow toggling visibility
                e.preventDefault();
                handlers.toggleVisibility();
            } else if (isShortcutPressed(e, 'processScreenshots')) {
                if (!isInput) {
                    e.preventDefault();
                    handlers.processScreenshots();
                }
                // If input focused, let default behavior (Enter) happen or handle it via onKeyDown in Input
            } else if (isShortcutPressed(e, 'resetCancel')) {
                e.preventDefault();
                handlers.resetCancel();
            } else if (isShortcutPressed(e, 'takeScreenshot')) {
                e.preventDefault();
                handlers.takeScreenshot();
            } else if (isShortcutPressed(e, 'selectiveScreenshot')) {
                e.preventDefault();
                handlers.selectiveScreenshot();
            }
        };

        window.addEventListener('keydown', handleGeneralKeyDown);
        return () => window.removeEventListener('keydown', handleGeneralKeyDown);
    }, [isShortcutPressed]);

    useEffect(() => {
        const unsubscribe = window.electronAPI?.onGlobalShortcutAction?.((actionId) => {
            if (actionId === 'chat:scrollUp') {
                scrollContainerRef.current?.scrollBy({ top: -100, behavior: 'smooth' });
            } else if (actionId === 'chat:scrollDown') {
                scrollContainerRef.current?.scrollBy({ top: 100, behavior: 'smooth' });
            }
        });

        return () => unsubscribe?.();
    }, []);

    return (
        <div ref={contentRef} className="flex flex-col items-center w-fit mx-auto h-fit min-h-0 bg-transparent p-0 rounded-[24px] font-sans text-slate-200 gap-2">

            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ opacity: 0, y: 20, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 20, scale: 0.95 }}
                        transition={{ duration: 0.3, ease: "easeInOut" }}
                        className="flex flex-col items-center gap-2 w-full"
                    >
                        <TopPill
                            expanded={isExpanded}
                            onToggle={() => setIsExpanded(!isExpanded)}
                            onQuit={() => onEndMeeting ? onEndMeeting() : window.electronAPI.quitApp()}
                        />
                        <div className="
                    relative max-w-full
                    bg-[#1E1E1E]/95
                    backdrop-blur-2xl
                    border border-white/10
                    shadow-2xl shadow-black/40
                    rounded-[24px] 
                    overflow-hidden 
                    flex flex-col
                    draggable-area
                " style={{ width: `${panelWidth}px`, transition: isResizing ? 'none' : 'width 180ms ease, max-height 180ms ease' }}>




                            {/* Rolling Transcript Bar - Single-line interviewer speech */}
                            {(rollingTranscript || isInterviewerSpeaking) && showTranscript && (
                                <RollingTranscript
                                    text={rollingTranscript}
                                    isActive={isInterviewerSpeaking}
                                />
                            )}

                            {/* Chat History - Only show if there are messages OR active states */}
                            {(messages.length > 0 || isManualRecording || isProcessing) && (
                                <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4 space-y-3 no-drag scroll-smooth custom-scrollbar flex flex-col" style={{ scrollbarWidth: 'thin', scrollBehavior: 'smooth', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', maxHeight: `${chatViewportHeight}px` }}>
                                    <AnimatePresence initial={false}>
                                        {messages.map((msg) => (
                                            <motion.div
                                                key={msg.id}
                                                data-autoscroll-message-id={msg.id}
                                                initial={{ opacity: 0, y: -8 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                exit={{ opacity: 0, y: -4 }}
                                                transition={{
                                                    opacity: { duration: 0.12, ease: [0.22, 1, 0.36, 1] },
                                                    y: { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
                                                    layout: { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
                                                }}
                                                layout="position"
                                                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                                            >
                                                <div className={`
                      ${msg.role === 'user' ? 'max-w-[72.25%] px-[13.6px] py-[10.2px]' : 'max-w-[85%] px-4 py-3'} text-[16.5px] leading-[1.72] relative group whitespace-pre-wrap
                      ${msg.role === 'user'
                                                        ? 'bg-blue-600/20 backdrop-blur-md border border-blue-500/30 text-blue-100 rounded-[20px] rounded-tr-[4px] shadow-sm font-medium'
                                                        : ''
                                                    }
                      ${msg.role === 'system'
                                                        ? 'text-slate-100 font-normal rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm shadow-lg'
                                                        : ''
                                                    }
                      ${msg.role === 'interviewer'
                                                        ? 'text-white/40 italic pl-0 text-[13px]'
                                                        : ''
                                                    }
                    `}>
                                                    {msg.role === 'interviewer' && (
                                                        <div className="flex items-center gap-1.5 mb-1 text-[10px] text-slate-600 font-medium uppercase tracking-wider">
                                                            Interviewer
                                                            {msg.isStreaming && <span className="w-1 h-1 bg-green-500 rounded-full animate-pulse" />}
                                                        </div>
                                                    )}
                                                    {msg.role === 'system' && msg.isStreaming && (
                                                        <div className="flex items-center gap-1.5 mb-1 text-[10px] text-blue-400 font-medium uppercase tracking-wider">
                                                            <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
                                                            Assistant
                                                        </div>
                                                    )}
                                                    {msg.role === 'user' && msg.hasScreenshot && (
                                                        <div className="flex items-center gap-1 text-[10px] opacity-70 mb-1 border-b border-white/10 pb-1">
                                                            <Image className="w-2.5 h-2.5" />
                                                            <span>Screenshot attached</span>
                                                        </div>
                                                    )}
                                                    {msg.role === 'system' && !msg.isStreaming && (
                                                        <button
                                                            onClick={() => handleCopy(msg.text)}
                                                            className="absolute top-2 right-2 p-1.5 bg-black/40 hover:bg-black/60 text-slate-400 hover:text-white rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
                                                            title="Copy to clipboard"
                                                        >
                                                            <Copy className="w-3.5 h-3.5" />
                                                        </button>
                                                    )}
                                                    {renderMessageText(msg)}
                                                </div>
                                            </motion.div>
                                        ))}
                                    </AnimatePresence>

                                    {/* Active Recording State with Live Transcription */}
                                    {isManualRecording && (
                                        <div className="flex flex-col items-end gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
                                            {/* Live transcription preview */}
                                            {(manualTranscript || voiceInput) && (
                                                <div className="max-w-[85%] px-3.5 py-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-[18px] rounded-tr-[4px]">
                                                    <span className="text-[13px] text-emerald-300">
                                                        {voiceInput}{voiceInput && manualTranscript ? ' ' : ''}{manualTranscript}
                                                    </span>
                                                </div>
                                            )}
                                            <div className="px-3 py-2 flex gap-1.5 items-center">
                                                <div className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                                <div className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                                <div className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                                <span className="text-[10px] text-emerald-400/70 ml-1">Listening...</span>
                                            </div>
                                        </div>
                                    )}

                                    {isProcessing && (
                                        <div className="flex justify-start">
                                            <div className="px-3 py-2 flex gap-1.5">
                                                <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                                <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                                <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Quick Actions - Minimal & Clean */}
                            <div className={`flex flex-nowrap justify-center items-center gap-1.5 px-4 pb-3 overflow-x-hidden ${rollingTranscript && showTranscript ? 'pt-1' : 'pt-3'}`}>
                                <button onClick={handleWhatToSay} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium text-slate-400 bg-white/5 border border-white/0 hover:text-slate-200 hover:bg-white/10 hover:border-white/5 transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0">
                                    <Pencil className="w-3 h-3 opacity-70" /> What to answer?
                                </button>
                                <button onClick={() => handleFollowUp('shorten')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium text-slate-400 bg-white/5 border border-white/0 hover:text-slate-200 hover:bg-white/10 hover:border-white/5 transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0">
                                    <MessageSquare className="w-3 h-3 opacity-70" /> Shorten
                                </button>
                                <button onClick={handleRecap} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium text-slate-400 bg-white/5 border border-white/0 hover:text-slate-200 hover:bg-white/10 hover:border-white/5 transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0">
                                    <RefreshCw className="w-3 h-3 opacity-70" /> Recap
                                </button>
                                <button onClick={handleFollowUpQuestions} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium text-slate-400 bg-white/5 border border-white/0 hover:text-slate-200 hover:bg-white/10 hover:border-white/5 transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0">
                                    <HelpCircle className="w-3 h-3 opacity-70" /> Follow Up Question
                                </button>
                                <button
                                    onClick={handleAnswerNow}
                                    className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium transition-all active:scale-95 duration-200 interaction-base interaction-press min-w-[74px] whitespace-nowrap shrink-0 ${isManualRecording
                                        ? 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20'
                                        : 'bg-white/5 text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10'
                                        }`}
                                >
                                    {isManualRecording ? (
                                        <>
                                            <div className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                                            Stop
                                        </>
                                    ) : (
                                        <><Zap className="w-3 h-3 opacity-70" /> Answer</>
                                    )}
                                </button>
                            </div>

                            {/* Input Area */}
                            <div className="p-3 pt-0">
                                {/* Latent Context Preview (Attached Screenshot) */}
                                {attachedContext.length > 0 && (
                                    <div className="mb-2 bg-white/5 border border-white/10 rounded-lg p-2 transition-all duration-200">
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className="text-[11px] font-medium text-white">
                                                {attachedContext.length} screenshot{attachedContext.length > 1 ? 's' : ''} attached
                                            </span>
                                            <button
                                                onClick={() => setAttachedContext([])}
                                                className="p-1 hover:bg-white/10 rounded-full text-slate-400 hover:text-white transition-colors"
                                                title="Remove all"
                                            >
                                                <X className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                        <div className="flex gap-1.5 overflow-x-auto max-w-full pb-1">
                                            {attachedContext.map((ctx, idx) => (
                                                <div key={ctx.path} className="relative group/thumb flex-shrink-0">
                                                    <img
                                                        src={ctx.preview}
                                                        alt={`Screenshot ${idx + 1}`}
                                                        className="h-10 w-auto rounded border border-white/20"
                                                    />
                                                    <button
                                                        onClick={() => setAttachedContext(prev => prev.filter((_, i) => i !== idx))}
                                                        className="absolute -top-1 -right-1 w-4 h-4 bg-red-500/80 hover:bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity"
                                                        title="Remove"
                                                    >
                                                        <X className="w-2.5 h-2.5 text-white" />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                        <span className="text-[10px] text-slate-400">Ask a question or click Answer</span>
                                    </div>
                                )}

                                <div className="relative group">
                                    <input
                                        ref={textInputRef}
                                        type="text"
                                        value={inputValue}
                                        onChange={(e) => setInputValue(e.target.value)}
                                        onKeyDown={(e) => e.key === 'Enter' && handleManualSubmit()}

                                        className="
                                    w-full 
                                    bg-[#1E1E1E] 
                                    hover:bg-[#252525] 
                                    focus:bg-[#1E1E1E]
                                    border border-white/5 
                                    focus:border-white/10
                                    focus:ring-1 focus:ring-white/10
                                    rounded-xl 
                                    pl-3 pr-10 py-2.5 
                                    text-slate-200 
                                    focus:outline-none 
                                    transition-all duration-200 ease-sculpted
                                    text-[13px] leading-relaxed
                                    placeholder:text-slate-500
                                "
                                    />

                                    {/* Custom Rich Placeholder */}
                                    {!inputValue && (
                                        <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 pointer-events-none text-[13px] text-slate-400">
                                            <span>Ask anything on screen or conversation, or</span>
                                            <div className="flex items-center gap-1 opacity-80">
                                                {(shortcuts.selectiveScreenshot || ['⌘', 'Shift', 'H']).map((key, i) => (
                                                    <React.Fragment key={i}>
                                                        {i > 0 && <span className="text-[10px]">+</span>}
                                                        <kbd className="px-1.5 py-0.5 rounded border border-white/10 bg-white/5 text-[10px] font-sans min-w-[20px] text-center">{key}</kbd>
                                                    </React.Fragment>
                                                ))}
                                            </div>
                                            <span>for selective screenshot</span>
                                        </div>
                                    )}

                                    {!inputValue && (
                                        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1 pointer-events-none opacity-20">
                                            <span className="text-[10px]">↵</span>
                                        </div>
                                    )}
                                </div>

                                {/* Bottom Row */}
                                <div className="flex items-center justify-between mt-3 px-0.5">
                                    <div className="flex items-center gap-1.5">
                                        <button
                                            onClick={(e) => {
                                                // Calculate position for detached window
                                                if (!contentRef.current) return;
                                                const contentRect = contentRef.current.getBoundingClientRect();
                                                const buttonRect = e.currentTarget.getBoundingClientRect();
                                                const GAP = 8;

                                                const x = window.screenX + buttonRect.left;
                                                const y = window.screenY + contentRect.bottom + GAP;

                                                window.electronAPI.toggleModelSelector({ x, y });
                                            }}
                                            className={`
                                                flex items-center gap-2 px-3 py-1.5 
                                                border border-white/10 rounded-lg transition-colors 
                                                text-xs font-medium w-[140px]
                                                interaction-base interaction-press
                                                bg-black/20 text-white/70 hover:bg-white/5 hover:text-white
                                            `}
                                        >
                                            <span className="truncate min-w-0 flex-1">
                                                {(() => {
                                                    const m = currentModel;
                                                    if (m.startsWith('ollama-')) return m.replace('ollama-', '');
                                                    if (m === 'gemini-3-flash-preview') return 'Gemini 3 Flash';
                                                    if (m === 'gemini-3-pro-preview') return 'Gemini 3 Pro';
                                                    if (m === 'llama-3.3-70b-versatile') return 'Groq Llama 3.3';
                                                    if (m === 'gpt-5.2-chat-latest') return 'GPT 5.2';
                                                    if (m === 'claude-sonnet-4-5') return 'Sonnet 4.5';
                                                    return m;
                                                })()}
                                            </span>
                                            <ChevronDown size={14} className="shrink-0 transition-transform" />
                                        </button>

                                        {modelFallbackNotice && (
                                            <div className="text-[10px] text-amber-300/90 max-w-[240px] leading-tight">
                                                {modelFallbackNotice}
                                            </div>
                                        )}

                                        <div className="w-px h-3 bg-white/10 mx-1" />

                                        {/* Settings Gear */}
                                        <div className="relative">
                                            <button
                                                onClick={(e) => {
                                                    if (isSettingsOpen) {
                                                        // If open, just close it (toggle will handle logic but we can be explicit or just toggle)
                                                        // Actually toggle-settings-window handles hiding if visible, so logic is same.
                                                        window.electronAPI.toggleSettingsWindow();
                                                        return;
                                                    }

                                                    if (!contentRef.current) return;

                                                    const contentRect = contentRef.current.getBoundingClientRect();
                                                    const buttonRect = e.currentTarget.getBoundingClientRect();
                                                    const POPUP_WIDTH = 270; // Matches SettingsWindowHelper actual width
                                                    const GAP = 8; // Same gap as between TopPill and main body (gap-2 = 8px)

                                                    // X: Left-aligned relative to the Settings Button
                                                    const x = window.screenX + buttonRect.left;

                                                    // Y: Below the main content + gap
                                                    const y = window.screenY + contentRect.bottom + GAP;

                                                    window.electronAPI.toggleSettingsWindow({ x, y });
                                                }}
                                                className={`
                                            w-7 h-7 flex items-center justify-center rounded-lg 
                                            interaction-base interaction-press
                                            ${isSettingsOpen ? 'text-white bg-white/10' : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'}
                                        `}
                                                title="Settings"
                                            >
                                                <SlidersHorizontal className="w-3.5 h-3.5" />
                                            </button>
                                        </div>

                                    </div>

                                    <button
                                        onClick={handleManualSubmit}
                                        disabled={!inputValue.trim()}
                                        className={`
                                    w-7 h-7 rounded-full flex items-center justify-center 
                                    interaction-base interaction-press
                                    ${inputValue.trim()
                                                ? 'bg-[#007AFF] text-white shadow-lg shadow-blue-500/20 hover:bg-[#0071E3]'
                                                : 'bg-white/5 text-white/10 cursor-not-allowed'
                                            }
                                `}
                                    >
                                        <ArrowRight className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            </div>

                            <button
                                type="button"
                                aria-label="Resize overlay from left edge"
                                onMouseDown={handleResizeStart('left')}
                                className="group absolute left-0 top-8 bottom-8 w-2 no-drag z-20 cursor-ew-resize bg-transparent"
                                title="Drag to resize width"
                            >
                                <span className="pointer-events-none absolute left-0 top-1/2 h-16 w-[2px] -translate-y-1/2 rounded-full bg-white/8 transition-all group-hover:h-24 group-hover:bg-white/35" />
                            </button>

                            <button
                                type="button"
                                aria-label="Resize overlay width"
                                onMouseDown={handleResizeStart('right')}
                                className="group absolute right-0 top-8 bottom-8 w-2 no-drag z-20 cursor-ew-resize bg-transparent"
                                title="Drag to resize width"
                            >
                                <span className="pointer-events-none absolute right-0 top-1/2 h-16 w-[2px] -translate-y-1/2 rounded-full bg-white/8 transition-all group-hover:h-24 group-hover:bg-white/35" />
                            </button>

                            <button
                                type="button"
                                aria-label="Resize overlay from top edge"
                                onMouseDown={handleResizeStart('top')}
                                className="group absolute left-8 right-8 top-0 h-2 no-drag z-20 cursor-ns-resize bg-transparent"
                                title="Drag to resize height"
                            >
                                <span className="pointer-events-none absolute left-1/2 top-0 h-[2px] w-20 -translate-x-1/2 rounded-full bg-white/8 transition-all group-hover:w-28 group-hover:bg-white/35" />
                            </button>

                            <button
                                type="button"
                                aria-label="Resize overlay height"
                                onMouseDown={handleResizeStart('bottom')}
                                className="group absolute left-8 right-8 bottom-0 h-2 no-drag z-20 cursor-ns-resize bg-transparent"
                                title="Drag to resize height"
                            >
                                <span className="pointer-events-none absolute bottom-0 left-1/2 h-[2px] w-20 -translate-x-1/2 rounded-full bg-white/8 transition-all group-hover:w-28 group-hover:bg-white/35" />
                            </button>

                            <button
                                type="button"
                                aria-label="Resize overlay from top left corner"
                                onMouseDown={handleResizeStart('top-left')}
                                className="group absolute left-2 top-2 no-drag z-30 h-5 w-5 cursor-nwse-resize rounded-full border border-white/10 bg-white/5 text-white/30 transition hover:bg-white/10 hover:text-white/80"
                                title="Drag to resize"
                            >
                                <span className="pointer-events-none absolute left-[3px] top-[3px] text-[10px] leading-none">↖</span>
                            </button>

                            <button
                                type="button"
                                aria-label="Resize overlay from top right corner"
                                onMouseDown={handleResizeStart('top-right')}
                                className="group absolute right-2 top-2 no-drag z-30 h-5 w-5 cursor-nesw-resize rounded-full border border-white/10 bg-white/5 text-white/30 transition hover:bg-white/10 hover:text-white/80"
                                title="Drag to resize"
                            >
                                <span className="pointer-events-none absolute right-[3px] top-[3px] text-[10px] leading-none">↗</span>
                            </button>

                            <button
                                type="button"
                                aria-label="Resize overlay from bottom left corner"
                                onMouseDown={handleResizeStart('bottom-left')}
                                className="group absolute bottom-2 left-2 no-drag z-30 h-5 w-5 cursor-nesw-resize rounded-full border border-white/10 bg-white/5 text-white/30 transition hover:bg-white/10 hover:text-white/80"
                                title="Drag to resize"
                            >
                                <span className="pointer-events-none absolute bottom-[3px] left-[3px] text-[10px] leading-none">↙</span>
                            </button>

                            <button
                                type="button"
                                aria-label="Resize overlay"
                                onMouseDown={handleResizeStart('bottom-right')}
                                className="group absolute bottom-2 right-2 no-drag z-30 h-5 w-5 cursor-nwse-resize rounded-full border border-white/10 bg-white/5 text-white/30 transition hover:bg-white/10 hover:text-white/80"
                                title="Drag to resize"
                            >
                                <span className="pointer-events-none absolute bottom-[3px] right-[3px] text-[10px] leading-none">↘</span>
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default NativelyInterface;
