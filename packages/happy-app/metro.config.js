const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

// Decode pathname so asset URLs like /assets/.%2Fsources%2F... resolve correctly (ENOENT on brutalist dir).
const expoRewrite = config.server.rewriteRequestUrl;
function decodeAssetPath(url) {
  try {
    const base = url.startsWith("/") ? "http://localhost" : undefined;
    const u = new URL(url, base);
    let decoded = u.pathname
      .split("/")
      .map((seg) => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return seg;
        }
      })
      .join("/");
    // Normalize /assets/./sources/... -> /assets/sources/...
    decoded = decoded.replace(/\/\.\//g, "/");
    const search = u.search || "";
    const hash = u.hash || "";
    url = url.startsWith("/") ? decoded + search + hash : u.origin + decoded + search + hash;
  } catch {
    // keep url unchanged
  }
  return url;
}
config.server.rewriteRequestUrl = (url) => {
  const decoded = decodeAssetPath(url);
  try {
    const pathname = new URL(decoded, "http://x").pathname;
    if (pathname.startsWith("/assets/") || pathname === "/assets") {
      return decoded;
    }
  } catch {}
  return typeof expoRewrite === "function" ? expoRewrite(decoded) : decoded;
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