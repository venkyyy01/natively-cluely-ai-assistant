/**
 * NAT-305: ProblemSummary — renders a CodingProblem above the streamed solution.
 * Listens on onProblemExtracted; falls back to legacy single-statement render.
 */
import React, { useState, useEffect } from 'react';
import type { CodingProblem } from '../../electron/coding/types';

const DIFFICULTY_COLOR: Record<string, string> = {
  easy: '#4ade80',
  medium: '#facc15',
  hard: '#f87171',
  unknown: '#888',
};

const TYPE_LABEL: Record<string, string> = {
  arrays: 'Arrays',
  strings: 'Strings',
  linked_list: 'Linked List',
  trees: 'Trees',
  graphs: 'Graphs',
  dynamic_programming: 'DP',
  backtracking: 'Backtracking',
  binary_search: 'Binary Search',
  heap_priority_queue: 'Heap / PQ',
  hash_map: 'Hash Map',
  two_pointers: 'Two Pointers',
  sliding_window: 'Sliding Window',
  stack_queue: 'Stack / Queue',
  greedy: 'Greedy',
  design: 'Design',
  system_design: 'System Design',
  unknown: '—',
};

interface ProblemSummaryProps {
  /** Raw problem info from PROBLEM_EXTRACTED IPC event */
  problemInfo: any;
}

export const ProblemSummary: React.FC<ProblemSummaryProps> = ({ problemInfo }) => {
  const [showRawOcr, setShowRawOcr] = useState(false);

  if (!problemInfo) return null;

  const coding: CodingProblem | undefined = problemInfo.codingProblem;
  const isPartial = problemInfo.extraction_partial === true;

  if (!coding) {
    const statement = problemInfo.problem_statement ?? '';
    if (!statement) return null;
    return (
      <div style={containerStyle}>
        <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, margin: 0 }}>{statement.slice(0, 300)}</p>
      </div>
    );
  }

  const diffColor = DIFFICULTY_COLOR[coding.difficulty] ?? '#888';

  return (
    <div style={containerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: 'rgba(255,255,255,0.92)' }}>
          {coding.title}
        </span>
        <span style={{ ...pillStyle, color: diffColor, borderColor: diffColor }}>
          {coding.difficulty}
        </span>
        <span style={{ ...pillStyle, color: '#aaa', borderColor: '#555' }}>
          {TYPE_LABEL[coding.problemType] ?? coding.problemType}
        </span>
        {isPartial && (
          <span style={{ ...pillStyle, color: '#f7a26a', borderColor: '#f7a26a' }}>
            partial
          </span>
        )}
      </div>

      {coding.problemStatement && (
        <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.72)', margin: '0 0 6px', lineHeight: 1.5 }}>
          {coding.problemStatement.slice(0, 400)}{coding.problemStatement.length > 400 ? '…' : ''}
        </p>
      )}

      {coding.examples.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          {coding.examples.slice(0, 2).map((ex, i) => (
            <div key={i} style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', fontFamily: 'monospace', marginBottom: 2 }}>
              <span style={{ color: 'rgba(255,255,255,0.35)' }}>Ex {i + 1}:</span>{' '}
              Input={ex.input} → Output={ex.output}
            </div>
          ))}
        </div>
      )}

      {coding.constraints.length > 0 && (
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>
          {coding.constraints.slice(0, 3).map((c, i) => (
            <div key={i}>• {c}</div>
          ))}
        </div>
      )}

      {isPartial && coding.rawOcr && (
        <button
          style={toggleBtnStyle}
          onClick={() => setShowRawOcr((v) => !v)}
        >
          {showRawOcr ? 'Hide raw OCR' : 'View raw OCR'}
        </button>
      )}

      {showRawOcr && coding.rawOcr && (
        <pre style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto', marginTop: 6 }}>
          {coding.rawOcr.slice(0, 1500)}
        </pre>
      )}
    </div>
  );
};

const containerStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  padding: '10px 14px',
  marginBottom: 10,
};

const pillStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  border: '1px solid',
  borderRadius: 4,
  padding: '1px 6px',
};

const toggleBtnStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#6abef7',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  textDecoration: 'underline',
};
