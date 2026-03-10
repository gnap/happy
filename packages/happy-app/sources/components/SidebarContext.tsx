import * as React from 'react';

interface SidebarContextValue {
    isCollapsed: boolean;
    setIsCollapsed: (value: boolean) => void;
    toggleSidebar: () => void;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

export const SidebarProvider = ({ children }: { children: React.ReactNode }) => {
    const [isCollapsed, setIsCollapsed] = React.useState(false);
    const toggleSidebar = React.useCallback(() => setIsCollapsed(v => !v), []);
    return (
        <SidebarContext.Provider value={{ isCollapsed, setIsCollapsed, toggleSidebar }}>
            {children}
        </SidebarContext.Provider>
    );
};

export function useSidebar() {
    return React.useContext(SidebarContext);
}
