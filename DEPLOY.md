# Deployment Guide

Minimal commands to get the Rocketlane status email job running in AWS.

## Prerequisites

- Node.js 20+, AWS CLI v2, SAM CLI installed and authenticated
- An SES sender address **already verified** in your target AWS region
- (If your SES account is in sandbox mode) recipient addresses verified too

```bash
aws sts get-caller-identity   # confirm you're in the right account
aws configure get region      # confirm the deploy region
```

## 1. Install + build

```bash
npm install
npm run build
```

## 2. First-time deploy (guided)

```bash
sam deploy --guided \
  --parameter-overrides \
      Stage=prod \
      SenderEmail=status@yourdomain.com \
      AdminEmail=admin@yourdomain.com \
      DayThreshold=7
```

Accept defaults. SAM saves your choices to `samconfig.toml`. Subsequent deploys are just `sam deploy`.

The first deploy provisions: Lambda, EventBridge schedule, S3 bucket, DynamoDB table, Secrets Manager secret, SNS topic, CloudWatch alarm, and all SSM parameters.

**Confirm the SNS subscription** in the admin inbox so alerts are delivered.

## 3. Push the Rocketlane API key

```bash
aws secretsmanager put-secret-value \
  --secret-id rocketlane/api-key-prod \
  --secret-string 'PASTE_ROCKETLANE_API_KEY_HERE'
```

## 4. Upload the email template to S3

```bash
export TEMPLATE_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name rocketlane-status-email \
  --query "Stacks[0].Outputs[?OutputKey=='TemplateBucket'].OutputValue" \
  --output text)

npx ts-node scripts/upload-template.ts
```

Re-run this script any time `templates/status-email.html` changes — no redeploy needed.

## 5. Set recipients (and any other runtime config)

```bash
aws ssm put-parameter \
  --name /rocketlane-status-email/prod/recipients \
  --value 'ceo@yourdomain.com,cto@yourdomain.com,vp-delivery@yourdomain.com' \
  --type String --overwrite

# Optional: change the urgency threshold without redeploying
aws ssm put-parameter \
  --name /rocketlane-status-email/prod/day_threshold \
  --value '5' --type String --overwrite
```

## 6. Smoke test

```bash
aws lambda invoke \
  --function-name rocketlane-status-email-prod \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' \
  /tmp/out.json

aws logs tail /aws/lambda/rocketlane-status-email-prod --since 5m --follow
```

You should see `Job started`, `Fetched N flagged project(s)`, and `Email sent` lines, and the email itself in the recipients' inboxes.

## Day-2 operations

| Action | Command |
|---|---|
| Change recipients | `aws ssm put-parameter --name /rocketlane-status-email/prod/recipients --value '...' --overwrite` |
| Change schedule | Edit `ScheduleExpression` in `template.yaml`, then `sam deploy` |
| Update template | Edit `templates/status-email.html`, then `npx ts-node scripts/upload-template.ts` |
| Rotate API key | `aws secretsmanager put-secret-value --secret-id rocketlane/api-key-prod --secret-string '...'` |
| Disable history reconciliation (when Rocketlane API exposes `statusUpdatedAt`) | `aws ssm put-parameter --name /rocketlane-status-email/prod/use_history_table --value 'false' --overwrite` |
| Tail logs | `aws logs tail /aws/lambda/rocketlane-status-email-prod --since 1h --follow` |
| Redeploy code only | `npm run build && sam deploy` |
| Tear down | `sam delete --stack-name rocketlane-status-email` (empty the S3 bucket first) |

## Troubleshooting quick reference

- **`MessageRejected: Email address is not verified`** — verify the SES sender (and recipients if in sandbox) in the same region as the Lambda.
- **`AccessDenied` on SSM/Secrets** — re-deploy; IAM policies in `template.yaml` cover all required actions.
- **No email but no errors** — check `recipients` parameter is comma-separated with no stray quotes.
- **Chart missing in email** — QuickChart.io was unreachable; the Lambda logs warn and the email still sends without the image.
- **Days-in-status all show `0`** — the Rocketlane response didn't include `statusUpdatedAt` and the history table hasn't observed a status change yet. After one full day with `use_history_table=true`, values will populate.
