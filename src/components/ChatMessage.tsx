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

export const UserMessage: React.FC<ChatMessageProps> = ({ content, timestamp, isNew = false }) => (
    <motion.article
        initial={isNew ? { opacity: 0, y: 12 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="mb-8 w-full"
    >
        {/* Enhanced Label + Timestamp */}
        <div className="flex items-center gap-2 mb-3 px-1">
            <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500" />
                <span className="text-xs font-bold uppercase tracking-wider bg-gradient-to-r from-emerald-600 to-teal-600 dark:from-emerald-400 dark:to-teal-400 bg-clip-text text-transparent">
                    You
                </span>
            </div>
            {timestamp && (
                <span className="text-xs font-medium text-text-tertiary">
                    {timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
            )}
        </div>

        {/* Enhanced Message Card with Emerald Accent */}
        <motion.div 
            className="
                relative
                pl-6
                pr-6
                py-5
                rounded-2xl
                bg-bg-card
                border-l-[3px]
                border-emerald-500/80
                dark:border-emerald-400/60
                shadow-lg
                dark:shadow-2xl
                dark:shadow-black/20
                border-t
                border-r
                border-b
                border-border-subtle
            "
            style={{
                background: `
                    linear-gradient(145deg, 
                        var(--bg-card) 0%, 
                        color-mix(in srgb, var(--bg-card) 95%, #10b981 5%) 100%
                    )
                `,
            }}
            initial={isNew ? { scale: 0.98, opacity: 0 } : false}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.3, ease: [0.34, 1.56, 0.64, 1] }}
        >
            {/* Glossy top border highlight */}
            <div 
                className="absolute top-0 left-0 right-0 h-px"
                style={{
                    background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.1) 50%, transparent 100%)'
                }}
            />
            
            <p className="text-[15px] font-normal leading-[1.85] whitespace-pre-wrap text-text-primary antialiased">
                {content}
            </p>
        </motion.div>
    </motion.article>
);

