/**
 * AgentStatusIcon draws @kangentic/branding's activity marks: a green ring that
 * spins while the agent thinks, and the yellow envelope for an idle session.
 *
 * Every expected value is read from the generated mark data rather than typed as
 * a literal. That is deliberate and it is the point of the module: the geometry,
 * the 1400ms period and the reduced-motion rendering arrive with the assets, so a
 * test that restated them would pass while the component and the brand drifted
 * apart - which is the exact failure the package exists to prevent.
 *
 * Four behaviours here are silent when broken:
 *
 *   THE SPIN NOT RUNNING. The dash is applied either way, so a component that
 *   never starts its animation renders a correct-looking static arc. The test
 *   asserts on the timing call, not on the drawn output.
 *
 *   THE MATRIX ON THE WRONG NODE. react-native-svg's Fabric group takes its
 *   transform as `matrix`; a `rotation` prop, or a matrix handed to the circle
 *   instead of the group, sets something nothing reads and the ring sits still
 *   while every other assertion here stays green. Note this tier can only prove
 *   WHICH node got the prop - whether the matrix is the right rotation is
 *   tests/unit/activitySpin.test.ts's job, and whether it runs on the UI thread
 *   nothing but a device can answer.
 *
 *   REDUCED MOTION CLOSING THE RING. agent-working rests 'keep-dash', holding
 *   its 3/4 arc. An earlier rotation rested on a SOLID ring, which read as a
 *   different state rather than as a paused one.
 *
 *   RECYCLING RESIDUE. FlashList rebinds one row's views to the next item. The
 *   spinner used to be a transform on the shared wrapper view, so a cancelled
 *   spin left a frozen mid-rotation and the envelope rendered tilted (the
 *   "tilted envelope", commit e4e5524), which needed an explicit reset. The
 *   marks are disjoint element trees, so the animated node unmounts on rebind
 *   and no reset is needed. That property matters MORE now, not less: the
 *   rotation is back, and it is only safe because it lives on a <G> inside the
 *   working branch. Hoist it to the shared <Svg> root and the bug returns.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import * as Reanimated from 'react-native-reanimated';
import { AgentStatusIcon, ThemeProvider, darkTerminalTheme } from '@/components';
import { ScreenMotionOverride } from '@/components/motion/ScreenMotion';
import {
  ACTIVITY_STROKE_LINECAP,
  ACTIVITY_STROKE_LINEJOIN,
  ACTIVITY_STROKE_WIDTH,
  ACTIVITY_VIEW_BOX,
  activityMarks,
} from '@/brand/activityMarks.generated';

// Each SVG primitive renders a View tagged with its element kind, so the marks'
// shapes can be read as props. Same approach as Brandmark.test.tsx, which mocks
// SvgXml to inspect the XML it is handed.
jest.mock('react-native-svg', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  const mockSvgElement = (elementName: string) => {
    function MockSvgElement({ children, ...props }: { children?: unknown; testID?: string }) {
      return React.createElement(View, { ...props, testID: props.testID ?? `svg-${elementName}` }, children);
    }
    return MockSvgElement;
  };
  const MockSvg = mockSvgElement('root');
  return {
    __esModule: true,
    default: MockSvg,
    Svg: MockSvg,
    Circle: mockSvgElement('circle'),
    G: mockSvgElement('g'),
    Path: mockSvgElement('path'),
    Rect: mockSvgElement('rect'),
  };
});

const workingMark = activityMarks['agent-working'];
const idleMark = activityMarks['agent-idle'];

// The spin policy is optional on the generated type, and most of this file is
// about it. Say so once here: a branding bump that drops it should name the
// assumption it broke rather than failing on an undefined property read.
const workingSpin = workingMark.spin;
if (workingSpin === undefined) {
  throw new Error('agent-working must declare a spin; @kangentic/branding changed its activity manifest');
}
const [workingRing] = workingMark.shapes.filter((shape) => shape.kind === 'circle' && shape.dash !== undefined);
if (workingRing === undefined || workingRing.kind !== 'circle' || workingRing.dash === undefined) {
  throw new Error('agent-working must ship exactly one dashed circle; @kangentic/branding changed its activity marks');
}
// Pulled out as its own const rather than read through workingRing at each use:
// narrowing a property does not survive into the test closures below.
const workingDash: readonly [number, number] = workingRing.dash;

const [idleEnvelope] = idleMark.shapes.filter((shape) => shape.kind === 'rect');
if (idleEnvelope === undefined || idleEnvelope.kind !== 'rect') {
  throw new Error('agent-idle must ship a rect body; @kangentic/branding changed its activity marks');
}
const idleEnvelopeHeight = idleEnvelope.height;

const [idleFlap] = idleMark.shapes.filter((shape) => shape.kind === 'path');
if (idleFlap === undefined || idleFlap.kind !== 'path') {
  throw new Error('agent-idle must ship a flap path; @kangentic/branding changed its activity marks');
}

function renderIcon(props: React.ComponentProps<typeof AgentStatusIcon>): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <AgentStatusIcon {...props} />
    </ThemeProvider>,
  );
}

/**
 * How many nodes in the CURRENTLY rendered tree carry a rotation, by any
 * mechanism: a `transform` in a style (the view-transform the spin uses now) or
 * a `matrix` prop (the SVG group it used before).
 *
 * Deliberately mechanism-agnostic. The recycling tests below are about a
 * rotation OUTLIVING the working branch, and naming whichever node happens to
 * carry it today is exactly how the next mechanism change would slip past them.
 */
