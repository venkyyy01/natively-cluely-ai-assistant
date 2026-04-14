import React, { useState, useEffect, useCallback, useRef } from 'react';

export interface HoverResponse {
  id: string;
  type: 'code' | 'mcq' | 'subjective';
  content: string;
  language?: string;
  optionLabel?: string;
  justification?: string;
  cursorPosition: { x: number; y: number };
  timestamp: number;
}

interface HoverResponseOverlayProps {
  response: HoverResponse | null;
  isProcessing: boolean;
  onDismiss?: () => void;
  className?: string;
}

const HOVER_OVERLAY_OFFSET = 16;
const MAX_OVERLAY_WIDTH = 400;
const MAX_OVERLAY_HEIGHT = 300;

export const HoverResponseOverlay: React.FC<HoverResponseOverlayProps> = ({
  response,
  isProcessing,
  onDismiss,
  className = '',
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!response) {
      setIsVisible(false);
      return;
    }

    const updatePosition = () => {
      if (!overlayRef.current) return;

      const overlayRect = overlayRef.current.getBoundingClientRect();
      const { innerWidth, innerHeight } = window;

      let x = response.cursorPosition.x + HOVER_OVERLAY_OFFSET;
      let y = response.cursorPosition.y + HOVER_OVERLAY_OFFSET;

      if (x + overlayRect.width > innerWidth) {
        x = response.cursorPosition.x - overlayRect.width - HOVER_OVERLAY_OFFSET;
      }

      if (y + overlayRect.height > innerHeight) {
        y = response.cursorPosition.y - overlayRect.height - HOVER_OVERLAY_OFFSET;
      }

      x = Math.max(0, Math.min(x, innerWidth - overlayRect.width));
      y = Math.max(0, Math.min(y, innerHeight - overlayRect.height));

      setPosition({ x, y });
      setIsVisible(true);
    };

    requestAnimationFrame(updatePosition);
  }, [response]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onDismiss) {
        onDismiss();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onDismiss]);

  if (!response && !isProcessing) return null;

  const renderCodeResponse = () => {
    if (!response || response.type !== 'code') return null;

    return (
      <div className="hover-code-response">
        {response.language && (
          <div className="text-xs text-gray-400 mb-2 font-mono">
            {response.language}
          </div>
        )}
        <pre className="text-sm text-gray-100 overflow-x-auto whitespace-pre-wrap">
          <code>{response.content}</code>
        </pre>
      </div>
    );
  };

  const renderMcqResponse = () => {
    if (!response || response.type !== 'mcq') return null;

    return (
      <div className="hover-mcq-response">
        <div className="text-lg font-bold text-green-400 mb-2">
          {response.optionLabel}
        </div>
        {response.justification && (
          <div className="text-sm text-gray-300 italic">
            {response.justification}
          </div>
        )}
      </div>
    );
  };

  const renderSubjectiveResponse = () => {
    if (!response || response.type !== 'subjective') return null;

    return (
      <div className="hover-subjective-response">
        <p className="text-sm text-gray-100">{response.content}</p>
      </div>
    );
  };

  return (
    <div
      ref={overlayRef}
      className={`hover-response-overlay ${className} ${
        isVisible ? 'opacity-100' : 'opacity-0'
      } transition-opacity duration-200`}
      style={{
        position: 'fixed',
        left: `${position.x}px`,
        top: `${position.y}px`,
        maxWidth: `${MAX_OVERLAY_WIDTH}px`,
        maxHeight: `${MAX_OVERLAY_HEIGHT}px`,
        zIndex: 9999,
        pointerEvents: 'none',
      }}
    >
      <div className="bg-gray-900/95 backdrop-blur-md rounded-lg border border-gray-700 shadow-xl overflow-hidden">
        {isProcessing ? (
          <div className="p-4 flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-gray-300">Analyzing...</span>
          </div>
        ) : (
          <div className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-400">
                {response?.type === 'code' && '💻 Code Solution'}
                {response?.type === 'mcq' && '✓ MCQ Answer'}
                {response?.type === 'subjective' && '📝 Answer'}
              </span>
              <span className="text-xs text-gray-500">
                Hover Mode
              </span>
            </div>
            {response?.type === 'code' && renderCodeResponse()}
            {response?.type === 'mcq' && renderMcqResponse()}
            {response?.type === 'subjective' && renderSubjectiveResponse()}
          </div>
        )}
      </div>
    </div>
  );
};

export default HoverResponseOverlay;
