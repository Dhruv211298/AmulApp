const fs = require('fs');
const path = 'e:\\\\ReactNative\\\\app\\\\AmulApp\\\\src\\\\screens\\\\LoginScreen.jsx';
let code = fs.readFileSync(path, 'utf8');

const floatAnimStr = `  // --- NEW: Continuous Ambient Animations ---
  const floatAnim1 = useRef(new Animated.Value(0)).current;
  const floatAnim2 = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim1, { toValue: 1, duration: 4000, useNativeDriver: true }),
        Animated.timing(floatAnim1, { toValue: 0, duration: 4000, useNativeDriver: true }),
      ])
    ).start();

    Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim2, { toValue: 1, duration: 5500, useNativeDriver: true }),
        Animated.timing(floatAnim2, { toValue: 0, duration: 5500, useNativeDriver: true }),
      ])
    ).start();

    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.03, duration: 2000, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 2000, useNativeDriver: true })
      ])
    ).start();
  }, [floatAnim1, floatAnim2, pulseAnim]);

  // --- Entrance choreography ---------------------------------------------`;

code = code.replace('// --- Entrance choreography ---------------------------------------------', floatAnimStr);

const returnIndex = code.indexOf('  return (');
if (returnIndex !== -1) {
  code = code.substring(0, returnIndex);
  code += `  return (
    <View style={styles.mainContainer}>
      <StatusBar barStyle="dark-content" translucent backgroundColor="transparent" />

      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Animated.View style={[
          styles.orbContainer, dyn.orbA,
          { transform: [{ translateY: floatAnim1.interpolate({ inputRange: [0, 1], outputRange: [0, 40] }) }] }
        ]}>
          <LinearGradient colors={['rgba(227,0,27,0.15)', 'rgba(227,0,27,0)']} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <Animated.View style={[
          styles.orbContainer, dyn.orbB,
          { transform: [{ translateX: floatAnim2.interpolate({ inputRange: [0, 1], outputRange: [0, -30] }) }, { translateY: floatAnim2.interpolate({ inputRange: [0, 1], outputRange: [0, 30] }) }] }
        ]}>
          <LinearGradient colors={['rgba(16,24,40,0.08)', 'rgba(16,24,40,0)']} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <Animated.View style={[
          styles.orbContainer, dyn.orbC,
          { transform: [{ translateY: floatAnim1.interpolate({ inputRange: [0, 1], outputRange: [0, -40] }) }] }
        ]}>
          <LinearGradient colors={['rgba(227,0,27,0.1)', 'rgba(227,0,27,0)']} style={StyleSheet.absoluteFill} />
        </Animated.View>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={[styles.scrollContent, { paddingTop: topInset + SPACING.lg }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          <View style={dyn.column}>
            <Animated.View style={[styles.glassCard, rise(0)]}>
              
              <View style={styles.brandContainer}>
                <Animated.Image
                  source={LOGO_URL}
                  style={[dyn.logo, { transform: [{ scale: pulseAnim }] }]}
                  resizeMode="contain"
                  accessible
                  accessibilityRole="image"
                  accessibilityLabel="Amul"
                />
                <View style={styles.chip}>
                  <View style={styles.chipDot} />
                  <Text style={styles.chipText}>Secure Access</Text>
                </View>
              </View>

              <View style={styles.headBlock}>
                <Text style={[styles.display, dyn.display]} accessibilityRole="header">
                  {isLogin ? 'Welcome back' : 'Set up access'}
                </Text>
                <Text style={[styles.lede, dyn.lede]}>
                  {isLogin
                    ? 'Enter your 4-digit PIN to continue.'
                    : 'Verify your credentials, then choose a PIN for this device.'}
                </Text>
              </View>

              <View style={styles.tabsContainer}>
                <View style={styles.tabs}>
                  <TouchableOpacity onPress={() => switchMode(true)} activeOpacity={0.7} style={styles.tab}>
                    <Text style={[styles.tabText, dyn.tabText, isLogin && styles.tabTextActive]}>Login</Text>
                    <View style={[styles.tabRule, isLogin && styles.tabRuleActive]} />
                  </TouchableOpacity>
                  {!isLogin && (
                    <TouchableOpacity onPress={() => switchMode(false)} activeOpacity={0.7} style={styles.tab}>
                      <Text style={[styles.tabText, dyn.tabText, !isLogin && styles.tabTextActive]}>Register</Text>
                      <View style={[styles.tabRule, !isLogin && styles.tabRuleActive]} />
                    </TouchableOpacity>
                  )}
                </View>
                <View style={styles.tabsRule} />
              </View>

              <View style={styles.formArea}>
                {isLogin ? (
                  <Animated.View style={[styles.pinSection, rise(1)]}>
                    <View style={styles.pinLabelRow}>
                      <Text style={[styles.label, dyn.label]}>LOGIN PIN</Text>
                      <EyeToggle visible={showLoginPin} onPress={() => setShowLoginPin(!showLoginPin)} size={19} style={styles.pinEye} />
                    </View>
                    <PinInput
                      value={loginPin}
                      onChange={setLoginPin}
                      onComplete={handleLogin}
                      length={4}
                      secure={!showLoginPin}
                      autoFocus
                      cellSize={dyn.pinCell}
                      gap={8}
                    />
                    <Text style={styles.hint}>Locked after 5 incorrect attempts</Text>
                  </Animated.View>
                ) : (
                  <Animated.View style={rise(1)}>
                    <Text style={[styles.label, dyn.label]}>USERNAME / ID</Text>
                    <View style={styles.field}>
                      <Animated.View pointerEvents="none" style={[styles.focusRing, { opacity: userFocusAnim }]} />
                      <View style={styles.fieldIcon}>
                        <UserIcon size={19} color={focusedField === 'username' ? COLORS.primaryRed : COLORS.muted} />
                      </View>
                      <TextInput
                        style={[styles.input, dyn.inputText]}
                        placeholder="Enter your ID"
                        placeholderTextColor="#A8AEB8"
                        value={username}
                        onChangeText={setUsername}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="next"
                        onFocus={() => setFocusedField('username')}
                        onBlur={() => setFocusedField(null)}
                      />
                    </View>

                    <Text style={[styles.label, dyn.label, styles.labelSpaced]}>PASSWORD</Text>
                    <View style={styles.field}>
                      <Animated.View pointerEvents="none" style={[styles.focusRing, { opacity: passFocusAnim }]} />
                      <View style={styles.fieldIcon}>
                        <LockIcon size={19} color={focusedField === 'password' ? COLORS.primaryRed : COLORS.muted} />
                      </View>
                      <TextInput
                        style={[styles.input, dyn.inputText]}
                        placeholder="Enter your password"
                        placeholderTextColor="#A8AEB8"
                        secureTextEntry={!showPassword}
                        value={password}
                        onChangeText={setPassword}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="done"
                        onFocus={() => setFocusedField('password')}
                        onBlur={() => setFocusedField(null)}
                      />
                      <EyeToggle visible={showPassword} onPress={() => setShowPassword(!showPassword)} size={19} style={styles.fieldTrailing} />
                    </View>

                    <View style={styles.stepRule} />

                    <View style={styles.pinLabelRow}>
                      <Text style={[styles.label, dyn.label]}>CHOOSE A 4-DIGIT PIN</Text>
                      <EyeToggle visible={showRegisterPin} onPress={() => setShowRegisterPin(!showRegisterPin)} size={19} style={styles.pinEye} />
                    </View>
                    <View style={styles.pinSectionCompact}>
                      <PinInput
                        value={registerPin}
                        onChange={setRegisterPin}
                        length={4}
                        secure={!showRegisterPin}
                        cellSize={dyn.pinCell}
                        gap={8}
                      />
                    </View>
                    <Text style={styles.hint}>You'll use this PIN to sign in from now on</Text>
                  </Animated.View>
                )}
              </View>

              <Animated.View style={rise(2)}>
                <TouchableWithoutFeedback
                  onPressIn={onPressIn}
                  onPressOut={onPressOut}
                  onPress={isLogin ? handleLogin : handleRegister}
                  disabled={isLoading}
                >
                  <Animated.View style={[styles.ctaShadow, isLoading && styles.ctaDisabled, { transform: [{ scale: scaleValue }] }]}>
                    <LinearGradient
                      colors={[COLORS.primaryRed, COLORS.redDark]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={styles.cta}
                    >
                      {isLoading ? (
                        <ActivityIndicator color="#FFFFFF" />
                      ) : (
                        <View style={styles.ctaInner}>
                          <Text style={[styles.ctaText, dyn.buttonText]}>{isLogin ? 'Sign in' : 'Create access'}</Text>
                          <ArrowRight />
                        </View>
                      )}
                    </LinearGradient>
                  </Animated.View>
                </TouchableWithoutFeedback>

                {isLogin && (
                  <TouchableOpacity style={styles.altAction} onPress={handleDifferentUser} activeOpacity={0.7}>
                    <Text style={styles.altActionText}>Sign in as a different user</Text>
                  </TouchableOpacity>
                )}
              </Animated.View>
            </Animated.View>

            <Animated.View style={[styles.footer, rise(3)]}>
              <LockIcon size={12} color={COLORS.muted} />
              <Text style={styles.footerText}>Amul Dairy · Authorised devices only</Text>
            </Animated.View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
};

const styles = StyleSheet.create({
  mainContainer: { flex: 1, backgroundColor: '#F8F9FA' },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    paddingBottom: SPACING.xl,
    justifyContent: 'center',
  },
  orbContainer: { position: 'absolute', overflow: 'hidden' },
  glassCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: SPACING.lg,
    paddingTop: SPACING.xl,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 12 },
    elevation: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.8)',
    width: '100%',
  },
  brandContainer: { alignItems: 'center', marginBottom: SPACING.lg },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: RADIUS.pill, backgroundColor: 'rgba(18, 183, 106, 0.1)', marginTop: SPACING.md,
  },
  chipDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#12B76A' },
  chipText: { fontSize: 12, fontWeight: '700', color: '#12B76A', letterSpacing: 0.3 },
  headBlock: { alignItems: 'center', marginBottom: SPACING.lg },
  display: { fontWeight: '800', color: COLORS.darkText, letterSpacing: -0.8, textAlign: 'center' },
  lede: { color: COLORS.mediumText, marginTop: SPACING.xs, textAlign: 'center', maxWidth: 300, lineHeight: 22 },
  tabsContainer: { position: 'relative', marginBottom: SPACING.lg, alignItems: 'center' },
  tabs: { flexDirection: 'row', justifyContent: 'center' },
  tab: { paddingHorizontal: SPACING.md, paddingBottom: 12 },
  tabText: { fontWeight: '600', color: COLORS.muted, letterSpacing: 0 },
  tabTextActive: { color: COLORS.darkText, fontWeight: '700' },
  tabRule: { position: 'absolute', left: 16, right: 16, bottom: 0, height: 3, borderRadius: 3, backgroundColor: 'transparent', zIndex: 2 },
  tabRuleActive: { backgroundColor: COLORS.primaryRed },
  tabsRule: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 1, backgroundColor: COLORS.line },
  formArea: { width: '100%' },
  label: { fontWeight: '700', color: COLORS.mediumText, letterSpacing: 0.7, marginBottom: SPACING.xs + 2, fontSize: 12 },
  labelSpaced: { marginTop: SPACING.md + 4 },
  field: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#F3F4F6', borderRadius: 16,
    borderWidth: 1.5, borderColor: 'transparent', paddingHorizontal: SPACING.md, minHeight: 56,
  },
  focusRing: {
    ...StyleSheet.absoluteFillObject, borderRadius: 16, borderWidth: 1.5, borderColor: COLORS.primaryRed,
    backgroundColor: '#FFFFFF', shadowColor: COLORS.primaryRed, shadowOpacity: 0.15, shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 }, elevation: 4,
  },
  fieldIcon: { marginRight: SPACING.sm + 2 },
  fieldTrailing: { paddingLeft: SPACING.sm },
  input: { flex: 1, paddingVertical: Platform.OS === 'ios' ? 16 : 12, fontWeight: '600', color: COLORS.darkText },
  stepRule: { height: 1, backgroundColor: COLORS.line, marginVertical: SPACING.lg },
  pinSection: { alignItems: 'center', width: '100%' },
  pinSectionCompact: { alignItems: 'center', marginTop: SPACING.xs },
  pinLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'stretch', marginBottom: SPACING.xs },
  pinEye: { padding: SPACING.xs },
  hint: { fontSize: 13, color: COLORS.muted, marginTop: SPACING.md, textAlign: 'center', fontWeight: '500' },
  ctaShadow: { marginTop: SPACING.xl, borderRadius: 16, shadowColor: COLORS.primaryRed, shadowOpacity: 0.4, shadowRadius: 20, shadowOffset: { width: 0, height: 10 }, elevation: 8 },
  cta: { height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  ctaInner: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ctaDisabled: { opacity: 0.6 },
  ctaText: { color: '#FFFFFF', fontWeight: '700', letterSpacing: 0.2, fontSize: 16 },
  altAction: { alignSelf: 'center', marginTop: SPACING.lg, paddingVertical: SPACING.sm },
  altActionText: { color: COLORS.primaryRed, fontWeight: '700', fontSize: 14 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: SPACING.xl },
  footerText: { fontSize: 12, color: COLORS.muted, fontWeight: '500' },
});

export default LoginScreen;
`;
}
fs.writeFileSync(path, code);
console.log("Successfully replaced LoginScreen.jsx UI!");
