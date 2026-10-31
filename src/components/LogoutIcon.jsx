import React from 'react';
import { View } from 'react-native';

// Logout glyph drawn from Views — no image asset, no network request.
//
// It replaces an <Image source={{ uri: 'https://cdn-icons-png.flaticon.com/...' }}>
// used in both the top bar and the sidebar. Loading a UI icon from a third-party
// CDN disclosed every user's IP to Flaticon on each app open, made the icon
// vanish offline (exactly when staff are in a plant with poor signal), and
// carried attribution terms.
//
// LAYOUT NOTE — why every part is absolutely positioned on a 24-unit grid:
// the first version mixed a flex child (the door) with absolutely positioned
// siblings (the shaft and head). Flex centring and absolute insets then fought
// each other, so the arrow floated clear of the doorway and the icon read as two
// unrelated shapes, "[ →". Placing all three parts by explicit coordinates on a
// shared grid makes the geometry exact and identical on both platforms.
//
//   grid:  door  x 2→12,  y 2→22        (3 sides, open on the right)
//          shaft x 8→18.5, y centred at 12
//          head  chevron with its tip at x 22, y 12
//
// The shaft deliberately starts INSIDE the door and the head overlaps the
// shaft's end, so the three parts form one continuous "leaving through the
// doorway" figure rather than separate strokes.
//
// Props: size (square, in px), color
const LogoutIcon = ({ size = 20, color = '#E3001B' }) => {
  const u = size / 24; // one design unit
  const stroke = Math.max(1.5, 2.2 * u);

  // Chevron: a square rotated 45° showing only its top and right borders draws a
  // ">" whose tip is its rightmost point, at side * √2/2 from the square centre.
  // Solve for the left/top that puts that tip exactly at (22u, 12u).
  const head = 7 * u;
  const tipOffset = head * 0.7071;
  const headLeft = 22 * u - tipOffset - head / 2;
  const headTop = 12 * u - head / 2;

  return (
    <View style={{ width: size, height: size }}>
      {/* Door frame — three sides, deliberately open on the right. */}
      <View
        style={{
          position: 'absolute',
          left: 2 * u,
          top: 2 * u,
          width: 10 * u,
          height: 20 * u,
          borderColor: color,
          borderLeftWidth: stroke,
          borderTopWidth: stroke,
          borderBottomWidth: stroke,
          borderTopLeftRadius: 2.5 * u,
          borderBottomLeftRadius: 2.5 * u,
        }}
      />

      {/* Arrow shaft — starts inside the frame and exits through the opening. */}
      <View
        style={{
          position: 'absolute',
          left: 8 * u,
          top: 12 * u - stroke / 2,
          width: 10.5 * u,
          height: stroke,
          backgroundColor: color,
          borderRadius: stroke / 2,
        }}
      />

      {/* Arrow head. */}
      <View
        style={{
          position: 'absolute',
          left: headLeft,
          top: headTop,
          width: head,
          height: head,
          borderColor: color,
          borderTopWidth: stroke,
          borderRightWidth: stroke,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  );
};

export default LogoutIcon;
