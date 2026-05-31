const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

// Decode pathname and unstable_path so asset URLs like /assets/.%2Fsources%2F... resolve correctly (ENOENT on brutalist dir).
// When asset path comes from query param unstable_path, Metro does not decode it; undecoded path crashes Metro (uncaught ENOENT).
const expoRewrite = config.server.rewriteRequestUrl;
function safeDecodeSegment(seg) {
  let s = seg;
  for (let i = 0; i < 3; i++) {
    try {
      const n = decodeURIComponent(s);
      if (n === s) break;
      s = n;
    } catch {
      break;
    }
  }
  return s;
}
function decodeAssetPath(url) {
  try {
    const base = url.startsWith("/") ? "http://localhost" : undefined;
    const u = new URL(url, base);
    // Multi-pass decode so double-encoded paths (e.g. .%252F) resolve; then normalize /.\//
    let decoded = u.pathname;
    for (let i = 0; i < 3; i++) {
      const next = decoded.split("/").map(safeDecodeSegment).join("/");
      if (next === decoded) break;
      decoded = next;
    }
    decoded = decoded.replace(/\/\.\//g, "/");
    let search = u.search || "";
    const unstablePath = u.searchParams.get("unstable_path");
    if (unstablePath) {
      try {
        let decodedPath = unstablePath;
        for (let i = 0; i < 3; i++) {
          const n = decodeURIComponent(decodedPath);
          if (n === decodedPath) break;
          decodedPath = n;
        }
        u.searchParams.set("unstable_path", decodedPath);
        search = "?" + u.searchParams.toString();
      } catch {
        // keep search unchanged
      }
    }
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

// Exclude Rust/Tauri build artifacts from module resolution.
// For dev mode, use CARGO_TARGET_DIR=/tmp/... to keep Rust build output
// outside the project tree entirely, preventing FallbackWatcher crashes.
config.resolver.blockList = [/src-tauri[/\\]target[/\\].*/];


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