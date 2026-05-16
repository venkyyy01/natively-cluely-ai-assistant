"""
generate_dataset.py
Generates a fine-tuning dataset for interview intent classification.
~700 examples across 8 intent categories, with emphasis on the hard pairs
(behavioral vs deep_dive, coding vs deep_dive, clarification vs follow_up).
"""

import json
import random
from pathlib import Path

INTENT_LABELS = [
    "clarification",
    "follow_up",
    "deep_dive",
    "behavioral",
    "example_request",
    "summary_probe",
    "coding",
    "general",
]

INTENT2ID = {label: i for i, label in enumerate(INTENT_LABELS)}

TEMPLATES: dict[str, list[str]] = {
    "clarification": [
        "Can you clarify what you mean by {term}?",
        "What exactly do you mean by {term}?",
        "Could you unpack that point about {term}?",
        "When you say {term}, what do you mean specifically?",
        "Can you break down what you meant by {term}?",
        "How so? What does {term} look like in practice?",
        "I didn't follow the part about {term}, can you explain?",
        "What do you mean by {term} in this context?",
        "Can you elaborate on that specific point about {term}?",
        "Sorry, could you clarify the {term} aspect?",
        "What exactly is {term} here?",
        "I'm not sure I understand the {term} part — can you explain?",
        "Can you rephrase what you said about {term}?",
        "What behavior should I expect from {term}?",
        "Could you explain the {term} concept more simply?",
        "What does {term} actually entail in your design?",
        "Can you walk through what {term} means step by step?",
        "I'm confused about the {term} tradeoff — can you clarify?",
        "What should we expect from {term} under load?",
        "Can you be more specific about {term}?",
    ],
    "follow_up": [
        "What happened next after you {action}?",
        "And then what did you do?",
        "What came after the {action}?",
        "After that, what was the next step?",
        "How did that go after you {action}?",
        "What was the outcome after {action}?",
        "And what did you do once the {system} recovered?",
        "What followed the {action}?",
        "Then what happened with the {system}?",
        "After you {action}, what changed?",
        "What was the next thing you did after {action}?",
        "How did things proceed after that?",
        "And what about after the {action} — what was the impact?",
        "What came next in the timeline?",
        "How did the team respond after {action}?",
        "What did you do after the incident was resolved?",
        "Walk me through what happened after {action}.",
        "What steps did you take next?",
        "What was the follow-up after {action}?",
        "And then? What was the resolution?",
    ],
    "deep_dive": [
        "Tell me more about how {system} works.",
        "Dive deeper into the {system} architecture.",
        "Explain further how you handle {concept}.",
        "How does {system} handle {scenario}?",
        "Walk me through the design of {system}.",
        "How would you scale {system} under {scenario}?",
        "What are the tradeoffs between {concept1} and {concept2}?",
        "Why would you choose {concept1} over {concept2}?",
        "Compare {concept1} vs {concept2} for this use case.",
        "How does {system} deal with {scenario}?",
        "Explain the {concept} tradeoff in your design.",
        "Tell me about your experience with {system} and how it handles {scenario}.",
        "Describe a situation where {concept} matters and explain your approach.",
        "Walk me through how {system} works under {scenario}.",
        "How do you approach {concept} in a distributed environment?",
        "What is the {concept} consideration when building {system}?",
        "Explain the architecture of {system} and why you chose that pattern.",
        "How does {system} maintain {concept} during {scenario}?",
        "What happens to {concept} when {system} experiences {scenario}?",
        "How would you design {system} to balance {concept1} and {concept2}?",
        "Explain the impact of {concept} on {system} performance.",
        "What are the failure modes of {system} and how does it recover?",
        "Walk me through the {concept} mechanism in {system}.",
        "How do you reason about {concept} when designing {system}?",
        "What considerations go into choosing between {concept1} and {concept2}?",
    ],
    "behavioral": [
        "Tell me about a time you {past_action}.",
        "Describe a time when you had to {past_action}.",
        "Describe a situation where you {past_action}.",
        "When have you had to {past_action}?",
        "Share an experience where you {past_action}.",
        "Walk me through a failure you owned end to end.",
        "Walk me through a time you had to {past_action}.",
        "Walk me through a conflict you had with a teammate.",
        "Give me an example of a time you {past_action}.",
        "Tell me about a situation where you disagreed with your manager.",
        "How did you handle a conflict with a stakeholder?",
        "Tell me about a mistake you made and how you recovered.",
        "Describe a time you influenced a team without authority.",
        "Walk me through a disagreement you had with a colleague and how you resolved it.",
        "Tell me about a time you failed to meet a deadline.",
        "Describe a situation where you had to push back on a requirement.",
        "When have you had to make a difficult tradeoff under pressure?",
        "Share an experience where you had to navigate competing priorities.",
        "Walk me through a time you had to escalate an issue.",
        "Tell me about a time you had to influence leadership.",
    ],
    "example_request": [
        "Can you give a concrete example of {concept}?",
        "What is one specific instance where {concept} applied?",
        "Give me an example of {concept} in practice.",
        "Can you show a concrete instance of {concept}?",
        "Like what? Give me one specific case.",
        "Such as? What does {concept} look like concretely?",
        "For instance, what would {concept} entail?",
        "Can you provide one concrete example of {concept}?",
        "What is a specific example of {concept}?",
        "Can you give me an instance where {concept} was critical?",
    ],
    "summary_probe": [
        "So to summarize, your approach is {summary}?",
        "So you're saying {summary}, right?",
        "Let me make sure I understand: {summary}?",
        "If I understood correctly, {summary}?",
        "Am I right that {summary}?",
        "Do I have this right — {summary}?",
        "To confirm, {summary}?",
        "So basically, {summary}?",
        "Correct me if I'm wrong, but {summary}?",
        "If I understand correctly, the key point is {summary}?",
    ],
    "coding": [
        "Implement {algo} in {lang}.",
        "Write code for {algo}.",
        "Write a function that {func_desc}.",
        "Build a class that {class_desc}.",
        "Debug this function: it {bug_desc}.",
        "Write a {algo} implementation.",
        "Code an {algo} in {lang}.",
        "Implement a method that {func_desc}.",
        "Design and code {algo} in {lang}.",
        "Write the algorithm for {algo}.",
        "How would you code {algo}?",
        "Write a {lang} snippet that {func_desc}.",
        "Implement {pattern} pattern in {lang}.",
        "Refactor this code to {refactor_goal}.",
        "Write a utility method for {func_desc}.",
        "Build a component that {class_desc}.",
        "Implement the handler code for {func_desc}.",
        "Write a program that {func_desc}.",
        "Optimize this function for {opt_goal}.",
        "Write boilerplate code for {algo}.",
    ],
    "general": [
        "What interests you most about this role?",
        "What kind of team environment helps you do your best work?",
        "Do you have any questions for us about the position?",
        "Why are you interested in this company?",
        "What are your career goals?",
        "How do you stay current with industry trends?",
        "What motivates you in your work?",
        "Tell me about yourself.",
        "What is your biggest strength?",
        "Where do you see yourself in five years?",
        "Why should we hire you?",
        "What is your preferred work style?",
        "How do you handle stress?",
        "What are you looking for in your next role?",
        "How do you approach work-life balance?",
    ],
}

