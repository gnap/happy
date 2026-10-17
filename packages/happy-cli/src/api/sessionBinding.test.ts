import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ happyHome: '/tmp/happy-test-home', serverUrl: 'https://a.example' }));

vi.mock('@/configuration', () => ({
  configuration: {
    get happyHomeDir() {
      return state.happyHome;
    },
    get serverUrl() {
      return state.serverUrl;
    },
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

import { loadSessionBinding, rememberSessionMetadata, saveSessionBinding, sessionBindingPath, type SessionBinding } from './sessionBinding';

const BINDING: SessionBinding = {
  id: 'cm-server-id',
  metadata: 'bWV0YQ==',
  metadataVersion: 7,
  agentState: 'c3RhdGU=',
  agentStateVersion: 3,
};

describe('sessionBinding', () => {
  beforeEach(() => {
    state.happyHome = mkdtempSync(join(tmpdir(), 'happy-binding-'));
    state.serverUrl = 'https://a.example';
  });
  afterEach(() => rmSync(state.happyHome, { recursive: true, force: true }));

  it('round-trips what the server last said', () => {
    saveSessionBinding('tag-1', BINDING);
    expect(loadSessionBinding('tag-1')).toEqual(BINDING);
  });

  it('keeps a null agentState as null', () => {
    saveSessionBinding('tag-1', { ...BINDING, agentState: null });
    expect(loadSessionBinding('tag-1')?.agentState).toBeNull();
  });

  it('knows nothing about a tag that has not been through the server', () => {
    expect(loadSessionBinding('never-seen')).toBeNull();
  });

  it('does not serve one server\'s id to another', () => {
    saveSessionBinding('tag-1', BINDING);
    state.serverUrl = 'https://b.example';
    expect(loadSessionBinding('tag-1')).toBeNull();
  });

  it('treats a damaged file as absent rather than throwing', () => {
    writeFileSync(sessionBindingPath('tag-1'), '{not json');
    expect(loadSessionBinding('tag-1')).toBeNull();
    writeFileSync(sessionBindingPath('tag-1'), JSON.stringify({ id: 'x' }));
    expect(loadSessionBinding('tag-1')).toBeNull();
  });

  it('remembers metadata that moved after the create, such as the conversation a restart resumes', () => {
    saveSessionBinding('tag-1', BINDING);
    rememberSessionMetadata('tag-1', 'bmV3ZXI=', 8);
    expect(loadSessionBinding('tag-1')).toEqual({ ...BINDING, metadata: 'bmV3ZXI=', metadataVersion: 8 });
  });

  it('never lets an older metadata version replace a newer one', () => {
    saveSessionBinding('tag-1', BINDING);
    rememberSessionMetadata('tag-1', 'b2xkZXI=', 7);
    rememberSessionMetadata('tag-1', 'b2xkZXI=', 6);
    expect(loadSessionBinding('tag-1')).toEqual(BINDING);
  });

  it('does not invent a binding for a tag the server has not answered', () => {
    rememberSessionMetadata('never-seen', 'bWV0YQ==', 1);
    expect(loadSessionBinding('never-seen')).toBeNull();
  });
});
