import * as React from 'react';
import { View, ActivityIndicator, Platform, Pressable, ScrollView, TextInput } from 'react-native';
import { t } from '@/text';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { Octicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { GitFileStatus, GitStatusFiles } from '@/sync/gitStatusFiles';
import { searchFiles, loadFileIndex, FileItem } from '@/sync/suggestionFile';
import { sync } from '@/sync/sync';
import { useRecentFiles } from '@/sync/recentFiles';
import { encodeFilePathParam } from '@/utils/filePathParam';
import { useSessionGitStatus, useSessionProjectGitStatus } from '@/sync/storage';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { FileIcon } from '@/components/FileIcon';
import { Modal } from '@/modal';

export default function FilesScreen() {
    const router = useRouter();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();

    const [gitStatusFiles, setGitStatusFiles] = React.useState<GitStatusFiles | null>(null);
    const [isLoading, setIsLoading] = React.useState(true);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [searchResults, setSearchResults] = React.useState<FileItem[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    /** The whole tree, flat; the browser slices it by directory. */
    const [fileIndex, setFileIndex] = React.useState<FileItem[]>([]);
    const [indexLoading, setIndexLoading] = React.useState(true);
    /** Where the browser is; '' is the session's working tree root. */
    const [currentPath, setCurrentPath] = React.useState('');
    /** The folder whose archive is being fetched, if one is. */
    const [downloadingFolder, setDownloadingFolder] = React.useState<string | null>(null);
    // Use project git status first, fallback to session git status for backward compatibility
    const projectGitStatus = useSessionProjectGitStatus(sessionId);
    const sessionGitStatus = useSessionGitStatus(sessionId);
    const gitStatus = projectGitStatus || sessionGitStatus;
    const { theme } = useUnistyles();
    
    // Load git status files
    const loadGitStatusFiles = React.useCallback(async () => {
        try {
            setIsLoading(true);
            const result = await sync.getGitStatusFiles(sessionId);
            setGitStatusFiles(result);
        } catch (error) {
            console.error('Failed to load git status files:', error);
            setGitStatusFiles(null);
        } finally {
            setIsLoading(false);
        }
    }, [sessionId]);

    // Load on mount
    React.useEffect(() => {
        setCurrentPath('');
    }, [sessionId]);

    React.useEffect(() => {
        loadGitStatusFiles();
    }, [loadGitStatusFiles]);

    /**
     * The whole tree, loaded once per visit (the cache behind it survives five minutes).
     *
     * The browser slices this by directory instead of rendering all of it: a repository with a
     * few thousand files is not a list, and the flat version of it was one endless scroll.
     */
    const loadIndex = React.useCallback(async () => {
        if (!sessionId) {
            return;
        }
        try {
            setIndexLoading(true);
            const items = await loadFileIndex(sessionId);
            setFileIndex(items);
        } catch (error) {
            console.error('Failed to load the file index:', error);
            setFileIndex([]);
        } finally {
            setIndexLoading(false);
        }
    }, [sessionId]);

    React.useEffect(() => {
        loadIndex();
    }, [loadIndex]);

    // Refresh when screen is focused
    useFocusEffect(
        React.useCallback(() => {
            loadGitStatusFiles();
            loadIndex();
        }, [loadGitStatusFiles, loadIndex])
    );

    /**
     * Search across the whole tree, but only when there is something to search for.
     *
     * An empty query is the browser's job now: fuzzy search over everything was how the screen
     * showed the entire project at once, which is the scroll this replaced.
     */
    React.useEffect(() => {
        if (!sessionId || !searchQuery.trim()) {
            setSearchResults([]);
            setIsSearching(false);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                setIsSearching(true);
                const results = await searchFiles(sessionId, searchQuery, { limit: 100 });
                if (!cancelled) {
                    setSearchResults(results);
                }
            } catch (error) {
                console.error('Failed to search files:', error);
                if (!cancelled) {
                    setSearchResults([]);
                }
            } finally {
                if (!cancelled) {
                    setIsSearching(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [searchQuery, sessionId]);

    const openFile = React.useCallback((fullPath: string) => {
        router.push(`/session/${sessionId}/file?path=${encodeFilePathParam(fullPath)}`);
    }, [router, sessionId]);

    const handleFilePress = React.useCallback((file: GitFileStatus | FileItem) => {
        openFile(file.fullPath);
    }, [openFile]);

    /**
     * The files opened from this session, newest first — "where was I" beside the tree's
     * "where is everything". Recorded by the viewer when a file actually loads.
     */
    const recentFiles = useRecentFiles();
    const sessionRecents = React.useMemo(
        () => recentFiles.filter((file) => file.sessionId === sessionId).slice(0, 8),
        [recentFiles, sessionId],
    );

    /** Every changed path, for the per-file marker and the per-directory totals. */
    const changedFiles = React.useMemo(() => {
        const map = new Map<string, GitFileStatus>();
        for (const file of gitStatusFiles?.unstagedFiles ?? []) {
            map.set(file.fullPath, file);
        }
        for (const file of gitStatusFiles?.stagedFiles ?? []) {
            if (!map.has(file.fullPath)) {
                map.set(file.fullPath, file);
            }
        }
        return map;
    }, [gitStatusFiles]);

    /**
     * How many changed files sit under each directory, itself included — what a folder's badge
     * counts. Recursive on purpose: the question "is there anything in here worth opening" is
     * about the subtree, not the immediate children.
     */
    const changeCounts = React.useMemo(() => {
        const counts = new Map<string, number>();
        for (const path of changedFiles.keys()) {
            let dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
            for (;;) {
                counts.set(dir, (counts.get(dir) ?? 0) + 1);
                if (!dir) break;
                dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
            }
        }
        return counts;
    }, [changedFiles]);

    /** The current directory's entries: folders first, then files, each by name. */
    const browserEntries = React.useMemo(() => {
        const prefix = currentPath ? currentPath + '/' : '';
        return fileIndex
            .filter((item) => item.filePath === prefix)
            .sort((a, b) => {
                if (a.fileType !== b.fileType) {
                    return a.fileType === 'folder' ? -1 : 1;
                }
                return a.fileName.localeCompare(b.fileName);
            });
    }, [fileIndex, currentPath]);

    const openFolder = React.useCallback((folderPath: string) => {
        setCurrentPath(folderPath.replace(/\/$/, ''));
    }, []);

    const goUp = React.useCallback(() => {
        setCurrentPath((path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''));
    }, []);

    /**
     * Save a packed directory where this device keeps downloads.
     *
     * A browser has no file system to write into; an anchor is its "save as". Native has the
     * archive on disk already and hands it to the share sheet, the same way the file viewer does.
     */
    const saveArchive = React.useCallback(async (name: string, uri: string | null, bytes: Uint8Array | null) => {
        if (Platform.OS === 'web') {
            const browser = (globalThis as unknown as {
                document?: { createElement: (tag: string) => { href: string; download: string; click: () => void } };
            }).document;
            const href = uri ?? (bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/gzip' })) : null);
            if (!browser || !href) {
                throw new Error('This device has no way to save the folder');
            }
            const anchor = browser.createElement('a');
            anchor.href = href;
            anchor.download = name;
            anchor.click();
            return;
        }
        if (!uri) {
            throw new Error('This device has no way to save the folder');
        }
        const Sharing = await import('expo-sharing');
        if (!(await Sharing.isAvailableAsync())) {
            throw new Error('This device has no way to save the folder');
        }
        await Sharing.shareAsync(uri, { mimeType: 'application/gzip', dialogTitle: name });
    }, []);

    const downloadFolder = React.useCallback(async (folder: FileItem) => {
        const path = folder.fullPath.replace(/\/$/, '');
        if (!sessionId || downloadingFolder) {
            return;
        }
        try {
            setDownloadingFolder(path);
            const download = await sync.downloadSessionFolder(sessionId, path);
            if (!download.ok) {
                throw new Error(download.error);
            }
            await saveArchive(download.name, download.uri ?? null, download.bytes ?? null);
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : 'Failed to download folder');
        } finally {
            setDownloadingFolder(null);
        }
    }, [sessionId, downloadingFolder, saveArchive]);

    const renderFileIcon = (file: GitFileStatus) => {
        return <FileIcon fileName={file.fileName} size={32} />;
    };

    const renderStatusIcon = (file: GitFileStatus) => {
        let statusColor: string;
        let statusIcon: string;

        switch (file.status) {
            case 'modified':
                statusColor = "#FF9500";
                statusIcon = "diff-modified";
                break;
            case 'added':
                statusColor = "#34C759";
                statusIcon = "diff-added";
                break;
            case 'deleted':
                statusColor = "#FF3B30";
                statusIcon = "diff-removed";
                break;
            case 'renamed':
                statusColor = "#007AFF";
                statusIcon = "arrow-right";
                break;
            case 'untracked':
                statusColor = theme.dark ? "#b0b0b0" : "#8E8E93";
                statusIcon = "file";
                break;
            default:
                return null;
        }

        return <Octicons name={statusIcon as any} size={16} color={statusColor} />;
    };

    const renderLineChanges = (file: GitFileStatus) => {
        const parts = [];
        if (file.linesAdded > 0) {
            parts.push(`+${file.linesAdded}`);
        }
        if (file.linesRemoved > 0) {
            parts.push(`-${file.linesRemoved}`);
        }
        return parts.length > 0 ? parts.join(' ') : '';
    };

    const renderFileSubtitle = (file: GitFileStatus) => {
        const lineChanges = renderLineChanges(file);
        const pathPart = file.filePath || t('files.projectRoot');
        return lineChanges ? `${pathPart} • ${lineChanges}` : pathPart;
    };

    const renderFileIconForSearch = (file: FileItem) => {
        if (file.fileType === 'folder') {
            return <Octicons name="file-directory" size={29} color="#007AFF" />;
        }
        
        return <FileIcon fileName={file.fileName} size={29} />;
    };

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            
            {/* Search Input - Always Visible */}
            <View style={{
                padding: 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider
            }}>
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: theme.colors.input.background,
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 8
                }}>
                    <Octicons name="search" size={16} color={theme.colors.textSecondary} style={{ marginRight: 8 }} />
                    <TextInput
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        placeholder={t('files.searchPlaceholder')}
                        style={{
                            flex: 1,
                            fontSize: 16,
                            ...Typography.default()
                        }}
                        placeholderTextColor={theme.colors.input.placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                </View>
            </View>
            
            {/* Header with branch info */}
            {!isLoading && gitStatusFiles && (
                <View style={{
                    padding: 16,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider
                }}>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        marginBottom: 8
                    }}>
                        <Octicons name="git-branch" size={16} color={theme.colors.textSecondary} style={{ marginRight: 6 }} />
                        <Text style={{
                            fontSize: 16,
                            fontWeight: '600',
                            color: theme.colors.text,
                            ...Typography.default()
                        }}>
                            {gitStatusFiles.branch || t('files.detachedHead')}
                        </Text>
                    </View>
                    <Text style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        ...Typography.default()
                    }}>
                        {t('files.summary', { staged: gitStatusFiles.totalStaged, unstaged: gitStatusFiles.totalUnstaged })}
                    </Text>
                </View>
            )}

            {/* Git Status List */}
            <ItemList style={{ flex: 1 }}>
                {isLoading ? (
                    <View style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        paddingTop: 40
                    }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : searchQuery ? (
                    /* A query is the one mode that spans the whole tree; the browser below shows
                       one directory at a time. */
                    isSearching ? (
                        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40 }}>
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            <Text style={{
                                fontSize: 16,
                                color: theme.colors.textSecondary,
                                textAlign: 'center',
                                marginTop: 16,
                                ...Typography.default()
                            }}>
                                {t('files.searching')}
                            </Text>
                        </View>
                    ) : searchResults.length === 0 ? (
                        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40, paddingHorizontal: 20 }}>
                            <Octicons name="search" size={48} color={theme.colors.textSecondary} />
                            <Text style={{
                                fontSize: 16,
                                color: theme.colors.textSecondary,
                                textAlign: 'center',
                                marginTop: 16,
                                ...Typography.default()
                            }}>
                                {t('files.noFilesFound')}
                            </Text>
                            <Text style={{
                                fontSize: 14,
                                color: theme.colors.textSecondary,
                                textAlign: 'center',
                                marginTop: 8,
                                ...Typography.default()
                            }}>
                                {t('files.tryDifferentTerm')}
                            </Text>
                        </View>
                    ) : (
                        <>
                            <SectionLabel
                                color={theme.colors.textLink}
                                text={t('files.searchResults', { count: searchResults.length })}
                            />
                            {searchResults.map((file, index) => (
                                <Item
                                    key={`file-${file.fullPath}-${index}`}
                                    title={file.fileName}
                                    subtitle={file.filePath || t('files.projectRoot')}
                                    icon={renderFileIconForSearch(file)}
                                    onPress={() => handleFilePress(file)}
                                    showDivider={index < searchResults.length - 1}
                                />
                            ))}
                        </>
                    )
                ) : (
                    <>
                        {/* Where the reader was. Root only: once inside a folder, the tree is what
                            the screen is for. */}
                        {!currentPath && sessionRecents.length > 0 && (
                            <>
                                <SectionLabel color={theme.colors.textSecondary} text={t('files.recentFiles')} />
                                {sessionRecents.map((file, index) => (
                                    <Item
                                        key={`recent-${file.path}`}
                                        title={file.name}
                                        subtitle={file.path}
                                        icon={<FileIcon fileName={file.name} size={29} />}
                                        onPress={() => openFile(file.path)}
                                        showDivider={index < sessionRecents.length - 1}
                                    />
                                ))}
                            </>
                        )}

                        {/* Not a repository is a fact about git, not about the files: the browser
                            below still lists the working tree. */}
                        {!gitStatusFiles && (
                            <View style={{
                                paddingHorizontal: 16,
                                paddingVertical: 12,
                                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                                borderBottomColor: theme.colors.divider
                            }}>
                                <Text style={{
                                    fontSize: 13,
                                    color: theme.colors.textSecondary,
                                    ...Typography.default()
                                }}>
                                    {t('files.notUnderGit')}
                                </Text>
                            </View>
                        )}

                        {/* Changes first, but never instead of the tree — and only at the root; a
                            folder shows its own count in the browser. */}
                        {!currentPath && gitStatusFiles && gitStatusFiles.stagedFiles.length > 0 && (
                            <>
                                <SectionLabel
                                    color={theme.colors.success}
                                    text={t('files.stagedChanges', { count: gitStatusFiles.stagedFiles.length })}
                                />
                                {gitStatusFiles.stagedFiles.map((file, index) => (
                                    <Item
                                        key={`staged-${file.fullPath}-${index}`}
                                        title={file.fileName}
                                        subtitle={renderFileSubtitle(file)}
                                        icon={renderFileIcon(file)}
                                        rightElement={renderStatusIcon(file)}
                                        onPress={() => handleFilePress(file)}
                                        showDivider={index < gitStatusFiles.stagedFiles.length - 1}
                                    />
                                ))}
                            </>
                        )}

                        {!currentPath && gitStatusFiles && gitStatusFiles.unstagedFiles.length > 0 && (
                            <>
                                <SectionLabel
                                    color={theme.colors.warning}
                                    text={t('files.unstagedChanges', { count: gitStatusFiles.unstagedFiles.length })}
                                />
                                {gitStatusFiles.unstagedFiles.map((file, index) => (
                                    <Item
                                        key={`unstaged-${file.fullPath}-${index}`}
                                        title={file.fileName}
                                        subtitle={renderFileSubtitle(file)}
                                        icon={renderFileIcon(file)}
                                        rightElement={renderStatusIcon(file)}
                                        onPress={() => handleFilePress(file)}
                                        showDivider={index < gitStatusFiles.unstagedFiles.length - 1}
                                    />
                                ))}
                            </>
                        )}

                        <Breadcrumbs path={currentPath} onNavigate={setCurrentPath} onUp={goUp} />

                        {indexLoading ? (
                            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40 }}>
                                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            </View>
                        ) : browserEntries.length === 0 ? (
                            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40, paddingHorizontal: 20 }}>
                                <Octicons name="file-directory" size={48} color={theme.colors.textSecondary} />
                                <Text style={{
                                    fontSize: 16,
                                    color: theme.colors.textSecondary,
                                    textAlign: 'center',
                                    marginTop: 16,
                                    ...Typography.default()
                                }}>
                                    {currentPath ? t('files.noFilesFound') : t('files.noFilesInProject')}
                                </Text>
                            </View>
                        ) : (
                            <>
                                {currentPath ? (
                                    <Item
                                        title=".."
                                        subtitle={currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : t('files.projectRoot')}
                                        icon={<Octicons name="chevron-left" size={29} color={theme.colors.textSecondary} />}
                                        onPress={goUp}
                                        showDivider={true}
                                    />
                                ) : null}
                                {browserEntries.map((entry, index) => {
                                    if (entry.fileType === 'folder') {
                                        const entryPath = entry.fullPath.replace(/\/$/, '');
                                        const changes = changeCounts.get(entryPath) ?? 0;
                                        return (
                                            <Item
                                                key={`dir-${entry.fullPath}`}
                                                title={entry.fileName}
                                                subtitle={entry.filePath ? entry.filePath.replace(/\/$/, '') : t('files.projectRoot')}
                                                icon={<Octicons name="file-directory" size={29} color="#007AFF" />}
                                                rightElement={(
                                                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                                        {changes > 0 && (
                                                            <View style={styles.changeBadge}>
                                                                <Text style={styles.changeBadgeText}>{changes > 99 ? '99+' : String(changes)}</Text>
                                                            </View>
                                                        )}
                                                        <Pressable
                                                            onPress={(event) => {
                                                                // The row opens the folder; this button downloads it.
                                                                // On web the click would otherwise bubble into the row.
                                                                event.stopPropagation?.();
                                                                downloadFolder(entry);
                                                            }}
                                                            disabled={downloadingFolder !== null}
                                                            hitSlop={8}
                                                            accessibilityRole="button"
                                                            accessibilityLabel={t('files.download')}
                                                            style={{ marginLeft: 12 }}
                                                        >
                                                            {downloadingFolder === entryPath
                                                                ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                                                : <Octicons name="download" size={16} color={theme.colors.textLink} />}
                                                        </Pressable>
                                                    </View>
                                                )}
                                                onPress={() => openFolder(entry.fullPath)}
                                                showDivider={index < browserEntries.length - 1}
                                            />
                                        );
                                    }
                                    const status = changedFiles.get(entry.fullPath);
                                    return (
                                        <Item
                                            key={`entry-${entry.fullPath}`}
                                            title={entry.fileName}
                                            subtitle={entry.filePath ? entry.filePath.replace(/\/$/, '') : t('files.projectRoot')}
                                            icon={<FileIcon fileName={entry.fileName} size={29} />}
                                            rightElement={status ? renderStatusIcon(status) : undefined}
                                            onPress={() => handleFilePress(entry)}
                                            showDivider={index < browserEntries.length - 1}
                                        />
                                    );
                                })}
                            </>
                        )}
                    </>
                )}
            </ItemList>
        </View>
    );
}