TERMS = [
    "backpressure",
    "idempotency",
    "circuit breaker",
    "rate limiting",
    "eventual consistency",
    "strong consistency",
    "partition tolerance",
    "consensus protocol",
    "sharding strategy",
    "replication lag",
    "cache invalidation",
    "retry jitter",
    "exponential backoff",
    "deadlock prevention",
    "race condition",
    "load shedding",
    "graceful degradation",
    "blue-green deployment",
    "canary release",
    "feature flagging",
    "hot partition",
    "compaction strategy",
    "write-ahead log",
    "saga pattern",
    "outbox pattern",
    "change data capture",
    "vector clock",
    "gossip protocol",
    "lease-based locking",
    "fencing token",
]

SYSTEMS = [
    "distributed cache",
    "message queue",
    "event bus",
    "replication pipeline",
    "API gateway",
    "service mesh",
    "data pipeline",
    "stream processor",
    "log aggregator",
    "worker pool",
    "saga orchestrator",
    "CQRS system",
    "search index",
    "notification service",
    "rate limiter",
    "config management system",
    "feature flag service",
    "Kafka cluster",
    "Redis cluster",
    "Postgres sharding layer",
]

CONCEPTS = [
    "consistency",
    "availability",
    "latency",
    "throughput",
    "freshness",
    "scalability",
    "reliability",
    "partition tolerance",
    "idempotency",
    "backpressure",
    "concurrency",
    "parallelism",
    "eventual consistency",
    "strong consistency",
    "ACID compliance",
    "event sourcing",
    "CQRS",
    "circuit breaking",
]

