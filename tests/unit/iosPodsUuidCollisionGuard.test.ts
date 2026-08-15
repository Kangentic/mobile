/**
 * The Podfile UUID-collision guard, which is what keeps `pod install` from
 * saving a Pods.xcodeproj whose PBXProject was clobbered by an SPM object
 * that received the root object's UUID (xcodebuild: "The project 'Pods' is
 * damaged", via -[XCSwiftPackageProductDependency _setSavedArchiveVersion:]).
 *
 * The assertion lives over the generated Podfile TEXT, the same split as
 * androidCmakeBuildStaging.test.ts: the unit tier runs with no ios/ checked
 * out and CocoaPods only exists on a macOS runner, so the Ruby cannot execute
 * here. What CAN regress silently on this tier is the injection itself: the
 * guard landing outside the post_install hook, after react_native_post_install
 * (too late, the SPM objects would already exist), or not at all when the
 * template changes. Those are exactly what these tests pin.
 */
import { describe, expect, it } from 'vitest';

import {
  applyPodsUuidCollisionGuard,
  PODS_UUID_COLLISION_GUARD_ANCHOR,
  PODS_UUID_COLLISION_GUARD_BLOCK,
} from '../../plugins/withIosPodsUuidCollisionGuard';

/**
 * Mirrors the shape of the Podfile expo prebuild generates for this app
 * (captured from build-ios.yml run 31909442213): a two-space-indented
 * post_install block whose first statement is react_native_post_install.
 */
const GENERATED_PODFILE = `require 'json'
podfile_properties = JSON.parse(File.read(File.join(__dir__, 'Podfile.properties.json'))) rescue {}

target 'Kangentic' do
  use_expo_modules!

  post_install do |installer|
    react_native_post_install(
      installer,
      config[:reactNativePath],
      :mac_catalyst_enabled => false,
    )
  end
end
`;

describe('applyPodsUuidCollisionGuard', () => {
  it('injects the guard inside post_install, before react_native_post_install', () => {
    const result = applyPodsUuidCollisionGuard(GENERATED_PODFILE);

    const anchorIndex = result.indexOf(PODS_UUID_COLLISION_GUARD_ANCHOR);
    const hookIndex = result.indexOf('post_install do |installer|');
    const reactNativePostInstallIndex = result.indexOf('react_native_post_install(');
    expect(anchorIndex).toBeGreaterThan(hookIndex);
    expect(anchorIndex).toBeLessThan(reactNativePostInstallIndex);
  });

  it('keeps the Ruby the plugin documents: purge queued UUIDs, then replace the generator', () => {
    const result = applyPodsUuidCollisionGuard(GENERATED_PODFILE);

    // The two halves of the guard, in dependency order: the purge must clear
    // an already-queued colliding UUID (the batch containing the root's UUID
    // can be pre-generated before any hook runs), and the singleton method
    // must make every future refill collision-safe.
    const purgeIndex = result.indexOf('pods_uuid_guard_queued.reject!');
    const generatorIndex = result.indexOf("define_singleton_method(:generate_available_uuid_list)");
    expect(purgeIndex).toBeGreaterThan(-1);
    expect(generatorIndex).toBeGreaterThan(purgeIndex);
  });

  it('is idempotent: a second application returns the contents untouched', () => {
    const once = applyPodsUuidCollisionGuard(GENERATED_PODFILE);
    const twice = applyPodsUuidCollisionGuard(once);

    expect(twice).toBe(once);
    const anchorMatches = once.split(PODS_UUID_COLLISION_GUARD_ANCHOR).length - 1;
    expect(anchorMatches).toBe(1);
  });

  it('throws loudly when the post_install hook is missing, instead of no-opping', () => {
    const podfileWithoutHook = GENERATED_PODFILE.replace(/post_install do \|installer\|[\s\S]*?end\n/, '');

    // A template change upstream must fail prebuild, not silently drop the
    // guard and ship the Pods corruption back to CI.
    expect(() => applyPodsUuidCollisionGuard(podfileWithoutHook)).toThrow(/post_install/);
  });

  it('the block does not shadow CocoaPods locals used later in the hook', () => {
    // The generated hook goes on to reference `installer` and `config`; the
    // guard must not rebind either name. Every HOOK-LEVEL local the guard
    // introduces carries the pods_uuid_guard_ prefix. Locals inside the
    // injected singleton method (random_uuids, unique_uuids) are method-scoped
    // in Ruby and cannot shadow the hook, so only the four-space-indented
    // hook-level assignments are held to the prefix.
    const hookLevelAssignments = [...PODS_UUID_COLLISION_GUARD_BLOCK.matchAll(/^ {4}([a-z_]+) =/gm)].map(
      (assignment) => assignment[1],
    );
    expect(hookLevelAssignments.length).toBeGreaterThan(0);
    for (const assignedName of hookLevelAssignments) {
      expect(assignedName).toMatch(/^pods_uuid_guard_/);
    }
  });
});
