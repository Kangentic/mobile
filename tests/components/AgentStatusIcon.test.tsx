/**
 * AgentStatusIcon draws @kangentic/branding's activity marks: a green ring that
 * marches while the agent thinks, and the yellow envelope for an idle session.
 *
 * Every expected value is read from the generated mark data rather than typed as
 * a literal. That is deliberate and it is the point of the module: the geometry,
 * the 1400ms march and the reduced-motion rendering arrive with the assets, so a
 * test that restated them would pass while the component and the brand drifted
 * apart - which is the exact failure the package exists to prevent.
 *
 * Three behaviours here are silent when broken:
 *
 *   THE MARCH NOT RUNNING. The dash is applied either way, so a component that
 *   never starts its animation renders a correct-looking static arc. The test
 *   asserts on the timing call, not on the drawn output.
 *
 *   REDUCED MOTION CLOSING THE RING. agent-working rests 'keep-dash', holding
 *   its 3/4 arc. The rotation this replaced rested on a SOLID ring, which read
 *   as a different state rather than as a paused one.
 *
 *   RECYCLING RESIDUE. FlashList rebinds one row's views to the next item. The
 *   spinner used to be a transform on the shared wrapper view, so a cancelled
 *   spin left a frozen mid-rotation and the envelope rendered tilted (the
 *   "tilted envelope", commit e4e5524), which needed an explicit reset. The
 *   marks are now disjoint element trees, so the animated node unmounts on
 *   rebind and no reset is needed. That is a property worth pinning: a future
 *   change that morphs one shared element between the two states reintroduces
 *   the bug, and this test is what would notice.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import * as Reanimated from 'react-native-reanimated';
import { AgentStatusIcon, ThemeProvider, darkTerminalTheme } from '@/components';
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
    Path: mockSvgElement('path'),
    Rect: mockSvgElement('rect'),
  };
});

const workingMark = activityMarks['agent-working'];
const idleMark = activityMarks['agent-idle'];

// The march policy is optional on the generated type, and most of this file is
// about it. Say so once here: a branding bump that drops it should name the
// assumption it broke rather than failing on an undefined property read.
const workingMarch = workingMark.march;
if (workingMarch === undefined) {
  throw new Error('agent-working must declare a march; @kangentic/branding changed its activity manifest');
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

  it('marches the dash offset a full cycle at the manifest duration', () => {
    // The drawn output cannot distinguish a running march from a static arc, so
    // this asserts the timing call itself. Both numbers come from the generated
    // data: a hardcoded duration or dash in the component would fail here.
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
    // withRepeat is the OTHER half of "does the march actually run forever":
    // its second argument (-1) means loop forever, its third (false) means do
    // not reverse, so the dash walks one full cycle and restarts from zero
    // rather than ping-ponging backwards. jest.setup.ts's mock is
    // `(animation) => animation`, discarding both arguments, so a -1 silently
    // swapped for a 1 (marches exactly one 1400ms cycle and then freezes on a
    // real device) would leave every other assertion in this file green. This
    // spy is the only thing that would catch it.
    const withRepeatSpy = jest.spyOn(Reanimated, 'withRepeat');
    renderIcon({ kind: 'working' });

    expect(withTimingSpy).toHaveBeenCalledWith(
      -workingMarch.periodUserUnits,
      expect.objectContaining({
        duration: workingMarch.durationMs,
        // scripts/syncBranding.mjs hard-fails the sync unless the manifest's
        // motion.march.timing is "linear", so linear easing is a real contract,
        // not a style choice. Asserted against the mocked export (what
        // jest.setup.ts defines Easing.linear as here), not a string literal.
        easing: Reanimated.Easing.linear,
        reduceMotion: Reanimated.ReduceMotion.System,
      }),
    );
    expect(withRepeatSpy).toHaveBeenCalledWith(-workingMarch.periodUserUnits, -1, false);
  });

  it('hands the animated offset to the circle', () => {
    renderIcon({ kind: 'working' });
    expect(screen.getByTestId('svg-circle').props.animatedProps).toEqual(
      expect.objectContaining({ strokeDashoffset: expect.any(Number) }),
    );
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
    // ...but nothing drives it.
    expect(circle.props.animatedProps).toBeUndefined();
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
   * The reason no reset is needed. Rebinding working -> idle in place must leave
   * NOTHING of the animation behind, and it does so structurally: the ring and
   * the envelope share no element, so the animated node unmounts.
   */
  it('leaves no animated node or dash behind when a row rebinds working to idle', () => {
    const { rerender } = renderIcon({ kind: 'working', testID: 'row-status' });
    expect(screen.getByTestId('svg-circle').props.animatedProps).toBeDefined();

    rerender(
      <ThemeProvider>
        <AgentStatusIcon kind="idle" testID="row-status" />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('svg-circle')).toBeNull();
    const rect = screen.getByTestId('svg-rect');
    expect(rect.props.animatedProps).toBeUndefined();
    expect(rect.props.strokeDasharray).toBeUndefined();
    expect(screen.getByTestId('row-status').props.color).toBe(darkTerminalTheme.colors.warning);
  });

  it('restarts the march when a row rebinds idle back to working', () => {
    const { rerender } = renderIcon({ kind: 'idle', testID: 'row-status' });
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');

    rerender(
      <ThemeProvider>
        <AgentStatusIcon kind="working" testID="row-status" />
      </ThemeProvider>,
    );

    expect(withTimingSpy).toHaveBeenCalledWith(
      -workingMarch.periodUserUnits,
      expect.objectContaining({ duration: workingMarch.durationMs }),
    );
    expect(screen.getByTestId('svg-circle').props.animatedProps).toBeDefined();
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

  it('does not march the below-floor dot', () => {
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
    renderIcon({ kind: 'working', size: workingMark.minPx - 1 });

    const dot = screen.getByTestId('svg-circle');
    expect(dot.props.fill).toBe('currentColor');
    expect(dot.props.animatedProps).toBeUndefined();
    expect(withTimingSpy).not.toHaveBeenCalled();
  });
});
