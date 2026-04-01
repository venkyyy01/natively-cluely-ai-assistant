# AGENTS

<skills_system priority="1">

## Available Skills

<!-- SKILLS_TABLE_START -->
<usage>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills:
- Invoke: `npx openskills read <skill-name>` (run in your shell)
  - For multiple: `npx openskills read skill-one,skill-two`
- The skill content will load with detailed instructions on how to complete the task
- Base directory provided in output for resolving bundled resources (references/, scripts/, assets/)

Usage notes:
- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already loaded in your context
- Each skill invocation is stateless
</usage>

<available_skills>

<skill>
<name>algorithmic-art</name>
<description>Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration. Use this when users request creating art using code, generative art, algorithmic art, flow fields, or particle systems. Create original algorithmic art rather than copying existing artists' work to avoid copyright violations.</description>
<location>project</location>
</skill>

<skill>
<name>brand-guidelines</name>
<description>Applies Anthropic's official brand colors and typography to any sort of artifact that may benefit from having Anthropic's look-and-feel. Use it when brand colors or style guidelines, visual formatting, or company design standards apply.</description>
<location>project</location>
</skill>

<skill>
<name>canvas-design</name>
<description>Create beautiful visual art in .png and .pdf documents using design philosophy. You should use this skill when the user asks to create a poster, piece of art, design, or other static piece. Create original visual designs, never copying existing artists' work to avoid copyright violations.</description>
<location>project</location>
</skill>

<skill>
<name>changeset-validation</name>
<description>Validate changesets in openai-agents-js using LLM judgment against git diffs (including uncommitted local changes). Use when packages/ or .changeset/ are modified, or when verifying PR changeset compliance and bump level.</description>
<location>project</location>
</skill>

<skill>
<name>claude-api</name>
<description>"Build apps with the Claude API or Anthropic SDK. TRIGGER when: code imports `anthropic`/`@anthropic-ai/sdk`/`claude_agent_sdk`, or user asks to use Claude API, Anthropic SDKs, or Agent SDK. DO NOT TRIGGER when: code imports `openai`/other AI SDK, general programming, or ML/data-science tasks."</description>
<location>project</location>
</skill>

<skill>
<name>code-change-verification</name>
<description>Run the mandatory verification stack when changes affect runtime code, tests, or build/test behavior in the OpenAI Agents JS monorepo.</description>
<location>project</location>
</skill>

<skill>
<name>doc-coauthoring</name>
<description>Guide users through a structured workflow for co-authoring documentation. Use when user wants to write documentation, proposals, technical specs, decision docs, or similar structured content. This workflow helps users efficiently transfer context, refine content through iteration, and verify the doc works for readers. Trigger when user mentions writing docs, creating proposals, drafting specs, or similar documentation tasks.</description>
<location>project</location>
</skill>

