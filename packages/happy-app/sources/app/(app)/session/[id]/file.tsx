import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Platform, Pressable, Image, useWindowDimensions } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/StyledText';
import { SimpleSyntaxHighlighter } from '@/components/SimpleSyntaxHighlighter';
import { Typography } from '@/constants/Typography';
import { sync } from '@/sync/sync';
import { recordRecentFile } from '@/sync/recentFiles';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { FileIcon } from '@/components/FileIcon';
import { decodeFilePathParam } from '@/utils/filePathParam';
import { Ionicons } from '@expo/vector-icons';

interface FileContent {
    content: string;
    encoding: 'utf8' | 'base64';
    isBinary: boolean;
}

/** Whether the viewer can draw this file itself instead of handing it to the system. */
function isPdfFile(path: string): boolean {
    return path.split('.').pop()?.toLowerCase() === 'pdf';
}

/** What the share sheet should call this file; only the types this viewer knows are named. */
function mimeTypeFor(path: string): string {
    switch (path.split('.').pop()?.toLowerCase()) {
        case 'pdf': return 'application/pdf';
        case 'png': return 'image/png';
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'gif': return 'image/gif';
        case 'webp': return 'image/webp';
        case 'bmp': return 'image/bmp';
        case 'svg': return 'image/svg+xml';
        default: return 'application/octet-stream';
    }
}

/** A file the machine served, handed to the system's own viewer or save dialog. */
/** The file's characters, from whichever transport carried it. */
async function readDownloadedText(download: { uri?: string; bytes?: Uint8Array }): Promise<string> {
    if (download.bytes) {
        return new TextDecoder().decode(download.bytes);
    }
    const fs = await import('expo-file-system');
    return new fs.File(download.uri!).text();
}

/** A browser URL for bytes, so an `<img>` or a save anchor can use them without a file system. */
function blobUrlFor(bytes: Uint8Array, type: string): string {
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
}

/** A byte count a person can read, for a download in progress. */
function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / 1024 ** exponent;
    return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

async function presentFile(uri: string, fileName: string): Promise<void> {
    const Sharing = await import('expo-sharing');
    if (!(await Sharing.isAvailableAsync())) {
        throw new Error('This device has no way to open the file');
    }
    await Sharing.shareAsync(uri, {
        mimeType: mimeTypeFor(fileName),
        dialogTitle: fileName,
        UTI: isPdfFile(fileName) ? 'com.adobe.pdf' : undefined,
    });
}

// Diff display component
const DiffDisplay: React.FC<{ diffContent: string }> = ({ diffContent }) => {
    const { theme } = useUnistyles();
    const lines = diffContent.split('\n');
    
    return (
        <View>
            {lines.map((line, index) => {
                const baseStyle = { ...Typography.mono(), fontSize: 14, lineHeight: 20 };
                let lineStyle: any = baseStyle;
                let backgroundColor = 'transparent';
                
                if (line.startsWith('+') && !line.startsWith('+++')) {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.addedText };
                    backgroundColor = theme.colors.diff.addedBg;
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.removedText };
                    backgroundColor = theme.colors.diff.removedBg;
                } else if (line.startsWith('@@')) {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.hunkHeaderText, fontWeight: '600' };
                    backgroundColor = theme.colors.diff.hunkHeaderBg;
                } else if (line.startsWith('+++') || line.startsWith('---')) {
                    lineStyle = { ...baseStyle, color: theme.colors.text, fontWeight: '600' };
                } else {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.contextText };
                }
                
                return (
                    <View 
                        key={index} 
                        style={{ 
                            backgroundColor, 
                            paddingHorizontal: 8, 
                            paddingVertical: 1,
                            borderLeftWidth: line.startsWith('+') && !line.startsWith('+++') ? 3 : 
                                           line.startsWith('-') && !line.startsWith('---') ? 3 : 0,
                            borderLeftColor: line.startsWith('+') && !line.startsWith('+++') ? theme.colors.diff.addedBorder : theme.colors.diff.removedBorder
                        }}
                    >
                        <Text style={lineStyle}>
                            {line || ' '}
                        </Text>
                    </View>
                );
            })}
        </View>
    );
};

