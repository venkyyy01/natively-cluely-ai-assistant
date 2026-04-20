/**
 * NAT-086: local in-process metrics with rolling log lines. No remote sink yet (EPIC-20).
 */

export type MetricLabels = Record<string, string>;

const counters = new Map<string, number>();
const gauges = new Map<string, number>();

function labelKey(labels?: MetricLabels): string {
  if (!labels || Object.keys(labels).length === 0) {
    return '';
  }
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

function compoundKey(name: string, labels?: MetricLabels): string {
  const lk = labelKey(labels);
  return lk ? `${name}{${lk}}` : name;
}

export const Metrics = {
  counter(name: string, delta = 1, labels?: MetricLabels): void {
    if (delta === 0) {
      return;
    }
    const key = compoundKey(name, labels);
    const next = (counters.get(key) ?? 0) + delta;
    counters.set(key, next);
  },

  gauge(name: string, value: number, labels?: MetricLabels): void {
    const key = compoundKey(name, labels);
    gauges.set(key, value);
  },

  getSnapshot(): { counters: Record<string, number>; gauges: Record<string, number> } {
    return {
      counters: Object.fromEntries(counters),
      gauges: Object.fromEntries(gauges),
    };
  },

  /** Test-only reset. */
  resetForTests(): void {
    counters.clear();
    gauges.clear();
  },
};
