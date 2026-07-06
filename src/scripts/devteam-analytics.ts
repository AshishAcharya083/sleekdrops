/**
 * DevTeam Analytics SDK - temporary test integration (do not merge to main).
 *
 * Runs the SDK against a local ingest endpoint to observe events and logs.
 * This bypasses the Mixpanel/GA4 consent gate intentionally: it is a test-only
 * branch that never ships to real users.
 *
 * To revert: delete this file and remove the <script> import in BaseLayout.astro.
 */

import { createAnalytics } from '@getdevteam/analytics-web';

const analytics = createAnalytics({
  key: 'dtp_9YapTQMaVMIKD5vLxcIiBl8ByAtwbHILHjrSUi2bshg',
  host: 'http://localhost:6080',
  trackPageviews: true,
});

analytics.identify('user_123');
analytics.track('app_opened');
