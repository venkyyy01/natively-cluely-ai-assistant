import React, { useState, useEffect } from 'react';
import { Lock, Key, ExternalLink, CheckCircle, AlertCircle, Copy, Check, X, Sparkles } from 'lucide-react';

interface PremiumUpgradeModalProps {
    isOpen: boolean;
    onClose: () => void;
    onActivated: () => void;
    onDeactivated?: () => void;
    isPremium?: boolean;
}

/**
 * Premium Upgrade Modal — Shown when non-premium users try to access Profile/JD features.
 * Provides Gumroad purchase link, license key input, and hardware ID display.
 *
 * ⚠️  PRIVATE FILE — Do NOT commit to the public/OSS repository.
 */
export const PremiumUpgradeModal: React.FC<PremiumUpgradeModalProps> = ({ isOpen, onClose, onActivated, onDeactivated, isPremium }) => {
    const [licenseKey, setLicenseKey] = useState('');
    const [hardwareId, setHardwareId] = useState('');
    const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [copiedHwid, setCopiedHwid] = useState(false);

    useEffect(() => {
        if (isOpen) {
            window.electronAPI?.licenseGetHardwareId?.().then(setHardwareId).catch(() => setHardwareId('unavailable'));
            setStatus('idle');
            setErrorMessage('');
            setLicenseKey('');
        }
    }, [isOpen]);

    const handleActivate = async () => {
        if (!licenseKey.trim()) return;
        setStatus('loading');
        setErrorMessage('');

        try {
            const result = await window.electronAPI?.licenseActivate?.(licenseKey.trim());
            if (result?.success) {
                setStatus('success');
                setTimeout(() => {
                    onActivated();
                    onClose();
                }, 1200);
            } else {
                setStatus('error');
                setErrorMessage(result?.error || 'Activation failed. Please try again.');
            }
        } catch (e: any) {
            setStatus('error');
            setErrorMessage(e.message || 'Activation failed.');
        }
    };

    const handleDeactivate = async () => {
        try {
            await window.electronAPI?.licenseDeactivate?.();
            onDeactivated?.();
            onClose();
        } catch (e: any) {
            setErrorMessage(e.message || 'Deactivation failed.');
        }
    };

    const copyHardwareId = () => {
        navigator.clipboard.writeText(hardwareId);
        setCopiedHwid(true);
        setTimeout(() => setCopiedHwid(false), 2000);
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center" onClick={onClose}>
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

            {/* Modal */}
            <div
                className="relative w-[380px] bg-[#111111] border border-white/[0.06] rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.05)] overflow-hidden animated fadeIn"
                onClick={(e) => e.stopPropagation()}
            >

                {/* Close button */}
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 text-text-tertiary hover:text-text-primary transition-colors z-10"
                >
                    <X size={16} />
                </button>

                {/* Content */}
                <div className="p-6">
                    {/* Header */}
                    <div className="flex flex-col items-center text-center gap-3 mb-1">
                        <div className="w-10 h-10 rounded-[10px] bg-white/[0.03] border border-white/[0.05] flex items-center justify-center shadow-inner relative group transition-transform duration-500 hover:scale-105">
                            <Lock size={16} className="text-white/70" strokeWidth={2} />
                        </div>
                        <div>
                            <h2 className="text-[15px] font-medium text-white/90 tracking-tight">Unlock Pro</h2>
                            <p className="text-[12px] text-white/40 mt-1 max-w-[260px] mx-auto leading-relaxed">Profile Engine & Job Description Intelligence</p>
                        </div>
                    </div>

                    {/* Feature list */}
                    <div className="mt-5 space-y-2 bg-white/[0.02] border border-white/[0.04] rounded-xl p-4">
                        {[
                            'Professional Identity Graph',
                            'JD analysis & persona tuning',
                            'Company research & salaries',
                            'Mock interviews & gap analysis'
                        ].map((feature, i) => (
                            <div key={i} className="flex items-center gap-2.5">
                                <div className="w-[14px] h-[14px] rounded-[4px] bg-white/[0.05] border border-white/[0.05] flex items-center justify-center shrink-0">
                                    <Check size={8} className="text-white/60" strokeWidth={3} />
                                </div>
                                <span className="text-[12px] text-white/60">{feature}</span>
                            </div>
                        ))}
                    </div>

                    {/* Buy button */}
                    <button
                        onClick={() => window.electronAPI?.openExternal?.('https://evynignatious.gumroad.com/l/natively')}
                        className="mt-5 w-full py-2.5 rounded-[10px] bg-[#FACC15] text-black text-[12px] font-semibold hover:bg-[#FDE047] active:scale-[0.98] transition-all duration-200 flex items-center justify-center shadow-[0_0_15px_rgba(250,204,21,0.15)] hover:shadow-[0_0_20px_rgba(250,204,21,0.25)]"
                    >
                        Purchase License
                    </button>

                    {/* Separator */}
                    <div className="flex items-center gap-3 my-4">
                        <div className="flex-1 h-px bg-white/[0.04]" />
                        <span className="text-[9px] text-white/30 uppercase tracking-widest font-medium">Already purchased?</span>
                        <div className="flex-1 h-px bg-white/[0.04]" />
                    </div>

                    {isPremium ? (
                        <div className="space-y-4">
                            <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 flex flex-col items-center justify-center text-center">
                                <CheckCircle size={24} className="text-green-400 mb-2" />
                                <h3 className="text-[13px] font-bold text-green-400">Pro License Active</h3>
                                <p className="text-[11px] text-green-400/70 mt-1">This device is authorized for all premium features.</p>
                            </div>

                            <button
                                onClick={handleDeactivate}
                                className="w-full py-2.5 rounded-[10px] bg-red-500/10 text-red-400 border border-red-500/20 text-[12px] font-medium hover:bg-red-500/20 active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2"
                            >
                                <X size={14} /> Deactivate License
                            </button>
                            <p className="text-[10px] text-white/30 text-center px-4 leading-relaxed">
                                Deactivating will remove the license from this device, allowing you to use it on another computer.
                            </p>
                        </div>
                    ) : (
                        <>
                            {/* License key input for non-premium */}
                            <div className="space-y-2.5">
                                <div className="relative">
                                    <Key size={12} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30" />
                                    <input
                                        type="text"
                                        value={licenseKey}
                                        onChange={(e) => setLicenseKey(e.target.value)}
                                        onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
                                        placeholder="Enter your license key"
                                        disabled={status === 'loading' || status === 'success'}
                                        className="w-full bg-black/30 border border-white/[0.06] rounded-[10px] pl-9 pr-3 py-2 text-[12px] text-white/90 placeholder-white/20 focus:outline-none focus:border-white/20 focus:bg-black/50 transition-all disabled:opacity-50 shadow-inner"
                                    />
                                </div>

                                <button
                                    onClick={handleActivate}
                                    disabled={!licenseKey.trim() || status === 'loading' || status === 'success'}
                                    className={`w-full py-2.5 rounded-[10px] text-[12px] font-medium transition-all duration-200 flex items-center justify-center gap-2 ${status === 'success'
                                        ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                                        : status === 'loading'
                                            ? 'bg-white/[0.02] border border-white/[0.05] text-white/30 cursor-wait'
                                            : !licenseKey.trim()
                                                ? 'bg-white/[0.02] border border-white/[0.05] text-white/30 cursor-not-allowed'
                                                : 'bg-white/90 text-black hover:bg-white active:scale-[0.98]'
                                        }`}
                                >
                                    {status === 'success' ? (
                                        <><CheckCircle size={12} /> Activated!</>
                                    ) : status === 'loading' ? (
                                        <><div className="w-3 h-3 border-2 border-white/20 border-t-transparent rounded-full animate-spin" /> Verifying...</>
                                    ) : (
                                        <><Lock size={12} /> Activate License</>
                                    )}
                                </button>

                                {/* Error message */}
                                {status === 'error' && errorMessage && (
                                    <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-[11px] text-red-500 font-medium animated fadeIn">
                                        <AlertCircle size={12} /> {errorMessage}
                                    </div>
                                )}
                            </div>
                        </>
                    )}

                    {/* Hardware ID */}
                    {hardwareId && (
                        <div className="mt-4 pt-3 border-t border-white/[0.04]">
                            <div className="flex items-center justify-between">
                                <span className="text-[9px] text-white/30 uppercase tracking-widest font-medium">Device ID</span>
                                <button
                                    onClick={copyHardwareId}
                                    className="text-[9px] text-white/30 hover:text-white/60 transition-colors flex items-center gap-1"
                                >
                                    {copiedHwid ? <Check size={8} className="text-green-400" /> : <Copy size={8} />}
                                    {copiedHwid ? 'Copied' : 'Copy'}
                                </button>
                            </div>
                            <p className="text-[9px] text-white/20 font-mono mt-1 truncate select-all">
                                {hardwareId}
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default PremiumUpgradeModal;
