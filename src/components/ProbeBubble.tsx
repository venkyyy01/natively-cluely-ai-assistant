/**
 * NAT-205: ProbeBubble — renders a single Tier-B probe answer.
 * Animates in; does not cause root re-render.
 */
import React, { useEffect, useRef } from 'react';
import type { ProbeAnswer, ProbeType } from '../../electron/coding/types';

const PROBE_TYPE_LABEL: Record<ProbeType, string> = {
  complexity: 'Complexity',
  edge_case: 'Edge Case',
  tradeoff: 'Tradeoff',
  pushback: 'Pushback',
  alternative: 'Alternative',
  data_structure: 'Data Structure',
  generic: 'Follow-up',
};

const PROBE_TYPE_COLOR: Record<ProbeType, string> = {
  complexity: '#7c6af7',
  edge_case: '#f7a26a',
  tradeoff: '#6abef7',
  pushback: '#f76a6a',
  alternative: '#6af79a',
  data_structure: '#f7e26a',
  generic: '#aaaaaa',
};

interface ProbeBubbleProps {
  probe: ProbeAnswer;
}

export const ProbeBubble: React.FC<ProbeBubbleProps> = ({ probe }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    const raf = requestAnimationFrame(() => {
      el.style.transition = 'opacity 180ms ease, transform 180ms ease';
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const color = PROBE_TYPE_COLOR[probe.probeType] ?? '#aaaaaa';
  const label = PROBE_TYPE_LABEL[probe.probeType] ?? 'Follow-up';

  return (
    <div
      ref={ref}
      style={{
        marginTop: 8,
        padding: '8px 12px',
        borderRadius: 8,
        borderLeft: `3px solid ${color}`,
        background: 'rgba(255,255,255,0.04)',
        fontSize: 13,
        lineHeight: 1.55,
        opacity: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color,
            opacity: 0.85,
          }}
        >
          {label}
        </span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {probe.question}
        </span>
      </div>
      <div style={{ color: 'rgba(255,255,255,0.88)', whiteSpace: 'pre-wrap' }}>
        {probe.answer}
      </div>
    </div>
  );
};
