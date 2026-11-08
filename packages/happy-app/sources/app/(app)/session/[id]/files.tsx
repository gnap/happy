import * as React from 'react';
import { View, ActivityIndicator, Platform, TextInput } from 'react-native';
import { t } from '@/text';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { Octicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { GitFileStatus, GitStatusFiles } from '@/sync/gitStatusFiles';
import { searchFiles, FileItem } from '@/sync/suggestionFile';
import { sync } from '@/sync/sync';
import { useRecentFiles } from '@/sync/recentFiles';
import { encodeFilePathParam } from '@/utils/filePathParam';
import { useSessionGitStatus, useSessionProjectGitStatus } from '@/sync/storage';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { FileIcon } from '@/components/FileIcon';

export default function FilesScreen() {
    const router = useRouter();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    
    const [gitStatusFiles, setGitStatusFiles] = React.useState<GitStatusFiles | null>(null);
    const [isLoading, setIsLoading] = React.useState(true);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [searchResults, setSearchResults] = React.useState<FileItem[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
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
        loadGitStatusFiles();
    }, [loadGitStatusFiles]);

    // Refresh when screen is focused
    useFocusEffect(
        React.useCallback(() => {
            loadGitStatusFiles();
        }, [loadGitStatusFiles])
    );

    /**
     * The file index, fetched whatever the git state is.
     *
     * This is the browser; the changes above it are a view of the same tree, not a replacement
     * for it. The index used to load only when the repository was clean, so one modified file
     * hid every other file in the project — the "where did my files go" state.
     */
    React.useEffect(() => {
        if (!sessionId || isLoading) {
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
    }, [searchQuery, sessionId, isLoading]);

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
                ) : (
                    <>
                        {/* Where the reader was, before where everything is. */}
                        {!searchQuery && sessionRecents.length > 0 && (
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

                        {/* Changes first, but never instead of the tree. */}
                        {!searchQuery && gitStatusFiles && gitStatusFiles.stagedFiles.length > 0 && (
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

                        {!searchQuery && gitStatusFiles && gitStatusFiles.unstagedFiles.length > 0 && (
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

                        {isSearching ? (
                            <View style={{ 
                                flex: 1, 
                                justifyContent: 'center', 
                                alignItems: 'center',
                                paddingTop: 40
                            }}>
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
                            <View style={{ 
                                flex: 1, 
                                justifyContent: 'center', 
                                alignItems: 'center',
                                paddingTop: 40,
                                paddingHorizontal: 20
                            }}>
                                <Octicons name={searchQuery ? "search" : "file-directory"} size={48} color={theme.colors.textSecondary} />
                                <Text style={{
                                    fontSize: 16,
                                    color: theme.colors.textSecondary,
                                    textAlign: 'center',
                                    marginTop: 16,
                                    ...Typography.default()
                                }}>
                                    {searchQuery ? t('files.noFilesFound') : t('files.noFilesInProject')}
                                </Text>
                                {searchQuery && (
                                    <Text style={{
                                        fontSize: 14,
                                        color: theme.colors.textSecondary,
                                        textAlign: 'center',
                                        marginTop: 8,
                                        ...Typography.default()
                                    }}>
                                        {t('files.tryDifferentTerm')}
                                    </Text>
                                )}
                            </View>
                        ) : (
                            <>
                                <SectionLabel
                                    color={searchQuery ? theme.colors.textLink : theme.colors.textSecondary}
                                    text={searchQuery
                                        ? t('files.searchResults', { count: searchResults.length })
                                        : t('files.allFiles')}
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

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    }
}));