function rotatingNodeCount(): number {
  let count = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const element = node as { props?: Record<string, unknown>; children?: unknown };
    const props = element.props ?? {};
    if (props.matrix !== undefined) count += 1;
    const styles = Array.isArray(props.style) ? props.style : [props.style];
    for (const style of styles) {
      if (style !== null && typeof style === 'object' && 'transform' in style) count += 1;
    }
    visit(element.children);
  };
  visit(screen.toJSON());
  return count;
}

// Top level, NOT inside the first describe: a describe-scoped afterEach would
// leave the reduced-motion mock and the withTiming spy in place for every later
// block, so those tests would silently run against reducedMotion = true and
// against a spy whose call count carried over from an earlier test.
afterEach(() => {
  jest.restoreAllMocks();
});

describe('AgentStatusIcon', () => {
  it('falls back to a per-kind testID so a caller need not supply one', () => {
    renderIcon({ kind: 'working' });
    expect(screen.getByTestId('agent-status-working')).toBeTruthy();

    screen.unmount();
    renderIcon({ kind: 'idle-unread' });
    expect(screen.getByTestId('agent-status-idle-unread')).toBeTruthy();

    screen.unmount();
    renderIcon({ kind: 'idle' });
    expect(screen.getByTestId('agent-status-idle')).toBeTruthy();
  });

  it('prefers an explicit testID, which is what the board cards pass', () => {
    renderIcon({ kind: 'working', testID: 'task-1-status' });
    expect(screen.getByTestId('task-1-status')).toBeTruthy();
    expect(screen.queryByTestId('agent-status-working')).toBeNull();
  });

  it('draws on the branding grid and tints through currentColor', () => {
    renderIcon({ kind: 'working' });
    const { props } = screen.getByTestId('agent-status-working');

    expect(props.viewBox).toBe(ACTIVITY_VIEW_BOX);
    expect(props.strokeWidth).toBe(ACTIVITY_STROKE_WIDTH);
    expect(props.stroke).toBe('currentColor');
    expect(props.fill).toBe('none');
    // Forwarded onto the Svg root so every shape's stroke gets round caps and
    // joins. Read from the generated constants, not typed as 'round' here,
    // because pinning a literal would pass even if the component forwarded the
    // wrong generated value.
    expect(props.strokeLinecap).toBe(ACTIVITY_STROKE_LINECAP);
    expect(props.strokeLinejoin).toBe(ACTIVITY_STROKE_LINEJOIN);
    // The marks are currentColor, so the theme token arrives as `color`. Green
    // is the terminal-native positive hue per tokens.ts's two-hue rule.
    expect(props.color).toBe(darkTerminalTheme.colors.statusWorking);
  });

  it('tints the idle envelope with the true-yellow warning token, not brand amber', () => {
    // activity.json labels agent-idle's tone "attention", whose token here would
    // be brand amber - but tokens.ts forbids pointing a warning role at amber,
    // and the package publishes #d9b83f as the mobile value. Advisory, not law.
    renderIcon({ kind: 'idle' });
    expect(screen.getByTestId('agent-status-idle').props.color).toBe(darkTerminalTheme.colors.warning);
    expect(screen.getByTestId('agent-status-idle').props.color).not.toBe(darkTerminalTheme.brand.amber);
  });

  it('honours the caller size, which the project picker sets to 15', () => {
    renderIcon({ kind: 'working', size: 15 });
    const { props } = screen.getByTestId('agent-status-working');
    expect(props.width).toBe(15);
    expect(props.height).toBe(15);
  });
});

