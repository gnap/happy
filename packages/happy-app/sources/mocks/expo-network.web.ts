/**
 * Web mock for expo-network.
 * On web/Tauri, network monitoring via expo-network is unavailable.
 * We expose a no-op API with the same shape so sync.ts compiles without changes.
 */

export enum NetworkStateType {
    NONE = 'NONE',
    UNKNOWN = 'UNKNOWN',
    CELLULAR = 'CELLULAR',
    WIFI = 'WIFI',
    BLUETOOTH = 'BLUETOOTH',
    ETHERNET = 'ETHERNET',
    WIMAX = 'WIMAX',
    VPN = 'VPN',
    OTHER = 'OTHER',
}

export interface NetworkState {
    type?: NetworkStateType;
    isConnected?: boolean;
    isInternetReachable?: boolean;
}

export function addNetworkStateListener(
    _listener: (state: NetworkState) => void,
): { remove: () => void } {
    return { remove: () => {} };
}

export async function getNetworkStateAsync(): Promise<NetworkState> {
    return { type: NetworkStateType.UNKNOWN, isConnected: true, isInternetReachable: true };
}
