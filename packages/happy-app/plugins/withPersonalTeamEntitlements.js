const { withEntitlementsPlist } = require('@expo/config-plugins');

/**
 * For development (.personal) builds only: remove Push Notifications and
 * Associated Domains so a personal Apple team (free account) can sign the app.
 * Preview and dev-testflight are paid-team TestFlight builds and keep
 * production aps-environment. Production is unaffected.
 */
function withPersonalTeamEntitlements(config) {
  return withEntitlementsPlist(config, (cfg) => {
    const env = process.env.APP_ENV;
    const e = cfg.modResults || {};
    if (env === 'development') {
      // Free personal team can't sign these capabilities.
      delete e['aps-environment'];
      delete e['com.apple.developer.associated-domains'];
    } else if (env === 'preview' || env === 'dev-testflight') {
      // Paid-team TestFlight build: production APNs (TestFlight uses prod APNs).
      e['aps-environment'] = 'production';
    }
    cfg.modResults = e;
    return cfg;
  });
}

module.exports = withPersonalTeamEntitlements;
