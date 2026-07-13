import React from 'react';
import { ScrollView, View } from 'react-native';
import { MonoText, useTheme, type MonoTextSize, type TextColorRole } from '@/components';

export interface MonoBlockProps {
  text: string;
  size?: MonoTextSize;
  color?: TextColorRole;
  /** Collapses the text to at most this many rendered lines. */
  maxLines?: number;
  /** Caps the block height and makes the content scrollable inside it. */
  maxHeight?: number;
  testID?: string;
}

/** A padded codeBackground block of monospace text, shared by the tool and prompt cards. */
export function MonoBlock({
  text,
  size = 'caption',
  color = 'primary',
  maxLines,
  maxHeight,
  testID,
}: MonoBlockProps): React.JSX.Element {
  const theme = useTheme();
  const containerStyle = {
    backgroundColor: theme.colors.codeBackground,
    borderRadius: theme.radii.sm,
    padding: theme.spacing.sm,
  };
  const textNode = (
    <MonoText size={size} color={color} numberOfLines={maxLines}>
      {text}
    </MonoText>
  );

  if (maxHeight !== undefined) {
    return (
      <ScrollView style={[containerStyle, { maxHeight }]} nestedScrollEnabled testID={testID}>
        {textNode}
      </ScrollView>
    );
  }
  return (
    <View style={containerStyle} testID={testID}>
      {textNode}
    </View>
  );
}
