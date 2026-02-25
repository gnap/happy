const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

// Decode pathname so asset URLs like /assets/.%2Fsources%2F... resolve correctly (ENOENT on brutalist dir)
config.server = {
  rewriteRequestUrl: (url) => {
    try {
      const u = new URL(url, "http://localhost");
      const decodedPath = u.pathname
        .split("/")
        .map((seg) => {
          try {
            return decodeURIComponent(seg);
          } catch {
            return seg;
          }
        })
        .join("/");
      if (decodedPath !== u.pathname) {
        return u.origin + decodedPath + (u.search || "") + (u.hash || "");
      }
      return url;
    } catch {
      return url;
    }
  },
};

// Add support for .wasm files (required by Skia for all platforms)
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/installation/
config.resolver.assetExts.push('wasm');

// Enable inlineRequires for proper Skia and Reanimated loading
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/web/
// Without this, Skia throws "react-native-reanimated is not installed" error
// This is cross-platform compatible (iOS, Android, web)
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true, // Critical for @shopify/react-native-skia
  },
});

module.exports = config;