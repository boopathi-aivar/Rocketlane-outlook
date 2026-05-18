<!--
Paste this whole file as a GitHub PR / issue comment.
GitHub renders the mermaid block and tables natively.
-->

## Rocketlane Daily Status Email — Architecture

> Single-Lambda, event-driven job that emails leadership a daily summary of all **blocked** and **delayed** Rocketlane projects, with days-in-status, owner, reason, and an inline summary chart — eliminating the need to click through to Rocketlane.

### Flow



### Why one Lambda (not four)

The original sketch split fetch / render / send across separate Lambdas. For a daily batch with at most a few hundred projects, that adds cold-start latency, IAM surface, and payload-passing complexity with **zero parallelism benefit** — fetch→render→send is strictly sequential.

| Decision | Choice | Reason |
|---|---|---|
| Compute | 1 Lambda (Node 20, arm64, 1 GB) | Sequential pipeline, low volume, simplest to operate |
| Schedule | EventBridge Scheduler (`cron`) | Configurable, supports per-region timezone offsets |
| Config | SSM Parameter Store | Free, versioned, edit-without-redeploy; DynamoDB would be over-spec |
| API key | Secrets Manager | Rotation-ready, IAM-gated |
| Template | S3 (`status-email.html`) | Edit + upload = live; no code redeploy |
| Days-in-status | Rocketlane API field if present, else DynamoDB fallback | Idempotent reconciliation survives across runs |
| Chart | QuickChart.io → inline CID PNG | Zero native deps, no Lambda layer, Outlook-safe |
| Email | SES `SendRawEmail` (multipart/mixed→related→alternative) | Inline image + HTML + plain-text fallback in one message |
| Alerting | CloudWatch Errors ≥ 1 → SNS → email | Standard, no extra services |

### Repository layout

```
├── src/
│   ├── index.ts          # Lambda handler — orchestrates the run
│   ├── config.ts         # SSM + Secrets Manager (cached across invokes)
│   ├── rocketlane.ts     # Paginated API client, response normalization
│   ├── statusHistory.ts  # DynamoDB reconciliation for days-in-status
│   ├── chart.ts          # QuickChart donut PNG with graceful fallback
│   ├── render.ts         # Handlebars HTML + plain-text rendering
│   ├── send.ts           # Raw MIME via SES (HTML + text + inline image)
│   └── types.ts
├── templates/
│   └── status-email.html # Email-safe HTML (table layout, inline styles)
├── scripts/
│   └── upload-template.ts
├── template.yaml         # SAM: Lambda + Scheduler + S3 + DDB + Secrets + SNS + alarm
└── DEPLOY.md             # Step-by-step deploy commands
```

### Acceptance-criteria mapping

| Requirement | Implementation |
|---|---|
| Full project details in email body — no Rocketlane click-through needed | `templates/status-email.html` renders name, status, days, owner, reason, last updated, project link |
| Days-in-status from last status change | `src/index.ts:buildFlagged` uses `statusUpdatedAt` if Rocketlane provides it, otherwise the DDB-tracked `statusSince` |
| All blocked/delayed projects included | `RocketlaneClient.fetchFlaggedProjects` paginates both statuses to completion |
| Latest state at send time | Synchronous fetch on every invocation, no caching of project data |
| Inline graphical summary | QuickChart PNG attached as `cid:summary-chart@rocketlane`, referenced by `<img src="cid:...">` |
| Plain-text fallback | `multipart/alternative` part rendered by `render.ts:renderPlainText` |
| Sort by days desc, blocked → delayed | `flagged.sort()` in `src/index.ts` |
| Urgent highlighting at configurable threshold | `isUrgent = daysInStatus >= dayThreshold`; threshold lives in SSM, no redeploy |
| "All clear" message when zero flagged | Subject line + dedicated "all clear" template branch |
| Failure alert to admin | CloudWatch alarm → SNS → admin email |
| Template editable without redeploy | S3-hosted, ETag-cached; re-upload picks up automatically |

### Cost envelope (typical)

- 1 Lambda invocation/day × ~10s × 1 GB → < $0.10/month
- SSM standard params, S3, DDB on-demand → effectively $0
- SES at $0.10 per 1,000 emails → negligible
- **Total: well under $1/month** before SES pricing.

### Build / deploy quick reference

```bash
npm install && npm run build
sam deploy --guided \
  --parameter-overrides SenderEmail=status@yourdomain.com AdminEmail=admin@yourdomain.com
aws secretsmanager put-secret-value --secret-id rocketlane/api-key-prod --secret-string '<key>'
npx ts-node scripts/upload-template.ts
aws lambda invoke --function-name rocketlane-status-email-prod /tmp/out.json
```

Full step-by-step in [`DEPLOY.md`](./DEPLOY.md).

### Open items before go-live

- [ ] Confirm Rocketlane API response shape (specifically whether `statusUpdatedAt` is present on the status field). If yes, set `use_history_table=false` and the DDB table becomes a no-op.
- [ ] Verify SES sender domain / address in the target region.
- [ ] Final recipient list from leadership.
- [ ] Decide on send time (currently `13:00 UTC`, Mon–Fri).
