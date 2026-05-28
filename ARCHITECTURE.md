<!--
Paste this whole file as a GitHub PR / issue comment.
GitHub renders the mermaid block and tables natively.
-->

## Rocketlane Daily Status Email — Architecture

> Single-Lambda, event-driven job that emails leadership a daily summary of all **blocked** and **delayed** Rocketlane projects, with days-in-status, owner, reason, and inline summary + per-role workload charts — eliminating the need to click through to Rocketlane.

### Flow



### Why one Lambda (not four)

The original sketch split fetch / render / send across separate Lambdas. For a daily batch with at most a few hundred projects, that adds cold-start latency, IAM surface, and payload-passing complexity with **zero parallelism benefit** — fetch→render→send is strictly sequential.

| Decision | Choice | Reason |
|---|---|---|
| Compute | 1 Lambda (Node 20, arm64, 1 GB) | Sequential pipeline, low volume, simplest to operate |
| Schedule | EventBridge Scheduler (`cron`) | Configurable, supports per-region timezone offsets |
| Config | SSM Parameter Store | Free, versioned, edit-without-redeploy; DynamoDB would be over-spec |
| Rocketlane API key | Secrets Manager | Rotation-ready, IAM-gated |
| Microsoft Graph credentials | SSM (`graph_tenant_id`, `graph_client_id`, `graph_client_secret`) | Editable without redeploy; secret to be converted to `SecureString` post-deploy |
| Template | S3 (`status-email.html`) | Edit + upload = live; no code redeploy |
| Logo | S3 (`templates/assets/aivar-logo.png`) | Inlined via CID, swap without redeploy |
| Days-in-status | Rocketlane API field if present, else DynamoDB fallback | Idempotent reconciliation survives across runs |
| Charts | QuickChart.io → inline CID PNGs | Zero native deps, no Lambda layer, Outlook-safe |
| Email | **Microsoft Graph `sendMail`** (raw MIME, base64-encoded body) | Sends from a real M365 mailbox; preserves `multipart/mixed → related → alternative` exactly; no per-message charge |
| Auth to Graph | OAuth 2.0 client credentials (cached access token) | Standard app-only auth via Azure AD; token re-used across warm invocations |
| Alerting | CloudWatch Errors ≥ 1 → SNS, **plus** in-Lambda `publishAdminAlert` on `job` / `send` failure stages | Structured failure detail (which stage, Graph response excerpt) reaches the admin inbox immediately |

### Repository layout

```
├── src/
│   ├── index.ts          # Lambda handler — orchestrates the run
│   ├── config.ts         # SSM + Secrets Manager (cached across invokes)
│   ├── rocketlane.ts     # Paginated API client, response normalization
│   ├── statusHistory.ts  # DynamoDB reconciliation for days-in-status
│   ├── chart.ts          # QuickChart summary + per-role stacked PNGs (graceful fallback)
│   ├── render.ts         # Handlebars HTML + plain-text rendering, S3 template + logo loader
│   ├── send.ts           # Raw MIME via Microsoft Graph sendMail (HTML + text + inline images)
│   ├── graphAuth.ts      # OAuth client-credentials token for Graph (in-memory cache)
│   ├── alert.ts          # SNS admin-alert helper (structured failure notifications)
│   └── types.ts
├── templates/
│   ├── status-email.html # Email-safe HTML (table layout, inline styles)
│   └── assets/
│       └── aivar-logo.png # Inlined header logo (cid:aivar-logo@aivar)
├── scripts/
│   └── upload-template.ts
├── template.yaml         # SAM: Lambda + Scheduler + S3 + DDB + Secrets + SNS + alarm + SSM params
└── DEPLOY.md             # Step-by-step deploy commands
```

### Acceptance-criteria mapping

| Requirement | Implementation |
|---|---|
| Full project details in email body — no Rocketlane click-through needed | `templates/status-email.html` renders name, status, days, owner, delivery manager, CSM, account manager, reason, last updated, project link |
| Days-in-status from last status change | `src/index.ts:buildFlagged` uses `statusUpdatedAt` if Rocketlane provides it, otherwise the DDB-tracked `statusSince` |
| All blocked/delayed projects included | `RocketlaneClient.fetchFlaggedProjects` paginates both statuses to completion |
| Latest state at send time | Synchronous fetch on every invocation, no caching of project data |
| Inline graphical summary | Four QuickChart PNGs referenced via CID: `summary-chart@rocketlane` (totals bar), `dm-chart@rocketlane`, `csm-chart@rocketlane`, `am-chart@rocketlane` (stacked workload by role), plus `aivar-logo@aivar` header |
| Plain-text fallback | `multipart/alternative` part rendered by `render.ts:renderPlainText` |
| Sort by days desc, blocked → delayed | `flagged.sort()` in `src/index.ts` |
| Urgent highlighting at configurable threshold | `isUrgent = daysInStatus >= dayThreshold`; threshold lives in SSM, no redeploy |
| "All clear" message when zero flagged | Subject line + dedicated "all clear" template branch |
| Failure alert to admin | CloudWatch alarm → SNS **and** `src/alert.ts:publishAdminAlert` publishes structured `{stage, error, context}` payloads to the same SNS topic when `job` or `send` stages throw |
| Template editable without redeploy | S3-hosted, ETag-cached; re-upload picks up automatically |

### Cost envelope (typical)

- 1 Lambda invocation/day × ~10s × 1 GB → < $0.10/month
- SSM standard params, S3, DDB on-demand → effectively $0
- Microsoft Graph `sendMail` → included with the M365 license of the sender mailbox; no per-message charge
- Azure AD token endpoint calls → free
- **Total: well under $1/month.**

### Build / deploy quick reference

```bash
npm install && npm run build
sam deploy --guided \
  --parameter-overrides SenderEmail=status@yourdomain.com AdminEmail=admin@yourdomain.com
aws secretsmanager put-secret-value --secret-id rocketlane/api-key-prod --secret-string '<key>'

# Microsoft Graph credentials (set the three SSM params via console or CLI)
aws ssm put-parameter --name /rocketlane-status-email/prod/graph_tenant_id     --type String --overwrite --value '<azure-tenant-id>'
aws ssm put-parameter --name /rocketlane-status-email/prod/graph_client_id     --type String --overwrite --value '<azure-app-client-id>'
aws ssm put-parameter --name /rocketlane-status-email/prod/graph_client_secret --type SecureString --overwrite --value '<azure-client-secret>'

npx ts-node scripts/upload-template.ts
aws lambda invoke --function-name rocketlane-status-email-prod /tmp/out.json
```

Full step-by-step in [`DEPLOY.md`](./DEPLOY.md).

### Open items before go-live

- [ ] Confirm Rocketlane API response shape (specifically whether `statusUpdatedAt` is present on the status field). If yes, set `use_history_table=false` and the DDB table becomes a no-op.
- [ ] Grant the Azure AD app `Mail.Send` **application** permission (admin-consented), ideally scoped to the sender mailbox via an `ApplicationAccessPolicy` so it cannot send as any other user.
- [ ] Convert `/rocketlane-status-email/<stage>/graph_client_secret` from `String` to `SecureString` and establish a rotation cadence.
- [ ] Final recipient list from leadership.
- [ ] Decide on send time (currently `13:00 UTC`, Mon–Fri).