export default function FileScreen() {

    const { theme } = useUnistyles();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const searchParams = useLocalSearchParams();
    const encodedPath = searchParams.path as string;
    // Base64url of the path's UTF-8 bytes; a raw path is accepted too, for links written by hand.
    const filePath = decodeFilePathParam(encodedPath ?? '');

    const [fileContent, setFileContent] = React.useState<FileContent | null>(null);
    const [diffContent, setDiffContent] = React.useState<string | null>(null);
    const [displayMode, setDisplayMode] = React.useState<'file' | 'diff'>('diff');
    const [isLoading, setIsLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [svgContent, setSvgContent] = React.useState<string | null>(null);
    /** Where the machine's copy landed on this device; the viewer draws from this file. */
    const [localUri, setLocalUri] = React.useState<string | null>(null);
    /**
     * The file's bytes, when there was no file system to put them on (web/Tauri). The viewer reads
     * characters and images from these directly.
     */
    const [localBytes, setLocalBytes] = React.useState<Uint8Array | null>(null);
    /** How far the download has got, when the machine sent a length to measure against. */
    const [progress, setProgress] = React.useState<{ written: number; total: number } | null>(null);
    const [isPreparing, setIsPreparing] = React.useState(false);
    /** Bumped by Retry; it is the effect's reason to run again. */
    const [reloadToken, setReloadToken] = React.useState(0);
    const { width: screenWidth } = useWindowDimensions();
    const fileName = filePath.split('/').pop() || filePath;

    // Determine file language from extension
    const getFileLanguage = React.useCallback((path: string): string | null => {
        const ext = path.split('.').pop()?.toLowerCase();
        switch (ext) {
            case 'js':
            case 'jsx':
                return 'javascript';
            case 'ts':
            case 'tsx':
                return 'typescript';
            case 'py':
                return 'python';
            case 'html':
            case 'htm':
                return 'html';
            case 'css':
                return 'css';
            case 'json':
                return 'json';
            case 'md':
                return 'markdown';
            case 'xml':
                return 'xml';
            case 'yaml':
            case 'yml':
                return 'yaml';
            case 'sh':
            case 'bash':
                return 'bash';
            case 'sql':
                return 'sql';
            case 'go':
                return 'go';
            case 'rust':
            case 'rs':
                return 'rust';
            case 'java':
                return 'java';
            case 'c':
                return 'c';
            case 'cpp':
            case 'cc':
            case 'cxx':
                return 'cpp';
            case 'php':
                return 'php';
            case 'rb':
                return 'ruby';
            case 'swift':
                return 'swift';
            case 'kt':
                return 'kotlin';
            default:
                return null;
        }
    }, []);

    // Check if file is likely binary based on extension
    const isBinaryFile = React.useCallback((path: string): boolean => {
        const ext = path.split('.').pop()?.toLowerCase();
        const binaryExtensions = [
            'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico',
            'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm',
            'mp3', 'wav', 'flac', 'aac', 'ogg',
            'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
            'zip', 'tar', 'gz', 'rar', '7z',
            'exe', 'dmg', 'deb', 'rpm',
            'woff', 'woff2', 'ttf', 'otf',
            'db', 'sqlite', 'sqlite3'
        ];
        return ext ? binaryExtensions.includes(ext) : false;
    }, []);

    // Check if file is an image (can be previewed)
    const isImageFile = React.useCallback((path: string): boolean => {
        const ext = path.split('.').pop()?.toLowerCase();
        const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg'];
        return ext ? imageExtensions.includes(ext) : false;
    }, []);

    // Load the file from the machine that owns it.
    //
    // One request for every type: the machine's own channel, which is where the bytes are and the
    // only route that reports how much of them has arrived. The response is written to a cache
    // file first, so the preview and the Download action share one copy.
    React.useEffect(() => {
        let isCancelled = false;

        const loadFile = async () => {
            setIsLoading(true);
            setError(null);
            setProgress(null);
            setLocalUri(null);
            setLocalBytes(null);
            setFileContent(null);
            setSvgContent(null);
            setDiffContent(null);

            // The diff is an optional second answer from the machine that holds the tree. It must
            // not hold up the file — and it no longer travels through the session's shell and the
            // server, which is what made the Diff tab slow to appear or never appear.
            if (sessionId && !isBinaryFile(filePath)) {
                void sync.getFileDiff(sessionId, filePath).then((diff) => {
                    if (!isCancelled && diff) {
                        setDiffContent(diff);
                    }
                }).catch((diffError) => {
                    console.log('Could not fetch git diff:', diffError);
                });
            }

            try {
                const download = await sync.downloadSessionFile(sessionId!, filePath, {
                    onProgress: (written, total) => {
                        if (!isCancelled) {
                            setProgress({ written, total });
                        }
                    },
                });
                if (isCancelled) {
                    return;
                }
                if (!download.ok) {
                    setError(download.error);
                    return;
                }
                // The bytes are the whole answer where there is no file system; there, a browser
                // URL is how the image branch draws them.
                if (download.bytes) {
                    setLocalBytes(download.bytes);
                    if (isImageFile(filePath)) {
                        setLocalUri(blobUrlFor(download.bytes, mimeTypeFor(filePath)));
                    }
                } else {
                    setLocalUri(download.uri ?? null);
                }
                // Opened, not merely named: the browser's "recent" row is about files that loaded.
                recordRecentFile({ sessionId: sessionId!, path: filePath });

                const ext = filePath.split('.').pop()?.toLowerCase();
                if (isImageFile(filePath)) {
                    if (ext === 'svg') {
                        // SVG is text; the webview needs the markup itself, not a file URL.
                        const svg = await readDownloadedText(download);
                        if (!isCancelled) setSvgContent(svg);
                    }
                    if (!isCancelled) {
                        setFileContent({ content: '', encoding: 'base64', isBinary: true });
                    }
                    return;
                }
                if (isBinaryFile(filePath)) {
                    if (!isCancelled) {
                        setFileContent({ content: '', encoding: 'base64', isBinary: true });
                    }
                    return;
                }

                // Text: the download is the transport, but the viewer needs the characters.
                const decodedContent = await readDownloadedText(download);
                if (isCancelled) {
                    return;
                }
                // Check if content contains binary data (null bytes or too many non-printable chars)
                const hasNullBytes = decodedContent.includes('\0');
                const nonPrintableCount = decodedContent.split('').filter(char => {
                    const code = char.charCodeAt(0);
                    return code < 32 && code !== 9 && code !== 10 && code !== 13; // Allow tab, LF, CR
                }).length;
                const isBinary = hasNullBytes || (nonPrintableCount / Math.max(1, decodedContent.length) > 0.1);
                setFileContent({
                    content: isBinary ? '' : decodedContent,
                    encoding: 'utf8',
                    isBinary,
                });
            } catch (loadError) {
                console.error('Failed to load file:', loadError);
                if (!isCancelled) {
                    setError(loadError instanceof Error ? loadError.message : 'Failed to load file');
                }
            } finally {
                if (!isCancelled) {
                    setIsLoading(false);
                }
            }
        };

        loadFile();

        return () => {
            isCancelled = true;
        };
    }, [sessionId, filePath, isBinaryFile, isImageFile, reloadToken]);

    // Set default display mode based on diff availability
    React.useEffect(() => {
        if (diffContent) {
            setDisplayMode('diff');
        } else if (fileContent) {
            setDisplayMode('file');
        }
    }, [diffContent, fileContent]);

    /**
     * Put the file on this device and open the system's own view of it.
     *
     * The preview above is this App drawing what it can; this is for everything it cannot draw —
     * a DOCX, a ZIP, a PDF on a platform whose viewer is not this viewer — and for keeping a copy.
     * The share sheet is the system's "open in" and "save to Files" in one action, so there is no
     * second file manager to maintain and no file-type table to keep complete.
     */
    const handleDownload = React.useCallback(async () => {
        if (!sessionId || !filePath || isPreparing) {
            return;
        }
        try {
            setIsPreparing(true);
            let uri = localUri;
            if (!uri) {
                const download = await sync.downloadSessionFile(sessionId, filePath);
                if (!download.ok) {
                    throw new Error(download.error);
                }
                uri = download.uri ?? (download.bytes ? blobUrlFor(download.bytes, mimeTypeFor(filePath)) : null);
                if (uri) {
                    setLocalUri(uri);
                }
            }
            if (!uri) {
                throw new Error('Failed to open file');
            }
            // The share sheet is a native contract. A browser saves the same bytes through an
            // anchor, which is the one "keep a copy" this platform has.
            const browser = Platform.OS === 'web'
                ? (globalThis as unknown as {
                    document?: { createElement: (tag: string) => { href: string; download: string; click: () => void } };
                }).document
                : undefined;
            if (browser) {
                const anchor = browser.createElement('a');
                anchor.href = uri;
                anchor.download = fileName;
                anchor.click();
                return;
            }
            await presentFile(uri, fileName);
        } catch (downloadError) {
            Modal.alert(
                t('common.error'),
                downloadError instanceof Error ? downloadError.message : 'Failed to open file',
            );
        } finally {
            setIsPreparing(false);
        }
    }, [sessionId, filePath, fileName, localUri, isPreparing]);

    const language = getFileLanguage(filePath);

    if (isLoading) {
        // A length the machine reported is the difference between "working" and "has it told us
        // anything?"; without one the spinner is the honest answer.
        const fraction = progress && progress.total > 0
            ? Math.min(1, progress.written / progress.total)
            : null;
        return (
            <View style={{
                flex: 1,
                backgroundColor: theme.colors.surface,
                justifyContent: 'center',
                alignItems: 'center',
                paddingHorizontal: 32,
            }}>
                {fraction === null
                    ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    : (
                        <View style={{
                            width: '100%',
                            maxWidth: 280,
                            height: 4,
                            borderRadius: 2,
                            backgroundColor: theme.colors.input.background,
                            overflow: 'hidden',
                        }}>
                            <View style={{
                                width: `${Math.round(fraction * 100)}%`,
                                height: '100%',
                                borderRadius: 2,
                                backgroundColor: theme.colors.textLink,
                            }} />
                        </View>
                    )}
                <Text style={{
                    marginTop: 16,
                    fontSize: 16,
                    color: theme.colors.textSecondary,
                    ...Typography.default()
                }}>
                    {t('files.loadingFile', { fileName })}
                </Text>
                {fraction !== null && (
                    <Text style={{
                        marginTop: 6,
                        fontSize: 13,
                        color: theme.colors.textSecondary,
                        ...Typography.default()
                    }}>
                        {`${formatBytes(progress!.written)} / ${formatBytes(progress!.total)}`}
                    </Text>
                )}
            </View>
        );
    }

    if (error) {
        return (
            <View style={{ 
                flex: 1, 
                backgroundColor: theme.colors.surface,
                justifyContent: 'center', 
                alignItems: 'center',
                padding: 20
            }}>
                <Text style={{ 
                    fontSize: 18, 
                    fontWeight: 'bold',
                    color: theme.colors.textDestructive,
                    marginBottom: 8,
                    ...Typography.default('semiBold')
                }}>
                    {t('common.error')}
                </Text>
                <Text style={{ 
                    fontSize: 16, 
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    ...Typography.default() 
                }}>
                    {error}
                </Text>
                <Pressable
                    onPress={() => setReloadToken((token) => token + 1)}
                    style={({ pressed }) => ({
                        marginTop: 20,
                        paddingHorizontal: 20,
                        paddingVertical: 10,
                        borderRadius: 10,
                        backgroundColor: theme.colors.input.background,
                        opacity: pressed ? 0.6 : 1,
                    })}
                >
                    <Text style={{
                        fontSize: 15,
                        color: theme.colors.textLink,
                        ...Typography.default('semiBold'),
                    }}>
                        {t('common.retry')}
                    </Text>
                </Pressable>
            </View>
        );
    }

    if (fileContent?.isBinary) {
        let preview: React.ReactNode;
        // SVG preview
        if (svgContent) {
            const svgHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>html,body{margin:0;padding:16px;background:${theme.colors.surface};display:flex;justify-content:center;align-items:center;}svg{max-width:100%!important;height:auto!important;}</style>
</head><body>${svgContent}</body></html>`;
            // Web: use dangerouslySetInnerHTML directly (no WebView needed)
            preview = Platform.OS === 'web' ? (
                <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
                    {/* @ts-ignore */}
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
                        dangerouslySetInnerHTML={{ __html: svgContent }} />
                </View>
            ) : (
                <NativeFileSvgView svgHtml={svgHtml} themeBg={theme.colors.surface} />
            );
        } else if (isImageFile(filePath) && localUri) {
            // Image preview, straight from the downloaded file — no base64 copy in JS memory.
            const imageWidth = Math.min(screenWidth - 32, 600);
            preview = (
                <ScrollView
                    style={{ flex: 1 }}
                    contentContainerStyle={{
                        justifyContent: 'center',
                        alignItems: 'center',
                        padding: 16,
                    }}
                    maximumZoomScale={3}
                    minimumZoomScale={1}
                >
                    <Image
                        source={{ uri: localUri }}
                        style={{
                            width: imageWidth,
                            height: imageWidth, // aspect ratio from image metadata would be better
                            resizeMode: 'contain',
                        }}
                    />
                </ScrollView>
            );
        } else if (isPdfFile(filePath) && localUri) {
            // Only WKWebView renders a PDF itself; elsewhere the Download action is the way in.
            preview = Platform.OS === 'ios'
                ? <NativeFilePdfView uri={localUri} themeBg={theme.colors.surface} />
                : (
                    <View style={styles.binaryMessage}>
                        <Text style={{
                            fontSize: 18,
                            fontWeight: 'bold',
                            color: theme.colors.textSecondary,
                            marginBottom: 8,
                            ...Typography.default('semiBold')
                        }}>
                            {t('files.binaryFile')}
                        </Text>
                        <Text style={{
                            fontSize: 14,
                            color: '#999',
                            textAlign: 'center',
                            marginTop: 8,
                            ...Typography.default()
                        }}>
                            {fileName}
                        </Text>
                    </View>
                );
        } else {
            preview = (
                <View style={styles.binaryMessage}>
                    <Text style={{
                        fontSize: 18,
                        fontWeight: 'bold',
                        color: theme.colors.textSecondary,
                        marginBottom: 8,
                        ...Typography.default('semiBold')
                    }}>
                        {t('files.binaryFile')}
                    </Text>
                    <Text style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        textAlign: 'center',
                        ...Typography.default()
                    }}>
                        {t('files.cannotDisplayBinary')}
                    </Text>
                    <Text style={{
                        fontSize: 14,
                        color: '#999',
                        textAlign: 'center',
                        marginTop: 8,
                        ...Typography.default()
                    }}>
                        {fileName}
                    </Text>
                </View>
            );
        }

        return (
            <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
                <FileScreenHeader
                    filePath={filePath}
                    fileName={fileName}
                    busy={isPreparing}
                    onOpen={handleDownload}
                />
                {preview}
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            
            {/* File path header */}
            <View style={{
                padding: 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider,
                backgroundColor: theme.colors.surfaceHigh,
                flexDirection: 'row',
                alignItems: 'center'
            }}>
                <FileIcon fileName={fileName} size={20} />
                <Text style={{
                    fontSize: 14,
                    color: theme.colors.textSecondary,
                    marginLeft: 8,
                    flex: 1,
                    ...Typography.mono()
                }}>
                    {filePath}
                </Text>
            </View>

            {/* Toggle buttons for File/Diff view */}
            {diffContent && (
                <View style={{
                    flexDirection: 'row',
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider,
                    backgroundColor: theme.colors.surface
                }}>
                    <Pressable
                        onPress={() => setDisplayMode('diff')}
                        style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            borderRadius: 8,
                            backgroundColor: displayMode === 'diff' ? theme.colors.textLink : theme.colors.input.background,
                            marginRight: 8
                        }}
                    >
                        <Text style={{
                            fontSize: 14,
                            fontWeight: '600',
                            color: displayMode === 'diff' ? 'white' : theme.colors.textSecondary,
                            ...Typography.default()
                        }}>
                            {t('files.diff')}
                        </Text>
                    </Pressable>
                    
                    <Pressable
                        onPress={() => setDisplayMode('file')}
                        style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            borderRadius: 8,
                            backgroundColor: displayMode === 'file' ? theme.colors.textLink : theme.colors.input.background
                        }}
                    >
                        <Text style={{
                            fontSize: 14,
                            fontWeight: '600',
                            color: displayMode === 'file' ? 'white' : theme.colors.textSecondary,
                            ...Typography.default()
                        }}>
                            {t('files.file')}
                        </Text>
                    </Pressable>
                </View>
            )}
            
            {/* Content display */}
            <ScrollView 
                style={{ flex: 1 }}
                contentContainerStyle={{ padding: 16 }}
                showsVerticalScrollIndicator={true}
            >
                {displayMode === 'diff' && diffContent ? (
                    <DiffDisplay diffContent={diffContent} />
                ) : displayMode === 'file' && fileContent?.content ? (
                    <SimpleSyntaxHighlighter 
                        code={fileContent.content}
                        language={language}
                        selectable={true}
                    />
                ) : displayMode === 'file' && fileContent && !fileContent.content ? (
                    <Text style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        fontStyle: 'italic',
                        ...Typography.default()
                    }}>
                        {t('files.fileEmpty')}
                    </Text>
                ) : !diffContent && !fileContent?.content ? (
                    <Text style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        fontStyle: 'italic',
                        ...Typography.default()
                    }}>
                        {t('files.noChanges')}
                    </Text>
                ) : null}
            </ScrollView>
        </View>
    );
}

/**
 * The bar binary previews share: what the file is, and the one action that gets it off the machine.
 *
 * The text view already has this header and its own Diff/File toggle; the previews that fill the
 * screen had none, so a file the App could not draw was also a file it offered no way to open.
 */
const FileScreenHeader = React.memo(({ filePath, fileName, busy, onOpen }: {
    filePath: string;
    fileName: string;
    busy: boolean;
    onOpen: () => void;
}) => {
    const { theme } = useUnistyles();
    return (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
            borderBottomColor: theme.colors.divider,
            backgroundColor: theme.colors.surfaceHigh,
        }}>
            <FileIcon fileName={fileName} size={20} />
            <Text numberOfLines={1} style={{
                flex: 1,
                marginLeft: 8,
                fontSize: 13,
                color: theme.colors.textSecondary,
                ...Typography.mono(),
            }}>
                {filePath}
            </Text>
            <Pressable
                onPress={onOpen}
                disabled={busy}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('files.download')}
                style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginLeft: 12,
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 8,
                    backgroundColor: theme.colors.input.background,
                    opacity: busy ? 0.5 : pressed ? 0.6 : 1,
                })}
            >
                {busy
                    ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    : <Ionicons name="download-outline" size={16} color={theme.colors.textLink} />}
                <Text style={{
                    marginLeft: 6,
                    fontSize: 13,
                    color: theme.colors.textLink,
                    ...Typography.default('semiBold'),
                }}>
                    {t('files.download')}
                </Text>
            </Pressable>
        </View>
    );
});

/**
 * A PDF the viewer draws itself, on the platform whose webview can.
 *
 * A local file, because the bytes came over the session's `readFile` RPC and never had a URL of
 * their own. iOS renders it in place; other platforms have no equivalent, and there the header's
 * Download hands the file to whatever the device uses instead.
 */
function NativeFilePdfView({ uri, themeBg }: { uri: string; themeBg: string }) {
    const [WebViewComp, setWebViewComp] = React.useState<any>(null);
    React.useEffect(() => { import('react-native-webview').then(m => setWebViewComp(() => m.WebView)); }, []);
    const directory = uri.slice(0, uri.lastIndexOf('/') + 1);
    return (
        <View style={{ flex: 1, backgroundColor: themeBg }}>
            {WebViewComp
                ? <WebViewComp
                    source={{ uri }}
                    style={{ flex: 1, backgroundColor: themeBg }}
                    originWhitelist={['*']}
                    allowFileAccess={true}
                    allowingReadAccessToURL={directory}
                    scrollEnabled={true}
                />
                : <ActivityIndicator size="small" color="#999" style={{ marginTop: 24 }} />}
        </View>
    );
}

// Dynamic WebView wrapper (unsupported on Linux/Tauri)
function NativeFileSvgView({ svgHtml, themeBg }: { svgHtml: string; themeBg: string }) {
    const [WebViewComp, setWebViewComp] = React.useState<any>(null);
    React.useEffect(() => { import('react-native-webview').then(m => setWebViewComp(() => m.WebView)); }, []);
    return (
        <View style={{ flex: 1, backgroundColor: themeBg }}>
            {WebViewComp
                ? <WebViewComp source={{ html: svgHtml }} style={{ flex: 1, backgroundColor: themeBg }} scrollEnabled={true} />
                : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
    /** What a preview shows when it has nothing to draw — centred under the shared header. */
    binaryMessage: {
        flex: 1,
        backgroundColor: theme.colors.surface,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
}));
