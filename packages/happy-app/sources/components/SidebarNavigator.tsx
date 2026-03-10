import { useAuth } from '@/auth/AuthContext';
import * as React from 'react';
import { Drawer } from 'expo-router/drawer';
import { useHasSidebar } from '@/utils/responsive';
import { SidebarView } from './SidebarView';
import { Slot } from 'expo-router';
import { Platform, View, useWindowDimensions } from 'react-native';
import { useSidebar } from './SidebarContext';
import { isRunningInTauri } from '@/utils/platform';

// Fixed sidebar width for desktop — a constant avoids the width drifting after
// repeated collapse/expand cycles that would occur with a percentage-based value.
const DESKTOP_SIDEBAR_WIDTH = 280;

// ─── Desktop layout (web / Tauri) ────────────────────────────────────────────
//
// Layout: [sidebar (fixed width) | content (flex:1)]
//
// When running inside Tauri, toggling the sidebar resizes and repositions the
// OS window so the RIGHT edge stays fixed on screen. The content area never
// changes size or position — only the window itself grows/shrinks from the left.
//
// In a plain browser (no Tauri), the window cannot be resized programmatically,
// so the sidebar simply shows/hides and the content reflowes normally.
//
const DesktopLayout = React.memo(() => {
    const auth = useAuth();
    const sidebar = useSidebar();
    const isCollapsed = sidebar?.isCollapsed ?? false;

    // Skip the resize effect on initial mount — only fire on real toggles.
    const isFirstRender = React.useRef(true);

    React.useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        if (!isRunningInTauri()) return;

        (async () => {
            try {
                const [{ getCurrentWindow }, { PhysicalSize, PhysicalPosition }] = await Promise.all([
                    import('@tauri-apps/api/window'),
                    import('@tauri-apps/api/dpi'),
                ]);

                const win = getCurrentWindow();
                const [physSize, physPos, scale] = await Promise.all([
                    win.outerSize(),
                    win.outerPosition(),
                    win.scaleFactor(),
                ]);

                // Convert the logical sidebar width to physical pixels for the OS.
                const physDelta = Math.round(DESKTOP_SIDEBAR_WIDTH * scale);

                if (isCollapsed) {
                    // Sidebar just hidden → shrink window from the left, right edge fixed.
                    await Promise.all([
                        win.setSize(new PhysicalSize(physSize.width - physDelta, physSize.height)),
                        win.setPosition(new PhysicalPosition(physPos.x + physDelta, physPos.y)),
                    ]);
                } else {
                    // Sidebar just shown → grow window to the left, right edge fixed.
                    const newX = Math.max(0, physPos.x - physDelta);
                    const actualDelta = physPos.x - newX;
                    await Promise.all([
                        win.setSize(new PhysicalSize(physSize.width + actualDelta, physSize.height)),
                        win.setPosition(new PhysicalPosition(newX, physPos.y)),
                    ]);
                }
            } catch (e) {
                console.error('[SidebarNavigator] window resize failed:', e);
            }
        })();
    }, [isCollapsed]);

    if (!auth.isAuthenticated) {
        return <Slot />;
    }

    return (
        <View style={{ flex: 1, flexDirection: 'row' }}>
            {!isCollapsed && (
                <View style={{ width: DESKTOP_SIDEBAR_WIDTH }}>
                    <SidebarView />
                </View>
            )}
            <View style={{ flex: 1 }}>
                <Slot />
            </View>
        </View>
    );
});

// ─── Tablet / phone layout (iOS / Android) ───────────────────────────────────
//
// Uses expo-router's Drawer in permanent mode for tablet, hidden for phone.
// Toggling the sidebar reflows the content, which is fine on touch devices.
//
const DrawerLayout = React.memo(() => {
    const auth = useAuth();
    const hasSidebar = useHasSidebar();
    const sidebar = useSidebar();
    const isCollapsed = sidebar?.isCollapsed ?? false;
    const showPermanentDrawer = auth.isAuthenticated && hasSidebar && !isCollapsed;
    const { width: windowWidth } = useWindowDimensions();

    const drawerWidth = React.useMemo(() => {
        if (!showPermanentDrawer) return 280;
        return Math.min(Math.max(Math.floor(windowWidth * 0.3), 250), 360);
    }, [windowWidth, showPermanentDrawer]);

    const drawerNavigationOptions = React.useMemo(() => {
        if (!showPermanentDrawer) {
            return {
                lazy: false,
                headerShown: false,
                drawerType: 'front' as const,
                swipeEnabled: false,
                drawerStyle: { width: 0, display: 'none' as const },
            };
        }
        return {
            lazy: false,
            headerShown: false,
            drawerType: 'permanent' as const,
            drawerStyle: { backgroundColor: 'white', borderRightWidth: 0, width: drawerWidth },
            swipeEnabled: false,
            drawerActiveTintColor: 'transparent',
            drawerInactiveTintColor: 'transparent',
            drawerItemStyle: { display: 'none' as const },
            drawerLabelStyle: { display: 'none' as const },
        };
    }, [showPermanentDrawer, drawerWidth]);

    const drawerContent = React.useCallback(() => <SidebarView />, []);

    return (
        <Drawer
            screenOptions={drawerNavigationOptions}
            drawerContent={showPermanentDrawer ? drawerContent : undefined}
        />
    );
});

// ─── Root export ─────────────────────────────────────────────────────────────

export const SidebarNavigator = React.memo(() => {
    if (Platform.OS === 'web') {
        return <DesktopLayout />;
    }
    return <DrawerLayout />;
});
