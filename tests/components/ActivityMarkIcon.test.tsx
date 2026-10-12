/**
 * ActivityMarkIcon draws the Command Terminal surfaces' branding marks: the
 * terminal silhouette, the "new terminal" mark and the desktop's stop control.
 * Like AgentStatusIcon.test.tsx, every expected shape and timing is read from
 * the generated mark data rather than typed as a literal.
 *
 * Three behaviours here are silent when broken, so each is asserted at the
 * mechanism rather than the picture:
 *
 *   THE STOP RING'S TURN MOVES THE WRONG THING. The stop control is the one
 *   mark whose motion moves only PART of it: the ring turns and the square
 *   holds still. A spin on the whole <Svg> (AgentStatusIcon's shortcut for its
 *   lone ring) would turn the square with it and draw a correct-looking
 *   spinning stop. So the test splits the tree: the rotating node holds the
 *   ring and nothing else, the still layer holds the filled square and nothing
 *   else.
 *
 *   A MAPPER REGISTERED ON A BRANCH THAT NEVER ANIMATES. Every static mark, a
 *   reduced-motion mark and a blurred screen's mark must register ZERO animated
 *   styles (motion-conventions.md: a mapper's writes outlive a FlashList
 *   recycle). A component with the hook hoisted to the top renders identically,
 *   which is why the "registered mappers" block asserts the spy, as
 *   AgentStatusIcon.test.tsx does.
 *
 *   THE SPIN NOT RUNNING. The dash is drawn either way, so a ring that never
 *   starts its animation still draws a correct static arc. The test asserts
 *   the timing call.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import * as Reanimated from 'react-native-reanimated';
import { ActivityMarkIcon, ThemeProvider, darkTerminalTheme } from '@/components';
import type { ActivityMarkTone } from '@/components/ActivityMarkIcon';
import { ScreenMotionOverride } from '@/components/motion/ScreenMotion';
import { ACTIVITY_VIEW_BOX, activityMarks } from '@/brand/activityMarks.generated';

// Each SVG primitive renders a View tagged with its element kind, so the marks'
// shapes can be read as props. Same approach as AgentStatusIcon.test.tsx.
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

const stopWorkingMark = activityMarks['control-stop-working'];
const stopIdleMark = activityMarks['control-stop-idle'];
const terminalIdleMark = activityMarks['terminal-idle'];
const terminalNewMark = activityMarks['terminal-new'];

const stopWorkingSpin = stopWorkingMark.spin;
if (stopWorkingSpin === undefined) {
  throw new Error('control-stop-working must declare a spin; @kangentic/branding changed its activity manifest');
}
const [stopWorkingRing] = stopWorkingMark.shapes.filter((shape) => shape.kind === 'circle' && shape.dash !== undefined);
if (stopWorkingRing === undefined || stopWorkingRing.kind !== 'circle' || stopWorkingRing.dash === undefined) {
  throw new Error('control-stop-working must ship a dashed ring; @kangentic/branding changed its activity marks');
}
const stopWorkingDash: readonly [number, number] = stopWorkingRing.dash;
const [stopSquare] = stopWorkingMark.shapes.filter((shape) => shape.kind === 'rect');
if (stopSquare === undefined || stopSquare.kind !== 'rect' || stopSquare.filled !== true) {
  throw new Error('control-stop-working must ship a filled square; @kangentic/branding changed its activity marks');
}
const stopSquareWidth = stopSquare.width;

interface RenderedNode {
  props: Record<string, unknown>;
  children: readonly (RenderedNode | string)[] | null;
}

function renderedRoots(): RenderedNode[] {
  const json = screen.toJSON() as unknown as RenderedNode | RenderedNode[] | null;
  if (json === null) return [];
  return Array.isArray(json) ? json : [json];
}

function nodesWithin(node: RenderedNode): RenderedNode[] {
  const nodes: RenderedNode[] = [node];
  for (const child of node.children ?? []) {
    if (typeof child !== 'string') nodes.push(...nodesWithin(child));
  }
  return nodes;
}

function allRenderedNodes(): RenderedNode[] {
  return renderedRoots().flatMap(nodesWithin);
}

/** True when the node's own style carries a transform, by any mechanism: the view-transform the spin uses. */
function carriesTransform(node: RenderedNode): boolean {
  const flattened = StyleSheet.flatten(node.props.style as never) as { transform?: unknown } | undefined;
  return flattened?.transform !== undefined;
}

