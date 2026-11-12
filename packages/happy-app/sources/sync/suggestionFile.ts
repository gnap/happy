/**
 * Suggestion file search functionality using ripgrep for fast file discovery
 * Provides fuzzy search capabilities with in-memory caching for autocomplete suggestions
 */

import Fuse from 'fuse.js';
import { sessionRipgrep } from './ops';
import { sync } from './sync';
import { AsyncLock } from '@/utils/lock';

export interface FileItem {
    fileName: string;
    filePath: string;
    fullPath: string;
    fileType: 'file' | 'folder';
}

interface SearchOptions {
    limit?: number;
    threshold?: number;
}

interface SessionCache {
    files: FileItem[];
    fuse: Fuse<FileItem> | null;
    lastRefresh: number;
    refreshLock: AsyncLock;
}

class FileSearchCache {
    private sessions = new Map<string, SessionCache>();
    private cacheTimeout = 5 * 60 * 1000; // 5 minutes

    private getOrCreateSessionCache(sessionId: string): SessionCache {
        let cache = this.sessions.get(sessionId);
        if (!cache) {
            cache = {
                files: [],
                fuse: null,
                lastRefresh: 0,
                refreshLock: new AsyncLock()
            };
            this.sessions.set(sessionId, cache);
        }
        return cache;
    }

    private initializeFuse(cache: SessionCache) {
        if (cache.files.length === 0) {
            cache.fuse = null;
            return;
        }

        const fuseOptions = {
            keys: [
                { name: 'fileName', weight: 0.7 },  // Higher weight for file/directory name
                { name: 'fullPath', weight: 0.3 }   // Lower weight for full path
            ],
            threshold: 0.3,
            includeScore: true,
            shouldSort: true,
            minMatchCharLength: 1,
            ignoreLocation: true,
            useExtendedSearch: true,
            // Allow fuzzy matching on slashes for directories
            distance: 100
        };

        cache.fuse = new Fuse(cache.files, fuseOptions);
    }

    private async ensureCacheValid(sessionId: string): Promise<void> {
        const cache = this.getOrCreateSessionCache(sessionId);
        const now = Date.now();
        
        // Check if cache needs refresh
        if (now - cache.lastRefresh <= this.cacheTimeout && cache.files.length > 0) {
            return; // Cache is still valid
        }

        // Use lock to prevent concurrent refreshes for this session
        await cache.refreshLock.inLock(async () => {
            // Double-check after acquiring lock
            const currentTime = Date.now();
            if (currentTime - cache.lastRefresh < 1000) { // Skip if refreshed within last second
                return;
            }

            console.log(`FileSearchCache: Refreshing file cache for session ${sessionId}...`);

            // The machine that holds the working tree answers this itself now, over LAN or the
            // relay. The session RPC is the old route, kept for daemons from before the listing
            // endpoint existed — and it is the one that made this screen spin.
            let output: string | null = null;
            const listing = await sync.getSessionListing(sessionId);
            if (listing) {
                output = listing.files;
            } else {
                const response = await sessionRipgrep(
                    sessionId,
                    ['--files', '--follow'],
                    undefined
                );
                if (!response.success || !response.stdout) {
                    console.error('FileSearchCache: Failed to fetch files', response.error);
                    console.log(response);
                    return;
                }
                output = response.stdout;
            }

            // Parse the output into file items
            const filePaths = output
                .split('\n')
                .filter(path => path.trim().length > 0);

            // Clear existing files
            cache.files = [];

            // Add all files
            filePaths.forEach(path => {
                const parts = path.split('/');
                const fileName = parts[parts.length - 1] || path;
                const filePath = parts.slice(0, -1).join('/') || '';

                cache.files.push({
                    fileName,
                    filePath: filePath ? filePath + '/' : '',
                    fullPath: path,
                    fileType: 'file' as const
                });
            });

            // Add unique directories with trailing slash
            const directories = new Set<string>();
            filePaths.forEach(path => {
                const parts = path.split('/');
                for (let i = 1; i <= parts.length - 1; i++) {
                    const dirPath = parts.slice(0, i).join('/');
                    if (dirPath) {
                        directories.add(dirPath);
                    }
                }
            });

            directories.forEach(dirPath => {
                const parts = dirPath.split('/');
                const dirName = parts[parts.length - 1] + '/';  // Add trailing slash to directory name
                const parentPath = parts.slice(0, -1).join('/');

                cache.files.push({
                    fileName: dirName,
                    filePath: parentPath ? parentPath + '/' : '',
                    fullPath: dirPath + '/',  // Add trailing slash to full path
                    fileType: 'folder'
                });
            });

            // One flat tree, in path order. Directories were appended after every file, so the
            // "all files" page — which is the first `limit` entries — was files only: in a
            // repository with more than a page of files, no directory ever appeared. Sorting by
            // path puts each directory beside the files it holds (`mk/` before `mk/qtest.py`),
            // which is also the order a reader of a tree expects to scroll through.
            cache.files.sort((a, b) =>
                a.fullPath < b.fullPath ? -1 : a.fullPath > b.fullPath ? 1 : 0);

            cache.lastRefresh = Date.now();
            this.initializeFuse(cache);

            console.log(`FileSearchCache: Cached ${cache.files.length} files and directories for session ${sessionId}`);
        });
    }

    async search(sessionId: string, query: string, options: SearchOptions = {}): Promise<FileItem[]> {
        await this.ensureCacheValid(sessionId);
        const cache = this.getOrCreateSessionCache(sessionId);

        if (!cache.fuse || cache.files.length === 0) {
            return [];
        }

        const { limit = 10, threshold = 0.3 } = options;

        // No query: the beginning of the tree, in path order, so directories and the files they
        // hold both make the page. (This used to claim "most recently modified"; it never sorted
        // by time, and the array's order put every directory past the limit.)
        if (!query || query.trim().length === 0) {
            return cache.files.slice(0, limit);
        }

        // Perform fuzzy search
        const searchOptions = {
            limit,
            threshold
        };

        const results = cache.fuse.search(query, searchOptions);
        return results.map(result => result.item);
    }

    getAllFiles(sessionId: string): FileItem[] {
        const cache = this.sessions.get(sessionId);
        return cache ? [...cache.files] : [];
    }

    /**
     * The whole index, built if it is not yet. A directory browser asks this instead of a query:
     * it wants the tree before anyone has typed anything into search.
     */
    async ensureLoaded(sessionId: string): Promise<FileItem[]> {
        await this.ensureCacheValid(sessionId);
        return this.getAllFiles(sessionId);
    }

    clearCache(sessionId?: string): void {
        if (sessionId) {
            this.sessions.delete(sessionId);
        } else {
            this.sessions.clear();
        }
    }
}

// Export singleton instance
export const fileSearchCache = new FileSearchCache();

// Main export: search files with fuzzy matching
export async function searchFiles(
    sessionId: string,
    query: string,
    options: SearchOptions = {}
): Promise<FileItem[]> {
    return fileSearchCache.search(sessionId, query, options);
}

/** Every file and directory the machine listed, for the browser's directory view. */
export async function loadFileIndex(sessionId: string): Promise<FileItem[]> {
    return fileSearchCache.ensureLoaded(sessionId);
}