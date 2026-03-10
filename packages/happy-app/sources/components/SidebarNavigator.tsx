import { useAuth } from '@/auth/AuthContext';
import * as React from 'react';
import { Drawer } from 'expo-router/drawer';
import { useHasSidebar } from '@/utils/responsive';
import { SidebarView } from './SidebarView';
import { Slot } from 'expo-router';
import { Platform, View, useWindowDimensions } from 'react-native';
import { useSidebar } from './SidebarContext';

// Shared constant — also imported by ChatHeaderView for the Tauri resize delta.
export const DESKTOP_SIDEBAR_WIDTH = 280;

// ─── Desktop layout (web / Tauri) ────────────────────────────────────────────
//
// Standard side-by-side layout: [sidebar | content].
// On Wayland, window position cannot be controlled by the app, so we don't
// attempt to resize or reposition the window. The sidebar simply shows/hides
// and the content area takes the remaining space — the same behaviour as most
// desktop apps (VS Code, Slack, etc.).
//
const DesktopLayout = React.memo(() => {
    const auth = useAuth();
    const sidebar = useSidebar();
    const isCollapsed = sidebar?.isCollapsed ?? false;

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
