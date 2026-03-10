import { useAuth } from '@/auth/AuthContext';
import * as React from 'react';
import { Drawer } from 'expo-router/drawer';
import { useHasSidebar } from '@/utils/responsive';
import { SidebarView } from './SidebarView';
import { Slot } from 'expo-router';
import { Platform, View, useWindowDimensions } from 'react-native';
import { useSidebar } from './SidebarContext';

// ─── Desktop layout (web / Tauri) ────────────────────────────────────────────
//
// Sidebar width animates via CSS transition so the content area expands /
// contracts smoothly without a jarring layout jump. The inner fixed-width
// wrapper keeps SidebarView from distorting during the width animation while
// overflow:hidden clips it cleanly.
//
const DesktopLayout = React.memo(() => {
    const auth = useAuth();
    const sidebar = useSidebar();
    const { width: windowWidth } = useWindowDimensions();
    const isCollapsed = sidebar?.isCollapsed ?? false;
    const drawerWidth = Math.min(Math.max(Math.floor(windowWidth * 0.3), 250), 360);

    if (!auth.isAuthenticated) {
        return <Slot />;
    }

    return (
        <View style={{ flex: 1, flexDirection: 'row' }}>
            {/* Animated sidebar column — width transitions, content expands to fill */}
            <View style={[
                { width: isCollapsed ? 0 : drawerWidth, overflow: 'hidden' },
                { transition: 'width 250ms ease-in-out' } as any,
            ]}>
                {/* Fixed-width inner prevents SidebarView from distorting during animation */}
                <View style={{ width: drawerWidth, flex: 1 }}>
                    <SidebarView />
                </View>
            </View>
            {/* Content — flex:1, smoothly expands as sidebar shrinks */}
            <View style={{ flex: 1 }}>
                <Slot />
            </View>
        </View>
    );
});

// ─── Tablet / phone layout (iOS / Android) ───────────────────────────────────
//
// Uses expo-router's Drawer in permanent mode for tablet, hidden for phone.
// Toggling the sidebar is fine here — tablets reflow naturally.
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
