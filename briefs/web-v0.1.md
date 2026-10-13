# Elsewhere Web v0.1 — interface to existing capabilities

**Status:** implementation brief; not implemented or authorized to run agents. **Product positioning:** Elsewhere is presently a research thesis. This web prototype tests how a person might interact with already-existing supervised solution-development capabilities.

## Mission

Build a small, polished web interface to the **existing** Development Cycle control plane. Development Cycle owns planning, approvals, execution lifecycle, validation and delivery; Octopus is its **external, optional** implementation adapter. Do not rebuild, fork or modify either engine, and do not implement Decision Multiverse in this phase.

The visitor begins with **“What are you trying to solve?”** rather than “What software do you want to build?” The UI must distinguish user intent from the implementation mechanism. Use the brand **elsewhere.** and tagline **“Same same, but different.”**

## Before coding

1. Read this repository's research README and the public Development Cycle README/API documentation, then inspect the current implementation interfaces. Do not infer runtime URLs, authentication, schemas or permissions from old examples.
2. Identify which read-only data can be safely exposed through a server-side adapter. Document gaps instead of inventing endpoints.
3. Propose the smallest credible, testable, portable web implementation. Avoid exposing private infrastructure or project state in public code, docs or fixtures.
4. Keep the public app disconnected by default. Real environment configuration must remain in private runtime config.

## MVP surfaces

**Home / projects.** Branded introduction, a problem statement input for draft-only composition, and a list of projects/runs when read-only data is available. Never suggest that entering a prompt automatically starts work.

**Run detail.** Show the real Development Cycle lifecycle, available status, plan/approval boundaries, implementation adapter, mechanical validation, final decision and delivery evidence. Render unknown/unavailable state explicitly. Link to evidence when safe and authorized.

**Execution controls.** In v0.1, default to read-only observation. If a draft action/approval request is displayed, make it inert or local-only and label it clearly. Do not provide controls that launch, continue, correct, validate, publish or otherwise advance runs until a separate, explicit authorization and server-side permission architecture are designed and reviewed. **Never call Octopus directly from the browser.**

**Decision Multiverse preview.** A visually appealing *Coming soon* section with a subtle, conceptual decision graph. This is a non-interactive teaser. It must not generate branches, inferred agent rationales, counterfactual results or fake decision records. Do not impose three alternatives or any default branching cardinality. Make clear that real decision exploration is future research.

**Demo mode.** Ship a clearly labeled local fixture/demo for visual review without requiring NAS, OpenClaw, tokens or secrets. Keep fixture data synthetic and clearly marked; never pretend demo work was executed. Provide clear empty/error/loading states.

## Architecture and security boundaries

- Web client -> owned server-side integration adapter -> explicitly authorized, documented Development Cycle interfaces. Octopus only via the Development Cycle adapter, not directly.
- All credentials and private endpoint URLs remain server-side in deployment config. Never embed them in bundles, screenshots, logs, examples or the public repository.
- No direct access to local Docker socket, SSH, underlying process execution, source worktrees or private files from the browser.
- No public exposure of an operational instance as part of this task. Do not touch gateways, reverse proxies, runtime configs or protected paths.
- Treat service data as untrusted. Enforce access control server-side before any real data becomes reachable, and use least privilege.
- No external tracking, paid API services, user accounts, billing, production deploy, auto-publication or speculative platform building for the prototype.

## Design language

Editorial rather than enterprise dashboard: dark charcoal, restrained warm accent, clean typography, lots of whitespace, concise states, strong visual hierarchy. One meaningful problem-first entry point; progressive disclosure of run details. Responsive and accessible. Visual prototype should not imply non-existent capabilities.

## Delivery

- A runnable, self-contained web prototype in this repository under a bounded app directory chosen after inspection.
- Read-only real-state integration **only if** a documented, secured interface exists; otherwise provide a clear adapter contract and honest demo mode. Do not create or assume a private bridge.
- One synthetic demonstration showing project and run-state views; Decision Multiverse appears only as *Coming soon*.
- Setup and usage instructions, architecture/boundary explanation, a short list of functionality explicitly deferred, and meaningful behavior-based validation.
- Public-sanitization audit must pass. No tautological/change-detector tests.

## Explicitly excluded from v0.1

Decision extraction, decision trees, alternative-path generation, historical checkpoints, branch replay, autonomous multi-agent exploration, execution/approval mutation endpoints, Octopus modification, Development Cycle modification and production deployment.

## Success criterion

A person can open Elsewhere Web, recognize the solution-first vision, understand the status of a Development Cycle run from observed data or an honest synthetic demo, understand that Octopus is an external execution adapter, and see where the future Decision Multiverse will live — **without launching work or misrepresenting research as a shipped capability**.
