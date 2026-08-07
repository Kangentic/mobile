/**
 * Pins the portrait lock to a decision, because Play Console actively argues
 * against it and the obvious "fix" is wrong.
 *
 * Play raises "Remove resizability and orientation restrictions in your app to
 * support large screen devices" against every release, flagging
 * `com.kangentic.mobile.MainActivity` with `android:screenOrientation="PORTRAIT"`.
 * The one-line response is to flip `orientation` in app.config.ts. That was
 * investigated and deliberately declined - see the Play Console advisories
 * section of docs/store-listing.md. In short:
 *
 * - The advisory is advice, not a gate, and it will keep firing forever.
 * - Large screens (sw600dp and up) already ignore this attribute, because the
 *   app targets SDK 36. That is the behaviour the advisory actually asks for,
 *   and it is already live.
 * - Phones (under sw600dp) are never forced to rotate, in Android 16 OR 17.
 *   There is no deadline behind the warning.
 * - Removing the lock would newly expose phone landscape, where four
 *   `fitToContents` form sheets cap content at 420px against a window roughly
 *   360dp tall.
 *
 * `orientation` is the cross-platform key: it writes BOTH `android:screenOrientation`
 * and iOS `UISupportedInterfaceOrientations`. So this file also pins the iOS
 * side of the coupling, which is what makes an Android-only change a
 * non-trivial edit rather than a one-word one.
 */
import { describe, expect, it } from 'vitest';
import appConfig from '../../app.config';

describe('app.config.ts orientation', () => {
  it('keeps the portrait lock, which is a recorded decision and not an oversight', () => {
    expect(appConfig.orientation).toBe('portrait');
  });

  it('keeps iOS iPhone-only, so the portrait key means the same thing on both platforms', () => {
    expect(appConfig.ios?.supportsTablet).toBe(false);
  });

  /**
   * `createInfoPlistPluginWithPropertyGuard` in @expo/config-plugins skips the
   * orientation mod entirely when `ios.infoPlist.UISupportedInterfaceOrientations`
   * is set, warning only when `orientation` is also present. An override added
   * here would therefore silently outrank the key above on iOS while leaving
   * Android alone - the exact split this file exists to make visible.
   */
  it('states iOS orientation in one place only, so neither platform drifts silently', () => {
    const infoPlist = appConfig.ios?.infoPlist ?? {};
    expect(infoPlist).not.toHaveProperty('UISupportedInterfaceOrientations');
  });
});
