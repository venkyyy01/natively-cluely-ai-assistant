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
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className="mb-6 w-full"
    >
        {/* Label + Timestamp */}
        <div className="flex items-center gap-2 mb-2.5 px-1">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                YOU
            </span>
            {timestamp && (
                <span className="text-xs text-slate-400/70 dark:text-slate-600">
                    {timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
            )}
        </div>

        {/* Message Card with Left Accent - Softer, More Opaque Background */}
        <div className="
            relative
            pl-5
            pr-6
            py-4
            rounded-xl
            bg-slate-100
            dark:bg-[#1e1e22]
            border-l-[3px]
            border-blue-500/80
            dark:border-blue-400/60
            shadow-sm
            dark:shadow-none
        ">
            <p className="text-base leading-[1.7] whitespace-pre-wrap text-slate-800 dark:text-slate-200">
                {content}
            </p>
        </div>
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
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="mb-6 w-full"
        >
            {/* Label + Timestamp */}
            <div className="flex items-center gap-2 mb-2.5 px-1">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                    AI
                </span>
                {timestamp && (
                    <span className="text-xs text-slate-400/70 dark:text-slate-600">
                        {timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                )}
            </div>

            {/* Message Content - Subtle Background for Better Readability */}
            <div className="
                px-5
                py-4
                rounded-xl
                bg-slate-50/50
                dark:bg-[#18181b]/40
                border
                border-slate-200/50
                dark:border-white/[0.06]
            ">
                <div className="
                    prose 
                    prose-slate 
                    dark:prose-invert 
                    max-w-none
                    prose-p:text-[15px]
                    prose-p:leading-[1.7]
                    prose-p:mb-4
                    prose-p:last:mb-0
                    prose-p:text-slate-700
                    dark:prose-p:text-slate-300
                    prose-headings:mb-3
                    prose-headings:mt-6
                    prose-headings:first:mt-0
                    prose-headings:text-slate-800
                    dark:prose-headings:text-slate-200
                    prose-code:text-sm
                    prose-li:my-1
                ">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex]}
                        components={{
                            p: ({ node, ...props }: any) => (
                                <p className="mb-4 last:mb-0 whitespace-pre-wrap text-slate-700 dark:text-slate-300" {...props} />
                            ),
                            strong: ({ node, ...props }: any) => (
                                <strong className="font-semibold text-slate-800 dark:text-slate-200" {...props} />
                            ),
                            em: ({ node, ...props }: any) => (
                                <em className="italic text-slate-600 dark:text-slate-400" {...props} />
                            ),
                            ul: ({ node, ...props }: any) => (
                                <ul className="list-disc ml-5 mb-4 space-y-1.5 text-slate-700 dark:text-slate-300" {...props} />
                            ),
                            ol: ({ node, ...props }: any) => (
                                <ol className="list-decimal ml-5 mb-4 space-y-1.5 text-slate-700 dark:text-slate-300" {...props} />
                            ),
                            li: ({ node, ...props }: any) => (
                                <li className="pl-1 leading-relaxed" {...props} />
                            ),
                            a: ({ node, ...props }: any) => (
                                <a 
                                    className="text-blue-600 dark:text-blue-400 hover:underline" 
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
                                    <div className="my-4 rounded-xl overflow-hidden border border-slate-200 dark:border-[#2a2a2f] shadow-sm dark:shadow-lg bg-slate-100 dark:bg-[#1a1a1e]">
                                        <div className="bg-slate-200/80 dark:bg-[#25252a] px-4 py-2 border-b border-slate-300/50 dark:border-white/[0.08]">
                                            <span className="text-[10px] uppercase tracking-widest font-semibold text-slate-500 dark:text-slate-400 font-mono">
                                                {lang || 'CODE'}
                                            </span>
                                        </div>
                                        <div className="bg-white dark:bg-[#1a1a1e]">
                                            <SyntaxHighlighter
                                                language={lang || 'text'}
                                                style={vscDarkPlus}
                                                customStyle={{
                                                    margin: 0,
                                                    borderRadius: 0,
                                                    fontSize: '14px',
                                                    lineHeight: '1.65',
                                                    background: 'transparent',
                                                    padding: '18px',
                                                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
                                                }}
                                                wrapLongLines={true}
                                                showLineNumbers={true}
                                                lineNumberStyle={{ 
                                                    minWidth: '2.8em', 
                                                    paddingRight: '1.4em', 
                                                    color: 'rgba(148, 163, 184, 0.3)', 
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
                                        className="bg-slate-200 dark:bg-[#25252a] px-1.5 py-0.5 rounded text-sm font-mono text-slate-800 dark:text-slate-300 border border-slate-300/60 dark:border-white/[0.08]" 
                                        {...props}
                                    >
                                        {children}
                                    </code>
                                );
                            },
                            blockquote: ({ node, ...props }: any) => (
                                <blockquote 
                                    className="my-4 border-l-3 border-blue-500/60 dark:border-blue-400/40 pl-4 py-1 italic text-slate-600 dark:text-slate-400 bg-slate-100/50 dark:bg-white/[0.02] rounded-r" 
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
                        className="inline-block w-0.5 h-4 bg-blue-500 dark:bg-blue-400 ml-0.5 align-middle"
                        animate={{ opacity: [1, 0] }}
                        transition={{ duration: 0.5, repeat: Infinity }}
                    />
                )}
            </div>

            {/* Copy Button */}
            {!isStreaming && content && (
                <button
                    onClick={handleCopy}
                    className="
                        flex 
                        items-center 
                        gap-1.5
                        mt-3 
                        px-3
                        py-1.5
                        rounded-lg
                        text-xs
                        text-slate-600
                        dark:text-slate-400
                        hover:text-slate-700
                        dark:hover:text-slate-300
                        hover:bg-slate-200/60
                        dark:hover:bg-white/[0.05]
                        border
                        border-transparent
                        hover:border-slate-300/50
                        dark:hover:border-white/[0.08]
                        transition-all
                        duration-150
                    "
                >
                    {copied ? (
                        <>
                            <Check size={13} className="text-emerald-600 dark:text-emerald-500" />
                            <span>Copied</span>
                        </>
                    ) : (
                        <>
                            <Copy size={13} />
                            <span>Copy</span>
                        </>
                    )}
                </button>
            )}
        </motion.article>
    );
};