<skill>
<name>docs-sync</name>
<description>Analyze main branch implementation and configuration to find missing, incorrect, or outdated documentation in docs/. Use when asked to audit doc coverage, sync docs with code, or propose doc updates/structure changes. Only update English docs (docs/src/content/docs/**) and never touch translated docs under docs/src/content/docs/ja, ko, or zh. Provide a report and ask for approval before editing docs.</description>
<location>project</location>
</skill>

<skill>
<name>docx</name>
<description>"Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a 'report', 'memo', 'letter', 'template', or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation."</description>
<location>project</location>
</skill>

<skill>
<name>examples-auto-run</name>
<description>Run examples:start-all in auto mode with parallel execution, per-script logs, and start/stop helpers.</description>
<location>project</location>
</skill>

<skill>
<name>final-release-review</name>
<description>Perform a release-readiness review by locating the previous release tag from remote tags and auditing the diff (e.g., v1.2.3...<commit>) for breaking changes, regressions, improvement opportunities, and risks before releasing openai-agents-js.</description>
<location>project</location>
</skill>

<skill>
<name>frontend-design</name>
<description>Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, or when styling/beautifying any web UI). Generates creative, polished code and UI design that avoids generic AI aesthetics.</description>
<location>project</location>
</skill>

<skill>
<name>implementation-strategy</name>
<description>Decide how to implement runtime and API changes in openai-agents-js before editing code. Use when a task changes exported APIs, runtime behavior, schemas, tests, or docs and you need to choose the compatibility boundary, whether shims or migrations are warranted, and when unreleased interfaces can be rewritten directly.</description>
<location>project</location>
</skill>

<skill>
<name>integration-tests</name>
<description>Run the integration-tests pipeline that depends on a local npm registry (Verdaccio). Use when asked to execute integration tests or local publish workflows in this repo.</description>
<location>project</location>
</skill>

<skill>
<name>internal-comms</name>
<description>A set of resources to help me write all kinds of internal communications, using the formats that my company likes to use. Claude should use this skill whenever asked to write some sort of internal communications (status reports, leadership updates, 3P updates, company newsletters, FAQs, incident reports, project updates, etc.).</description>
<location>project</location>
</skill>

<skill>
<name>mcp-builder</name>
<description>Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. Use when building MCP servers to integrate external APIs or services, whether in Python (FastMCP) or Node/TypeScript (MCP SDK).</description>
<location>project</location>
</skill>

<skill>
<name>openai-knowledge</name>
<description>Use when working with the OpenAI API (Responses API) or OpenAI platform features (tools, streaming, Realtime API, auth, models, rate limits, MCP) and you need authoritative, up-to-date documentation (schemas, examples, limits, edge cases). Prefer the OpenAI Developer Documentation MCP server tools when available; otherwise guide the user to enable `openaiDeveloperDocs`.</description>
<location>project</location>
</skill>

<skill>
<name>pdf</name>
<description>Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs to make them searchable. If the user mentions a .pdf file or asks to produce one, use this skill.</description>
<location>project</location>
</skill>

<skill>
<name>pnpm-upgrade</name>
<description>'Keep pnpm current: run pnpm self-update/corepack prepare, align packageManager in package.json, and bump pnpm/action-setup + pinned pnpm versions in .github/workflows to the latest release. Use this when refreshing the pnpm toolchain manually or in automation.'</description>
<location>project</location>
</skill>

<skill>
<name>pptx</name>
<description>"Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file (even if the extracted content will be used elsewhere, like in an email or summary); editing, modifying, or updating existing presentations; combining or splitting slide files; working with templates, layouts, speaker notes, or comments. Trigger whenever the user mentions \"deck,\" \"slides,\" \"presentation,\" or references a .pptx filename, regardless of what they plan to do with the content afterward. If a .pptx file needs to be opened, created, or touched, use this skill."</description>
<location>project</location>
</skill>

<skill>
<name>pr-draft-summary</name>
<description>Create a PR title and draft description after substantive code changes are finished. Trigger when wrapping up a moderate-or-larger change (runtime code, tests, build config, docs with behavior impact) and you need the PR-ready summary block with change summary plus PR draft text.</description>
<location>project</location>
</skill>

<skill>
<name>skill-creator</name>
<description>Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.</description>
<location>project</location>
</skill>

<skill>
<name>slack-gif-creator</name>
<description>Knowledge and utilities for creating animated GIFs optimized for Slack. Provides constraints, validation tools, and animation concepts. Use when users request animated GIFs for Slack like "make me a GIF of X doing Y for Slack."</description>
<location>project</location>
</skill>

<skill>
<name>template</name>
<description>Replace with description of the skill and when Claude should use it.</description>
<location>project</location>
</skill>

<skill>
<name>test-coverage-improver</name>
<description>'Improve test coverage in the OpenAI Agents JS monorepo: run `pnpm test:coverage`, inspect coverage artifacts, identify low-coverage files and branches, propose high-impact tests, and confirm with the user before writing tests.'</description>
<location>project</location>
</skill>

<skill>
<name>theme-factory</name>
<description>Toolkit for styling artifacts with a theme. These artifacts can be slides, docs, reportings, HTML landing pages, etc. There are 10 pre-set themes with colors/fonts that you can apply to any artifact that has been creating, or can generate a new theme on-the-fly.</description>
<location>project</location>
</skill>

<skill>
<name>web-artifacts-builder</name>
<description>Suite of tools for creating elaborate, multi-component claude.ai HTML artifacts using modern frontend web technologies (React, Tailwind CSS, shadcn/ui). Use for complex artifacts requiring state management, routing, or shadcn/ui components - not for simple single-file HTML/JSX artifacts.</description>
<location>project</location>
</skill>

<skill>
<name>webapp-testing</name>
<description>Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser logs.</description>
<location>project</location>
</skill>

<skill>
<name>xlsx</name>
<description>"Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats. Trigger especially when the user references a spreadsheet file by name or path — even casually (like \"the xlsx in my downloads\") — and wants something done to it or produced from it. Also trigger for cleaning or restructuring messy tabular data files (malformed rows, misplaced headers, junk data) into proper spreadsheets. The deliverable must be a spreadsheet file. Do NOT trigger when the primary deliverable is a Word document, HTML report, standalone Python script, database pipeline, or Google Sheets API integration, even if tabular data is involved."</description>
<location>project</location>
</skill>

<!-- oh-my-claudecode (OMC) skills -->
<skill>
<name>omc-autopilot</name>
<description>Full autonomous execution from idea to working code. Takes a brief product idea and autonomously handles: requirements analysis, technical design, planning, parallel implementation, QA cycling, and multi-perspective validation. Trigger when user says "autopilot", "build me", "create me", "full auto", or wants end-to-end autonomous execution.</description>
<location>project</location>
</skill>

<skill>
<name>omc-team</name>
<description>N coordinated agents on shared task list using Claude Code native teams. Spawns N agents working through staged pipeline: team-plan → team-prd → team-exec → team-verify → team-fix. Trigger when user says "team N:agent-type task" or wants coordinated multi-agent execution.</description>
<location>project</location>
</skill>

<skill>
<name>omc-ralph</name>
<description>Self-referential persistence loop until task completion with configurable verification. Keeps working until ALL user stories pass verification. Includes ultrawork parallel execution with retry on failure. Trigger when user says "ralph", "don't stop", "must complete", "finish this", or "keep going until done".</description>
<location>project</location>
</skill>

<skill>
<name>omc-ultrawork</name>
<description>Parallel execution engine for high-throughput task completion. Fires multiple agents simultaneously for independent tasks with smart model routing (Haiku/Sonnet/Opus). Trigger when user says "ulw", "ultrawork", or wants parallel execution.</description>
<location>project</location>
</skill>

<skill>
<name>omc-ccg</name>
<description>Claude-Codex-Gemini tri-model orchestration. Routes to codex + gemini via /ask, then Claude synthesizes results. Trigger when user says "ccg" or wants multi-model cross-validation.</description>
<location>project</location>
</skill>

<skill>
<name>omc-deep-interview</name>
<description>Socratic deep interview with mathematical ambiguity gating before execution. Uses Socratic questioning to clarify vague ideas, exposes hidden assumptions, measures clarity across weighted dimensions. Trigger when user says "deep-interview" or has a vague idea needing clarification.</description>
<location>project</location>
</skill>

<skill>
<name>omc-ralplan</name>
<description>Consensus planning entrypoint that auto-gates vague requests before execution. 3-stage pipeline: deep-interview → ralplan → autopilot. Trigger when user says "ralplan" or wants validated planning before execution.</description>
<location>project</location>
</skill>

<skill>
<name>omc-ai-slop-cleaner</name>
<description>Clean AI-generated code slop with regression-safe, deletion-first workflow. Optional reviewer-only mode for identifying issues without fixing. Trigger when user says "deslop", "anti-slop", or wants to clean up AI-generated code smells.</description>
<location>project</location>
</skill>

<skill>
<name>omc-deepinit</name>
<description>Deep codebase initialization with hierarchical AGENTS.md documentation. Scans and documents the entire project structure. Trigger when user says "deepinit" or wants comprehensive project initialization.</description>
<location>project</location>
</skill>

<skill>
<name>omc-deep-dive</name>
<description>2-stage pipeline: trace (causal investigation) → deep-interview (requirements crystallization) with 3-point injection. Trigger when user says "deep-dive" or wants to investigate a problem before requirements gathering.</description>
<location>project</location>
</skill>

<skill>
<name>omc-ultraqa</name>
<description>QA cycling workflow - test, verify, fix, repeat until goal met. Runs build/test/fix loops with up to 5 cycles, stopping if same error persists 3 times. Trigger when user says "ultraqa" or wants intensive QA cycling.</description>
<location>project</location>
</skill>

<skill>
<name>omc-cancel</name>
<description>Cancel any active OMC mode (autopilot, ralph, ultrawork, team, etc). Handles graceful shutdown of teammates, state cleanup, and resource deallocation. Trigger when user says "cancelomc", "stopomc", or wants to stop an active OMC mode.</description>
<location>project</location>
</skill>

<skill>
<name>omc-ask</name>
<description>Process-first advisor routing for Claude, Codex, or Gemini via omc ask. Runs local provider CLIs and saves markdown artifacts. Trigger when user says "ask codex", "ask gemini", or wants external AI advisor input.</description>
<location>project</location>
</skill>

<skill>
<name>omc-teams</name>
<description>CLI-team runtime for claude, codex, or gemini workers in tmux panes. Spawns real tmux worker processes for process-based parallel execution. Trigger when user says "omc team N:codex" or "omc team N:gemini".</description>
<location>project</location>
</skill>

<skill>
<name>omc-hud</name>
<description>Configure HUD display options (layout, presets, display elements). Real-time orchestration metrics in your status bar. Trigger when user says "hud" or wants to configure the OMC HUD.</description>
<location>project</location>
</skill>

<skill>
<name>omc-learner</name>
<description>Extract a learned skill from the current conversation. Identifies reusable patterns with strict quality gates and creates portable skill files. Trigger when user says "learner" or wants to learn from the current session.</description>
<location>project</location>
</skill>

<skill>
<name>omc-skill</name>
<description>Manage local skills - list, add, remove, search, edit, setup wizard. Trigger when user says "skill list", "skill add", or wants to manage OMC skills.</description>
<location>project</location>
</skill>

<skill>
<name>omc-setup</name>
<description>Install or refresh oh-my-claudecode for plugin, npm, and local-dev setups. Canonical setup flow for OMC installation. Trigger when user says "setup omc" or "omc-setup".</description>
<location>project</location>
</skill>

<skill>
<name>omc-setup-router</name>
<description>Unified setup/configuration entrypoint. Routes setup, doctor, or MCP requests to the correct OMC setup flow. Trigger when user says "/setup" or wants OMC configuration routing.</description>
<location>project</location>
</skill>

<skill>
<name>omc-doctor</name>
<description>Diagnose and fix oh-my-claudecode installation issues. Checks dependencies, configuration, and state. Trigger when user says "omc-doctor" or has OMC installation problems.</description>
<location>project</location>
</skill>

<skill>
<name>omc-reference</name>
<description>OMC agent catalog, available tools, team pipeline routing, commit protocol, and skills registry. Auto-loads when delegating to agents or using OMC tools.</description>
<location>project</location>
</skill>

<skill>
<name>omc-mcp-setup</name>
<description>Configure popular MCP servers for enhanced agent capabilities. Sets up MCP integrations for extended tool access. Trigger when user says "mcp-setup" or wants to configure MCP servers.</description>
<location>project</location>
</skill>

<skill>
<name>omc-configure-notifications</name>
<description>Configure notification integrations (Telegram, Discord, Slack, OpenClaw) via natural language. Trigger when user says "configure notifications" or wants to set up OMC notifications.</description>
<location>project</location>
</skill>

<skill>
<name>omc-plan</name>
<description>Strategic planning with optional interview workflow. Creates implementation plans with optional deep-interview pre-gate. Pipeline: deep-interview → omc-plan → autopilot. Trigger when user says "plan" or wants strategic planning.</description>
<location>project</location>
</skill>

<skill>
<name>omc-trace</name>
<description>Evidence-driven tracing lane that orchestrates competing tracer hypotheses. Causal investigation using systematic hypothesis testing. Trigger when user says "trace" or wants evidence-driven debugging.</description>
<location>project</location>
</skill>

<skill>
<name>omc-release</name>
<description>Automated release workflow for oh-my-claudecode. Handles versioning, changelog, and publishing. Trigger when user says "release" or wants to publish an OMC release.</description>
<location>project</location>
</skill>

<skill>
<name>omc-sciomc</name>
<description>Orchestrate parallel scientist agents for comprehensive analysis with AUTO mode. Runs multiple research agents in parallel for thorough investigation. Trigger when user says "sciomc" or wants comprehensive multi-agent analysis.</description>
<location>project</location>
</skill>

<skill>
<name>omc-external-context</name>
<description>Invoke parallel document-specialist agents for external web searches and documentation lookup. Trigger when user says "external-context" or needs parallel documentation research.</description>
<location>project</location>
</skill>

<skill>
<name>omc-project-session-manager</name>
<description>Worktree-first dev environment manager for issues, PRs, and features with optional tmux sessions. Trigger when user says "psm" or wants project session management.</description>
<location>project</location>
</skill>

<skill>
<name>omc-visual-verdict</name>
<description>Structured visual QA verdict for screenshot-to-reference comparisons. Trigger when user says "visual-verdict" or wants structured visual quality assessment.</description>
<location>project</location>
</skill>

<skill>
<name>omc-writer-memory</name>
<description>Agentic memory system for writers - track characters, relationships, scenes, and themes. Commands: init, char, rel, scene, query, validate, synopsis, status, export. Trigger when user says "writer-memory" or wants narrative tracking.</description>
<location>project</location>
</skill>

<skill>
<name>007</name>
<description>Security audit, hardening, threat modeling (STRIDE/PASTA), Red/Blue Team, OWASP checks, code review, incident response, and infrastructure security for any project.</description>
<location>project</location>
</skill>

<skill>
<name>agent-memory-systems</name>
<description>You are a cognitive architect who understands that memory makes agents intelligent. You've built memory systems for agents handling millions of interactions. You know that the hard part isn't stori...</description>
<location>project</location>
</skill>

<skill>
<name>ai-engineering-toolkit</name>
<description>6 production-ready AI engineering workflows: prompt evaluation (8-dimension scoring), context budget planning, RAG pipeline design, agent security audit (65-point checklist), eval harness building,...</description>
<location>project</location>
</skill>

<skill>
<name>airflow-dag-patterns</name>
<description>Build production Apache Airflow DAGs with best practices for operators, sensors, testing, and deployment. Use when creating data pipelines, orchestrating workflows, or scheduling batch jobs.</description>
<location>project</location>
</skill>

<skill>
<name>analyze-project</name>
<description>Forensic root cause analyzer for Antigravity sessions. Classifies scope deltas, rework patterns, root causes, hotspots, and auto-improves prompts/health.</description>
<location>project</location>
</skill>

<skill>
<name>android-jetpack-compose-expert</name>
<description>Expert guidance for building modern Android UIs with Jetpack Compose, covering state management, navigation, performance, and Material Design 3.</description>
<location>project</location>
</skill>

<skill>
<name>api-documenter</name>
<description>Master API documentation with OpenAPI 3.1, AI-powered tools, and modern developer experience practices. Create interactive docs, generate SDKs, and build comprehensive developer portals.</description>
<location>project</location>
</skill>

<skill>
<name>api-endpoint-builder</name>
<description>Builds production-ready REST API endpoints with validation, error handling, authentication, and documentation. Follows best practices for security and scalability.</description>
<location>project</location>
</skill>

<skill>
<name>api-fuzzing-bug-bounty</name>
<description>Provide comprehensive techniques for testing REST, SOAP, and GraphQL APIs during bug bounty hunting and penetration testing engagements. Covers vulnerability discovery, authentication bypass, IDOR ...</description>
<location>project</location>
</skill>

<skill>
<name>api-patterns</name>
<description>API design principles and decision-making. REST vs GraphQL vs tRPC selection, response formats, versioning, pagination.</description>
<location>project</location>
</skill>

<skill>
<name>api-security-best-practices</name>
<description>Implement secure API design patterns including authentication, authorization, input validation, rate limiting, and protection against common API vulnerabilities</description>
<location>project</location>
</skill>

<skill>
<name>architect-review</name>
<description>Master software architect specializing in modern architecture</description>
<location>project</location>
</skill>

<skill>
<name>architecture-decision-records</name>
<description>Comprehensive patterns for creating, maintaining, and managing Architecture Decision Records (ADRs) that capture the context and rationale behind significant technical decisions.</description>
<location>project</location>
</skill>

<skill>
<name>architecture-patterns</name>
<description>Master proven backend architecture patterns including Clean Architecture, Hexagonal Architecture, and Domain-Driven Design to build maintainable, testable, and scalable systems.</description>
<location>project</location>
</skill>

<skill>
<name>astro</name>
<description>Build content-focused websites with Astro — zero JS by default, islands architecture, multi-framework components, and Markdown/MDX support.</description>
<location>project</location>
</skill>

<skill>
<name>auth-implementation-patterns</name>
<description>Build secure, scalable authentication and authorization systems using industry-standard patterns and modern best practices.</description>
<location>project</location>
</skill>

<skill>
<name>avoid-ai-writing</name>
<description>Audit and rewrite content to remove 21 categories of AI writing patterns with a 43-entry replacement table</description>
<location>project</location>
</skill>

<skill>
<name>aws-cost-optimizer</name>
<description>Comprehensive AWS cost analysis and optimization recommendations using AWS CLI and Cost Explorer</description>
<location>project</location>
</skill>

<skill>
<name>aws-serverless</name>
<description>Proper Lambda function structure with error handling</description>
<location>project</location>
</skill>

<skill>
<name>backend-architect</name>
<description>Expert backend architect specializing in scalable API design, microservices architecture, and distributed systems.</description>
<location>project</location>
</skill>

<skill>
<name>beautiful-prose</name>
<description>A hard-edged writing style contract for timeless, forceful English prose without modern AI tics. Use when users ask for prose or rewrites that must be clean, exact, concrete, and free of AI cadence...</description>
<location>project</location>
</skill>

<skill>
<name>behavioral-modes</name>
<description>AI operational modes (brainstorm, implement, debug, review, teach, ship, orchestrate). Use to adapt behavior based on task type.</description>
<location>project</location>
</skill>

<skill>
<name>blueprint</name>
<description>Turn a one-line objective into a step-by-step construction plan any coding agent can execute cold. Each step has a self-contained context brief — a fresh agent in a new session can pick up any step...</description>
<location>project</location>
</skill>

<skill>
<name>browser-automation</name>
<description>You are a browser automation expert who has debugged thousands of flaky tests and built scrapers that run for years without breaking. You've seen the evolution from Selenium to Puppeteer to Playwri...</description>
<location>project</location>
</skill>

<skill>
<name>bug-hunter</name>
<description>Systematically finds and fixes bugs using proven debugging techniques. Traces from symptoms to root cause, implements fixes, and prevents regression.</description>
<location>project</location>
</skill>

<skill>
<name>bullmq-specialist</name>
<description>BullMQ expert for Redis-backed job queues, background processing, and reliable async execution in Node.js/TypeScript applications. Use when: bullmq, bull queue, redis queue, background job, job queue.</description>
<location>project</location>
</skill>

<skill>
<name>c4-architecture-c4-architecture</name>
<description>Generate comprehensive C4 architecture documentation for an existing repository/codebase using a bottom-up analysis approach.</description>
<location>project</location>
</skill>

<skill>
<name>c4-component</name>
<description>Expert C4 Component-level documentation specialist. Synthesizes C4 Code-level documentation into Component-level architecture, defining component boundaries, interfaces, and relationships.</description>
<location>project</location>
</skill>

<skill>
<name>c4-container</name>
<description>Expert C4 Container-level documentation specialist.</description>
<location>project</location>
</skill>

<skill>
<name>c4-context</name>
<description>Expert C4 Context-level documentation specialist. Creates high-level system context diagrams, documents personas, user journeys, system features, and external dependencies.</description>
<location>project</location>
</skill>

<skill>
<name>chrome-extension-developer</name>
<description>Expert in building Chrome Extensions using Manifest V3. Covers background scripts, service workers, content scripts, and cross-context communication.</description>
<location>project</location>
</skill>

<skill>
<name>clean-code</name>
<description>This skill embodies the principles of \"Clean Code\" by Robert C. Martin (Uncle Bob). Use it to transform \"code that works\" into \"code that is clean.\</description>
<location>project</location>
</skill>

<skill>
<name>closed-loop-delivery</name>
<description>Use when a coding task must be completed against explicit acceptance criteria with minimal user re-intervention across implementation, review feedback, deployment, and runtime verification.</description>
<location>project</location>
</skill>

<skill>
<name>cloudflare-workers-expert</name>
<description>Expert in Cloudflare Workers and the Edge Computing ecosystem. Covers Wrangler, KV, D1, Durable Objects, and R2 storage.</description>
<location>project</location>
</skill>

<skill>
<name>codebase-cleanup-tech-debt</name>
<description>You are a technical debt expert specializing in identifying, quantifying, and prioritizing technical debt in software projects. Analyze the codebase to uncover debt, assess its impact, and create acti</description>
<location>project</location>
</skill>

<skill>
<name>concise-planning</name>
<description>Use when a user asks for a plan for a coding task, to generate a clear, actionable, and atomic checklist.</description>
<location>project</location>
</skill>

<skill>
<name>context-window-management</name>
<description>You're a context engineering specialist who has optimized LLM applications handling millions of conversations. You've seen systems hit token limits, suffer context rot, and lose critical informatio...</description>
<location>project</location>
</skill>

<skill>
<name>convex</name>
<description>Convex reactive backend expert: schema design, TypeScript functions, real-time subscriptions, auth, file storage, scheduling, and deployment.</description>
<location>project</location>
</skill>

<skill>
<name>copywriting</name>
<description>Write rigorous, conversion-focused marketing copy for landing pages and emails. Enforces brief confirmation and strict no-fabrication rules.</description>
<location>project</location>
</skill>

<skill>
<name>cpp-pro</name>
<description>Write idiomatic C++ code with modern features, RAII, smart pointers, and STL algorithms. Handles templates, move semantics, and performance optimization.</description>
<location>project</location>
</skill>

<skill>
<name>csharp-pro</name>
<description>Write modern C# code with advanced features like records, pattern matching, and async/await. Optimizes .NET applications, implements enterprise patterns, and ensures comprehensive testing.</description>
<location>project</location>
</skill>

<skill>
<name>data-engineer</name>
<description>Build scalable data pipelines, modern data warehouses, and real-time streaming architectures. Implements Apache Spark, dbt, Airflow, and cloud-native data platforms.</description>
<location>project</location>
</skill>

<skill>
<name>data-scientist</name>
<description>Expert data scientist for advanced analytics, machine learning, and statistical modeling. Handles complex data analysis, predictive modeling, and business intelligence.</description>
<location>project</location>
</skill>

<skill>
<name>data-storytelling</name>
<description>Transform raw data into compelling narratives that drive decisions and inspire action.</description>
<location>project</location>
</skill>

<skill>
<name>database-architect</name>
<description>Expert database architect specializing in data layer design from scratch, technology selection, schema modeling, and scalable database architectures.</description>
<location>project</location>
</skill>

<skill>
<name>database-migration</name>
<description>Master database schema and data migrations across ORMs (Sequelize, TypeORM, Prisma), including rollback strategies and zero-downtime deployments.</description>
<location>project</location>
</skill>

<skill>
<name>database-optimizer</name>
<description>Expert database optimizer specializing in modern performance tuning, query optimization, and scalable architectures.</description>
<location>project</location>
</skill>

<skill>
<name>dbt-transformation-patterns</name>
<description>Production-ready patterns for dbt (data build tool) including model organization, testing strategies, documentation, and incremental processing.</description>
<location>project</location>
</skill>

<skill>
<name>debugger</name>
<description>Debugging specialist for errors, test failures, and unexpected</description>
<location>project</location>
</skill>

<skill>
<name>design-spells</name>
<description>Curated micro-interactions and design details that add "magic" and personality to websites and apps.</description>
<location>project</location>
</skill>

<skill>
<name>devops-troubleshooter</name>
<description>Expert DevOps troubleshooter specializing in rapid incident response, advanced debugging, and modern observability.</description>
<location>project</location>
</skill>

<skill>
<name>django-pro</name>
<description>Master Django 5.x with async views, DRF, Celery, and Django Channels. Build scalable web applications with proper architecture, testing, and deployment.</description>
<location>project</location>
</skill>

<skill>
<name>drizzle-orm-expert</name>
<description>Expert in Drizzle ORM for TypeScript — schema design, relational queries, migrations, and serverless database integration. Use when building type-safe database layers with Drizzle.</description>
<location>project</location>
</skill>

<skill>
<name>e2e-testing-patterns</name>
<description>Build reliable, fast, and maintainable end-to-end test suites that provide confidence to ship code quickly and catch regressions before users do.</description>
<location>project</location>
</skill>

<skill>
<name>elixir-pro</name>
<description>Write idiomatic Elixir code with OTP patterns, supervision trees, and Phoenix LiveView. Masters concurrency, fault tolerance, and distributed systems.</description>
<location>project</location>
</skill>

<skill>
<name>embedding-strategies</name>
<description>Guide to selecting and optimizing embedding models for vector search applications.</description>
<location>project</location>
</skill>

<skill>
<name>expo-deployment</name>
<description>Deploy Expo apps to production</description>
<location>project</location>
</skill>

<skill>
<name>fastapi-pro</name>
<description>Build high-performance async APIs with FastAPI, SQLAlchemy 2.0, and Pydantic V2. Master microservices, WebSockets, and modern Python async patterns.</description>
<location>project</location>
</skill>

<skill>
<name>find-bugs</name>
<description>Find bugs, security vulnerabilities, and code quality issues in local branch changes. Use when asked to review changes, find bugs, security review, or audit code on the current branch.</description>
<location>project</location>
</skill>

<skill>
<name>frontend-developer</name>
<description>Build React components, implement responsive layouts, and handle client-side state management. Masters React 19, Next.js 15, and modern frontend architecture.</description>
<location>project</location>
</skill>

<skill>
<name>github-issue-creator</name>
<description>Transform messy input (error logs, voice notes, screenshots) into clean, actionable GitHub issues.</description>
<location>project</location>
</skill>

<skill>
<name>godot-gdscript-patterns</name>
<description>Master Godot 4 GDScript patterns including signals, scenes, state machines, and optimization. Use when building Godot games, implementing game systems, or learning GDScript best practices.</description>
<location>project</location>
</skill>

<skill>
<name>golang-pro</name>
<description>Master Go 1.21+ with modern patterns, advanced concurrency, performance optimization, and production-ready microservices.</description>
<location>project</location>
</skill>

<skill>
<name>grafana-dashboards</name>
<description>Create and manage production-ready Grafana dashboards for comprehensive system observability.</description>
<location>project</location>
</skill>

<skill>
<name>haskell-pro</name>
<description>Expert Haskell engineer specializing in advanced type systems, pure</description>
<location>project</location>
</skill>

<skill>
<name>helm-chart-scaffolding</name>
<description>Comprehensive guidance for creating, organizing, and managing Helm charts for packaging and deploying Kubernetes applications.</description>
<location>project</location>
</skill>

<skill>
<name>incident-responder</name>
<description>Expert SRE incident responder specializing in rapid problem resolution, modern observability, and comprehensive incident management.</description>
<location>project</location>
</skill>

<skill>
<name>java-pro</name>
<description>Master Java 21+ with modern features like virtual threads, pattern matching, and Spring Boot 3.x. Expert in the latest Java ecosystem including GraalVM, Project Loom, and cloud-native patterns.</description>
<location>project</location>
</skill>

<skill>
<name>javascript-pro</name>
<description>Master modern JavaScript with ES6+, async patterns, and Node.js APIs. Handles promises, event loops, and browser/Node compatibility.</description>
<location>project</location>
</skill>

<skill>
<name>k6-load-testing</name>
<description>Comprehensive k6 load testing skill for API, browser, and scalability testing. Write realistic load scenarios, analyze results, and integrate with CI/CD.</description>
<location>project</location>
</skill>

<skill>
<name>k8s-manifest-generator</name>
<description>Step-by-step guidance for creating production-ready Kubernetes manifests including Deployments, Services, ConfigMaps, Secrets, and PersistentVolumeClaims.</description>
<location>project</location>
</skill>

<skill>
<name>kaizen</name>
<description>Guide for continuous improvement, error proofing, and standardization. Use this skill when the user wants to improve code quality, refactor, or discuss process improvements.</description>
<location>project</location>
</skill>

<skill>
<name>laravel-expert</name>
<description>Senior Laravel Engineer role for production-grade, maintainable, and idiomatic Laravel solutions. Focuses on clean architecture, security, performance, and modern standards (Laravel 10/11+).</description>
<location>project</location>
</skill>

<skill>
<name>llm-app-patterns</name>
<description>Production-ready patterns for building LLM applications, inspired by [Dify](https://github.com/langgenius/dify) and industry best practices.</description>
<location>project</location>
</skill>

<skill>
<name>local-llm-expert</name>
<description>Master local LLM inference, model selection, VRAM optimization, and local deployment using Ollama, llama.cpp, vLLM, and LM Studio. Expert in quantization formats (GGUF, EXL2) and local AI privacy.</description>
<location>project</location>
</skill>

<skill>
<name>matplotlib</name>
<description>Matplotlib is Python's foundational visualization library for creating static, animated, and interactive plots.</description>
<location>project</location>
</skill>

<skill>
<name>nestjs-expert</name>
<description>You are an expert in Nest.js with deep knowledge of enterprise-grade Node.js application architecture, dependency injection patterns, decorators, middleware, guards, interceptors, pipes, testing st...</description>
<location>project</location>
</skill>

<skill>
<name>networkx</name>
<description>NetworkX is a Python package for creating, manipulating, and analyzing complex networks and graphs.</description>
<location>project</location>
</skill>

<skill>
<name>nosql-expert</name>
<description>Expert guidance for distributed NoSQL databases (Cassandra, DynamoDB). Focuses on mental models, query-first modeling, single-table design, and avoiding hot partitions in high-scale systems.</description>
<location>project</location>
</skill>

<skill>
<name>observability-engineer</name>
<description>Build production-ready monitoring, logging, and tracing systems. Implements comprehensive observability strategies, SLI/SLO management, and incident response workflows.</description>
<location>project</location>
</skill>

<skill>
<name>on-call-handoff-patterns</name>
<description>Effective patterns for on-call shift transitions, ensuring continuity, context transfer, and reliable incident response across shifts.</description>
<location>project</location>
</skill>

<skill>
<name>plan-writing</name>
<description>Structured task planning with clear breakdowns, dependencies, and verification criteria. Use when implementing features, refactoring, or any multi-step work.</description>
<location>project</location>
</skill>

<skill>
<name>plotly</name>
<description>Interactive visualization library. Use when you need hover info, zoom, pan, or web-embeddable charts. Best for dashboards, exploratory analysis, and presentations. For static publication figures us...</description>
<location>project</location>
</skill>

<skill>
<name>polars</name>
<description>Fast in-memory DataFrame library for datasets that fit in RAM. Use when pandas is too slow but data still fits in memory. Lazy evaluation, parallel execution, Apache Arrow backend. Best for 1-100GB...</description>
<location>project</location>
</skill>

<skill>
<name>postmortem-writing</name>
<description>Comprehensive guide to writing effective, blameless postmortems that drive organizational learning and prevent incident recurrence.</description>
<location>project</location>
</skill>

<skill>
<name>progressive-estimation</name>
<description>Estimate AI-assisted and hybrid human+agent development work with research-backed PERT statistics and calibration feedback loops</description>
<location>project</location>
</skill>

<skill>
<name>rag-engineer</name>
<description>I bridge the gap between raw documents and LLM understanding. I know that retrieval quality determines generation quality - garbage in, garbage out. I obsess over chunking boundaries, embedding dim...</description>
<location>project</location>
</skill>

<skill>
<name>slo-implementation</name>
<description>Framework for defining and implementing Service Level Indicators (SLIs), Service Level Objectives (SLOs), and error budgets.</description>
<location>project</location>
</skill>

<skill>
<name>spark-optimization</name>
<description>Optimize Apache Spark jobs with partitioning, caching, shuffle optimization, and memory tuning. Use when improving Spark performance, debugging slow jobs, or scaling data processing pipelines.</description>
<location>project</location>
</skill>

<skill>
<name>sveltekit</name>
<description>Build full-stack web applications with SvelteKit — file-based routing, SSR, SSG, API routes, and form actions in one framework.</description>
<location>project</location>
</skill>

<skill>
<name>tanstack-query-expert</name>
<description>Expert in TanStack Query (React Query) — asynchronous state management. Covers data fetching, stale time configuration, mutations, optimistic updates, and Next.js App Router (SSR) integration.</description>
<location>project</location>
</skill>

<skill>
<name>tdd-orchestrator</name>
<description>Master TDD orchestrator specializing in red-green-refactor discipline, multi-agent workflow coordination, and comprehensive test-driven development practices.</description>
<location>project</location>
</skill>

<skill>
<name>test-automator</name>
<description>Master AI-powered test automation with modern frameworks, self-healing tests, and comprehensive quality engineering. Build scalable testing strategies with advanced CI/CD integration.</description>
<location>project</location>
</skill>

<skill>
<name>ui-visual-validator</name>
<description>Rigorous visual validation expert specializing in UI testing, design system compliance, and accessibility verification.</description>
<location>project</location>
</skill>

</available_skills>
<!-- SKILLS_TABLE_END -->

</skills_system>