describe('the working ring', () => {
  it('renders one dashed circle carrying the generated user-unit dash', () => {
    renderIcon({ kind: 'working' });
    const circle = screen.getByTestId('svg-circle');

    expect(circle.props.r).toBe(workingRing.r);
    expect(circle.props.cx).toBe(workingRing.cx);
    expect(circle.props.strokeDasharray).toEqual([...workingDash]);
  });

  it('turns a full revolution at the manifest duration', () => {
    // The drawn output cannot distinguish a running spin from a static arc, so
    // this asserts the timing call itself. The duration comes from the
    // generated data: a hardcoded 1400 in the component would fail here.
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
    // withRepeat is the OTHER half of "does the spin actually run forever":
    // its second argument (-1) means loop forever, its third (false) means do
    // not reverse, so the ring turns one full revolution and restarts from zero
    // rather than ping-ponging backwards. jest.setup.ts's mock is
    // `(animation) => animation`, discarding both arguments, so a -1 silently
    // swapped for a 1 (turns exactly one 1400ms revolution and then freezes on
    // a real device) would leave every other assertion in this file green. This
    // spy is the only thing that would catch it.
    const withRepeatSpy = jest.spyOn(Reanimated, 'withRepeat');
    renderIcon({ kind: 'working' });

    expect(withTimingSpy).toHaveBeenCalledWith(
      // One TURN, not one degree count: the matrix helper takes turns, so the
      // 360 lives in src/lib/activitySpin.ts and is proven there.
      1,
      expect.objectContaining({
        duration: workingSpin.durationMs,
        // scripts/syncBranding.mjs hard-fails the sync unless the manifest's
        // motion.spin.timing is "linear", so linear easing is a real contract,
        // not a style choice. Asserted against the mocked export (what
        // jest.setup.ts defines Easing.linear as here), not a string literal.
        easing: Reanimated.Easing.linear,
        reduceMotion: Reanimated.ReduceMotion.System,
      }),
    );
    expect(withRepeatSpy).toHaveBeenCalledWith(1, -1, false);
  });

  /**
   * WHICH node carries the transform is still the whole safety argument, but
   * the node changed on 2026-08-29: the turn moved OFF the SVG <G>'s `matrix`
   * prop and onto a transform on the wrapping native view, because driving an
   * SVG prop per frame cost ~8 percentage points of CPU per icon (see the
   * REACT-NATIVE-5 section of docs/developer-guide.md).
   *
   * The safety property is unchanged and is asserted by the rebind test below:
   * the wrapper is rendered ONLY on the working branch, so it unmounts on a
   * rebind rather than leaving a stale rotation behind and tilting the envelope
   * (e4e5524). Nothing inside the SVG is animated any more.
   */
  it('turns the wrapping view, leaving every SVG node unanimated', () => {
    renderIcon({ kind: 'working' });

    // The SVG itself and everything in it is static: no animatedProps anywhere.
    expect(screen.getByTestId('agent-status-working').props.animatedProps).toBeUndefined();
    expect(screen.getByTestId('svg-circle').props.animatedProps).toBeUndefined();
    // The rotating <G> is gone entirely - the dash sits on a plain circle.
    expect(screen.queryByTestId('svg-g')).toBeNull();
  });

  it('keeps the dash on the circle itself now that no group wraps it', () => {
    renderIcon({ kind: 'working' });
    expect(screen.getByTestId('svg-circle').props.strokeDasharray).toEqual([...workingDash]);
  });
});

