# InvoiceFlow AI

**AI-Powered Invoice Processing & Business Automation Platform**

A multi-tenant SaaS that automates the accounts-payable invoice lifecycle: upload → AI extraction → deterministic validation → duplicate & anomaly detection → **company-defined business rules** → auto-approval / human approval / exception queue → notifications → audit trail → analytics.

> **The core idea:** *AI understands the document. Validation checks the maths. Business rules decide what the company wants. Automation executes the decision.* AI can never override a company rule.

```
unzip invoiceflow-ai.zip && cd invoiceflow-ai
docker compose up --build        # UI http://localhost:5173  ·  API docs http://localhost:4000/api/docs
# demo login:  admin@invoiceflow.demo / Demo@12345
```

---

## Contents
1. [Problem statement](#problem-statement) · 2. [Features](#features) · 3. [Architecture](#architecture) · 4. [Tech stack](#technology-stack) · 5. [Database schema](#database-schema) · 6. [Invoice processing flow](#invoice-processing-flow) · 7. [AI architecture](#ai-architecture) · 8. [Business rule engine](#business-rule-engine) · 9. [Rule builder](#rule-builder) · 10. [Automation engine](#automation-engine) · 11. [Approval workflow](#approval-workflow) · 12. [Security](#security) · 13. [Multi-tenancy](#multi-tenancy) · 14. [Local setup](#local-setup) · 15. [Docker setup](#docker-setup) · 16. [Demo credentials](#demo-credentials) · 17. [Gemini API key setup](#gemini-api-key-setup) · 18. [Creating a business rule](#creating-a-business-rule) · 19. [Deployment](#deployment) · 20. [Testing](#testing) · 21. [API documentation](#api-documentation) · 22. [Verification status & known limitations](#verification-status--known-limitations) · 23. [Future improvements](#future-improvements)

---

## Problem statement
Finance teams spend hours re-keying invoices, hunting duplicates, chasing approvals and explaining to auditors why something was paid. Existing "OCR demos" extract text but leave the policy side hard-coded or manual. InvoiceFlow separates the concerns: AI reads the invoice, code verifies it, and **each company configures its own approval policy through a no-code rule builder** — with a full, inspectable audit trail of every decision.

## Features
- **Multi-tenant workspaces** – self-service company registration; strict tenant isolation enforced server-side.
- **Auth** – registration, login, logout, JWT access tokens + rotating httpOnly refresh-token cookie (with reuse detection), forgot/reset password, bcrypt hashing.
- **RBAC** – OWNER, ADMIN, FINANCE_MANAGER, FINANCE_USER, VIEWER, enforced on the backend.
- **Invoice upload** – PDF/PNG/JPG/JPEG with extension + MIME + magic-byte + integrity checks, size limit (default 10 MB, configurable per org), SHA-256 fingerprint, authorized file access, pluggable storage (`StorageService`; local disk implemented).
- **AI extraction** – Gemini with structured output validated by Zod; deterministic **Mock** mode that needs no key. Provider abstraction (`AIProvider`).
- **Deterministic validation** – `subtotal + tax ≈ total`, `qty × unit ≈ line total`, line/subtotal/tax sums, due ≥ invoice date, required fields, configurable rounding tolerance. No AI arithmetic.
- **Duplicate detection** – vendor + number + date + total, and document hash.
- **Anomaly & risk scoring** – missing PO, unknown vendor, tax mismatch, unusually high amount (vs vendor history), low AI confidence, invalid dates…; AI only *explains* the risk.
- **Business Rule Builder** – visual WHEN / IF / THEN builder with AND/OR and nested groups, 9 triggers, 15 condition fields, 12 action types, priorities, enable/disable/duplicate/soft-delete, **versioning with readable diffs**, **dry-run tester**, templates, execution history.
- **Approvals** – single and multi-level chains, role- or user-specific approvers, approve / reject (reason required) / request changes.
- **Exception queue** – review, edit data, retry AI, send for approval, approve, reject.
- **In-app notifications, tasks, tags** created by rules (with `{{variables}}`).
- **Audit log** of every material event (never contains secrets).
- **Dashboard & analytics** – KPIs, automation rate, charts, rule performance.
- **Background processing** – BullMQ on Redis, 3 attempts with exponential back-off, idempotent jobs.
- **Swagger/OpenAPI** at `/api/docs`, CSV export, dark mode, responsive layout.

## Architecture
```
 React (Vite, TS, Tailwind, TanStack Query)
        │  /api  (nginx proxy in Docker, Vite proxy in dev → same origin)
        ▼
 Express (modular monolith)  ── routes → services → Prisma ──►  PostgreSQL  (source of truth)
        │                                                  
        ├── security/   JWT, bcrypt, AES-256-GCM CredentialService, RBAC permissions
        ├── ai/         AIProvider · GeminiProvider · MockAIProvider · factory (per-org)
        ├── invoices/   upload validation, pipeline (extract → validate → dup → anomalies → rules), duplicate detection
        ├── validation/ deterministic checks, anomaly detection, risk scoring (pure functions)
        ├── rules/      field catalog · condition trees · actions · conflict resolution · engine · dry-run · versioning
        ├── automation/ decision application (auto-approve / approval chain / manual review / reject)
        ├── approvals/  chain creation, multi-level decisions, exception resolution
        ├── analytics/  dashboard + automation metrics
        └── jobs/       BullMQ queue + worker (Redis) with inline mode for tests
```
Layering rule: route handlers only parse input and call services; no business logic lives in routes.

## Technology stack
| Layer | Tech |
|---|---|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS, React Router, TanStack Query, Axios, React Hook Form + Zod, Recharts, Lucide |
| Backend | Node 22, Express, TypeScript (strict), Zod, Helmet, CORS, express-rate-limit, Multer, swagger-ui-express |
| Data | PostgreSQL 16, **Prisma 6** (migrations, indexes, FKs, unique constraints, transactions) |
| Queue | Redis 7 + BullMQ |
| AI | Google Gemini (REST, structured JSON output) + deterministic mock |
| Tests | Vitest + Supertest (backend, real Postgres), Vitest + Testing Library (frontend) |
| Ops | Docker Compose with health checks, GitHub Actions CI |

## Database schema
Defined in `backend/prisma/schema.prisma`; migration in `backend/prisma/migrations/`.

| Model | Purpose |
|---|---|
| `Organization`, `OrganizationSettings`, `Onboarding` | tenant, per-org config (AI mode/model, rounding tolerance, max upload), onboarding checklist |
| `User`, `OrganizationMember` (role), `RefreshToken`, `PasswordResetToken` | identity & sessions |
| `Vendor` | vendor master (`industry`, `group` usable in rules; `verified` flag) |
| `Invoice`, `InvoiceLineItem` | invoices (+ JSON: extraction, validation, anomalies, AI analysis), lines |
| `Approval` | multi-level approval chain (`level`, `totalLevels`, role/user, status) |
| `BusinessRule`, `BusinessRuleVersion`, `BusinessRuleExecution` | rules (conditions/actions as **structured JSON**, never code), full version history, per-evaluation execution log |
| `Notification`, `Task`, `Tag`, `InvoiceTag` | outputs of automation |
| `AuditLog` | append-only event log |
| `AIProcessingJob` | per-attempt AI job record |
| `Credential` | AES-256-GCM encrypted secrets (Gemini key) |

Every org-owned row carries `organizationId`. Idempotency is backed by unique constraints (`Approval(invoiceId, runKey, ruleKey, level)`, `BusinessRuleExecution(ruleId, invoiceId, trigger, runKey)`, `Notification(org, user, dedupeKey)`, `Task(org, dedupeKey)`, `InvoiceTag(invoiceId, tagId)`).

## Invoice processing flow
```
Upload → validate file (size/ext/MIME/magic bytes/integrity) → create Invoice → store file → enqueue job (idempotent jobId)
  Worker:  claim (lock + completedRun guard)
        → AI extraction (Zod-validated; retries ×3, non-retryable errors fail fast)
        → derive totals in code → deterministic validation
        → vendor resolution → duplicate detection → anomaly detection → risk score
        → AI risk *explanation* (cannot change the risk)
        → ONE DB TRANSACTION: persist data → run rules → resolve conflicts → apply decision
                              → effects (notify/tag/task) → chained events → audit → mark completed
```
Because the decision + all side effects commit atomically, a crashed or retried job never leaves half-applied automation.
After 3 failed attempts the invoice becomes `FAILED`, appears in the exception queue and the uploader/finance managers are notified. Reprocessing creates a new *run* that supersedes the old one (open approvals are cancelled).

## AI architecture
- `AIProvider { extractInvoice, analyzeInvoice, generateInsight }`, implemented by `GeminiProvider` and `MockAIProvider`; `getProviderForOrg()` picks per organization.
- **No silent fake data:** in Gemini mode without a stored key the invoice **fails loudly**; it never falls back to mock output.
- Gemini output is requested as JSON (`responseMimeType` + `responseSchema`) and validated with Zod; `"UNKNOWN"`/empty → `null`; numeric strings are coerced; garbage → retryable `AIProviderError`.
- The API key travels only in the `x-goog-api-key` header (never in URLs or logs).
- **Mock mode** is deterministic (SHA-256 of the file → vendor/amounts). For tests and seeding, a `MOCKDATA:{json}` line inside the file overrides the extraction. This hook exists only in the mock provider.

## Business rule engine
Rules are **data**: `{ trigger, conditions (tree), actions[] , priority, enabled }`, validated against a server-side catalog. Unsupported fields/operators/actions, bad values, empty groups, nesting > 5 and references to users of other organizations are rejected. No user code is ever stored or executed.

**Triggers:** `INVOICE_UPLOADED`, `INVOICE_PROCESSED`, `INVOICE_VALIDATION_FAILED`, `DUPLICATE_DETECTED`, `ANOMALY_DETECTED`, `APPROVAL_REQUESTED`, `APPROVAL_COMPLETED`, `INVOICE_APPROVED`, `INVOICE_REJECTED`. (Adding one = one enum value + emitting the event.)

**Condition fields:** `invoice.total/subtotal/tax/taxRate/currency/invoiceDate/dueDate/riskLevel/duplicateDetected/purchaseOrderPresent/aiConfidence`, `vendor.name/id/industry/group`. Operators: equals, not equals, >, ≥, <, ≤, contains (per field type). Risk levels compare by severity.

**Actions** (registry in `rules/actions.ts` – add one entry to extend): `AUTO_APPROVE`, `REQUIRE_APPROVAL`, `REQUIRE_MULTI_LEVEL_APPROVAL`, `REJECT_INVOICE`, `SEND_NOTIFICATION`, `CREATE_TASK`, `ADD_TAG`, `MOVE_TO_EXCEPTION_QUEUE`, `SET_RISK_LEVEL`, `UPDATE_STATUS`, `REQUEST_HUMAN_REVIEW`, `TRIGGER_AI_ANALYSIS`.
*Decision* actions (approve/approval/review/reject) decide the invoice and are only allowed on triggers that run before the decision. *Effect* actions (notify/tag/task/…) are allowed everywhere.

### Conflict resolution (deterministic)
1. Matching rules are ordered by **priority** (1 = highest), then creation time.
2. The decision comes from the highest-priority matching rule that has a decision action.
3. If several decisions share that priority, the **most restrictive wins**: `REJECT > MANUAL REVIEW > APPROVAL > AUTO-APPROVE`. So an equal-priority review/reject rule always beats auto-approve.
4. Losing decisions are recorded as `SUPPRESSED` (with the reason) and never executed. Effect actions from **all** matching rules still run.
5. **System safety floor (not overridable by rules):** duplicates and blocking validation errors (arithmetic mismatch, negative amounts, missing invoice number/vendor/total) can never be auto-approved — they go to manual review. If *no* rule decides, the invoice goes to a finance manager (never auto-approved).
> Note: a *lower*-priority restrictive rule does not override a *higher*-priority auto-approve (per the spec: "equal/higher priority"). Keep auto-approve rules at a low priority (high number) as the defaults do.

### Safety
- Pure evaluation (`evaluateRules`) is separated from execution, which is what makes dry-run possible.
- **Loop protection:** chained events carry a depth (max 3), every execution is keyed by `(rule, invoice, trigger, runKey)` and is skipped if it already ran; effects never re-trigger rules directly.
- **Idempotency:** execution/approval/notification/task/tag uniqueness + atomic transaction + job claim.
- Corrupted stored rules are recorded as errors and cannot crash processing. Failed actions are recorded as `FAILED` – never reported as success.

### Default rules (created for every new organization; fully editable)
| P | Rule | Effect |
|---|---|---|
| 1 | Duplicate Invoice Review | exception queue + notify finance manager |
| 2 | Critical Risk Review | human review + notify admin |
| 3 | Missing Purchase Order (> 25,000) | human review + tag |
| 4 | Low AI Confidence (< 70%) | human review |
| 5 | Admin Approval (≥ 100,000) | admin approval + notify + tag *High Value* |
| 6 | Manager Approval (10,000–100,000) | finance-manager approval + notify |
| 7 | Low Value Auto Approval (< 10,000, risk LOW, confidence ≥ 70%) | auto-approve + notify uploader |

Extra templates: *Multi-level approval for very high value*, *High value + elevated risk* (approval + notification + tag + task).
> Thresholds are plain numbers; add a `Currency equals …` condition if you process several currencies.

## Rule builder
`/automation/rules` (list, enable switch, duplicate, delete-with-confirmation, last run, run count) and `/automation/rules/new|:id` (builder). It communicates **WHEN → IF → THEN** as three connected blocks; AND/OR groups are colour-coded and can be nested; all dropdowns come from `GET /api/automation/metadata`, so the UI can never offer something the backend rejects. A side panel provides the **dry-run tester** (works on unsaved drafts) and **version history** ("Condition changed: Invoice total is greater than 50000 → …, by Rahul, 03 Oct 2026").

## Automation engine
`rules/engine.ts#runEvent` → load enabled rules for the triggers → evaluate (pure) → resolve conflicts → apply the decision (`automation/decision.ts`) → run effects → write one `BusinessRuleExecution` per evaluated rule (conditions tree, matched?, per-action result, duration) → emit chained events. Everything happens inside the caller's transaction.

## Approval workflow
Rules create approval chains (role- or user-specific; multi-level = level 1 `PENDING`, later levels `WAITING`). Role checks use a hierarchy (OWNER ≥ ADMIN ≥ FINANCE_MANAGER). Approving the last level approves the invoice; rejecting requires a reason and cancels remaining levels; *request changes* sends the invoice to the exception queue. Decisions are race-safe (one wins on double-click).

## Security
Helmet, CORS (allow-list), rate limiting (stricter on auth), Zod validation everywhere, centralized error handler (no stack/secret leakage), bcrypt (cost 12), JWT access (15 min) + rotating refresh tokens stored hashed with reuse detection, httpOnly SameSite cookie, RBAC, tenant isolation, magic-byte upload validation, path-traversal-safe storage keys, authorized file download, CSV formula-injection neutralization, AES-256-GCM credential encryption, audit redaction of secret-looking keys, no secrets in logs/Git, API key never returned (masked `••••1234` only).

## Multi-tenancy
The organization ID is **never** read from the client. It comes from the verified JWT and is re-checked against `OrganizationMember` on every request (so role changes/removals apply immediately). Every query is scoped by `organizationId`; cross-tenant access returns `404`. Rules, vendors, invoices, approvals, notifications, audit logs and credentials are all per organization. Covered by automated tests (see below).

## Local setup
Requirements: Node ≥ 20, PostgreSQL 16, Redis 7.
```bash
# backend
cd backend
cp .env.example .env            # fill JWT_SECRET, JWT_REFRESH_SECRET, ENCRYPTION_KEY (openssl rand -hex 32)
npm install
npx prisma generate
npx prisma migrate deploy       # applies backend/prisma/migrations
npm run seed                    # idempotent demo data
npm run dev                     # http://localhost:4000

# frontend (new terminal)
cd frontend && npm install && npm run dev     # http://localhost:5173 (proxies /api → :4000)
```

## Docker setup
```bash
docker compose up --build
```
Starts **postgres → redis → backend → frontend** with health checks. The backend entrypoint runs `prisma migrate deploy`, seeds demo data (idempotent; disable with `SEED_DEMO_DATA=false`), then starts the API + BullMQ worker. UI: <http://localhost:5173>, API docs: <http://localhost:4000/api/docs>. Copy `.env.example` to `.env` to override secrets/ports (the built-in defaults are **development only**).

## Demo credentials
| Email | Password | Role |
|---|---|---|
| `admin@invoiceflow.demo` | `Demo@12345` | OWNER |
| `manager@invoiceflow.demo` | `Demo@12345` | FINANCE_MANAGER |
| `clerk@invoiceflow.demo` | `Demo@12345` | FINANCE_USER |

Seed: 1 organization, 3 users, 10 vendors (+1 unverified vendor auto-created from an invoice, on purpose), 30 invoices / ~119 line items pushed **through the real pipeline** (auto-approved, pending/approved/rejected, duplicates, missing PO, arithmetic mismatch, low confidence, unknown vendor, a 2-level approval), ~200 rule executions, approvals, notifications and audit logs. All data is fictional.

## Gemini API key setup
1. Start InvoiceFlow and log in.
2. Go to **Settings → AI**.
3. Select **Gemini**.
4. Enter your Gemini API key (from Google AI Studio).
5. Click **Validate key**.
6. Click **Save**. (The server re-validates before storing; the key is AES-256-GCM encrypted, never shown again.)
7. Upload an invoice — extraction now runs on Gemini. If Google renames/retires a model, change the **model** field on the same page.

## Creating a business rule
Example from the brief — *Automation → Rules → New rule*:
- **Name** `High Risk Large Invoice` · **Priority** `2`
- **WHEN** Invoice processed
- **IF** (ALL) `Invoice total` is greater than `75000` **AND** `Risk level` does not equal `LOW`
- **THEN** Require approval → Finance Manager **AND** Send notification → Finance Manager **AND** Add tag `High Risk`
- Pick an invoice in **Test rule** → see each condition's actual value, MATCH / NO MATCH and the actions that *would* run (nothing executes) → **Save rule**.

Upload a ₹92,000 invoice with elevated risk and the approval is created, the manager notified and the tag added automatically; the invoice's **Business rules** panel shows exactly why.

## Deployment
- **Frontend** – Vercel/Netlify: build `npm run build`, output `dist`. Because auth uses a SameSite=Lax cookie, serve the API on the **same site** (rewrite `/api/*` to the backend, as `nginx.conf` does) or put both on subdomains of one domain.
- **Backend** – Render/Railway/Fly.io/any Docker host: build `backend/Dockerfile`. Set `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY` (≥ 32 chars each), `FRONTEND_URL` (exact origin, comma-separated for several), `COOKIE_SECURE=true`, `SEED_DEMO_DATA=false`. Run `npx prisma migrate deploy` on each release (the entrypoint does it).
- **Database** – managed PostgreSQL (Neon, RDS, Supabase DB…). **Redis** – managed Redis (Upstash, ElastiCache…; BullMQ needs `maxmemory-policy noeviction`).
- **Storage** – local disk is for development/single node; implement `StorageService` for S3/R2/Supabase Storage and mount it in `storage/storage.service.ts`.
- **HTTPS** – terminate TLS at the platform/proxy; keep `trust proxy` (already enabled) and `COOKIE_SECURE=true`.
- **CORS** – `FRONTEND_URL` is the allow-list; credentials are enabled.
- **Gemini** – configured per organization in Settings → AI (no deploy-time key needed). Back up `ENCRYPTION_KEY`: losing it makes stored keys unreadable.

## Testing
```bash
cd backend  && npm test        # unit + integration against a real Postgres (creates `invoiceflow_test`)
cd frontend && npm test        # component tests (jsdom)
npm run lint && npm run typecheck   # in each package
```
Backend tests cover: registration/login/refresh-rotation/reset, RBAC, **tenant isolation across every resource**, upload validation, extraction, validation maths, duplicate detection, rule conditions (AND/OR/nested), priorities & conflicts, dry-run purity (state snapshot before/after), action execution, idempotency & concurrent workers, recursion/loop protection, retries/failure handling, multi-level approvals, exception queue, Gemini provider (HTTP mocked: valid, fenced, invalid JSON, schema-invalid, 429/403/network) and key security (never returned, encrypted at rest, never logged), analytics, CSV export, OpenAPI/health. The end-to-end test registers an organization, creates the ₹92,000 rule, uploads, processes and asserts approval + notification + tag + task + audit + execution record.
Frontend tests render the real rule builder (using metadata captured from the live API), build a rule through the UI and assert the exact payload, run the dry-run tester, and cover auth forms and list/dashboard states.

## API documentation
Swagger UI: `/api/docs`. All responses use `{ "success": true, "data": … }` or `{ "success": false, "error": { "code", "message" } }`. Main groups: `/api/auth`, `/api/invoices` (+ `/upload`, `/manual`, `/export.csv`, `/:id/file`, `/:id/reprocess`), `/api/vendors`, `/api/approvals`, `/api/exceptions`, `/api/automation` (`/rules`, `/rules/:id/test`, `/rules/test-draft`, `/rules/:id/versions`, `/templates`, `/executions`, `/metadata`), `/api/analytics`, `/api/audit-logs`, `/api/notifications`, `/api/settings/ai`, `/api/users`, `/api/tasks`.

## Verification status & known limitations
Honest status of what was actually verified when this ZIP was produced:

**Verified (executed):** all backend tests (real PostgreSQL 16), all frontend tests, lint + type-check + production builds for both packages, the compiled backend booted in production mode against real PostgreSQL + Redis with the **BullMQ worker** processing an uploaded invoice end-to-end over HTTP, idempotent seeding via the compiled `dist/seed/seed.js`, cookie-based login/refresh rotation, Swagger and health endpoints.

**Not verified in the build environment — please check on your machine:**
- `docker compose up --build` was **not run** (no Docker available in the build sandbox). The Dockerfiles, nginx config and entrypoint follow the same steps that were run manually, but have not been built. In particular `prisma migrate deploy` inside the container uses Prisma's native schema engine (downloaded at image build time); here the migration SQL was generated with Prisma's WASM engine and applied directly with `psql`/`pg`.
- **Live Gemini calls**: no API key was available. The provider is tested against mocked HTTP only; the request shape (header auth, inline file data, `responseSchema`) follows Google's REST docs, but verify with a real key and adjust the model name in Settings if needed.
- **A real browser**: the UI was verified through type-checking, a production build and jsdom component tests – not screenshots or manual clicking. Expect to polish visuals.

**Design limitations / simplifications**
- One real queue (`invoice-processing`) runs the whole pipeline atomically; the other queue names in the brief are reserved but not split out (stages are separate functions, so splitting is straightforward).
- No email transport: password reset returns the link only outside production (and logs it); plug a sender into `auth.service.ts#forgotPassword`.
- "Default approval workflow" = the default rule set above (approval chains are created by rules).
- Rule thresholds are not currency-aware (add a currency condition).
- Local-disk storage only; no virus scanning; no OCR fallback besides the AI provider.
- Vendors are matched by tax ID or normalized name only (no fuzzy matching).

## Future improvements
S3/R2 storage adapter · email/Slack notification channels (the engine already supports pluggable actions) · split the pipeline across the reserved queues · fuzzy vendor matching & vendor bank-detail verification · currency conversion & per-currency thresholds · SSO/SAML & MFA · rule simulation over historical invoices (bulk what-if) · segregation-of-duties rule (uploader ≠ approver) · payment export (ACH/NEFT file) · webhooks · e2e browser tests (Playwright).
