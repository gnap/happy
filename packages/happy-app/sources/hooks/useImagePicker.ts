/**
 * Cross-platform image picker hook.
 * Uses expo-image-picker on native, hidden <input type="file"> on web/Tauri.
 */

import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

export type PickedImage = {
    data: string;       // base64
    mimeType: string;   // e.g. "image/png"
    width: number;
    height: number;
    name: string;       // filename
    size: number;       // bytes
};

async function pickImageWeb(): Promise<PickedImage | null> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) { resolve(null); return; }
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result as string;
                const base64 = dataUrl.split(',')[1];
                // Get image dimensions
                const img = new Image();
                img.onload = () => {
                    resolve({
                        data: base64,
                        mimeType: file.type || 'image/png',
                        width: img.naturalWidth,
                        height: img.naturalHeight,
                        name: file.name || 'image.png',
                        size: file.size,
                    });
                };
                img.src = dataUrl;
            };
            reader.readAsDataURL(file);
        };
        input.click();
    });
}

async function pickImageNative(): Promise<PickedImage | null> {
    const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.8,
        base64: true,
    });
    if (result.canceled || !result.assets[0]) return null;
    const asset = result.assets[0];
    return {
        data: asset.base64 ?? '',
        mimeType: asset.mimeType ?? 'image/png',
        width: asset.width,
        height: asset.height,
        name: asset.fileName ?? 'image.png',
        size: asset.fileSize ?? 0,
    };
}

export function useImagePicker() {
    const pickImage = async (): Promise<PickedImage | null> => {
        try {
            if (Platform.OS === 'web') {
                return await pickImageWeb();
            }
            return await pickImageNative();
        } catch {
            return null;
        }
    };
    return { pickImage } as const;
}