function rotatingNodes(): RenderedNode[] {
  return allRenderedNodes().filter(carriesTransform);
}

function testIdsWithin(node: RenderedNode): string[] {
  return nodesWithin(node).flatMap((descendant) => (typeof descendant.props.testID === 'string' ? [descendant.props.testID] : []));
}

/**
 * The tree split into the turning node and everything that is not inside it,
 * from ONE snapshot of the render (toJSON builds fresh objects on every call,
 * so identity cannot be compared across two). The "still layer" is what the
 * spin does NOT hold.
 */
function splitAtSpinningLayer(): { spinningLayer: RenderedNode | undefined; stillNodes: RenderedNode[] } {
  const snapshot = renderedRoots().flatMap(nodesWithin);
  const spinningLayer = snapshot.find(carriesTransform);
  if (spinningLayer === undefined) return { spinningLayer, stillNodes: snapshot };
  const spinningNodes = new Set(nodesWithin(spinningLayer));
  return { spinningLayer, stillNodes: snapshot.filter((node) => !spinningNodes.has(node)) };
}

type IconProps = React.ComponentProps<typeof ActivityMarkIcon>;

function renderIcon(props: IconProps): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <ActivityMarkIcon {...props} />
    </ThemeProvider>,
  );
}

function renderGated(active: boolean, props: IconProps): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <ScreenMotionOverride active={active}>
        <ActivityMarkIcon {...props} />
      </ScreenMotionOverride>
    </ThemeProvider>,
  );
}

// Top level, NOT inside a describe: a describe-scoped afterEach would leave the
// reduced-motion mock and the spies in place for every later block.
afterEach(() => {
  jest.restoreAllMocks();
});

