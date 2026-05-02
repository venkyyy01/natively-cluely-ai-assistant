import React from 'react';
import {
    Github, Shield, Cpu, Database,
    Globe, Sparkles, Zap
} from 'lucide-react';

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

    return (
        <div className="space-y-6 animated fadeIn pb-10">
            {/* Header */}
            <div>
                <h3 className="text-lg font-bold text-text-primary mb-1">Natively</h3>
                <p className="text-sm text-text-secondary">Invisible AI interview assistant. How to use every feature.</p>
            </div>

            {/* Features */}
            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">Features</h4>
                <div className="bg-bg-item-surface rounded-xl border border-border-subtle overflow-hidden">
                    {/* Live Transcription */}
                    <div className="p-3 border-b border-border-subtle bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400 shrink-0">
                                <Cpu size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Live Transcription</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    Real-time speech-to-text during meetings using Deepgram, OpenAI, Soniox, or ElevenLabs. Choose your provider and language in Settings. Use this during any interview or call to capture everything being said.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* AI Copilot */}
                    <div className="p-3 border-b border-border-subtle bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-yellow-500/10 flex items-center justify-center text-yellow-400 shrink-0">
                                <Sparkles size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">AI Copilot &mdash; What Should I Say</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    Press the shortcut or enable Conscious Mode for auto-suggestions. The AI analyzes the conversation and suggests answers. Use when you are asked a question or stuck on how to respond. Works best when Profile Intelligence is loaded.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Screenshots */}
                    <div className="p-3 border-b border-border-subtle bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 shrink-0">
                                <Database size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Screenshots & Visual Context</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    Attach screenshots so the AI can see your screen. Use for live coding rounds, system-design diagrams, or any visual question. Press the global shortcuts or use the in-app buttons to capture.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Profile Intelligence */}
                    <div className="p-3 border-b border-border-subtle bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-pink-500/10 flex items-center justify-center text-pink-400 shrink-0">
                                <Globe size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Profile Intelligence</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    Upload your Resume and the Job Description in Settings. The AI tailors every answer to your background and the specific role. Set this up once before your interview and answers become instantly personalized.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Live RAG */}
                    <div className="p-3 border-b border-border-subtle bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-400 shrink-0">
                                <Database size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Live Meeting RAG</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    Automatically retrieves relevant context from past meetings while you talk. Runs entirely on-device via SQLite and local embeddings. No setup required; it learns as you use it.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Stealth */}
                    <div className="p-3 bg-bg-card/50">
                        <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-lg bg-red-500/10 flex items-center justify-center text-red-400 shrink-0">
                                <Shield size={20} />
                            </div>
                            <div>
                                <h5 className="text-sm font-bold text-text-primary mb-1">Stealth Mode</h5>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                    Hide the app from the dock, disguise its name and icon, or enable Undetectable Mode. Use during screen shares or whenever you need the assistant to stay invisible.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Shortcuts */}
            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">Global Shortcuts</h4>
                <div className="bg-bg-item-surface rounded-xl border border-border-subtle p-4 space-y-3">
                    <div className="flex items-center justify-between text-xs text-text-secondary">
                        <span className="text-text-primary font-medium">Full Screenshot</span>
                        <span>Cmd + Opt + Shift + S</span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-text-secondary">
                        <span className="text-text-primary font-medium">Selective Screenshot</span>
                        <span>Cmd + Opt + Shift + A</span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-text-secondary">
                        <span className="text-text-primary font-medium">Toggle Visibility</span>
                        <span>Cmd + Opt + Shift + V</span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-text-secondary">
                        <span className="text-text-primary font-medium">Process / Submit</span>
                        <span>Ctrl + Enter</span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-text-secondary">
                        <span className="text-text-primary font-medium">Reset / Cancel</span>
                        <span>Ctrl + R</span>
                    </div>
                </div>
            </div>

            {/* License & Attribution */}
            <div>
                <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">Source & License</h4>
                <div className="bg-bg-item-surface rounded-xl border border-border-subtle p-5 space-y-4">
                    <p className="text-xs text-text-secondary leading-relaxed">
                        This application is derived from open-source code originally published on GitHub. It is licensed under the <strong>GNU Affero General Public License v3.0 (AGPL-3.0)</strong>. The full source code and license text are linked below.
                    </p>
                    <p className="text-xs text-text-secondary leading-relaxed">
                        This program is free software: you can redistribute it and/or modify it under the terms of the AGPL. There is no warranty, to the extent permitted by law.
                    </p>
                    <div className="flex flex-wrap gap-3">
                        <a
                            href="https://github.com/evinjohnn/natively-cluely-ai-assistant"
                            onClick={(e) => handleOpenLink(e, "https://github.com/evinjohnn/natively-cluely-ai-assistant")}
                            className="px-3 py-2 bg-text-primary hover:bg-white/90 text-bg-main text-xs font-bold rounded-lg transition-all shadow flex items-center gap-2"
                        >
                            <Github size={14} />
                            View Source
                        </a>
                        <a
                            href="https://www.gnu.org/licenses/agpl-3.0.html"
                            onClick={(e) => handleOpenLink(e, "https://www.gnu.org/licenses/agpl-3.0.html")}
                            className="px-3 py-2 bg-bg-input border border-border-subtle text-text-primary text-xs font-bold rounded-lg transition-all hover:bg-white/5 flex items-center gap-2"
                        >
                            <Zap size={14} />
                            AGPL-3.0 License
                        </a>
                    </div>
                </div>
            </div>
        </div>
    );
};
