/**
 * AGP 9 turned on `android.r8.strictFullModeForKeepRules`, so `-keep class A` stopped
 * implying `-keep class A { <init>(); }`. Room's consumer rule is that bare form, and
 * Room creates WorkDatabase_Impl by reflection, so the first SDK 58 release build
 * crashed in InitializationProvider, before any JS and before Sentry, with every
 * check green. No JS tier can see that: what these tests pin is the property that
 * prevents it, and the launch itself is proved on a release build.
 */
import { describe, expect, it } from 'vitest';
import {
  applyImplicitConstructorKeeps,
  R8_STRICT_KEEP_RULES_PROPERTY,
} from '../../plugins/withAndroidR8ImplicitConstructors';

type GradleProperties = Parameters<typeof applyImplicitConstructorKeeps>[0];

function propertyLines(properties: GradleProperties): string[] {
  return properties.flatMap((item) => (item.type === 'property' && item.key === R8_STRICT_KEEP_RULES_PROPERTY ? [item.value] : []));
}

describe('applyImplicitConstructorKeeps', () => {
  it('names the property AGP documents', () => {
    expect(R8_STRICT_KEEP_RULES_PROPERTY).toBe('android.r8.strictFullModeForKeepRules');
  });

  it('turns strict keep rules off', () => {
    expect(propertyLines(applyImplicitConstructorKeeps([]))).toEqual(['false']);
  });

  it('replaces a value the template writes rather than adding a second line', () => {
    const fromTemplate: GradleProperties = [{ type: 'property', key: R8_STRICT_KEEP_RULES_PROPERTY, value: 'true' }];
    expect(propertyLines(applyImplicitConstructorKeeps(fromTemplate))).toEqual(['false']);
  });

  it('leaves every other property and comment alone', () => {
    const others: GradleProperties = [
      { type: 'comment', value: 'Kept by hand' },
      { type: 'property', key: 'android.newDsl', value: 'false' },
    ];
    expect(applyImplicitConstructorKeeps(others).slice(0, 2)).toEqual(others);
  });
});
