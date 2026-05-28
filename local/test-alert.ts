/**
 * Local test for the admin-alert path (criterion 15).
 *
 * Verifies:
 *   1. publishAdminAlert() gracefully no-ops when ADMIN_ALERT_TOPIC_ARN is unset.
 *   2. markAlerted()/isAlerted() de-dup flag works.
 *   3. (Optional) If ADMIN_ALERT_TOPIC_ARN + AWS creds are set, publishes a real
 *      test message to SNS — the admin should receive an email.
 *
 * Usage:
 *   # Test 1 + 2 only (no AWS calls):
 *   npm run local-test-alert
 *
 *   # Test 3 (real SNS publish) — set env vars first:
 *   ADMIN_ALERT_TOPIC_ARN=arn:aws:sns:us-east-1:123456789012:rocketlane-status-email-alerts-prod \
 *   AWS_REGION=us-east-1 \
 *   AWS_PROFILE=your-profile \
 *   npm run local-test-alert -- --live
 */

import { publishAdminAlert, markAlerted, isAlerted } from '../src/alert';

const live = process.argv.includes('--live');

async function main(): Promise<void> {
  let pass = 0;
  let fail = 0;

  const assert = (label: string, cond: boolean): void => {
    if (cond) {
      console.log(`  ✓  ${label}`);
      pass++;
    } else {
      console.log(`  ✗  ${label}`);
      fail++;
    }
  };

  console.log('\n[1] publishAdminAlert no-ops when ADMIN_ALERT_TOPIC_ARN is unset');
  const savedArn = process.env.ADMIN_ALERT_TOPIC_ARN;
  delete process.env.ADMIN_ALERT_TOPIC_ARN;
  try {
    await publishAdminAlert({ stage: 'send', error: new Error('synthetic') });
    assert('returns without throwing when topic ARN is missing', true);
  } catch (err) {
    assert(`returns without throwing when topic ARN is missing (threw: ${err})`, false);
  }
  if (savedArn) process.env.ADMIN_ALERT_TOPIC_ARN = savedArn;

  console.log('\n[2] markAlerted / isAlerted de-dup flag');
  const e = new Error('boom');
  assert('isAlerted is false initially', isAlerted(e) === false);
  markAlerted(e);
  assert('isAlerted is true after markAlerted', isAlerted(e) === true);
  assert('isAlerted is false for non-objects', isAlerted('string-error') === false);
  assert('isAlerted is false for null', isAlerted(null) === false);

  if (live) {
    console.log('\n[3] Live SNS publish (--live flag set)');
    if (!process.env.ADMIN_ALERT_TOPIC_ARN) {
      console.log('  ✗  ADMIN_ALERT_TOPIC_ARN not set; cannot run live test');
      fail++;
    } else {
      try {
        await publishAdminAlert({
          stage: 'job',
          error: new Error('LOCAL TEST — this is a synthetic alert from local/test-alert.ts'),
          context: { runAt: new Date().toISOString(), source: 'local-test' },
        });
        assert(`published test alert to ${process.env.ADMIN_ALERT_TOPIC_ARN}`, true);
        console.log('     Check the admin inbox for the SNS email.');
      } catch (err) {
        assert(`live publish failed: ${err instanceof Error ? err.message : err}`, false);
      }
    }
  } else {
    console.log('\n[3] Live SNS publish — skipped (pass --live to enable)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
