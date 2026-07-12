import 'react-native-gesture-handler/jestSetup';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require is the documented reanimated jest mock pattern
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

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