describe('the idle envelope', () => {
  it('draws the corrected 18 x 16 body with its flap, and no ring', () => {
    renderIcon({ kind: 'idle' });

    const rect = screen.getByTestId('svg-rect');
    expect(rect.props.x).toBe(idleEnvelope.x);
    expect(rect.props.y).toBe(idleEnvelope.y);
    expect(rect.props.width).toBe(idleEnvelope.width);
    expect(rect.props.height).toBe(idleEnvelopeHeight);
    expect(rect.props.rx).toBe(idleEnvelope.rx);
    // Proves WHICH path is drawn, not just that a path exists: a stale or
    // hardcoded `d` would still satisfy a bare toBeTruthy() here.
    expect(screen.getByTestId('svg-path').props.d).toBe(idleFlap.d);
    expect(screen.queryByTestId('svg-circle')).toBeNull();
  });

  it('renders identically for idle-unread, which is a semantic kind only', () => {
    renderIcon({ kind: 'idle-unread' });
    expect(screen.getByTestId('svg-rect').props.height).toBe(idleEnvelopeHeight);
    expect(screen.getByTestId('agent-status-idle-unread').props.color).toBe(darkTerminalTheme.colors.warning);
  });

  it('never animates: a static mark has no march to run', () => {
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
    renderIcon({ kind: 'idle' });

    expect(idleMark.march).toBeUndefined();
    expect(withTimingSpy).not.toHaveBeenCalled();
  });
});

describe('reduced motion', () => {
  it('rests the ring holding its arc instead of closing it into a solid circle', () => {
    jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');

    renderIcon({ kind: 'working' });
    const circle = screen.getByTestId('svg-circle');

    // 'keep-dash': the dash SURVIVES, so the mark reads as a paused spinner.
    expect(workingMark.restRendering).toBe('keep-dash');
    expect(circle.props.strokeDasharray).toEqual([...workingDash]);
    // ...but nothing drives it, and no rotating group is mounted at all - a
    // stopped <G> holding an identity matrix would work, but it would also be
    // one more shared-looking node for a later change to hang a transform on.
    expect(circle.props.animatedProps).toBeUndefined();
    expect(screen.queryByTestId('svg-g')).toBeNull();
    expect(withTimingSpy).not.toHaveBeenCalled();
  });

  it('leaves the static envelope unchanged', () => {
    jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);
    renderIcon({ kind: 'idle' });

    expect(screen.getByTestId('svg-rect').props.height).toBe(idleEnvelopeHeight);
    expect(screen.getByTestId('svg-rect').props.animatedProps).toBeUndefined();
  });
});