CONCEPT_PAIRS = [
    ("consistency", "availability"),
    ("latency", "throughput"),
    ("freshness", "cache hit rate"),
    ("sharding", "replication"),
    ("SQL", "NoSQL"),
    ("Kafka", "RabbitMQ"),
    ("gRPC", "REST"),
    ("push", "pull"),
    ("synchronous replication", "asynchronous replication"),
    ("horizontal scaling", "vertical scaling"),
    ("microservices", "monolith"),
    ("event sourcing", "CRDT"),
    ("stateful", "stateless"),
]

SCENARIOS = [
    "network partitions",
    "hot partitions",
    "node failures",
    "traffic spikes",
    "data center outages",
    "cascading failures",
    "thundering herd",
    "slow consumers",
    "poison messages",
    "split brain",
    "clock drift",
    "disk full",
]

PAST_ACTIONS = [
    "had to deal with a critical production outage",
    "disagreed with your manager on a technical decision",
    "had to influence a team without formal authority",
    "had to ship under a tight deadline",
    "made a mistake that affected production",
    "had to push back on a feature request",
    "had to resolve a conflict between two teams",
    "had to make a decision with incomplete information",
    "led a project that was at risk of missing its deadline",
    "had to onboard a new team member remotely",
    "dealt with a difficult stakeholder",
    "had to prioritize competing demands",
    "had to recover from a failed deployment",
    "navigated organizational change",
    "handled a situation where you lacked expertise",
]

ACTIONS = [
    "paused the deployment",
    "rolled back the release",
    "paged the on-call team",
    "isolated the failing node",
    "scaled up the consumer pool",
    "throttled the producers",
    "added circuit breakers",
    "implemented retry logic",
    "drained the queue backlog",
    "applied the hotfix",
    "triggered the canary",
    "restarted the service",
]

ALGOS = [
    "LRU cache",
    "debounce",
    "throttle",
    "rate limiter",
    "trie",
    "binary search tree",
    "hash map",
    "min heap",
    "concurrent queue",
    "producer-consumer pattern",
    "singleton",
    "observer pattern",
    "strategy pattern",
    "factory pattern",
    "pub-sub system",
    "circular buffer",
    "bloom filter",
    "skip list",
    "consistent hashing",
]

LANGS = ["TypeScript", "JavaScript", "Python", "Java", "Go", "Rust", "C++"]

FUNC_DESCS = [
    "deduplicates IDs while preserving order",
    "handles retry with exponential backoff",
    "validates webhook signatures",
    "merges overlapping time intervals",
    "parses and normalizes phone numbers",
    "computes the running median of a stream",
    "implements a sliding window rate limiter",
    "converts CSV to JSON with type inference",
    "chunks an array into batches of N",
    "finds the longest increasing subsequence",
    "serializes and deserializes a binary tree",
    "implements a thread-safe counter",
]

CLASS_DESCS = [
    "manages a connection pool with health checks",
    "implements an event emitter with once/on/off",
    "tracks feature flags with rollout percentages",
    "manages circuit breaker state transitions",
    "implements a least-recently-used eviction policy",
    "provides a distributed lock using Redis",
    "handles graceful shutdown with in-flight request draining",
    "implements a leader election protocol",
]

BUG_DESCS = [
    "should deduplicate IDs but still returns duplicates",
    "crashes on empty input",
    "returns incorrect results for negative numbers",
    "leaks memory when called repeatedly",
    "hangs on concurrent access",
    "skips the last element in the list",
    "returns stale data after cache invalidation",
    "raises an exception for valid edge cases",
]

REFCTOR_GOALS = [
    "reduce cognitive complexity",
    "eliminate code duplication",
    "improve testability",
    "add proper error handling",
    "use dependency injection",
    "extract a reusable utility",
]

