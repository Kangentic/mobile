import React from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { SheetScrollerSlot } from '@/components';

/**
 * Deliberately structural assertions, against the repo's usual
 * behavior-only convention: the collapsable={false} + overflow: 'hidden'
 * wrapper IS the iOS form-sheet fix (see the component's invariant comment),
 * it renders invisibly on Android, and it cannot be exercised on iOS before
 * a TestFlight build. This test is the only guard that keeps the wrapper
 * from being flattened away by a future refactor.
 */

function renderedSlotHost(): ReactTestRendererJSON {
  const rendered = screen.toJSON();
  if (rendered === null || Array.isArray(rendered)) {
    throw new Error('expected a single rendered root host element');
  }
  return rendered;
}

describe('SheetScrollerSlot', () => {
  it('renders its scroller child', () => {
    render(
      <SheetScrollerSlot>
        <ScrollView testID="slot-child">
          <Text>row</Text>
        </ScrollView>
      </SheetScrollerSlot>,
    );

    expect(screen.getByTestId('slot-child')).toBeTruthy();
    expect(screen.getByText('row')).toBeTruthy();
  });

  it('is a real, clipping native view: collapsable false and overflow hidden', () => {
    render(
      <SheetScrollerSlot>
        <ScrollView testID="slot-child" />
      </SheetScrollerSlot>,
    );

    const slotHost = renderedSlotHost();
    expect(slotHost.type).toBe('View');
    expect(slotHost.props.collapsable).toBe(false);
    expect(StyleSheet.flatten(slotHost.props.style)).toMatchObject({ overflow: 'hidden' });
    expect(slotHost.children?.[0]).toMatchObject({ props: { testID: 'slot-child' } });
  });

  it('keeps the height cap on the scroller child, not the wrapper', () => {
    render(
      <SheetScrollerSlot>
        <ScrollView testID="slot-child" style={{ maxHeight: 420 }} />
      </SheetScrollerSlot>,
    );

    const slotHost = renderedSlotHost();
    expect(StyleSheet.flatten(slotHost.props.style).maxHeight).toBeUndefined();
    const scrollerHost = slotHost.children?.[0] as ReactTestRendererJSON;
    expect(StyleSheet.flatten(scrollerHost.props.style).maxHeight).toBe(420);
  });
});