describe('list recycling', () => {
  /**
   * THE tilted-envelope regression, stated as an assertion. This is the exact
   * bug commit e4e5524 fixed with a reset, and reintroducing a rotation is
   * precisely what could bring it back: a transform on any node that SURVIVES
   * the rebind keeps whatever angle Reanimated last wrote, because Reanimated
   * writes to the native view and React's prop diff never clears it.
   *
   * So the assertion is about survival, not about pixels: after rebinding, no
   * rotating group may exist and no node in the envelope may carry a matrix.
   */
  it('leaves no rotating node, matrix or dash behind when a row rebinds working to idle', () => {
    const { rerender } = renderIcon({ kind: 'working', testID: 'row-status' });
    // The rotation now lives on a wrapping view's transform rather than on an
    // SVG group's matrix, so the survival check reads the whole tree for a
    // transform instead of naming one node. Written this way deliberately: the
    // bug is about a rotation OUTLIVING the working branch, whichever node
    // happens to carry it, and naming a node is what would let the next
    // mechanism change slip past this test.
    expect(rotatingNodeCount()).toBeGreaterThan(0);

    rerender(
      <ThemeProvider>
        <AgentStatusIcon kind="idle" testID="row-status" />
      </ThemeProvider>,
    );

    // Nothing anywhere in the envelope is rotating - not merely stopped, gone.
    expect(rotatingNodeCount()).toBe(0);
    expect(screen.queryByTestId('svg-g')).toBeNull();
    expect(screen.queryByTestId('svg-circle')).toBeNull();

    const rect = screen.getByTestId('svg-rect');
    expect(rect.props.animatedProps).toBeUndefined();
    expect(rect.props.matrix).toBeUndefined();
    expect(rect.props.strokeDasharray).toBeUndefined();

    // The flap too: the envelope is two shapes and a tilt would take both.
    const flap = screen.getByTestId('svg-path');
    expect(flap.props.animatedProps).toBeUndefined();
    expect(flap.props.matrix).toBeUndefined();

    // And the shared root, which is the ONE node that does survive the rebind.
    // If a future change hoists the transform up here, this is what fails.
    const root = screen.getByTestId('row-status');
    expect(root.props.animatedProps).toBeUndefined();
    expect(root.props.matrix).toBeUndefined();
    expect(root.props.color).toBe(darkTerminalTheme.colors.warning);
  });

  it('restarts the spin when a row rebinds idle back to working', () => {
    const { rerender } = renderIcon({ kind: 'idle', testID: 'row-status' });
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');

    rerender(
      <ThemeProvider>
        <AgentStatusIcon kind="working" testID="row-status" />
      </ThemeProvider>,
    );

    expect(withTimingSpy).toHaveBeenCalledWith(1, expect.objectContaining({ duration: workingSpin.durationMs }));
    expect(rotatingNodeCount()).toBeGreaterThan(0);
  });
});

/**
 * A loop nobody can see costs exactly what a visible one costs: Reanimated
 * drives its worklets on the UI thread every vsync, whether or not the view is
 * on screen. Measured on a release build, the Agents list sitting underneath
 * the pushed Settings screen burned 22-46% of a core (peaking at 86%) while
 * rendering ZERO frames - eight rings animating for nobody.
 *
 * The gate defaults to on, so these assertions are about the OFF case; every
 * other test in this file exercises the default and would not notice a gate
 * that never engaged.
 */
describe('the screen motion gate', () => {
  function renderGated(active: boolean, props: React.ComponentProps<typeof AgentStatusIcon>) {
    return render(
      <ThemeProvider>
        <ScreenMotionOverride active={active}>
          <AgentStatusIcon {...props} />
        </ScreenMotionOverride>
      </ThemeProvider>,
    );
  }

  it('does not start the spin while the screen is blurred', () => {
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
    renderGated(false, { kind: 'working' });
    expect(withTimingSpy).not.toHaveBeenCalled();
  });

  it('still spins when the gate is active, so the gate cannot silently kill the ring', () => {
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
    renderGated(true, { kind: 'working' });
    expect(withTimingSpy).toHaveBeenCalledWith(1, expect.objectContaining({ duration: workingSpin.durationMs }));
  });

  /**
   * The gate drops the MOUNT, not just the driver, so that a blurred screen
   * leaves no Reanimated node registered for a view nobody can see - the
   * per-frame flush walks the registered nodes.
   *
   * Stated precisely, because this file's own history is a lesson in claiming
   * more than was measured: forcing the gate closed on a FOCUSED screen is
   * worth ~9 points of idle CPU on a release build, while the blurred-screen
   * before/after (50% against 47.5%) sat inside the run-to-run spread. The
   * mount-level form is chosen on correctness grounds; it is not a measured
   * win over cancelling the driver.
   */
  it('drops the rotating wrapper entirely while blurred, not just its driver', () => {
    renderGated(false, { kind: 'working' });
    expect(rotatingNodeCount()).toBe(0);
  });

  it('brings the wrapper back on focus', () => {
    renderGated(true, { kind: 'working' });
    expect(rotatingNodeCount()).toBe(1);
  });

  it('leaves the static envelope alone, which has no loop to gate', () => {
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
    renderGated(false, { kind: 'idle' });
    expect(screen.getByTestId('agent-status-idle')).toBeTruthy();
    expect(withTimingSpy).not.toHaveBeenCalled();
  });
});

