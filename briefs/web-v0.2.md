# Elsewhere Web — product contract v0.2

**Status:** design/implementation brief, not a shipped feature. Supersedes the narrow read-only v0.1 scope as the target experience, but is explicitly staged. Do not infer that connected GitHub, autonomous runs, cross-project history or a public execution gateway already exist.

## Product intent

Elsewhere starts from a **problem and a target repository**, not an engineering prompt. The user oversees **decisions and approvals**, not verbose agent prompting. Development Cycle remains the supervised state-machine owner and Octopus is an external, optional implementation adapter. The Decision Multiverse is not implemented: show only *Coming soon*, not a fake decision tree or predicted outcomes.

**Execution location:** runs execute on the user's own machine, through the simplest install path available. No hosted execution is part of these stages.

## First-class workflows

### Identity and repositories

- Sign in via GitHub. Prefer a GitHub App installation with scoped, repository-selective permissions and server-side short-lived installation tokens rather than broad personal tokens. Verify the GitHub account identity securely, and require permission and installation checks server-side.
- List only repositories the authenticated user can access through the granted installation(s). Provide account/organization filtering and repository selection for users with multiple installations and repos.
- Let users select a repository and branch; let them request creation of a new repository, with name, owner, visibility and explicit confirmation. Creation is a separate GitHub permission/action and may require installation/re-authorization. Do not imply it is available if permissions are missing.
- Explicitly distinguish a repository that the user can read from one where Elsewhere is authorized to create branches, Issues and PRs. Check permissions before executing. Never force a push to a protected/default branch.
- Issues, implementation branches and PRs live in the selected repository, with links back to Elsewhere runs. Support existing Issues as an entry point, not just free-text problem descriptions.

### Modes, authority and approvals

- **Supervised:** humans review consequential decisions as they arise, including plan/implementation approvals, interventions and final go/revise/stop. Surface short decision cards: what is proposed, alternatives when evidenced, impact, trade-offs, recommendation, evidence and explicit approve/reject/request-change actions.
- **Autonomous:** within an explicitly authorized scope, budget, risk policy and maximum execution duration, approved automation can decide routine steps. Decisions are still persistently recorded and searchable. Do not bypass control-plane phase checks. Never equate autonomous with unlimited authority. Sensitive/out-of-scope actions block or need explicit approval.
- Each run stores immutable policy **snapshots** and an attributable authorizer, with subsequent mode changes recorded as decisions. This is a proposed product requirement, not a claim about Development Cycle's current enforcement.
- **Policy ownership:** the user defines policies in Elsewhere and answers approvals in Elsewhere. Development Cycle does not define policy; it needs explicit check points at each gated transition where Elsewhere's answer (approved, rejected, or covered by the run's policy snapshot) is required and recorded before the transition proceeds. Those check points do not exist today and are a prerequisite for Stage B.
- Any actual execution, including request_plan, record_plan, start, resume or finalization, must go through a reviewed authenticated server-side control adapter and existing Development Cycle tool/state machine, never direct browser-to-Octopus calls. No mutation features until permission enforcement and explicit operator authorization exist.

### Decisions, not prompts

- UI primary object: **Decision**: concise question, phase, proposal, meaningful context-specific alternatives (possibly zero), trade-offs, evidence/provenance, authority/policy, status, human or policy decision, timestamps and final outcome if observed.
- Distinguish human decisions, agent recommendations, autonomous policy decisions, and unverified post-run interpretations. Never claim access to hidden reasoning or impose a fixed number of branches.
- Keep prompt text, raw agent logs and technical diagnostics available only as optional permission-protected evidence. Do not structure the main experience around them.
- Plan edits/changes and approval decisions should remain attributable and traceable.

### Audit in the chosen repository

- Elsewhere keeps an append-oriented canonical run/audit record in its own secured persistent store, plus a **sanitized, concise, commit-linked** export in the selected repository. This avoids losing authoritative records if users rewrite Git history and avoids exposing private raw prompts/secrets in Git.
- Propose a default repository location such as `.elsewhere/runs/<run-id>/decisions.jsonl` plus `summary.md`, **only after** verifying repository compatibility and obtaining consent. Commit the export on the run's own implementation branch so it ships in the run's PR; never write directly to the default branch and do not open a separate PR per run. When a run has no PR (stopped before delivery, or delivery disabled), keep the export in Elsewhere's store and mark it as not exported.
- Each decision entry should have an id, timestamp, actor type/identity, authorization policy version, decision and rationale *only when explicitly recorded*, source links, action/result and related commit/Issue/PR. Hash-link or sign entries if tamper-evidence is later required; Git alone is not an immutable audit store.
- Handle concurrent runs, retrying exports, idempotency, partial delivery, deleted repositories and permission revocations without duplicating or silently losing decisions.

