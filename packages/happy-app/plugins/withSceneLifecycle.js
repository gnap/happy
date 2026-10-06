const { withInfoPlist, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Adopt the UIKit scene-based life cycle.
 *
 * Apps built with the iOS 26 SDK or later that don't adopt UIScene are terminated at
 * launch on iOS 27 with:
 *
 *   UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption
 *   "UIScene life cycle is required for apps built with this SDK."
 *
 * (Apple TN3187 — https://developer.apple.com/documentation/technotes/tn3187-migrating-to-the-uikit-scene-based-life-cycle)
 *
 * Neither React Native 0.86 nor Expo SDK 57 ships scene support, and expo prebuild
 * regenerates ios/ without the manifest, so we add both halves here:
 *
 *   1. the UIApplicationSceneManifest entry in Info.plist, and
 *   2. a SceneDelegate class, appended to the existing AppDelegate.swift so it lands
 *      in the app target without touching the Xcode project file.
 *
 * The React Native setup stays where it is — AppDelegate creates the window in
 * didFinishLaunchingWithOptions; SceneDelegate just attaches that window to the scene.
 */

const SCENE_DELEGATE_CLASS = 'SceneDelegate';

const sceneDelegateSource = `
// MARK: - Scene lifecycle
//
// Required since iOS 27: UIKit terminates apps built with the iOS 26+ SDK that don't
// adopt the scene-based life cycle. React Native's setup is unchanged — AppDelegate
// creates the window in didFinishLaunchingWithOptions, and this delegate attaches it
// to the incoming scene. See plugins/withSceneLifecycle.js.
class ${SCENE_DELEGATE_CLASS}: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }

    if let appWindow = (UIApplication.shared.delegate as? AppDelegate)?.window {
      appWindow.windowScene = windowScene
      window = appWindow
      appWindow.makeKeyAndVisible()
    } else {
      // AppDelegate didn't create a window (shouldn't happen) — fall back to an empty one.
      let fallback = UIWindow(windowScene: windowScene)
      window = fallback
      fallback.makeKeyAndVisible()
    }
  }
}
`;

function withSceneManifest(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).' + SCENE_DELEGATE_CLASS,
          },
        ],
      },
    };
    return cfg;
  });
}

function withSceneDelegate(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const projectRoot = cfg.modRequest.platformProjectRoot;
      const appDirs = fs
        .readdirSync(projectRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      const appDir = appDirs.find((d) =>
        fs.existsSync(path.join(projectRoot, d, 'AppDelegate.swift'))
      );
      if (!appDir) {
        throw new Error(
          'withSceneLifecycle: no AppDelegate.swift found under ' + projectRoot
        );
      }

      const appDelegatePath = path.join(projectRoot, appDir, 'AppDelegate.swift');
      const contents = fs.readFileSync(appDelegatePath, 'utf8');

      if (contents.includes(`class ${SCENE_DELEGATE_CLASS}:`)) {
        return cfg;
      }

      fs.writeFileSync(appDelegatePath, contents.trimEnd() + '\n' + sceneDelegateSource);
      return cfg;
    },
  ]);
}

module.exports = (config) => withSceneDelegate(withSceneManifest(config));