/**
 * The idle-CPU lever, asserted at the source. The per-vsync Reanimated flush
 * walks every REGISTERED mapper, dirty or not, so an idle-envelope row that
 * registered a dead `useAnimatedProps` and a dead `useAnimatedStyle` was paying
 * for both on every frame - measured at ~0.47 CPU points per registered mapper
 * on a release build (see the REACT-NATIVE-5 section of docs/developer-guide.md).
 * The split moved those hooks into children mounted only on the animating
 * branch, so these assert the hooks are NOT called at all on a non-animating
 * row. A row rendered identically but with the hooks back at the top (the old
 * shape) passes every OTHER test in this file, which is exactly why the rule
 * asks for a mechanism assertion here.
 */
describe('registered mappers (the idle-CPU lever)', () => {
  it('registers no animated mapper for an idle envelope', () => {
    const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
    const animatedPropsSpy = jest.spyOn(Reanimated, 'useAnimatedProps');
    renderIcon({ kind: 'idle' });
    expect(animatedStyleSpy).not.toHaveBeenCalled();
    expect(animatedPropsSpy).not.toHaveBeenCalled();
  });

  it('registers no animated mapper under reduced motion', () => {
    jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);
    const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
    const animatedPropsSpy = jest.spyOn(Reanimated, 'useAnimatedProps');
    renderIcon({ kind: 'working' });
    expect(animatedStyleSpy).not.toHaveBeenCalled();
    expect(animatedPropsSpy).not.toHaveBeenCalled();
  });

  it('registers no animated mapper while the screen is blurred, not just no driver', () => {
    const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
    const animatedPropsSpy = jest.spyOn(Reanimated, 'useAnimatedProps');
    render(
      <ThemeProvider>
        <ScreenMotionOverride active={false}>
          <AgentStatusIcon kind="working" />
        </ScreenMotionOverride>
      </ThemeProvider>,
    );
    expect(animatedStyleSpy).not.toHaveBeenCalled();
    expect(animatedPropsSpy).not.toHaveBeenCalled();
  });

  it('registers exactly one animated style (the spin transform) for a working ring, and no animated props', () => {
    const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
    const animatedPropsSpy = jest.spyOn(Reanimated, 'useAnimatedProps');
    renderIcon({ kind: 'working' });
    // The turn is a view transform, so exactly one useAnimatedStyle and - since
    // no mark marches today - zero useAnimatedProps. If a future change hoists
    // the march hook back onto every spinning row, this fails.
    expect(animatedStyleSpy).toHaveBeenCalledTimes(1);
    expect(animatedPropsSpy).not.toHaveBeenCalled();
  });
});

describe('the legibility floor', () => {
  /**
   * Below the floor a 2px stroke on a 24 grid falls under one device pixel and
   * the glyph turns to mush, so the branding contract says draw a dot instead.
   * No caller is below it today (they render at 15 and 16); this is the contract
   * being honoured, not a bug being fixed.
   */
  it('draws a filled dot instead of the mark below the floor', () => {
    renderIcon({ kind: 'idle', size: idleMark.minPx - 1 });

    expect(screen.queryByTestId('svg-rect')).toBeNull();
    expect(screen.queryByTestId('svg-path')).toBeNull();
    const dot = screen.getByTestId('svg-circle');
    expect(dot.props.fill).toBe('currentColor');
    expect(dot.props.strokeDasharray).toBeUndefined();
  });

  it('draws the full mark at the floor exactly', () => {
    renderIcon({ kind: 'idle', size: idleMark.minPx });
    expect(screen.getByTestId('svg-rect')).toBeTruthy();
    expect(screen.getByTestId('svg-path')).toBeTruthy();
  });

  it('does not spin the below-floor dot', () => {
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
    renderIcon({ kind: 'working', size: workingMark.minPx - 1 });

    const dot = screen.getByTestId('svg-circle');
    expect(dot.props.fill).toBe('currentColor');
    expect(dot.props.animatedProps).toBeUndefined();
    // A rotating dot is invisible but not free: it would drive a timing loop
    // forever on every recycled row that fell below the floor.
    expect(screen.queryByTestId('svg-g')).toBeNull();
    expect(withTimingSpy).not.toHaveBeenCalled();
  });
});
