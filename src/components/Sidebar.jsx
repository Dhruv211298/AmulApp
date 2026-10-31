/** @format */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
	View,
	Text,
	StyleSheet,
	TouchableOpacity,
	Image,
	ScrollView,
	TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import LinearGradient from "react-native-linear-gradient";
import DeviceInfo from "react-native-device-info";
import { COLORS } from "../theme";
import { getSidebarMenu, getSidebarTree, refreshSidebarMenu } from "../services/menu";
import useSafeTopInset from "../hooks/useSafeTopInset";
// Same drawn logout glyph as the top bar, so the two always match.
import LogoutIcon from "./LogoutIcon";

const LOGO = require("../assets/Amul_Logo.png");

// Magnifier drawn from views — a ring plus an angled handle. Avoids adding an
// asset just for one small icon, and tints to match the theme.
// Magnifier drawn from two Views (no icon font / no SVG dependency).
//
// The container is sized to the glyph's ACTUAL bounding box rather than to a
// round number. A ring centred in a square plus a handle sticking out of its
// bottom-right is not centred — the composite leans down-right by however far
// the handle reaches. Measuring the box means the parent's plain `center`
// alignment puts the whole magnifier, not just its ring, in the middle of the
// bubble.
const SearchIcon = ({ size = 16, color }) => {
	const R = size * 0.7; // ring outer diameter
	const L = size * 0.34; // handle length
	const W = 2; // stroke width
	const D = 0.7071; // cos/sin 45°

	// Handle centre: out along the 45° diagonal, starting at the ring's edge.
	const c = R / 2 + (R / 2 + L / 2) * D;
	// Far tip of the handle — the widest point of the glyph, so the box size.
	const box = c + (L / 2) * D + W / 2;

	return (
		<View style={{ width: box, height: box }}>
			<View
				style={{
					position: "absolute",
					left: 0,
					top: 0,
					width: R,
					height: R,
					borderRadius: R / 2,
					borderWidth: W,
					borderColor: color,
				}}
			/>
			<View
				style={{
					position: "absolute",
					left: c - W / 2,
					top: c - L / 2,
					width: W,
					height: L,
					borderRadius: W / 2,
					backgroundColor: color,
					transform: [{ rotate: "-45deg" }],
				}}
			/>
		</View>
	);
};
// Read the version straight from the native build (kept in sync with
// package.json via `npm run sync-version`). Single source of truth.
const APP_VERSION = DeviceInfo.getVersion();

