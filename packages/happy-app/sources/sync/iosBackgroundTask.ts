/**
 * Platform-safe wrapper around expo-ios-background-task.
 * On non-iOS platforms this module is not available, so we provide no-op stubs.
 */
import { Platform } from 'react-native';

interface BackgroundTaskResult { success: boolean; taskId?: string }

let _module: { default: { beginBackgroundTask(name: string): Promise<BackgroundTaskResult>; endBackgroundTask(taskId: string): Promise<void> } } | null = null;

function getModule() {
    if (!_module) {
        try {
            _module = require('expo-ios-background-task');
        } catch {
            // Web/Tauri — module not available, use stub
        }
    }
    return _module?.default;
}

export async function beginBackgroundTask(name: string): Promise<BackgroundTaskResult> {
    if (Platform.OS !== 'ios') return { success: false };
    const mod = getModule();
    if (!mod) return { success: false };
    return mod.beginBackgroundTask(name);
}

export async function endBackgroundTask(taskId: string): Promise<void> {
    if (Platform.OS !== 'ios') return;
    const mod = getModule();
    if (!mod) return;
    return mod.endBackgroundTask(taskId);
}
