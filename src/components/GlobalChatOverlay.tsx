import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStreamBuffer } from '../hooks/useStreamBuffer';
import { useHumanSpeedAutoScroll } from '../hooks/useHumanSpeedAutoScroll';
import { X, ArrowUp } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import nativelyIcon from './icon.png';
import { UserMessage, AssistantMessage } from './ChatMessage';

// ============================================
// Types
// ============================================

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: number;
    isStreaming?: boolean;
}

interface GlobalChatOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    initialQuery?: string;
}



// ============================================
// Main Component
// ============================================

type ChatState = 'idle' | 'waiting_for_llm' | 'streaming_response' | 'error';

const GlobalChatOverlay: React.FC<GlobalChatOverlayProps> = ({
    isOpen,
    onClose,
    initialQuery = ''
}) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [chatState, setChatState] = useState<ChatState>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const streamBuffer = useStreamBuffer();

    const chatWindowRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const activeRequestIdRef = useRef<string | null>(null);
    const lastHandledInitialQueryRef = useRef<string>('');
    const activeCleanupRef = useRef<Array<() => void>>([]);
    const chatStateRef = useRef<ChatState>('idle');

    useEffect(() => {
        chatStateRef.current = chatState;
    }, [chatState]);

    const cleanupActiveRequest = useCallback(() => {
        for (const cleanup of activeCleanupRef.current) {
            cleanup();
        }
        activeCleanupRef.current = [];
        activeRequestIdRef.current = null;
        streamBuffer.reset();
    }, [streamBuffer]);

    const latestReadableMessage = messages.find(msg => msg.role === 'assistant') || null;

    useHumanSpeedAutoScroll({
        enabled: isOpen,
        containerRef: scrollContainerRef,
        latestMessage: latestReadableMessage ? {
            id: latestReadableMessage.id,
            role: latestReadableMessage.role,
            content: latestReadableMessage.content,
            isStreaming: latestReadableMessage.isStreaming,
        } : null,
        eligibleRoles: ['assistant'],
    });

    useEffect(() => {
        return () => {
            cleanupActiveRequest();
        };
    }, [cleanupActiveRequest]);

    // ESC key handler
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    // Click outside handler
    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    }, [onClose]);

    const handleInputKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && query.trim()) {
            e.preventDefault();
            submitQuestion(query);
            setQuery('');
        }
    };

    // Submit question using global RAG
    const submitQuestion = useCallback(async (question: string) => {
        if (!question.trim() || chatStateRef.current === 'waiting_for_llm' || chatStateRef.current === 'streaming_response') return;

        cleanupActiveRequest();
        const requestId = `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        activeRequestIdRef.current = requestId;

        const userMessage: Message = {
            id: `user-${Date.now()}`,
            role: 'user',
            content: question,
            createdAt: Date.now()
        };
        setMessages(prev => [userMessage, ...prev]);
        setChatState('waiting_for_llm');
        setErrorMessage(null);

        const assistantMessageId = `assistant-${Date.now()}`;

        const isCurrentRequest = () => activeRequestIdRef.current === requestId;
        const finishRequest = () => {
            if (!isCurrentRequest()) {
                return;
            }
            cleanupActiveRequest();
        };

        try {
            if (!isCurrentRequest()) return;

            // Create assistant message placeholder
            setMessages(prev => [{
                id: assistantMessageId,
                role: 'assistant',
                content: '',
                createdAt: Date.now(),
                isStreaming: true
            }, ...prev]);

            // Set up RAG streaming listeners (RAF-batched)
            streamBuffer.reset();
            const tokenCleanup = window.electronAPI?.onRAGStreamChunk((data: { chunk: string }) => {
                if (!isCurrentRequest()) return;
                setChatState('streaming_response');
                streamBuffer.appendToken(data.chunk, (content) => {
                    if (!isCurrentRequest()) return;
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantMessageId
                            ? { ...msg, content }
                            : msg
                    ));
                });
            });

            const doneCleanup = window.electronAPI?.onRAGStreamComplete(() => {
                if (!isCurrentRequest()) return;
                const finalContent = streamBuffer.getBufferedContent();
                setMessages(prev => prev.map(msg =>
                    msg.id === assistantMessageId
                        ? { ...msg, content: finalContent, isStreaming: false }
                        : msg
                ));
                setChatState('idle');
                finishRequest();
            });

            const errorCleanup = window.electronAPI?.onRAGStreamError((data: { error: string }) => {
                if (!isCurrentRequest()) return;
                console.error('[GlobalChat] RAG stream error:', data.error);
                setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
                setErrorMessage("Couldn't get a response. Please try again.");
                setChatState('error');
                finishRequest();
            });

            activeCleanupRef.current = [tokenCleanup, doneCleanup, errorCleanup].filter(Boolean) as Array<() => void>;

            // Use global RAG query
            const result = await window.electronAPI?.ragQueryGlobal(question);
            if (!isCurrentRequest()) return;

            if (result?.fallback) {
                console.log("[GlobalChat] RAG unavailable, falling back to standard chat");
                cleanupActiveRequest();
                activeRequestIdRef.current = requestId;

                // Setup fallback listeners (Standard Gemini)
                streamBuffer.reset();
                const oldTokenCleanup = window.electronAPI?.onGeminiStreamToken((token: string) => {
                    if (!isCurrentRequest()) return;
                    setChatState('streaming_response');
                    streamBuffer.appendToken(token, (content) => {
                        if (!isCurrentRequest()) return;
                        setMessages(prev => prev.map(msg =>
                            msg.id === assistantMessageId
                                ? { ...msg, content }
                                : msg
                        ));
                    });
                });

                const oldDoneCleanup = window.electronAPI?.onGeminiStreamDone(() => {
                    if (!isCurrentRequest()) return;
                    const finalContent = streamBuffer.getBufferedContent();
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantMessageId
                            ? { ...msg, content: finalContent, isStreaming: false }
                            : msg
                    ));
                    setChatState('idle');
                    finishRequest();
                });

                const oldErrorCleanup = window.electronAPI?.onGeminiStreamError((error: string) => {
                    if (!isCurrentRequest()) return;
                    console.error('[GlobalChat] Gemini stream error:', error);
                    setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
                    setErrorMessage("Couldn't get a response. Please check your settings.");
                    setChatState('error');
                    finishRequest();
                });

                activeCleanupRef.current = [oldTokenCleanup, oldDoneCleanup, oldErrorCleanup].filter(Boolean) as Array<() => void>;

                // Call standard chat
                await window.electronAPI?.streamGeminiChat(question, undefined, undefined, { skipSystemPrompt: false });
            }

        } catch (error) {
            if (!isCurrentRequest()) return;
            console.error('[GlobalChat] Error:', error);
            setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
            setErrorMessage("Something went wrong. Please try again.");
            setChatState('error');
            finishRequest();
        }
    }, [cleanupActiveRequest, streamBuffer]);

    useEffect(() => {
        if (!isOpen) {
            lastHandledInitialQueryRef.current = '';
            return;
        }
        const trimmed = initialQuery.trim();
        if (trimmed && trimmed !== lastHandledInitialQueryRef.current) {
            lastHandledInitialQueryRef.current = trimmed;
            submitQuestion(initialQuery);
        }
    }, [isOpen, initialQuery, submitQuestion]);

    return (
        <AnimatePresence
            onExitComplete={() => {
                cleanupActiveRequest();
                setChatState('idle');
                setMessages([]);
                setErrorMessage(null);
            }}
        >
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    className="absolute inset-0 z-40 flex flex-col justify-end"
                    onClick={handleBackdropClick}
                >
                    {/* Backdrop with blur */}
                    <motion.div
                        initial={{ backdropFilter: 'blur(0px)' }}
                        animate={{ backdropFilter: 'blur(8px)' }}
                        exit={{ backdropFilter: 'blur(0px)' }}
                        transition={{ duration: 0.16 }}
                        className="absolute inset-0 bg-black/40"
                    />

                    {/* Chat Window */}
                    <motion.div
                        ref={chatWindowRef}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "85vh", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{
                            height: { type: "spring", stiffness: 300, damping: 30, mass: 0.8 },
                            opacity: { duration: 0.2 }
                        }}
                        className="relative mx-auto w-full max-w-[680px] mb-0 bg-bg-secondary dark:bg-[#0C0C0C] rounded-t-[24px] border-t border-x border-border-subtle shadow-2xl overflow-hidden flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
                            <div className="flex items-center gap-2 text-text-tertiary">
                                <img src={nativelyIcon} className="w-3.5 h-3.5 force-black-icon brightness-0 dark:brightness-100 dark:opacity-50 dark:grayscale" alt="logo" />
                                <span className="text-[13px] font-medium">Search all meetings</span>
                            </div>
                            <button
                                onClick={onClose}
                                className="p-2 transition-colors group"
                            >
                                <X size={16} className="text-text-tertiary group-hover:text-red-500 group-hover:drop-shadow-[0_0_8px_rgba(239,68,68,0.5)] transition-all duration-300" />
                            </button>
                        </div>

                        {/* Messages area - scrollable with improved spacing */}
                        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-8 py-6 pb-32 custom-scrollbar flex flex-col">
                            <AnimatePresence initial={false}>
                                {messages.map((msg, index) => (
                                    <div
                                        key={msg.id}
                                        data-autoscroll-message-id={msg.id}
                                    >
                                        {msg.role === 'user'
                                            ? <UserMessage 
                                                role={msg.role}
                                                content={msg.content}
                                                isNew={index === 0}
                                              />
                                            : <AssistantMessage 
                                                role={msg.role}
                                                content={msg.content} 
                                                isStreaming={msg.isStreaming}
                                                isNew={index === 0}
                                              />
                                        }
                                    </div>
                                ))}
                            </AnimatePresence>

                            {errorMessage && (
                                <motion.div
                                    initial={{ opacity: 0, y: 4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="
                                        px-5 
                                        py-3 
                                        rounded-xl 
                                        bg-red-50 
                                        dark:bg-red-900/20 
                                        border 
                                        border-red-200 
                                        dark:border-red-800/40 
                                        text-red-700 
                                        dark:text-red-400 
                                        text-sm
                                        mb-4
                                    "
                                >
                                    {errorMessage}
                                </motion.div>
                            )}

                        </div>

                        {/* Floating Footer (Ask Bar) */}
                        <div className="absolute bottom-0 left-0 right-0 p-6 flex justify-center z-50 pointer-events-none">
                            <div className="w-full max-w-[440px] relative group pointer-events-auto">
                                {/* Dark Glass Effect Input */}
                                <input
                                    type="text"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={handleInputKeyDown}
                                    placeholder="Ask me anything..."
                                    className="w-full pl-5 pr-12 py-3 bg-bg-elevated shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-border-muted dark:bg-bg-elevated/20 dark:backdrop-blur-xl dark:border-border-subtle rounded-full text-sm text-text-primary placeholder-text-tertiary/70 focus:outline-none transition-all"
                                />
                                <button
                                    onClick={() => {
                                        if (query.trim()) {
                                            submitQuestion(query);
                                            setQuery('');
                                        }
                                    }}
                                    className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full transition-all duration-200 border border-white/5 ${query.trim() ? 'bg-text-primary text-bg-primary hover:scale-105' : 'bg-bg-item-active text-text-primary hover:bg-bg-item-hover'
                                        }`}
                                >
                                    <ArrowUp size={16} className="transform rotate-45" />
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default GlobalChatOverlay;
