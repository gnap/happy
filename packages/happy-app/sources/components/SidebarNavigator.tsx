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
// The sidebar occupies a fixed-width column that is ALWAYS reserved in the
// flex row, so toggling its visibility never changes the content area's width.
// When collapsed the sidebar content slides off-screen via translateX while
// the reserved column remains, giving the "session size unchanged" effect.
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
            {/* Reserved sidebar column — width never changes */}
            <View style={{ width: drawerWidth, overflow: 'hidden' }}>
                {/* Sidebar slides in/out without affecting sibling layout */}
                <View style={{
                    position: 'absolute',
                    left: 0, right: 0, top: 0, bottom: 0,
                    transform: [{ translateX: isCollapsed ? -drawerWidth : 0 }],
                }}>
                    <SidebarView />
                </View>
            </View>
            {/* Content — always the same width */}
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
