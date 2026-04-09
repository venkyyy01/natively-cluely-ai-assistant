import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsciousSemanticFactStore } from '../conscious/ConsciousSemanticFactStore';

test('ConsciousSemanticFactStore builds compact fact blocks from profile data', () => {
  const store = new ConsciousSemanticFactStore();
  store.seedFromProfileData({
    identity: {
      name: 'Jane Doe',
      role: 'Senior Backend Engineer',
      summary: 'Built distributed systems and observability tooling.',
    },
    skills: ['Redis', 'Kafka', 'Go'],
    projects: [
      {
        name: 'Tenant Analytics Platform',
        description: 'Multi-tenant analytics system with hot-tenant isolation.',
        technologies: ['Redis', 'Kafka', 'ClickHouse'],
      },
    ],
    experience: [
      {
        company: 'Acme',
        role: 'Senior Backend Engineer',
        bullets: ['Reduced p99 latency from 500ms to 70ms with caching and batching.'],
      },
    ],
    activeJD: {
      title: 'Staff Backend Engineer',
      company: 'ExampleCorp',
      technologies: ['Redis', 'Kafka'],
      requirements: ['Design distributed systems', 'Own service reliability'],
      keywords: ['scalability', 'latency'],
    },
  });

  const block = store.buildContextBlock({
    question: 'How would you design a Redis-backed analytics pipeline?',
    reaction: null,
    limit: 4,
  });

  assert.ok(block.includes('<conscious_semantic_memory>'));
  assert.ok(block.includes('Tenant Analytics Platform'));
  assert.ok(block.includes('Redis'));
});
