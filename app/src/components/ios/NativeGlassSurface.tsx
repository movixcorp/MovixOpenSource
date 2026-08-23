import React, { type PropsWithChildren } from 'react';
import {
  Platform,
  requireNativeComponent,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

type Props = PropsWithChildren<{
  interactive?: boolean;
  prominent?: boolean;
  cornerRadius?: number;
  style?: StyleProp<ViewStyle>;
}>;

const IOSGlass = requireNativeComponent<Props>('MovixGlassEffectView');

export function NativeGlassSurface(props: Props) {
  if (Platform.OS !== 'ios') {
    const {
      interactive: _interactive,
      prominent: _prominent,
      cornerRadius: _cornerRadius,
      ...viewProps
    } = props;
    return <View {...viewProps} />;
  }

  return <IOSGlass {...props} />;
}
