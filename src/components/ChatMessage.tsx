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
            <span className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400">
                YOU
            </span>
            {timestamp && (
                <span className="text-xs font-medium text-slate-500 dark:text-slate-500">
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
            <p className="text-[15px] font-medium leading-[1.75] whitespace-pre-wrap text-slate-900 dark:text-slate-100 antialiased">
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
                <span className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400">
                    AI
                </span>
                {timestamp && (
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-500">
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
                    prose-p:font-normal
                    prose-p:leading-[1.8]
                    prose-p:mb-4
                    prose-p:last:mb-0
                    prose-p:text-slate-900
                    dark:prose-p:text-slate-50
                    prose-p:antialiased
                    prose-headings:mb-3
                    prose-headings:mt-6
                    prose-headings:first:mt-0
                    prose-headings:font-bold
                    prose-headings:text-slate-900
                    dark:prose-headings:text-slate-50
                    prose-code:text-sm
                    prose-code:font-semibold
                    prose-li:my-1
                ">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex]}
                        components={{
                            p: ({ node, ...props }: any) => (
                                <p className="mb-4 last:mb-0 whitespace-pre-wrap text-[15px] font-normal leading-[1.8] text-slate-900 dark:text-slate-50 antialiased" {...props} />
                            ),
                            strong: ({ node, ...props }: any) => (
                                <strong className="font-bold text-slate-950 dark:text-white" {...props} />
                            ),
                            em: ({ node, ...props }: any) => (
                                <em className="italic font-medium text-slate-800 dark:text-slate-200" {...props} />
                            ),
                            ul: ({ node, ...props }: any) => (
                                <ul className="list-disc ml-5 mb-4 space-y-2 text-slate-900 dark:text-slate-50" {...props} />
                            ),
                            ol: ({ node, ...props }: any) => (
                                <ol className="list-decimal ml-5 mb-4 space-y-2 text-slate-900 dark:text-slate-50" {...props} />
                            ),
                            li: ({ node, ...props }: any) => (
                                <li className="pl-1 leading-[1.75] font-normal" {...props} />
                            ),
                            a: ({ node, ...props }: any) => (
                                <a 
                                    className="text-blue-700 dark:text-blue-300 hover:underline font-medium underline-offset-2" 
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
                                            <span className="text-[10px] uppercase tracking-widest font-bold text-slate-600 dark:text-slate-300 font-mono">
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
                                                    lineHeight: '1.7',
                                                    background: 'transparent',
                                                    padding: '18px',
                                                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                                                    fontWeight: '500'
                                                }}
                                                wrapLongLines={true}
                                                showLineNumbers={true}
                                                lineNumberStyle={{ 
                                                    minWidth: '2.8em', 
                                                    paddingRight: '1.4em', 
                                                    color: 'rgba(148, 163, 184, 0.4)', 
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
                                        className="bg-slate-200 dark:bg-[#25252a] px-2 py-0.5 rounded text-[13px] font-semibold text-slate-900 dark:text-slate-100 border border-slate-300/60 dark:border-white/[0.08]" 
                                        {...props}
                                    >
                                        {children}
                                    </code>
                                );
                            },
                            blockquote: ({ node, ...props }: any) => (
                                <blockquote 
                                    className="my-4 border-l-3 border-blue-500/60 dark:border-blue-400/40 pl-4 py-1 italic font-medium text-slate-700 dark:text-slate-300 bg-slate-100/50 dark:bg-white/[0.02] rounded-r" 
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
                        font-semibold
                        text-slate-700
                        dark:text-slate-300
                        hover:text-slate-900
                        dark:hover:text-slate-100
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
                            <Check size={13} className="text-emerald-600 dark:text-emerald-400" />
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