describe('the stop control while the terminal works (motion allowed)', () => {
  it('splits into a still layer and a spinning layer, the testID on the shared outer box', async () => {
    await renderIcon({ mark: 'control-stop-working', tone: 'working', size: 20, testID: 'stop-mark' });

    const outer = screen.getByTestId('stop-mark');
    expect(StyleSheet.flatten(outer.props.style)).toEqual(expect.objectContaining({ width: 20, height: 20 }));
    // Two Svgs: one per layer. A single Svg would mean the square turns with the ring.
    expect(screen.getAllByTestId('svg-root')).toHaveLength(2);
  });

  it('turns a layer holding the ring and ONLY the ring', async () => {
    await renderIcon({ mark: 'control-stop-working', tone: 'working', testID: 'stop-mark' });

    const [spinningLayer, ...otherRotatingNodes] = rotatingNodes();
    expect(spinningLayer).toBeDefined();
    expect(otherRotatingNodes).toEqual([]);
    if (spinningLayer === undefined) return;

    const spinningTestIds = testIdsWithin(spinningLayer);
    expect(spinningTestIds).toContain('svg-circle');
    // The square must NOT be inside the turning node: it holds still.
    expect(spinningTestIds).not.toContain('svg-rect');

    const ring = nodesWithin(spinningLayer).find((node) => node.props.testID === 'svg-circle');
    expect(ring?.props.r).toBe(stopWorkingRing.r);
    expect(ring?.props.strokeDasharray).toEqual([...stopWorkingDash]);
  });

  it('holds the filled square, and no ring, in the layer that does not turn', async () => {
    await renderIcon({ mark: 'control-stop-working', tone: 'working', testID: 'stop-mark' });

    const { spinningLayer, stillNodes } = splitAtSpinningLayer();
    expect(spinningLayer).toBeDefined();

    const stillTestIds = stillNodes.flatMap((node) => (typeof node.props.testID === 'string' ? [node.props.testID] : []));
    expect(stillTestIds).toContain('svg-rect');
    expect(stillTestIds).not.toContain('svg-circle');

    const square = stillNodes.find((node) => node.props.testID === 'svg-rect');
    expect(square?.props.width).toBe(stopSquareWidth);
    // Solid, not outlined: the stop control's square is a filled shape.
    expect(square?.props.fill).toBe('currentColor');
    expect(square?.props.stroke).toBe('none');
  });

  it('draws both layers on the branding grid in the same tone', async () => {
    await renderIcon({ mark: 'control-stop-working', tone: 'working', testID: 'stop-mark' });

    const layers = screen.getAllByTestId('svg-root');
    expect(layers).toHaveLength(2);
    for (const layer of layers) {
      expect(layer.props.viewBox).toBe(ACTIVITY_VIEW_BOX);
      expect(layer.props.color).toBe(darkTerminalTheme.colors.statusWorking);
    }
  });

  it('turns one full revolution at the manifest duration, forever', async () => {
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
    const withRepeatSpy = jest.spyOn(Reanimated, 'withRepeat');
    await renderIcon({ mark: 'control-stop-working', tone: 'working' });

    expect(withTimingSpy).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        duration: stopWorkingSpin.durationMs,
        easing: Reanimated.Easing.linear,
        reduceMotion: Reanimated.ReduceMotion.System,
      }),
    );
    // -1: loop forever; false: do not reverse. The jest mock discards both, so
    // only this spy would notice a loop swapped for a single pass.
    expect(withRepeatSpy).toHaveBeenCalledWith(1, -1, false);
  });

  it('registers exactly one animated style, and no animated props', async () => {
    const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
    const animatedPropsSpy = jest.spyOn(Reanimated, 'useAnimatedProps');
    await renderIcon({ mark: 'control-stop-working', tone: 'working' });

    expect(animatedStyleSpy).toHaveBeenCalledTimes(1);
    expect(animatedPropsSpy).not.toHaveBeenCalled();
  });
});

describe('the stop control under reduced motion', () => {
  it('rests as one static Svg holding the arc and the square, with nothing turning', async () => {
    jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
    await renderIcon({ mark: 'control-stop-working', tone: 'working', testID: 'stop-mark' });

    expect(rotatingNodes()).toEqual([]);
    // One layer, with the testID on the Svg itself.
    expect(screen.queryAllByTestId('svg-root')).toHaveLength(0);
    const svg = screen.getByTestId('stop-mark');
    expect(svg.props.viewBox).toBe(ACTIVITY_VIEW_BOX);
    // 'keep-dash': the arc SURVIVES, so the mark reads as a paused spinner rather than a closed ring.
    expect(stopWorkingMark.restRendering).toBe('keep-dash');
    expect(screen.getByTestId('svg-circle').props.strokeDasharray).toEqual([...stopWorkingDash]);
    expect(screen.getByTestId('svg-rect').props.fill).toBe('currentColor');
    expect(withTimingSpy).not.toHaveBeenCalled();
  });

  it('registers no animated style', async () => {
    jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);
    const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
    const animatedPropsSpy = jest.spyOn(Reanimated, 'useAnimatedProps');
    await renderIcon({ mark: 'control-stop-working', tone: 'working' });

    expect(animatedStyleSpy).not.toHaveBeenCalled();
    expect(animatedPropsSpy).not.toHaveBeenCalled();
  });
});