OPT_GOALS = [
    "reduced latency",
    "lower memory usage",
    "better throughput under load",
    "faster cold start",
    "smaller bundle size",
]

SUMMARIES = [
    "you prioritize availability over consistency",
    "writes are synchronous and fan-out is async",
    "you shard by tenant before region",
    "the first step is hot partition isolation",
    "you use eventual consistency for read replicas",
    "the system uses a write-ahead log for durability",
    "you rely on canary deployments for safety",
    "circuit breakers protect downstream services",
    "the saga orchestrator compensates on failure",
    "you split ownership between ingestion and enrichment",
]

PATTERNS = [
    "observer",
    "strategy",
    "factory",
    "singleton",
    "adapter",
    "decorator",
    "command",
    "iterator",
    "state machine",
    "builder",
    "prototype",
]


def generate_examples(intent: str, count: int) -> list[dict]:
    random.seed(42)
    examples = []
    template_list = TEMPLATES[intent]

    for i in range(count):
        template = template_list[i % len(template_list)]

        text = template.format(
            term=random.choice(TERMS),
            system=random.choice(SYSTEMS),
            concept=random.choice(CONCEPTS),
            concept1=random.choice(CONCEPT_PAIRS)[0],
            concept2=random.choice(CONCEPT_PAIRS)[1],
            scenario=random.choice(SCENARIOS),
            past_action=random.choice(PAST_ACTIONS),
            action=random.choice(ACTIONS),
            algo=random.choice(ALGOS),
            lang=random.choice(LANGS),
            func_desc=random.choice(FUNC_DESCS),
            class_desc=random.choice(CLASS_DESCS),
            bug_desc=random.choice(BUG_DESCS),
            refactor_goal=random.choice(REFCTOR_GOALS),
            opt_goal=random.choice(OPT_GOALS),
            summary=random.choice(SUMMARIES),
            pattern=random.choice(PATTERNS),
        )

        examples.append(
            {
                "text": text,
                "label": INTENT2ID[intent],
                "label_text": intent,
            }
        )

    return examples


