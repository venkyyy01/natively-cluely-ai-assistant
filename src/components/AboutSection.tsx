import React from 'react';
import {
    Shield, Cpu, Database,
    Star, Bug, Globe, Sparkles, Zap, MicOff, Package,
} from 'lucide-react';
import packageJson from '../../package.json';

interface AboutSectionProps { }

export const AboutSection: React.FC<AboutSectionProps> = () => {

    const handleOpenLink = (e: React.MouseEvent<HTMLAnchorElement>, url: string) => {
        e.preventDefault();

        if (window.electronAPI?.openExternal) {
            window.electronAPI.openExternal(url);
        } else {
            window.open(url, '_blank');
        }
    };

    const appVersion = packageJson.version;

    return (
        <div className="space-y-6 animated fadeIn pb-10">
            <div>
                <div className="flex flex-wrap items-center gap-2 mb-2">
                    <h3 className="text-lg font-bold text-text-primary">About Natively</h3>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-bg-item-surface border border-border-subtle text-[11px] font-semibold text-text-secondary tabular-nums">
                        <Package size={12} className="opacity-70" aria-hidden />
                        v{appVersion}
                    </span>
                </div>
                <p className="text-sm text-text-secondary">
                    A local-first meeting assistant: listen, reason, and recall context—without turning your call into a billboard.
                </p>
            </div>

            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">What&apos;s New in v2.0</h4>
                <div className="bg-bg-item-surface rounded-xl border border-border-subtle overflow-hidden">
                    <div className="p-3 border-b border-border-subtle bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-yellow-500/10 flex items-center justify-center text-yellow-400 shrink-0">
                                <Sparkles size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Profile Intelligence</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    Upload your Resume & Job Description for hyper-personalized interview assistance, company research, and salary negotiation tactics.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="p-3 border-b border-border-subtle bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 shrink-0">
                                <Zap size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Live Meeting RAG</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    Instant intelligent retrieval of context directly during a live meeting using local vectors.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="p-3 bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-pink-500/10 flex items-center justify-center text-pink-400 shrink-0">
                                <Globe size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Soniox & Multilingual</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    Ultra-fast streaming STT with Soniox. Set speech recognition specific to accents, dialects, and varied AI response languages.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">How Natively Works</h4>
                <div className="bg-bg-item-surface rounded-xl border border-border-subtle overflow-hidden">
                    <div className="p-3 border-b border-border-subtle bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400 shrink-0">
                                <Cpu size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Hybrid Intelligence</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    Seamlessly routes queries between ultra-fast models for instant speed and reasoning models (Gemini, OpenAI, Claude) for complex tasks. Powered by enterprise-grade speech recognition from 7+ providers.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="p-3 bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-400 shrink-0">
                                <Database size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Local RAG & Memory</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    A purely local vector memory system allows Natively to recall details from past meetings. Embeddings and retrieval happen on-device via SQLite for maximum privacy.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">Privacy & Data</h4>
                <div className="bg-bg-item-surface rounded-xl border border-border-subtle p-5 space-y-4">
                    <div className="flex items-start gap-3">
                        <Shield size={16} className="text-green-400 mt-0.5 shrink-0" />
                        <div>
                            <h5 className="text-sm font-medium text-text-primary">Stealth & Control</h5>
                            <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                                Features &quot;Undetectable Mode&quot; to hide from the dock and &quot;Masquerading&quot; to disguise as system apps. You control exactly what data leaves your device.
                            </p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3">
                        <MicOff size={16} className="text-red-500 mt-0.5 shrink-0" />
                        <div>
                            <h5 className="text-sm font-medium text-text-primary">No Recording</h5>
                            <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                                Natively listens only when active. It does not record video, take arbitrary screenshots without command, or perform background surveillance.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">Resources</h4>
                <div className="space-y-3">
                    <a
                        href="https://natively.software"
                        onClick={(e) => handleOpenLink(e, 'https://natively.software')}
                        className="bg-bg-item-surface border border-border-subtle rounded-xl p-4 flex items-center gap-4 transition-all hover:bg-white/5"
                    >
                        <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400 shrink-0">
                            <Globe size={18} />
                        </div>
                        <div className="min-w-0 flex-1">
                            <h5 className="text-sm font-bold text-text-primary">Website</h5>
                            <p className="text-xs text-text-secondary mt-0.5">Product updates and documentation</p>
                        </div>
                    </a>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <a
                            href="https://github.com/evinjohnn/natively-cluely-ai-assistant"
                            onClick={(e) => handleOpenLink(e, 'https://github.com/evinjohnn/natively-cluely-ai-assistant')}
                            className="bg-bg-item-surface border border-border-subtle rounded-xl p-4 transition-all group flex items-center gap-4 h-full hover:bg-white/5"
                        >
                            <div className="w-10 h-10 rounded-lg bg-yellow-500/10 flex items-center justify-center text-yellow-500 shrink-0 group-hover:scale-105 transition-transform">
                                <Star size={20} className="transition-all group-hover:fill-current" />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary">Star on GitHub</h5>
                                <p className="text-xs text-text-secondary mt-0.5">Helps others discover the project</p>
                            </div>
                        </a>

                        <a
                            href="https://github.com/evinjohnn/natively-cluely-ai-assistant/issues"
                            onClick={(e) => handleOpenLink(e, 'https://github.com/evinjohnn/natively-cluely-ai-assistant/issues')}
                            className="bg-bg-item-surface border border-border-subtle rounded-xl p-4 transition-all group flex items-center gap-4 h-full hover:bg-white/5"
                        >
                            <div className="w-10 h-10 rounded-lg bg-red-500/10 flex items-center justify-center text-red-500 shrink-0 group-hover:scale-105 transition-transform">
                                <Bug size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary">Report an issue</h5>
                                <p className="text-xs text-text-secondary mt-0.5">Bugs, crashes, or feature ideas</p>
                            </div>
                        </a>
                    </div>
                </div>
            </div>

            <p className="text-[11px] text-text-tertiary leading-relaxed border-t border-border-subtle pt-4">
                Open-source app. Local RAG and on-device workflows keep your transcripts and vectors on your machine; cloud AI providers are only used when you add API keys in Settings.
            </p>
        </div>
    );
};
