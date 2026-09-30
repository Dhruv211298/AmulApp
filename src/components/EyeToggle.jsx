import React from 'react';
import { TouchableOpacity, Image, StyleSheet } from 'react-native';

// The single source of truth for the show/hide eye icons used across the whole
// app (login, settings, and any future password/PIN field). Use this component
// everywhere so the icon, size, tint and behaviour stay identical.
//
// Convention: open eye when the value is HIDDEN (tap to reveal),
//             crossed-out eye when the value is VISIBLE (tap to hide).
const EYE_ICON = require('../assets/eye.png');
const EYE_OFF_ICON = require('../assets/eye_off.png');

const EyeToggle = ({
  visible,
  onPress,
  size = 22,
  color = '#8A909C',
  style,
  hitSlop = { top: 10, bottom: 10, left: 10, right: 10 },
}) => (
  <TouchableOpacity
    onPress={onPress}
    style={style}
    hitSlop={hitSlop}
    activeOpacity={0.7}
    accessibilityRole="button"
    accessibilityLabel={visible ? 'Hide' : 'Show'}
  >
    <Image
      source={visible ? EYE_OFF_ICON : EYE_ICON}
      style={{ width: size, height: size, tintColor: color }}
    />
  </TouchableOpacity>
);

export default EyeToggle;
