import 'react-native-gesture-handler/jestSetup';

// Reanimated 4 splits its runtime into react-native-worklets, and the bundled
// `react-native-reanimated/mock` imports the real package (which needs the
// worklets native module), so it cannot load under Jest. This hand-rolled
// factory never touches the real package; it covers the surface the app uses
// (Animated.* host components, entering/exiting builders, the core hooks).
// Extend it here when a component adopts a new reanimated API.
// (Identifiers inside the factory are `mock`-prefixed because babel-plugin-jest-hoist
// only permits out-of-scope references with that prefix.)
jest.mock('react-native-reanimated', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View, Text, Image, ScrollView, FlatList } = require('react-native');

  const mockCreateAnimationBuilder = (): Record<string, () => unknown> => {
    const mockBuilder: Record<string, () => unknown> = {};
    for (const methodName of ['duration', 'delay', 'springify', 'damping', 'easing']) {
      mockBuilder[methodName] = () => mockBuilder;
    }
    return mockBuilder;
  };

  const mockAnimated = {
    View,
    Text,
    Image,
    ScrollView,
    FlatList,
    createAnimatedComponent: (component: unknown) => component,
  };

  return {
    __esModule: true,
    default: mockAnimated,
    ...mockAnimated,
    useSharedValue: (initialValue: unknown) => ({ value: initialValue }),
    useAnimatedStyle: (styleFactory: () => object) => styleFactory(),
    useDerivedValue: (valueFactory: () => unknown) => ({ value: valueFactory() }),
    withTiming: (toValue: unknown) => toValue,
    withSpring: (toValue: unknown) => toValue,
    withDelay: (delayMilliseconds: number, animation: unknown) => animation,
    runOnJS: (callback: unknown) => callback,
    SlideInDown: mockCreateAnimationBuilder(),
    SlideOutDown: mockCreateAnimationBuilder(),
    SlideInUp: mockCreateAnimationBuilder(),
    SlideOutUp: mockCreateAnimationBuilder(),
    FadeIn: mockCreateAnimationBuilder(),
    FadeOut: mockCreateAnimationBuilder(),
  };
});

jest.mock('react-native-pager-view', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  const MockPagerView = React.forwardRef(function MockPagerView(props: object, ref: unknown) {
    return React.createElement(View, { ...props, ref });
  });
  return {
    __esModule: true,
    default: MockPagerView,
  };
});
