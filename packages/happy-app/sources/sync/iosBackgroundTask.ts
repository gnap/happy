/**
 * Platform-safe wrapper around expo-ios-background-task.
 * On non-iOS platforms this module is not available, so we provide no-op stubs.
 */
import { Platform } from 'react-native';

interface BackgroundTaskResult { success: boolean; taskId?: string }

// Static import for Hermes/Runtime bundler compatibility.
// On non-iOS platforms the native module may not be linked — catch the error.
let bgTask: { beginBackgroundTask(name: string): Promise<BackgroundTaskResult>; endBackgroundTask(taskId: string): Promise<void> } | null = null;
try {
    bgTask = require('expo-ios-background-task').default;
} catch {
    // Module not available (non-iOS or not linked)
}

export async function beginBackgroundTask(name: string): Promise<BackgroundTaskResult> {
    if (Platform.OS !== 'ios' || !bgTask) return { success: false };
    return bgTask.beginBackgroundTask(name);
}

export async function endBackgroundTask(taskId: string): Promise<void> {
    if (Platform.OS !== 'ios' || !bgTask) return;
    return bgTask.endBackgroundTask(taskId);
}