describe('the screen motion gate', () => {
  it('drops the spinning layer entirely while the screen is blurred, not just its driver', async () => {
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
    const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
    await renderGated(false, { mark: 'control-stop-working', tone: 'working', testID: 'stop-mark' });

    expect(rotatingNodes()).toEqual([]);
    expect(animatedStyleSpy).not.toHaveBeenCalled();
    expect(withTimingSpy).not.toHaveBeenCalled();
    // Still drawn, as the static mark.
    expect(screen.getByTestId('stop-mark')).toBeTruthy();
  });

  it('brings the spin back on focus, so the gate cannot silently kill the ring', async () => {
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
    await renderGated(true, { mark: 'control-stop-working', tone: 'working' });

    expect(rotatingNodes()).toHaveLength(1);
    expect(withTimingSpy).toHaveBeenCalledWith(1, expect.objectContaining({ duration: stopWorkingSpin.durationMs }));
  });
});

describe('marks that never animate', () => {
  it.each([
    ['terminal-idle', terminalIdleMark],
    ['terminal-new', terminalNewMark],
    ['control-stop-idle', stopIdleMark],
  ] as const)('%s declares no spin, draws one static Svg and registers no animated style', async (markName, mark) => {
    const withTimingSpy = jest.spyOn(Reanimated, 'withTiming');
    const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
    const animatedPropsSpy = jest.spyOn(Reanimated, 'useAnimatedProps');
    await renderIcon({ mark: markName, tone: 'working', testID: 'static-mark' });

    expect(mark.spin).toBeUndefined();
    expect(mark.march).toBeUndefined();
    expect(screen.getByTestId('static-mark').props.viewBox).toBe(ACTIVITY_VIEW_BOX);
    expect(rotatingNodes()).toEqual([]);
    expect(animatedStyleSpy).not.toHaveBeenCalled();
    expect(animatedPropsSpy).not.toHaveBeenCalled();
    expect(withTimingSpy).not.toHaveBeenCalled();
  });

  it('terminal-idle never animates even with motion allowed and a focused screen', async () => {
    const withRepeatSpy = jest.spyOn(Reanimated, 'withRepeat');
    await renderGated(true, { mark: 'terminal-idle', tone: 'needs-you', testID: 'terminal-mark' });

    expect(rotatingNodes()).toEqual([]);
    expect(withRepeatSpy).not.toHaveBeenCalled();
  });

  it('draws the idle stop control as a plain ring and the filled square, with no dash', async () => {
    await renderIcon({ mark: 'control-stop-idle', tone: 'needs-you', testID: 'stop-idle' });

    expect(screen.getByTestId('svg-circle').props.strokeDasharray).toBeUndefined();
    expect(screen.getByTestId('svg-rect').props.fill).toBe('currentColor');
  });

  it('honours the caller size', async () => {
    await renderIcon({ mark: 'terminal-idle', tone: 'working', size: 18, testID: 'sized-mark' });

    const svg = screen.getByTestId('sized-mark');
    expect(svg.props.width).toBe(18);
    expect(svg.props.height).toBe(18);
  });
});

describe('tones', () => {
  const colors = darkTerminalTheme.colors;

  it.each([
    ['working', colors.statusWorking],
    ['needs-you', colors.statusNeedsYou],
    ['rest', colors.textSecondary],
    ['danger', colors.danger],
  ] as const satisfies readonly (readonly [ActivityMarkTone, string])[])('tone %s resolves to its theme colour', async (tone, expectedColor) => {
    await renderIcon({ mark: 'terminal-idle', tone, testID: 'toned-mark' });

    expect(screen.getByTestId('toned-mark').props.color).toBe(expectedColor);
  });

  it('keeps the four tone colours distinct, so a mapping that collapsed two would show', () => {
    expect(new Set([colors.statusWorking, colors.statusNeedsYou, colors.textSecondary, colors.danger]).size).toBe(4);
  });

  it('tints the spinning stop control\'s two layers by the same tone mapping', async () => {
    await renderIcon({ mark: 'control-stop-working', tone: 'needs-you' });

    for (const layer of screen.getAllByTestId('svg-root')) {
      expect(layer.props.color).toBe(colors.statusNeedsYou);
    }
  });
});