/** One section heading in the file list: changes, search results, or the tree itself. */
const SectionLabel = React.memo(({ text, color }: { text: string; color: string }) => {
    const { theme } = useUnistyles();
    return (
        <View style={{
            backgroundColor: theme.colors.surfaceHigh,
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
            borderBottomColor: theme.colors.divider,
        }}>
            <Text style={{
                fontSize: 14,
                fontWeight: '600',
                color,
                ...Typography.default(),
            }}>
                {text}
            </Text>
        </View>
    );
});

/**
 * Where the browser is, and the way back out of it.
 *
 * A path, not a title: every segment is a place one tap away, which is what makes a deep folder
 * one glance away from the root instead of a stack of backs.
 */
const Breadcrumbs = React.memo(({ path, onNavigate, onUp }: {
    path: string;
    onNavigate: (path: string) => void;
    onUp: () => void;
}) => {
    const { theme } = useUnistyles();
    const segments = path ? path.split('/') : [];
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
            {path ? (
                <Pressable onPress={onUp} hitSlop={8} style={{ marginRight: 8 }}>
                    <Octicons name="chevron-left" size={16} color={theme.colors.textSecondary} />
                </Pressable>
            ) : null}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center' }}>
                <Pressable onPress={() => onNavigate('')} hitSlop={6}>
                    <Text style={{
                        fontSize: 14,
                        fontWeight: '600',
                        color: path ? theme.colors.textSecondary : theme.colors.text,
                        ...Typography.default(),
                    }}>
                        {t('files.projectRoot')}
                    </Text>
                </Pressable>
                {segments.map((segment, index) => {
                    const target = segments.slice(0, index + 1).join('/');
                    const last = index === segments.length - 1;
                    return (
                        <React.Fragment key={target}>
                            <Text style={{
                                marginHorizontal: 6,
                                color: theme.colors.textSecondary,
                                ...Typography.default(),
                            }}>
                                /
                            </Text>
                            <Pressable onPress={() => onNavigate(target)} hitSlop={6} disabled={last}>
                                <Text style={{
                                    fontSize: 14,
                                    fontWeight: last ? '600' : '400',
                                    color: last ? theme.colors.text : theme.colors.textSecondary,
                                    ...Typography.default(),
                                }}>
                                    {segment}
                                </Text>
                            </Pressable>
                        </React.Fragment>
                    );
                })}
            </ScrollView>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
    /** How many changed files sit under a folder — a count, no words to translate. */
    changeBadge: {
        minWidth: 20,
        height: 20,
        borderRadius: 10,
        paddingHorizontal: 6,
        backgroundColor: theme.colors.warning,
        alignItems: 'center',
        justifyContent: 'center',
    },
    changeBadgeText: {
        color: '#fff',
        fontSize: 11,
        fontWeight: '600',
    },
}));
