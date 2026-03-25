const { withEntitlementsPlist } = require('@expo/config-plugins');

/**
 * For development and preview (.personal) builds: remove Push Notifications
 * and Associated Domains from entitlements so a personal Apple team (free
 * account) can sign the app. Paid teams are unaffected.
 */
function withPersonalTeamEntitlements(config) {
  return withEntitlementsPlist(config, (cfg) => {
    const env = process.env.APP_ENV;
    if (env !== 'development' && env !== 'preview') return cfg;
    const e = cfg.modResults || {};
    delete e['aps-environment'];
    delete e['com.apple.developer.associated-domains'];
    cfg.modResults = e;
    return cfg;
  });
}

module.exports = withPersonalTeamEntitlements;