// ============================================
// Assistant Message (No Card)
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
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="mb-8 w-full"
        >
            {/* Enhanced Label + Timestamp with Glass Effect */}
            <div className="flex items-center justify-between mb-3 px-1">
                <div className="flex items-center gap-2">
                    <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-gradient-to-r from-blue-500 to-purple-500 animate-pulse" />
                        <span className="text-xs font-bold uppercase tracking-wider bg-gradient-to-r from-blue-600 to-purple-600 dark:from-blue-400 dark:to-purple-400 bg-clip-text text-transparent">
                            Assistant
                        </span>
                    </div>
                    {timestamp && (
                        <span className="text-xs font-medium text-text-tertiary">
                            {timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                    )}
                </div>
                
                {/* Copy Button - Moved to header for better UX */}
                {!isStreaming && content && (
                    <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={handleCopy}
                        className="
                            flex 
                            items-center 
                            gap-1.5
                            px-3
                            py-1.5
                            rounded-lg
                            text-xs
                            font-semibold
                            text-text-secondary
                            hover:text-text-primary
                            bg-bg-item-surface
                            hover:bg-bg-item-active
                            border
                            border-border-subtle
                            hover:border-border-muted
                            transition-all
                            duration-200
                            interaction-base
                        "
                    >
                        {copied ? (
                            <>
                                <Check size={13} className="text-emerald-500 dark:text-emerald-400" />
                                <span>Copied</span>
                            </>
                        ) : (
                            <>
                                <Copy size={13} />
                                <span>Copy</span>
                            </>
                        )}
                    </motion.button>
                )}
            </div>

            {/* Enhanced Message Card with Glossy Glass Effect */}
            <motion.div 
                className="
                    relative
                    overflow-hidden
                    rounded-2xl
                    bg-bg-card
                    border
                    border-border-subtle
                    shadow-lg
                    dark:shadow-2xl
                    dark:shadow-black/20
                "
                style={{
                    background: `
                        linear-gradient(145deg, 
                            var(--bg-card) 0%, 
                            color-mix(in srgb, var(--bg-card) 95%, var(--accent-primary) 5%) 100%
                        )
                    `,
                    backdropFilter: 'blur(12px)',
                    WebkitBackdropFilter: 'blur(12px)',
                }}
                initial={isNew ? { scale: 0.98, opacity: 0 } : false}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.3, ease: [0.34, 1.56, 0.64, 1] }}
            >
                {/* Glossy top border highlight */}
                <div 
                    className="absolute top-0 left-0 right-0 h-px"
                    style={{
                        background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.1) 50%, transparent 100%)'
                    }}
                />
                
                {/* Content Area with Enhanced Padding */}
                <div className="relative px-6 py-5">
                    <div className="
                        prose 
                        prose-slate 
                        dark:prose-invert 
                        max-w-none
                        prose-p:text-[15px]
                        prose-p:font-normal
                        prose-p:leading-[1.85]
                        prose-p:mb-4
                        prose-p:last:mb-0
                        prose-p:text-text-primary
                        prose-p:antialiased
                        prose-headings:mb-4
                        prose-headings:mt-6
                        prose-headings:first:mt-0
                        prose-headings:font-bold
                        prose-headings:text-text-primary
                        prose-h1:text-2xl
                        prose-h2:text-xl
                        prose-h3:text-lg
                        prose-code:text-sm
                        prose-code:font-semibold
                        prose-li:my-1.5
                        prose-ul:space-y-2
                        prose-ol:space-y-2
                    ">
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[rehypeKatex]}
                            components={{
                                p: ({ node, ...props }: any) => (
                                    <p className="mb-4 last:mb-0 whitespace-pre-wrap text-[15px] font-normal leading-[1.85] text-text-primary antialiased" {...props} />
                                ),
                                strong: ({ node, ...props }: any) => (
                                    <strong className="font-bold text-text-primary" {...props} />
                                ),
                                em: ({ node, ...props }: any) => (
                                    <em className="italic font-medium text-text-secondary" {...props} />
                                ),
                                ul: ({ node, ...props }: any) => (
                                    <ul className="list-disc ml-6 mb-4 space-y-2 text-text-primary" {...props} />
                                ),
                                ol: ({ node, ...props }: any) => (
                                    <ol className="list-decimal ml-6 mb-4 space-y-2 text-text-primary" {...props} />
                                ),
                                li: ({ node, ...props }: any) => (
                                    <li className="pl-2 leading-[1.8] font-normal" {...props} />
                                ),
                                a: ({ node, ...props }: any) => (
                                    <a 
                                        className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 underline decoration-blue-500/30 hover:decoration-blue-500/60 underline-offset-2 transition-colors font-medium" 
                                        target="_blank" 
                                        rel="noopener noreferrer" 
                                        {...props} 
                                    />
                                ),
                                pre: ({ children }: any) => (
                                    <div className="not-prose my-5">{children}</div>
                                ),
                                code: ({ node, inline, className, children, ...props }: any) => {
                                    const match = /language-(\w+)/.exec(className || '');
                                    const isInline = inline ?? false;
                                    const lang = match ? match[1] : '';

                                    return !isInline ? (
                                        <div className="my-5 rounded-xl overflow-hidden border border-border-muted shadow-md bg-bg-elevated">
                                            <div className="bg-bg-item-surface px-4 py-2.5 border-b border-border-subtle">
                                                <span className="text-[10px] uppercase tracking-widest font-bold text-text-secondary font-mono">
                                                    {lang || 'CODE'}
                                                </span>
                                            </div>
                                            <div className="bg-bg-elevated">
                                                <SyntaxHighlighter
                                                    language={lang || 'text'}
                                                    style={vscDarkPlus}
                                                    customStyle={{
                                                        margin: 0,
                                                        borderRadius: 0,
                                                        fontSize: '14px',
                                                        lineHeight: '1.7',
                                                        background: 'transparent',
                                                        padding: '20px',
                                                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                                                        fontWeight: '500'
                                                    }}
                                                    wrapLongLines={true}
                                                    showLineNumbers={true}
                                                    lineNumberStyle={{ 
                                                        minWidth: '3em', 
                                                        paddingRight: '1.5em', 
                                                        color: 'var(--text-tertiary)', 
                                                        textAlign: 'right', 
                                                        fontSize: '12px',
                                                        fontWeight: '500'
                                                    }}
                                                    {...props}
                                                >
                                                    {String(children).replace(/\n$/, '')}
                                                </SyntaxHighlighter>
                                            </div>
                                        </div>
                                    ) : (
                                        <code 
                                            className="bg-bg-item-surface px-2.5 py-1 rounded-md text-[13px] font-semibold text-text-primary border border-border-subtle" 
                                            {...props}
                                        >
                                            {children}
                                        </code>
                                    );
                                },
                                blockquote: ({ node, ...props }: any) => (
                                    <div className="my-5 relative">
                                        <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-blue-500 to-purple-500 rounded-full" />
                                        <blockquote 
                                            className="pl-6 py-2 italic font-medium text-text-secondary bg-bg-item-surface/50 rounded-r-lg border-l-0" 
                                            {...props} 
                                        />
                                    </div>
                                ),
                            }}
                        >
                            {content}
                        </ReactMarkdown>
                    </div>

                    {/* Enhanced Streaming Cursor */}
                    {isStreaming && (
                        <motion.span
                            className="inline-block w-0.5 h-5 bg-gradient-to-t from-blue-500 to-purple-500 ml-1 align-middle rounded-full"
                            animate={{ opacity: [1, 0.3, 1] }}
                            transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
                        />
                    )}
                </div>

                {/* Subtle bottom gradient for depth */}
                <div 
                    className="absolute bottom-0 left-0 right-0 h-px"
                    style={{
                        background: 'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.05) 50%, transparent 100%)'
                    }}
                />
            </motion.div>
        </motion.article>
    );
};
