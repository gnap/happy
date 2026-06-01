import { Message } from '@/sync/typesMessage';

export function loadFixture(name: string): Message[] {
    // Dynamic require for JSON fixtures
    try {
        return require(`../fixtures/${name}.json`) as Message[];
    } catch {
        return [];
    }
}