// Presentational drawer. Menu is loaded from the cache (fetched at login),
// with a static fallback. All positioning/animation lives in MainNavigator.
//
// `refreshSignal` bumps every time the drawer opens: the cached menu shows
// instantly, and a background fetch then pulls the CURRENT rights-managed
// menu from the server — so when an admin changes an employee's app-group
// rights, the sidebar reflects it on the very next open, no re-login needed.
// The fetch is best-effort: offline, the cached menu simply stays.
const Sidebar = ({ onSelect, onClose, onLogout, refreshSignal = 0 }) => {
	const [menu, setMenu] = useState([]);
	const [tree, setTree] = useState([]);
	// Which category headings are open. Sections start CLOSED — that is the
	// whole point of grouping a menu this long.
	const [openCats, setOpenCats] = useState({});
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	const insets = useSafeAreaInsets();
	// True once the server refresh has applied its tree, so the slower cached
	// read cannot land afterwards and overwrite it with stale data.
	const refreshedRef = useRef(false);

	// Scroll container + per-category geometry, so opening a section low in
	// the list can pull its sub-items into view (near the Log Out footer).
	const scrollRef = useRef(null);
	const catY = useRef({});     // category id -> y offset in the scroll content
	const catH = useRef({});     // category id -> measured height (heading+items)
	const viewportH = useRef(0); // visible height of the scroll area
	const scrollY = useRef(0);   // current scroll offset

	const q = query.trim().toLowerCase();
	const matches = (name) => String(name || "").toLowerCase().includes(q);

	// What actually gets drawn.
	//
	// Filtering happens on the ALREADY-FETCHED menu, so a search can only ever
	// surface screens this user is entitled to — it can never reveal an option
	// their rights exclude.
	//
	// When the server sent no tree (older endpoint, or first launch before any
	// fetch), `tree` is empty and we fall back to the flat list wrapped as
	// plain items. The sidebar then looks and behaves exactly as it did before
	// categories existed.
	const visibleTree = useMemo(() => {
		const source =
			tree.length > 0
				? tree
				: menu.map((m) => ({ type: "item", ...m }));

		if (!q) return source;

		// Searching keeps the headings and drops non-matching rows. A category
		// whose NAME matches keeps all its items, so typing "portal" shows the
		// whole Amul Portals section rather than nothing.
		return source
			.map((entry) => {
				if (entry.type !== "category") {
					return matches(entry.name) ? entry : null;
				}
				if (matches(entry.name)) return entry;
				const items = entry.items.filter((it) => matches(it.name));
				return items.length ? { ...entry, items } : null;
			})
			.filter(Boolean);
	}, [tree, menu, q]);

	// Total tappable rows — used only to decide whether to show "no matches".
	const visibleCount = useMemo(
		() =>
			visibleTree.reduce(
				(n, e) => n + (e.type === "category" ? e.items.length : 1),
				0,
			),
		[visibleTree],
	);

	// A section counts as open when the user opened it, OR while a search is
	// running (so matches are never hidden behind a collapsed heading).
	const isOpen = (id) => (q ? true : !!openCats[id]);

	// Accordion: opening a section CLOSES any other open one, so only one
	// sub-menu is ever expanded at a time. Opening also scrolls the section's
	// sub-items into view when it sits low in the list.
	const toggleCat = (id) => {
		const willOpen = !openCats[id];
		setOpenCats(willOpen ? { [id]: true } : {});
		if (!willOpen) return;
		// Let the expand (and any sibling collapse) finish laying out, then
		// reveal the section only if it is not already fully visible.
		setTimeout(() => {
			const y = catY.current[id];
			const h = catH.current[id] || 0;
			const vh = viewportH.current || 0;
			const top = scrollY.current || 0;
			if (y == null || !vh || !scrollRef.current) return;
			const PAD = 12;
			const bottom = y + h;
			if (bottom > top + vh) {
				// Sub-items run past the bottom edge — scroll up just enough.
				scrollRef.current.scrollTo({ y: Math.max(0, bottom - vh + PAD), animated: true });
			} else if (y < top) {
				// Heading sits above the viewport — bring it down into view.
				scrollRef.current.scrollTo({ y: Math.max(0, y - PAD), animated: true });
			}
			// Otherwise already fully visible; leave the list where it is.
		}, 120);
	};

	// Shared with Topbar so the drawer header and the bar it sits beside clear
	// the notch / punch-hole / Dynamic Island by exactly the same amount. The
	// extra 12 is breathing room below the inset, not part of the inset itself.
	const topPad = useSafeTopInset() + 12;

	// Clear the system navigation bar. Use the FULL bottom inset (a 3-button
	// nav bar is ~48px — capping it lower pushed the version label under the
	// bar), plus a little breathing room.
	const bottomPad = (insets && insets.bottom > 0 ? insets.bottom : 12) + 8;

	// Each time the drawer opens, start from a clean, unfiltered list — leaving
	// a stale search term behind would make the menu look half-empty.
	useEffect(() => {
		setSearchOpen(false);
		setQuery("");
		// openCats is deliberately NOT reset here.
		//
		// It used to be, on the reasoning that the drawer should always open
		// short and scannable. In use that is wrong: the common action is to
		// open a section, tap an item, then come straight back for the next one
		// — and finding the section closed again means re-opening it every
		// single time. The user's expansion state is a place in the menu, so it
		// survives until they collapse it themselves or log out.
	}, [refreshSignal]);

	useEffect(() => {
		let mounted = true;
		refreshedRef.current = false;
		// 1) Instant: show the cached menu (never leaves the drawer empty).
		getSidebarMenu()
			.then((items) => {
				if (mounted) setMenu(items);
			})
			.catch(() => {});
		// Only applied if the background refresh below has not already landed —
		// otherwise a slow cache read could overwrite fresher server data.
		getSidebarTree()
			.then((t) => {
				if (mounted && !refreshedRef.current) setTree(Array.isArray(t) ? t : []);
			})
			.catch(() => {});
		// 2) Fresh: pull the current rights from the server in the background
		//    and swap it in when it arrives. Bounded by apiPost's timeout, and
		//    silently ignored on failure — the cache remains authoritative.
		refreshSidebarMenu()
			.then((fresh) => {
				if (!mounted) return;
				if (Array.isArray(fresh) && fresh.length) setMenu(fresh);
				// refreshSidebarMenu writes the tree to storage as part of the
				// same response, so re-read it here rather than returning two
				// values — that keeps the flat list authoritative if anything
				// about the tree is off.
				refreshedRef.current = true;
				getSidebarTree()
					.then((t) => {
						if (mounted) setTree(Array.isArray(t) ? t : []);
					})
					.catch(() => {});
			})
			.catch(() => {});
		return () => {
			mounted = false;
		};
	}, [refreshSignal]);

	return (
		<View style={styles.root}>
			{/* Branded gradient header */}
			<View style={[styles.headerContainer, { paddingTop: topPad }]}>
				<LinearGradient
					colors={[COLORS.primaryRed, COLORS.redDark]}
					start={{ x: 0, y: 0 }}
					end={{ x: 1, y: 1 }}
					style={StyleSheet.absoluteFill}
				/>
				<View style={styles.headerTop}>
					<View style={styles.brandRow}>
						<View style={styles.logoBadge}>
							<Image source={LOGO} style={styles.logo} resizeMode='contain' />
						</View>
						<View style={styles.brandTextWrap}>
							<Text style={styles.brandName}>Amul Dairy</Text>
						</View>
					</View>
					{/* Close button — "<" chevron to match the top bar's arrow style */}
					<TouchableOpacity
						onPress={onClose}
						style={styles.closeBtn}
						accessibilityRole='button'
						accessibilityLabel='Close menu'>
						<View style={styles.backChevron} />
					</TouchableOpacity>
				</View>
			</View>

			{/* Menu list — each item is a full bubble with the whole name */}
			<ScrollView
				ref={scrollRef}
				style={styles.body}
				contentContainerStyle={styles.bodyContent}
				showsVerticalScrollIndicator={false}
				scrollEventThrottle={16}
				onScroll={(e) => {
					scrollY.current = e.nativeEvent.contentOffset.y;
				}}
				onLayout={(e) => {
					viewportH.current = e.nativeEvent.layout.height;
				}}>
				<View style={styles.menuHeaderRow}>
					<Text style={styles.sectionLabel}>MENU</Text>
					<TouchableOpacity
						onPress={() => {
							// Closing also clears the term, so the full menu is
							// back the moment the search is dismissed.
							setSearchOpen((open) => {
								if (open) setQuery("");
								return !open;
							});
						}}
						style={[styles.searchBtn, searchOpen && styles.searchBtnActive]}
						hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
						accessibilityRole='button'
						accessibilityLabel={searchOpen ? "Close search" : "Search menu"}>
						<SearchIcon
							size={16}
							color={searchOpen ? "#FFFFFF" : COLORS.primaryRed}
						/>
					</TouchableOpacity>
				</View>

				{searchOpen && (
					<View style={styles.searchWrap}>
						<TextInput
							style={styles.searchInput}
							placeholder='Search menu…'
							placeholderTextColor={COLORS.muted}
							value={query}
							onChangeText={setQuery}
							autoFocus
							returnKeyType='search'
							autoCorrect={false}
						/>
						{query.length > 0 && (
							<TouchableOpacity
								onPress={() => setQuery("")}
								hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
								accessibilityRole='button'
								accessibilityLabel='Clear search'>
								<Text style={styles.searchClear}>×</Text>
							</TouchableOpacity>
						)}
					</View>
				)}

				{visibleCount === 0 && query.length > 0 && (
					<Text style={styles.noMatch}>No menu matches “{query.trim()}”</Text>
				)}

				{visibleTree.map((entry) => {
					// ---- Plain item (uncategorised) ----------------------------
					if (entry.type !== "category") {
						return (
							<TouchableOpacity
								key={entry.id}
								style={styles.bubble}
								activeOpacity={0.75}
								onPress={() => onSelect(entry)}
								accessibilityRole='button'
								accessibilityLabel={entry.name}>
								<View style={styles.bubbleAccent} />
								<Text style={styles.bubbleText} numberOfLines={1}>
									{entry.name}
								</Text>
								<Text style={styles.chevron}>›</Text>
							</TouchableOpacity>
						);
					}

					// ---- Category heading + its items --------------------------
					const open = isOpen(entry.id);
					return (
						<View
							key={entry.id}
							style={styles.catWrap}
							onLayout={(e) => {
								catY.current[entry.id] = e.nativeEvent.layout.y;
								catH.current[entry.id] = e.nativeEvent.layout.height;
							}}>
							<TouchableOpacity
								style={[styles.catHeader, open && styles.catHeaderOpen]}
								activeOpacity={0.75}
								onPress={() => toggleCat(entry.id)}
								accessibilityRole='button'
								accessibilityState={{ expanded: open }}
								accessibilityLabel={`${entry.name}, ${entry.items.length} items`}>
								{/* Same accent bar as an item row — a heading should
								    read as part of the same family, not a different
								    control. The count pill and the rotating chevron
								    are what mark it as expandable. */}
								<View style={styles.bubbleAccent} />
								<Text style={styles.catTitle} numberOfLines={1}>
									{entry.name}
								</Text>
								<View style={styles.catCount}>
									<Text style={styles.catCountText}>
										{entry.items.length}
									</Text>
								</View>
								{/* Rotating the same chevron the rows use keeps one
								    visual language: › points right when closed,
								    down when open. */}
								<Text
									style={[
										styles.catChevron,
										open && styles.catChevronOpen,
									]}>
									›
								</Text>
							</TouchableOpacity>

							{open && (
								// A rail down the left edge ties the children to their
								// heading, so several open sections never blur together.
								<View style={styles.catChildren}>
									{entry.items.map((item) => (
										<TouchableOpacity
											key={item.id}
											style={styles.subBubble}
											activeOpacity={0.75}
											onPress={() => onSelect(item)}
											accessibilityRole='button'
											accessibilityLabel={item.name}>
											{/* A dot, not the parent's bar — the child is a
											    leaf, and the smaller mark says so at a glance. */}
											<View style={styles.subDot} />
											<Text style={styles.subText} numberOfLines={1}>
												{item.name}
											</Text>
											<Text style={styles.subChevron}>›</Text>
										</TouchableOpacity>
									))}
								</View>
							)}
						</View>
					);
				})}
			</ScrollView>

			{/* Footer: logout + version */}
			<View style={[styles.footer, { paddingBottom: bottomPad }]}>
				<TouchableOpacity
					style={styles.logoutBtn}
					onPress={onLogout}
					activeOpacity={0.85}
					accessibilityRole='button'
					accessibilityLabel='Logout'>
					<View style={styles.logoutIconWrap}>
						<LogoutIcon size={20} color={COLORS.primaryRed} />
					</View>
					<Text style={styles.logoutText}>Log Out</Text>
				</TouchableOpacity>
				<Text style={styles.version}>Version {APP_VERSION}</Text>
			</View>
		</View>
	);
};

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: "#FFFFFF" },

	// Header
	headerContainer: {
		borderBottomRightRadius: 28,
		overflow: "hidden",
		paddingHorizontal: 18,
		paddingBottom: 20,
	},
	// minHeight guarantees the logo row can never collapse to nothing.
	headerTop: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		minHeight: 60,
	},
	brandRow: { flexDirection: "row", alignItems: "center", flex: 1 },
	logoBadge: {
		width: 58,
		height: 58,
		borderRadius: 29,
		backgroundColor: "#FFFFFF",
		alignItems: "center",
		justifyContent: "center",
	},
	logo: { width: 44, height: 44 },
	brandTextWrap: { marginLeft: 12, flex: 1 },
	brandName: {
		color: "#FFFFFF",
		fontSize: 19,
		fontWeight: "800",
		letterSpacing: 0.3,
	},
	closeBtn: {
		width: 32,
		height: 32,
		borderRadius: 16,
		backgroundColor: "rgba(255,255,255,0.18)",
		alignItems: "center",
		justifyContent: "center",
	},
	// "<" drawn from a rotated square's left+bottom borders (crisp, matches top bar)
	backChevron: {
		width: 10,
		height: 10,
		borderLeftWidth: 2.5,
		borderBottomWidth: 2.5,
		borderColor: "#FFFFFF",
		transform: [{ rotate: "45deg" }],
		marginLeft: 3,
	},

	// Menu
	body: { flex: 1 },
	bodyContent: { paddingHorizontal: 14, paddingTop: 18, paddingBottom: 8 },
	// "MENU" and the search toggle share a row; the label's own bottom margin
	// moved to the row so both stay aligned.
	menuHeaderRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		marginBottom: 10,
	},
	sectionLabel: {
		color: COLORS.muted,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1,
		marginLeft: 6,
	},
	searchBtn: {
		width: 30,
		height: 30,
		borderRadius: 15,
		backgroundColor: COLORS.redTint,
		alignItems: "center",
		justifyContent: "center",
	},
	searchBtnActive: { backgroundColor: COLORS.primaryRed },

	searchWrap: {
		flexDirection: "row",
		alignItems: "center",
		backgroundColor: "#FFFFFF",
		borderWidth: 1,
		borderColor: COLORS.inputBorder,
		borderRadius: 12,
		paddingHorizontal: 12,
		marginBottom: 12,
	},
	searchInput: {
		flex: 1,
		paddingVertical: 9,
		fontSize: 14,
		color: COLORS.darkText,
	},
	searchClear: {
		fontSize: 20,
		color: COLORS.muted,
		paddingHorizontal: 4,
		lineHeight: 22,
	},
	noMatch: {
		color: COLORS.muted,
		fontSize: 13,
		textAlign: "center",
		paddingVertical: 18,
	},
	bubble: {
		flexDirection: "row",
		alignItems: "center",
		backgroundColor: COLORS.redTint,
		borderRadius: 14,
		paddingVertical: 8,
		paddingHorizontal: 16,
		marginBottom: 8,
		shadowColor: COLORS.primaryRed,
		shadowOpacity: 0.1,
		shadowRadius: 6,
		shadowOffset: { width: 0, height: 2 },
		elevation: 1,
	},
	// ---- Category sections ------------------------------------------------
	// A heading is visually the INVERSE of an item bubble: white with a red
	// border instead of a red tint with a solid accent. That reads as "this is
	// a container, not a destination" without introducing a new colour.
	catWrap: { marginBottom: 8 },
	// A heading is the SAME pill as a menu row — identical background, radius,
	// padding and shadow. Mixing two different shapes in one short list made
	// the drawer look unfinished; the count and the chevron carry the "this
	// expands" meaning on their own.
	catHeader: {
		flexDirection: "row",
		alignItems: "center",
		backgroundColor: COLORS.redTint,
		borderRadius: 14,
		paddingVertical: 8,
		paddingHorizontal: 16,
		shadowColor: COLORS.primaryRed,
		shadowOpacity: 0.1,
		shadowRadius: 6,
		shadowOffset: { width: 0, height: 2 },
		elevation: 1,
	},
	// Open: just a gap before the first child. No shape change — the indent on
	// the rows below is what shows they belong to this heading.
	catHeaderOpen: {
		marginBottom: 6,
	},
	// Identical to bubbleText, so a heading and a row share one type style.
	catTitle: {
		flex: 1,
		fontSize: 16,
		fontWeight: "700",
		color: COLORS.primaryRed,
		letterSpacing: 0.2,
	},
	// Count badge. SOLID RED with a white number — not white-on-tint, which
	// read as a hole punched in the pill and made the whole row look like a
	// different component. Filled in the brand colour it reads as a deliberate
	// badge, the way the accent bar does.
	catCount: {
		minWidth: 20,
		height: 20,
		paddingHorizontal: 6,
		borderRadius: 10,
		backgroundColor: COLORS.primaryRed,
		alignItems: "center",
		justifyContent: "center",
		marginLeft: 8,
	},
	catCountText: {
		fontSize: 11.5,
		fontWeight: "800",
		color: "#FFFFFF",
		// Centres the digit optically inside the small circle — without this
		// the default line height pushes it a pixel low on Android.
		lineHeight: 14,
	},
	// EXACTLY the row chevron — same size, weight and left margin — so the
	// glyphs line up down the right edge and no row looks heavier than another.
	// Only the rotation differs when a section is open.
	catChevron: {
		fontSize: 22,
		color: COLORS.primaryRed,
		fontWeight: "400",
		marginLeft: 6,
	},
	// Same glyph, rotated — closed points right, open points down.
	catChevronOpen: {
		transform: [{ rotate: "90deg" }],
	},
	// ---- Sub-menu rows ----------------------------------------------------
	// Deliberately a LIGHTER treatment than a top-level row: white instead of
	// filled, a thin outline instead of a shadow, smaller text, and a dot
	// instead of the accent bar. Top-level rows stay the strongest thing in the
	// drawer; children read as their contents.
	catChildren: {
		marginLeft: 12,
		paddingLeft: 12,
		borderLeftWidth: 2,
		borderLeftColor: COLORS.redTint,
		marginBottom: 2,
	},
	subBubble: {
		flexDirection: "row",
		alignItems: "center",
		backgroundColor: "#FFFFFF",
		borderWidth: 1,
		borderColor: COLORS.redTint,
		borderRadius: 12,
		paddingVertical: 8,
		paddingHorizontal: 14,
		marginBottom: 6,
	},
	subDot: {
		width: 6,
		height: 6,
		borderRadius: 3,
		backgroundColor: COLORS.primaryRed,
		marginRight: 12,
	},
	subText: {
		flex: 1,
		fontSize: 14.5,
		fontWeight: "600",
		color: COLORS.primaryRed,
		letterSpacing: 0.1,
	},
	subChevron: {
		fontSize: 18,
		lineHeight: 20,
		color: COLORS.primaryRed,
		opacity: 0.55,
		fontWeight: "700",
	},

	bubbleAccent: {
		width: 4,
		height: 20,
		borderRadius: 2,
		backgroundColor: COLORS.primaryRed,
		marginRight: 14,
	},
	bubbleText: {
		flex: 1,
		fontSize: 16,
		fontWeight: "700",
		color: COLORS.primaryRed,
		letterSpacing: 0.2,
	},
	chevron: {
		fontSize: 22,
		color: COLORS.primaryRed,
		fontWeight: "400",
		marginLeft: 6,
	},

	// Footer
	footer: {
		paddingHorizontal: 16,
		paddingTop: 10,
		borderTopWidth: 1,
		borderTopColor: "#F0F1F4",
	},
	logoutBtn: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: COLORS.redTint,
		borderRadius: 12,
		paddingVertical: 13,
		marginBottom: 10,
	},
	logoutIconWrap: { marginRight: 10 },
	logoutText: { color: COLORS.primaryRed, fontSize: 15, fontWeight: "700" },
	version: {
		textAlign: "center",
		color: COLORS.muted,
		fontSize: 11,
		marginBottom: 6,
	},
});

export default Sidebar;
