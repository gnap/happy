const { withEntitlementsPlist } = require('@expo/config-plugins');

/**
 * For development builds: remove Push Notifications and Associated Domains
 * from entitlements so a personal Apple team (free account) can sign the app.
 * Paid teams are unaffected.
 */
function withPersonalTeamEntitlements(config) {
  return withEntitlementsPlist(config, (cfg) => {
    if (process.env.APP_ENV !== 'development') return cfg;
    const e = cfg.modResults || {};
    delete e['aps-environment'];
    delete e['com.apple.developer.associated-domains'];
    cfg.modResults = e;
    return cfg;
  });
}

module.exports = withPersonalTeamEntitlements;