HARD_PAIR_EXAMPLES = [
    {
        "text": "Tell me about your experience with distributed systems and how you handle partition tolerance.",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "Tell me about your experience building microservices and what tradeoffs you made.",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "Describe a situation where you had to choose between consistency and availability in your system.",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "Give me an example of how you would design a rate limiter for a public API.",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "Walk me through how you would handle a cascading failure in a microservice architecture.",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "How do you manage tradeoffs between latency and throughput in a data pipeline?",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "Tell me about your experience with Kafka and how you handle consumer lag.",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "Describe a situation where you had to implement backpressure in a streaming system.",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "Walk me through your experience with consensus protocols and why you chose Raft.",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "How do you prioritize between strong consistency and availability when designing a database?",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "Give me an example of how circuit breakers work in a distributed system.",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "Tell me about your experience with sharding strategies and how you handle hot partitions.",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "Describe a situation involving idempotency in a payment processing system.",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "How do you influence the architecture decision between event sourcing and CQRS?",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "What is your approach to designing a scalable notification system?",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "How would you handle conflict between cache freshness and latency in a CDN?",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "Why would you choose Kafka over RabbitMQ for an event-driven architecture?",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "Compare SQL vs NoSQL for a high-throughput write-heavy workload.",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "Walk me through how you would scale a PostgreSQL database for a global service.",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "Explain the tradeoffs you made between consistency and availability in your last project.",
        "label": 2,
        "label_text": "deep_dive",
    },
    {
        "text": "Tell me about a time you disagreed with your manager and how you resolved it.",
        "label": 3,
        "label_text": "behavioral",
    },
    {
        "text": "Describe a time when you had to influence people without formal authority.",
        "label": 3,
        "label_text": "behavioral",
    },
    {
        "text": "Walk me through a failure you owned end to end and what you learned.",
        "label": 3,
        "label_text": "behavioral",
    },
    {
        "text": "Share an experience where you had to navigate competing priorities from stakeholders.",
        "label": 3,
        "label_text": "behavioral",
    },
    {
        "text": "When have you had to make a difficult decision under pressure with incomplete information?",
        "label": 3,
        "label_text": "behavioral",
    },
    {
        "text": "Tell me about a time you had to push back on a feature request from leadership.",
        "label": 3,
        "label_text": "behavioral",
    },
    {
        "text": "Describe a situation where you had a conflict with a teammate and how you resolved it.",
        "label": 3,
        "label_text": "behavioral",
    },
    {
        "text": "Give me an example of a time you failed to meet a deadline and how you handled it.",
        "label": 3,
        "label_text": "behavioral",
    },
    {
        "text": "Tell me about a mistake you made in production and how you recovered.",
        "label": 3,
        "label_text": "behavioral",
    },
    {
        "text": "Walk me through a time you had to onboard a new team member during a crisis.",
        "label": 3,
        "label_text": "behavioral",
    },
    {
        "text": "Can you show an example API payload and handler code for this endpoint?",
        "label": 6,
        "label_text": "coding",
    },
    {
        "text": "Implement a rate limiter using the token bucket algorithm.",
        "label": 6,
        "label_text": "coding",
    },
    {
        "text": "Write code for a concurrent hash map in Java.",
        "label": 6,
        "label_text": "coding",
    },
    {"text": "Implement debouncing in JavaScript.", "label": 6, "label_text": "coding"},
    {
        "text": "Design and code an LRU cache in TypeScript.",
        "label": 6,
        "label_text": "coding",
    },
    {
        "text": "Debug this function: it should deduplicate IDs but still returns duplicates.",
        "label": 6,
        "label_text": "coding",
    },
    {
        "text": "Write a function that handles retry with exponential backoff.",
        "label": 6,
        "label_text": "coding",
    },
    {
        "text": "Can you give a concrete example of retry jitter in practice?",
        "label": 5,
        "label_text": "example_request",
    },
    {
        "text": "What is one specific instance where this tradeoff hurt you?",
        "label": 5,
        "label_text": "example_request",
    },
    {
        "text": "Can you give me one concrete example of that?",
        "label": 5,
        "label_text": "example_request",
    },
    {
        "text": "Can you clarify the scope boundary you drew between services?",
        "label": 0,
        "label_text": "clarification",
    },
    {
        "text": "When you say eventual consistency here, what exactly do you mean?",
        "label": 0,
        "label_text": "clarification",
    },
    {
        "text": "Can you unpack what you meant by backpressure in your queue workers?",
        "label": 0,
        "label_text": "clarification",
    },
    {
        "text": "What happened next after you paused the deployment?",
        "label": 1,
        "label_text": "follow_up",
    },
    {
        "text": "And then what did you do once the queue recovered?",
        "label": 1,
        "label_text": "follow_up",
    },
    {
        "text": "So you are saying writes stay synchronous while fan-out is async, right?",
        "label": 4,
        "label_text": "summary_probe",
    },
    {
        "text": "Let me make sure I got this: you sharded by tenant before region?",
        "label": 4,
        "label_text": "summary_probe",
    },
]


def main():
    random.seed(42)

    counts = {
        "deep_dive": 160,
        "behavioral": 130,
        "coding": 130,
        "clarification": 100,
        "follow_up": 90,
        "example_request": 80,
        "summary_probe": 80,
        "general": 60,
    }

    all_examples = []
    for intent, count in counts.items():
        all_examples.extend(generate_examples(intent, count))

    all_examples.extend(HARD_PAIR_EXAMPLES)

    random.shuffle(all_examples)

    split_idx = int(len(all_examples) * 0.8)
    train = all_examples[:split_idx]
    val = all_examples[split_idx:]

    out_dir = Path(__file__).parent / "data"
    out_dir.mkdir(exist_ok=True)

    with open(out_dir / "train.json", "w") as f:
        json.dump(train, f, indent=2)

    with open(out_dir / "val.json", "w") as f:
        json.dump(val, f, indent=2)

    label_map = {i: label for label, i in INTENT2ID.items()}
    with open(out_dir / "label_map.json", "w") as f:
        json.dump(label_map, f, indent=2)

    print(
        f"Generated {len(train)} train + {len(val)} val = {len(all_examples)} total examples"
    )
    for intent in INTENT_LABELS:
        train_count = sum(1 for e in train if e["label_text"] == intent)
        val_count = sum(1 for e in val if e["label_text"] == intent)
        print(f"  {intent}: train={train_count}, val={val_count}")


if __name__ == "__main__":
    main()
