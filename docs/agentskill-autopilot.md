---
name: autopilot
description: "Autonomous eval loop + code hardening skill. Run self-review as principal engineer → HARDEN with clean code, design patterns, classic SDE skills → lint/typecheck → eval → iterate until score >= 95%. Use for: verify, harden, rigorous code review on ANY code implementation."
---
# Autopilot: Principal Engineer Eval Loop
Execute autonomous eval loop: code → self-review as principal → harden → repeat until production-ready.
## Loop (Max 5x)
```
FOR iteration 1 to 5:
  1. SELF-REVIEW as Principal Engineer
     - Apply ALL checklists below
     - Find 5+ issues in your own code
  2. HARDEN — Fix all critical issues
     - Apply clean code principles
     - Apply design patterns where appropriate
     - Apply SDE fundamentals
  3. VERIFY — Run tools based on stack
  4. SCORE → IF >= 95 AND tests pass → DONE
```
---
# PART 1: CLEAN CODE PRINCIPLES
## Code Quality (Principal Level)
### Naming
- [ ] Variables describe WHAT, not HOW
- [ ] Functions do ONE thing (SRP)
- [ ] Classes have single responsibility
- [ ] No magic numbers — use constants
- [ ] Booleans named as questions (`isValid`, `hasPermission`)
### Functions
- [ ] Max 20 lines
- [ ] Max 3 parameters (use objects if more)
- [ ] No flag arguments (`enableFeature: true` = separate functions)
- [ ] Early returns for happy path
- [ ] Errors thrown, not returned
### Classes
- [ ] Open/Closed: open for extension, closed for modification
- [ ] Liskov: substitutable without breaking clients
- [ ] Dependency Inversion: depend on abstractions, not concretions
- [ ] Interface Segregation: small, focused interfaces
- [ ] Single Responsibility: one reason to change
### Code Smells (Detect & Fix)
- [ ] Duplicate code → extract to function
- [ ] Long function → break apart
- [ ] Primitive obsession → use Value Objects
- [ ] Feature envy → move function to data class
- [ ] Indecent exposure → hide invariants
- [ ] Refused bequest → respect inheritance
- [ ] Parallel inheritance → combine hierarchies
- [ ] Lazy class → remove it
- [ ] Speculative generality → delete unused code
- [ ] Temporary field → use factory or builder
### Comments
- [ ] Explain WHY, not WHAT
- [ ] No commented-out code
- [ ] No FIXMEs or TODOs in production code
- [ ] API contracts documented
---
# PART 2: DESIGN PATTERNS
## Creational (When to Use)
### Singleton
- [ ] Exactly one instance needed
- [ ] Strict access control (config, logger)
- [ ] Subclassing not required
### Factory Method
- [ ] Object creation varies
- [ ] Decouple creation from usage
- [ ] Single Responsibility for creation
### Abstract Factory
- [ ] Families of related objects
- [ ] Independent of implementation
- [ ] Product variation without code change
### Builder
- [ ] Complex object construction
- [ ] Many constructor parameters
- [ ] Immutable objects
### Prototype
- [ ] Expensive cloning
- [ ] Variation without subclassing
## Structural (When to Use)
### Adapter
- [ ] Integrate incompatible interface
- [ ] Wrap legacy code
- [ ] Third-party integration
### Bridge
- [ ] Abstraction/implementation vary independently
- [ ] Avoid explosion of subclasses
- [ ] Compile-time binding
### Composite
- [ ] Tree structures
- [ ] Part-whole hierarchies
- [ ] Uniform treatment
### Decorator
- [ ] Add behavior at runtime
- [ ] Avoid subclass explosion
- [ ] Single Responsibility per decorator
### Facade
- [ ] Simplify complex subsystem
- [ ] Layered architecture
- [ ] Decouple client from internals
### Flyweight
- [ ] Many fine-grained objects
- [ ] Memory critical
- [ ] Share common state
### Proxy
- [ ] Lazy initialization
- [ ] Access control
- [ ] Remote representation
## Behavioral (When to Use)
### Observer
- [ ] One-to-many dependency
- [ ] Event handling
- [ ] Decouple subject from observers
### Strategy
- [ ] Multiple algorithms
- [ ] Swap at runtime
- [ ] Avoid conditionals
### Command
- [ ] Queue operations
- [ ] Undo/redo
- [ ] Parameterize objects
### State
- [ ] Behavior varies with state
- [ ] Avoid conditionals
- [ ] Finite state machine
### Template Method
- [ ] Algorithm skeleton
- [ ] Invariant steps
- [ ] Extension points
### Chain of Responsibility
- [ ] Multiple handlers
- [ ] Decouple sender/receiver
- [ ] Dynamic chain
### Iterator
- [ ] Traverse collection
- [ ] Encapsulate traversal
- [ ] Multiple traversal
### Visitor
- [ ] Operations on object structure
- [ ] Add operations without changing classes
- [ ] Double dispatch
---
# PART 3: CLASSIC SDE FUNDAMENTALS
## Data Structures
### Time Complexity (Know These)
| Structure | Access | Search | Insert | Delete |
|----------|-------|--------|--------|--------|
| Array | O(1) | O(n) | O(n) | O(n) |
| LinkedList | O(n) | O(n) | O(1)* | O(1)* |
| HashMap | O(1) | O(1) | O(1) | O(1) |
| Binary Tree | O(log n) | O(log n) | O(log n) | O(log n) |
| BST | O(log n) | O(log n) | O(log n) | O(log n) |
| Heap | O(1) | O(n) | O(log n) | O(log n) |
| Stack | O(1) | - | O(1) | O(1) |
| Queue | O(1) | - | O(1) | O(1) |
*At head/tail
### When to Use What
- [ ] Random access → Array or HashMap
- [ ] Insertion order → LinkedList or Array
- [ ] Sorted data → Binary Search Tree
- [ ] Priority → Heap (PriorityQueue)
- [ ] FIFO → Queue
- [ ] LIFO → Stack
- [ ] Unique keys → Set
- [ ] Graph adjacency → Adjacency list/matrix
### Choose Based On
- [ ] Access pattern (sequential vs random)
- [ ] Mutation pattern (insert/delete frequency)
- [ ] Memory constraints
- [ ] Sorted order requirement
## Algorithms
### Sorting
| Algorithm | Best | Average | Worst | Stable | Notes |
|----------|------|--------|-------|--------|-------|
| QuickSort | n log n | n log n | n² | No | In-place |
| MergeSort | n log n | n log n | n log n | Yes | O(n) space |
| HeapSort | n log n | n log n | n log n | No | In-place |
| InsertSort | n | n² | n² | Yes | Nearly sorted |
| TimSort | n | n log n | n log n | Yes | Hybrid |
### Use Based On
- [ ] Nearly sorted → InsertSort
- [ ] Memory constrained → HeapSort
- [ ] Stable required → MergeSort
- [ ] Average case → QuickSort
### Searching
- [ ] Sorted + random access → Binary Search (O(log n))
- [ ] Unsorted + small → Linear (O(n))
- [ ] Unsorted + large → Build HashMap (O(1))
- [ ] Range queries → Segment Tree / Binary Indexed Tree
## System Design
### CAP Theorem
- [ ] Know tradeoffs: Consistency vs Availability vs Partition Tolerance
- [ ] CP systems: ZooKeeper, etcd, Consul
- [ ] AP systems: Cassandra, DynamoDB
- [ ] CA doesn't exist in distributed systems
### DistributedPatterns
- [ ] Leader election (Raft, Paxos)
- [ ] Load balancing (Round Robin, Least Connections)
- [ ] Caching (Redis, Memcached)
- [ ] Sharding (horizontal partitioning)
- [ ] Replication (leader-follower)
- [ ] Consensus (Quorum, 2PC, 3PC)
### Microservices
- [ ] API Gateway pattern
- [ ] Circuit Breaker
- [ ] Service Mesh
- [ ] Event-driven (Kafka, RabbitMQ)
- [ ] CQRS pattern
- [ ] Saga pattern
### Database
- [ ] ACID (relational)
- [ ] BASE (NoSQL)
- [ ] Normalization (1NF, 2NF, 3NF, BCNF)
- [ ] Indexes: B-tree for range, Hash for equality
- [ ] Sharding keys
- [ ] Replication lag
### Message Queues
- [ ] At-least-once → idempotency required
- [ ] Exactly-once → expensive
- [ ] FIFO → ordering required
---
# PART 4: PRINCIPAL ENGINEER REVIEW
## Correctness (30 pts)
- [ ] Does exactly what spec says
- [ ] No off-by-one errors
- [ ] Null/undefined handled
- [ ] Type-safe throughout
- [ ] No race conditions
## Edge Cases (25 pts)
- [ ] null input
- [ ] empty input
- [ ] zero / negative / max
- [ ] overflow / underflow
- [ ] bad input format
- [ ] partial data
- [ ] concurrent access
## Error Handling (20 pts)
- [ ] ALL errors caught
- [ ] Errors return friendly messages
- [ ] Logs with context (correlation IDs)
- [ ] No silent failures
- [ ] Cleanup in error paths (finally/using/defer)
- [ ] Retry for transient failures
## Security (15 pts)
- [ ] Input validation on ALL boundaries
- [ ] No SQL injection (parameterized)
- [ ] No command injection
- [ ] No path traversal
- [ ] No XSS
- [ ] No secrets exposed in logs
- [ ] Rate limiting
- [ ] Authorization checks
## Performance (10 pts)
- [ ] No O(n²) without justification
- [ ] No N+1 queries
- [ ] No memory leaks
- [ ] Connection pooling
- [ ] Appropriate indexes on DB
---
# PART 5: TOOLS BY STACK
## JavaScript/TypeScript
```bash
# Run all
npm test && npm run lint && npm run typecheck
# Individual tools
npx eslint . --fix           # ESLint with auto-fix
npx tsc --noEmit            # TypeScript check
npx prettier --write .       # Prettier format
npm run test                # Jest/Vitest
```
## Python
```bash
# Run all
pytest && ruff check . && mypy .
# Individual tools
ruff check . --fix          # Ruff (fast linter)
ruff format .               # Ruff format
mypy .                    # Type checking
pytest -v                  # Testing
bandit -r .               # Security
safety check               # Vulnerabilities
```
## Go
```bash
# Run all
go test ./... && go vet && golint ./... && staticcheck ./...
# Individual tools
go test -v -race ./...    # Test with race detector
go vet ./...             # Vet
golint ./...             # Linting
staticcheck ./...         # Static analysis
gofmt -w .            # Format
golines .              # Max line length
```
## Rust
```bash
# Run all
cargo test && cargo clippy && cargo fmt --check
# Individual tools
cargo clippy --fix -Z allow-dirty  # Clippy (lint)
cargo fmt --check              # Format check
cargo test                    # Tests
cargo audit                  # Security
```
## Java
```bash
# Run all
mvn test && mvn checkstyle:check && mvn spotbugs:check
# Individual tools
mvn checkstyle:check    # Checkstyle
mvn spotbugs:check    # SpotBugs
mvn pmd:check        # PMD
mvn test             # JUnit
```
## C/C++
```bash
# Run all
cmake --build . && cppcheck . && cpplint .
# Individual tools
cppcheck --enable=all .     # Cppcheck
cpplint.py .              # CPPLint
clang-format -i .         # Format
splint .                  # Splint
```
---
# PART 6: SCORING
## Eval Dimensions (0-100)
| Dimension | Max | Weight |
|-----------|-----|--------|
| Correctness | 30 | Does it work? |
| Edge cases | 25 | null/empty/bad input |
| Error handling | 20 | Fails gracefully? |
| Security | 15 | Safe from attacks? |
| Performance | 10 | Acceptable? |
## Stop Conditions
- ✅ Eval score >= 95
- ✅ All tests pass
- ✅ Lint passes (based on stack)
- ✅ Typecheck passes (if applicable)
- ✅ Build passes
- ✅ No known issues
---
# OUTPUT FORMAT
```markdown
## Autopilot Complete: [task]
### Iteration: [N]/5
### Eval Score: [X]/100
- Correctness: [N]/30 ✓
- Edge cases: [N]/25 ✓
- Error handling: [N]/20 ✓
- Security: [N]/15 ✓
- Performance: [N]/10 ✓
### Verification
- Tests: ✓
- Lint: ✓
- Typecheck: ✓
- Build: ✓
### Patterns Applied: [list]
### Issues Fixed: [list]
### Clean Code Fixes: [list]
```