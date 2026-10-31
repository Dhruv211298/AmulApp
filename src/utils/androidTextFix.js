import { Platform, Text, TextInput } from 'react-native';

// ---------------------------------------------------------------------------
// Fix for clipped text on OEM-font Android devices (OnePlus / Oppo / Realme).
//
// THE BUG: those brands replace Android's default typeface with their own
// ("Slate" on OnePlus, and any user-selected system font on ColorOS/RealmeUI).
// React Native measures text with metrics that don't match the substituted
// font, which renders slightly WIDER — so every <Text> box comes out about one
// character too narrow and the tail is clipped: "Refresh" -> "Refres",
// "Latitude" -> "Latitud", "22.550440" -> "22.55044". It looks like dozens of
// layout bugs; it is one font bug.
//
// THE FIX: explicitly request "sans-serif" — the genuine Roboto family shipped
// on every Android device — as the app-wide font family. The OEM replacement
// hooks the DEFAULT typeface; a font requested BY NAME resolves to the real
// system Roboto, whose metrics match what RN measures. fontWeight ('600',
// 'bold', ...) keeps working because it is a system family with real weights.
// ("sans-serif" is the safe alias — some OEM builds alias the literal name
// "Roboto" to their own font, but "sans-serif" always maps to the stock one.)
//
// HOW: Text and TextInput are forwardRef components, so their `render` is
// wrapped to prepend the family to every style. Prepending (not appending)
// means any screen that deliberately sets its own fontFamily still wins —
// this is a default, not an override.
//
// RN 0.86 NOTE: on the new architecture Text / TextInput are exported as
// React.memo(React.forwardRef(...)). For a memo() component the render fn
// lives on Component.type.render, NOT Component.render — so the old guard
// `if (typeof Component.render !== 'function') return;` silently did nothing
// and the fix never applied. resolveRenderHolder() below handles both shapes.
//
// Android-only: iOS has no OEM font substitution, and San Francisco's metrics
// are always correct there.
// ---------------------------------------------------------------------------

if (Platform.OS === 'android') {
  // "sans-serif" = stock Roboto on every Android, so requesting it by name
  // sidesteps the OEM substitution that causes the clipping. No trailing
  // padding is added: that would shift every layout, and forcing the genuine
  // font already makes the measured width match the drawn width.
  const baseStyle = { fontFamily: 'sans-serif' };
  const inputStyle = { fontFamily: 'sans-serif' };

  // Find the object that actually holds the `render` function.
  //   forwardRef(fn)            -> { render: fn }              (holder = Component)
  //   memo(forwardRef(fn))      -> { type: { render: fn } }    (holder = Component.type)
  //   memo(fn)                  -> { type: fn }                (no render to wrap)
  const resolveRenderHolder = Component => {
    if (!Component) return null;
    if (typeof Component.render === 'function') return Component;
    if (Component.type && typeof Component.type.render === 'function') {
      return Component.type;
    }
    return null;
  };

  const patch = (Component, extra) => {
    const holder = resolveRenderHolder(Component);
    if (!holder || holder.__amulFontPatched) return;
    const originalRender = holder.render;
    holder.render = function render(props, ref) {
      return originalRender.call(
        this,
        { ...props, style: [extra, props.style] },
        ref,
      );
    };
    // Guard against double-patching (e.g. a hot reload re-running this module),
    // which would otherwise stack wrappers and prepend the family twice.
    holder.__amulFontPatched = true;
  };

  patch(Text, baseStyle);
  patch(TextInput, inputStyle);
}