### Run and project history

- Show project-level and cross-repository run history with statuses, started/completed times, mode, cost/resource accounting when available, decisive events, associated Issues/PRs/commits and terminal outcomes.
- Reuse existing Development Cycle persisted run state and repository delivery evidence where available. Inventory the real schema and retention/cleanup mechanisms before designing import. Do not assume an existing global list API.
- Store a minimal durable Elsewhere history/index so that future workspace views survive ordinary cleanup of ephemeral executor logs. Policies for retention, export and deletion must be defined, and private raw artifacts must not be automatically published.
- If historical data has already been pruned, show *not available* rather than reconstructing fictional events. Existing GitHub PRs/Issues/commits may allow **partial** reconstruction, clearly labeled as such.

## Necessary overlooked capabilities

- **Pause/cancel/resume and recovery:** explicit interruption, stalled-run status, idempotent handoff, approval expiry and resumption after browser closure.
- **Finite budgets:** per-run token/currency/time limits and stop rules, aggregated across orchestrators; never silently increase caps.
- **Security and multi-tenancy:** least-privilege GitHub App, repository scoping, server-side auth, access checks for each resource, CSRF/state validation, webhook authentication and secure secret storage.
- **Data ownership:** export/migrate/delete personal workspace data and handle revoked GitHub access; decisions remain linked to the proper author and repo.
- **Delivery semantics:** distinguish proposed work, branch created, PR opened, checks passed, reviewed, merged, released and actual product outcomes.
- **Cost-effective notifications:** concise actionable alerts for pending decisions and terminal states; no noisy stream of routine logs.
- **Compatibility:** clear degraded/demo mode when no control-plane API or GitHub permissions are available; never claim a connected account or live run in a fixture.

## Incremental delivery / no fake controls

**Stage A (first executable UI):** branded GitHub sign-in/installation and repository selection **if secure server infrastructure and approvals are available**; otherwise an honest local demo. Read-only project/run listing using verified server APIs; decision-list UI populated only by genuine evidence or clearly marked synthetic fixtures. Decision Multiverse as non-interactive *Coming soon*. No live execution mutations.

**Stage B (authorized control):** GitHub repo creation where permitted, secure run creation and supervised approvals, branch/PR/Issue delivery, durable audit and history. Each action uses documented Development Cycle state transitions and separate explicit authorization. Do not fabricate missing interfaces.

**Stage C (bounded autonomy):** explicit mode and policy enforcement, decision journal, interruptions and recovery, resource budgets, notifications and delivery review. No autonomous production deploy/spending by default.

**Later research:** decision-path branching, replay and alternative-outcome comparison after provenance/evaluation research has validated them.

## Acceptance criteria to validate incrementally

Each stage is accepted on its own criteria; a later stage's criteria are not tested against an earlier stage. Tests must be meaningful behavioral tests only.

**Stage A**
- A user with multiple authorized repositories can select the correct target, or the demo mode says plainly that no account is connected.
- Run listing shows only runs present in the verified source, and pruned or unreadable runs appear as *not available* rather than reconstructed.
- A proposed decision cannot be mistaken for an approval, and synthetic fixtures are visibly labeled as synthetic.
- No control in the UI starts, advances or approves a run.

**Stage B**
- Each approval is attributable to a user and is recorded before the Development Cycle transition it authorizes.
- A run that reaches delivery can be traced to an Issue, branch, PR, commit and decision export. A run without a PR is traced through its record in Elsewhere's store, marked as not exported.
- Run history remains available after safe executor-artifact cleanup.
- A retried or concurrent export neither duplicates nor drops decisions.

**Stage C**
- An autonomous decision carries the policy snapshot that governed it.
- Actions cannot escape repository or budget scope; reaching a cap stops the run instead of raising the cap.
- Pausing, cancelling and resuming leave the run in a recorded, recoverable state.

## Not authorized by this document

No Development Cycle or Octopus runs, GitHub App installation, credential changes, user account creation, protected-config edits, infrastructure exposure, repo creation, or production deployments. Those require separate explicit review and authorization.
