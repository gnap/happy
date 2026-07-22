// Hermes runtime on iOS 26.5 / Xcode 26.6 lacks console before JS bundle executes.
// This polyfill must run before any other code.
if (typeof globalThis.console === 'undefined') {
    (globalThis as any).console = { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, trace: () => {}, group: () => {}, groupEnd: () => {} };
}
import './sources/unistyles';
import 'expo-router/entry';
