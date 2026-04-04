import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import 'katex/dist/katex.min.css';

// ============================================
// Types
// ============================================

interface ChatMessageProps {
    role: 'user' | 'assistant';
    content: string;
    isStreaming?: boolean;
    timestamp?: Date;
    isNew?: boolean;
}

// ============================================
// User Message Card
// ============================================

export const UserMessage: React.FC<ChatMessageProps> = ({ content, isNew = false }) => (
    <motion.article
        initial={isNew ? { opacity: 0, y: 12 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className="flex justify-end mb-5"
    >
        <div className="
            group
            relative
            max-w-[75ch]
            px-5 
            py-4
            rounded-2xl 
            rounded-tr-md
            bg-accent-primary/90
            dark:bg-accent-primary/80
            text-white
            shadow-sm
            hover:shadow-md
            transition-shadow
            duration-200
        ">
            <p className="text-base leading-relaxed whitespace-pre-wrap">
                {content}
            </p>
        </div>
    </motion.article>
);

// ============================================
// Assistant Message Card
// ============================================

export const AssistantMessage: React.FC<ChatMessageProps> = ({ 
    content, 
    isStreaming = false, 
    timestamp,
    isNew = false 
}) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    return (
        <motion.article
            initial={isNew ? { opacity: 0, y: 12 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-col items-start mb-5"
        >
            {/* Card Container */}
            <div className="
                group
                relative
                w-full
                max-w-[75ch]
                px-6
                py-5
                rounded-xl
                bg-bg-tertiary/95
                backdrop-blur-sm
                border
                border-border-subtle
                dark:border-white/[0.08]
                shadow-sm
                hover:shadow-md
                transition-all
                duration-200
            ">
                {/* Optional Timestamp Header */}
                {timestamp && (
                    <header className="flex items-center gap-2 mb-3 pb-3 border-b border-border-subtle dark:border-white/[0.06]">
                        <span className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                            Assistant
                        </span>
                        <span className="text-xs text-text-tertiary">
                            {timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                    </header>
                )}

                {/* Message Content */}
                <div className="
                    prose 
                    prose-slate 
                    dark:prose-invert 
                    max-w-none
                    prose-p:text-base
                    prose-p:leading-relaxed
                    prose-p:mb-4
                    prose-p:last:mb-0
                    prose-headings:mb-3
                    prose-headings:mt-6
                    prose-headings:first:mt-0
                    prose-code:text-sm
                    prose-li:my-1
                ">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex]}
                        components={{
                            p: ({ node, ...props }: any) => (
                                <p className="mb-4 last:mb-0 whitespace-pre-wrap text-text-primary" {...props} />
                            ),
                            strong: ({ node, ...props }: any) => (
                                <strong className="font-semibold text-text-primary" {...props} />
                            ),
                            em: ({ node, ...props }: any) => (
                                <em className="italic text-text-secondary" {...props} />
                            ),
                            ul: ({ node, ...props }: any) => (
                                <ul className="list-disc ml-5 mb-4 space-y-1.5" {...props} />
                            ),
                            ol: ({ node, ...props }: any) => (
                                <ol className="list-decimal ml-5 mb-4 space-y-1.5" {...props} />
                            ),
                            li: ({ node, ...props }: any) => (
                                <li className="pl-1 leading-relaxed" {...props} />
                            ),
                            a: ({ node, ...props }: any) => (
                                <a 
                                    className="text-accent-primary hover:underline" 
                                    target="_blank" 
                                    rel="noopener noreferrer" 
                                    {...props} 
                                />
                            ),
                            pre: ({ children }: any) => (
                                <div className="not-prose mb-4">{children}</div>
                            ),
                            code: ({ node, inline, className, children, ...props }: any) => {
                                const match = /language-(\w+)/.exec(className || '');
                                const isInline = inline ?? false;
                                const lang = match ? match[1] : '';

                                return !isInline ? (
                                    <div className="my-4 rounded-xl overflow-hidden border border-border-muted dark:border-white/[0.08] shadow-lg bg-zinc-800/60 dark:bg-zinc-900/60 backdrop-blur-md">
                                        <div className="bg-white/[0.04] px-3 py-1.5 border-b border-white/[0.08]">
                                            <span className="text-[10px] uppercase tracking-widest font-semibold text-white/40 font-mono">
                                                {lang || 'CODE'}
                                            </span>
                                        </div>
                                        <div className="bg-transparent">
                                            <SyntaxHighlighter
                                                language={lang || 'text'}
                                                style={vscDarkPlus}
                                                customStyle={{
                                                    margin: 0,
                                                    borderRadius: 0,
                                                    fontSize: '14px',
                                                    lineHeight: '1.6',
                                                    background: 'transparent',
                                                    padding: '16px',
                                                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
                                                }}
                                                wrapLongLines={true}
                                                showLineNumbers={true}
                                                lineNumberStyle={{ 
                                                    minWidth: '2.5em', 
                                                    paddingRight: '1.2em', 
                                                    color: 'rgba(255,255,255,0.2)', 
                                                    textAlign: 'right', 
                                                    fontSize: '12px' 
                                                }}
                                                {...props}
                                            >
                                                {String(children).replace(/\n$/, '')}
                                            </SyntaxHighlighter>
                                        </div>
                                    </div>
                                ) : (
                                    <code 
                                        className="bg-bg-input dark:bg-white/[0.06] px-1.5 py-0.5 rounded text-sm font-mono text-text-primary border border-border-subtle dark:border-white/[0.08]" 
                                        {...props}
                                    >
                                        {children}
                                    </code>
                                );
                            },
                            blockquote: ({ node, ...props }: any) => (
                                <blockquote 
                                    className="my-3 border-l-2 border-accent-primary pl-4 italic text-text-secondary" 
                                    {...props} 
                                />
                            ),
                        }}
                    >
                        {content}
                    </ReactMarkdown>
                </div>

                {/* Streaming Cursor */}
                {isStreaming && (
                    <motion.span
                        className="inline-block w-0.5 h-4 bg-accent-primary ml-0.5 align-middle"
                        animate={{ opacity: [1, 0] }}
                        transition={{ duration: 0.5, repeat: Infinity }}
                    />
                )}

                {/* Accent Line (Hover Indicator) */}
                <div className="
                    absolute 
                    -left-3 
                    top-6 
                    w-1 
                    h-10 
                    rounded-full 
                    bg-accent-primary
                    opacity-0 
                    group-hover:opacity-100 
                    transition-opacity
                    duration-200
                " />
            </div>

            {/* Copy Button */}
            {!isStreaming && content && (
                <button
                    onClick={handleCopy}
                    className="
                        flex 
                        items-center 
                        gap-2 
                        mt-3 
                        ml-2
                        px-3
                        py-1.5
                        rounded-lg
                        text-[13px] 
                        text-text-tertiary 
                        hover:text-text-primary
                        hover:bg-bg-input
                        dark:hover:bg-white/[0.04]
                        transition-all
                        duration-150
                    "
                >
                    {copied ? (
                        <>
                            <Check size={14} className="text-emerald-500" />
                            <span>Copied</span>
                        </>
                    ) : (
                        <>
                            <Copy size={14} />
                            <span>Copy message</span>
                        </>
                    )}
                </button>
            )}
        </motion.article>
    );
};
