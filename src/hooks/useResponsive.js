import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';

// ---------------------------------------------------------------------------
// useResponsive — the single source of truth for adaptive sizing.
//
// Rule of the codebase: NO layout-critical dimension may be a bare constant.
// Fixed pixel values are how the QR frame overflowed landscape and the
// Dashboard mascot vanished under a width-relative padding. Every screen
// should derive its sizes from this hook instead:
//
//   const { width, height, shortEdge, isLandscape, scale, clamp } = useResponsive();
//
//   scale(16)          -> a 16pt design size, scaled for this device
//   shortEdge * 0.6    -> proportional to the stable (shorter) screen edge
//   clamp(n, lo, hi)   -> bound any computed value
//
// Why shortEdge: width flips meaning on rotation, but the shorter edge is
// stable — sizing squares/fonts against it gives layouts that survive
// rotation, split-screen, and foldables without special cases.
//
// scale() uses a 375pt design baseline (standard phone width) and is clamped
// (0.85–1.25 by default) so text/controls neither shrink unreadably on small
// phones nor balloon on tablets.
//
// Reads useWindowDimensions, so every consumer re-renders with fresh values
// the moment the window changes — rotation is handled automatically.
// ---------------------------------------------------------------------------

export default function useResponsive() {
  const { width, height } = useWindowDimensions();

  return useMemo(() => {
    const shortEdge = Math.min(width, height);
    const longEdge = Math.max(width, height);
    const isLandscape = width > height;

    const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
    const scale = (size, lo = 0.85, hi = 1.25) =>
      Math.round(size * clamp(shortEdge / 375, lo, hi));

    return { width, height, shortEdge, longEdge, isLandscape, clamp, scale };
  }, [width, height]);
}
