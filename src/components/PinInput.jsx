import React, {
  useRef,
  useState,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Animated,
} from 'react-native';

/**
 * PinInput — a smooth, professional PIN / OTP entry field.
 *
 * How it works (and why the old version needed multiple taps):
 * Instead of one tiny TextInput per digit (whose touch target was only the
 * glyph, so taps missed it), this renders the digit cells as *display only*
 * and places ONE full-width transparent TextInput on top of them. Tapping
 * anywhere on the row hits that single large input, so the numeric keypad
 * opens on the very first tap — and there is no focus juggling between fields.
 *
 * Props:
 *   value        string           controlled PIN value
 *   onChange     (str) => void    fires as the user types (digits only)
 *   onComplete   (str) => void    fires when length is reached
 *   length       number = 4
 *   secure       bool = false     mask entered digits with dots
 *   autoFocus    bool = false     open the keypad automatically on mount
 *   cellSize     number = 52
 *   activeColor  string
 *   filledBg     string
 *
 * Ref API: `focus()` — opens the keypad on demand. `autoFocus` only applies at
 * mount, so a screen that decides later that the user should start typing (the
 * login screen, once biometrics have been given up on) needs this instead.
 */
const PinInput = forwardRef(({
  value = '',
  onChange,
  onComplete,
  length = 4,
  secure = false,
  autoFocus = false,
  cellSize = 52,
  gap = 7,
  activeColor = '#E3001B',
  filledBg = '#FFF0F0',
  idleBorder = '#D9DDE3',
}, ref) => {
  const inputRef = useRef(null);
  const [focused, setFocused] = useState(false);
  const caret = useRef(new Animated.Value(1)).current;

  // Blinking caret only while the field is focused.
  useEffect(() => {
    if (!focused) {
      caret.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(caret, {
          toValue: 0,
          duration: 500,
          useNativeDriver: true,
        }),
        Animated.timing(caret, {
          toValue: 1,
          duration: 500,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [focused, caret]);

  const handleChange = useCallback(
    text => {
      const clean = String(text).replace(/[^0-9]/g, '').slice(0, length);
      if (onChange) onChange(clean);
      if (clean.length === length && onComplete) onComplete(clean);
    },
    [length, onChange, onComplete],
  );

  const focus = useCallback(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  useImperativeHandle(ref, () => ({ focus }), [focus]);

  const activeIndex = value.length;

  return (
    <Pressable onPress={focus} style={styles.wrap} hitSlop={8}>
      {/* Display cells — no touch handling, they let taps fall through. */}
      <View style={styles.row} pointerEvents="none">
        {Array.from({ length }).map((_, i) => {
          const filled = i < value.length;
          const isActive = focused && i === activeIndex;
          return (
            <View
              key={i}
              style={[
                styles.cell,
                {
                  width: cellSize,
                  height: cellSize + 6,
                  marginHorizontal: gap,
                  borderColor: idleBorder,
                },
                filled && { borderColor: activeColor, backgroundColor: filledBg },
                isActive && { borderColor: activeColor, borderWidth: 2 },
              ]}
            >
              {filled ? (
                secure ? (
                  <View style={[styles.dot, { backgroundColor: activeColor }]} />
                ) : (
                  <Text style={styles.digit}>{value[i]}</Text>
                )
              ) : isActive ? (
                <Animated.View
                  style={[
                    styles.caret,
                    { opacity: caret, backgroundColor: activeColor },
                  ]}
                />
              ) : null}
            </View>
          );
        })}
      </View>

      {/* The single real input: covers the whole row, invisible, big tap target. */}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={handleChange}
        keyboardType="number-pad"
        maxLength={length}
        autoFocus={autoFocus}
        caretHidden
        contextMenuHidden
        blurOnSubmit={false}
        importantForAutofill="no"
        textContentType="oneTimeCode"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={styles.hiddenInput}
      />
    </Pressable>
  );
});

PinInput.displayName = 'PinInput';

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
    alignSelf: 'center',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  cell: {
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  digit: {
    fontSize: 24,
    fontWeight: '700',
    color: '#E3001B', // Amul red — visible entered digits
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  caret: {
    width: 2,
    height: 26,
    borderRadius: 1,
  },
  // Full-cover, fully transparent input — the actual touch + typing surface.
  hiddenInput: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0,
    color: 'transparent',
    fontSize: 1,
    textAlign: 'center',
  },
});

export default PinInput;
