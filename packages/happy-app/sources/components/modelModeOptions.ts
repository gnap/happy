import type { Metadata } from '@/sync/storageTypes';
import { hackModes } from '@/sync/modeHacks';

export type ModeOption = {
    key: string;
    name: string;
    description?: string | null;
};

export type PermissionMode = ModeOption;
export type ModelMode = ModeOption;

export type PermissionModeKey = string;
export type ModelModeKey = string;

export type AgentFlavor = 'claude' | 'codex' | 'gemini' | string | null | undefined;

type Translate = (key: any) => string;

type MetadataOption = {
    code: string;
    value: string;
    description?: string | null;
};

const GEMINI_MODEL_FALLBACKS: ModelMode[] = [
    { key: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Most capable' },
    { key: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast & efficient' },
    { key: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', description: 'Fastest' },
];

export function mapMetadataOptions(options?: MetadataOption[] | null): ModeOption[] {
    if (!options || options.length === 0) {
        return [];
    }

    return options.map((option) => ({
        key: option.code,
        name: option.value,
        description: option.description ?? null,
    }));
}

export function getClaudePermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.permissionMode.default'), description: null },
        { key: 'acceptEdits', name: translate('agentInput.permissionMode.acceptEdits'), description: null },
        { key: 'plan', name: translate('agentInput.permissionMode.plan'), description: null },
        { key: 'bypassPermissions', name: translate('agentInput.permissionMode.bypassPermissions'), description: null },
    ];
}

export function getCodexPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.codexPermissionMode.default'), description: null },
        { key: 'read-only', name: translate('agentInput.codexPermissionMode.readOnly'), description: null },
        { key: 'safe-yolo', name: translate('agentInput.codexPermissionMode.safeYolo'), description: null },
        { key: 'yolo', name: translate('agentInput.codexPermissionMode.yolo'), description: null },
    ];
}

export function getGeminiPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.geminiPermissionMode.default'), description: null },
        { key: 'read-only', name: translate('agentInput.geminiPermissionMode.readOnly'), description: null },
        { key: 'safe-yolo', name: translate('agentInput.geminiPermissionMode.safeYolo'), description: null },
        { key: 'yolo', name: translate('agentInput.geminiPermissionMode.yolo'), description: null },
    ];
}

export function getClaudeModelModes(): ModelMode[] {
    return [
        { key: 'default', name: 'Default', description: 'Use CLI settings' },
        { key: 'adaptiveUsage', name: 'Adaptive Usage', description: 'Balanced model routing' },
        { key: 'sonnet', name: 'Sonnet', description: 'Fast and capable' },
        { key: 'opus', name: 'Opus', description: 'Most capable' },
        { key: 'fable', name: 'Fable', description: 'Next-gen superfast model' },
    ];
}

export function getCodexModelModes(translate: Translate): ModelMode[] {
    return [
        { key: 'gpt-5-codex-high', name: translate('agentInput.codexModel.gpt5CodexHigh'), description: null },
        { key: 'gpt-5-codex-medium', name: translate('agentInput.codexModel.gpt5CodexMedium'), description: null },
        { key: 'gpt-5-codex-low', name: translate('agentInput.codexModel.gpt5CodexLow'), description: null },
        { key: 'gpt-5-minimal', name: translate('agentInput.codexModel.gpt5Minimal'), description: null },
        { key: 'gpt-5-low', name: translate('agentInput.codexModel.gpt5Low'), description: null },
        { key: 'gpt-5-medium', name: translate('agentInput.codexModel.gpt5Medium'), description: null },
        { key: 'gpt-5-high', name: translate('agentInput.codexModel.gpt5High'), description: null },
    ];
}

export function getGeminiModelModes(): ModelMode[] {
    return GEMINI_MODEL_FALLBACKS;
}

/** Cursor permission modes aligned with cursor-agent: --mode plan, --mode ask, -f/--force */
export function getCursorPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.cursorPermissionMode.default'), description: null },
        { key: 'plan', name: translate('agentInput.cursorPermissionMode.plan'), description: null },
        { key: 'ask', name: translate('agentInput.cursorPermissionMode.ask'), description: null },
        { key: 'force', name: translate('agentInput.cursorPermissionMode.force'), description: null },
    ];
}

/** Cursor-native model IDs and labels (from cursor-agent --list-models). Curated subset for complexity control. */
const CURSOR_MODELS: ModelMode[] = [
    { key: 'auto', name: 'Auto', description: null },
    { key: 'composer-1.5', name: 'Composer 1.5', description: null },
    { key: 'composer-2', name: 'Composer 2', description: null },
    { key: 'composer-2-fast', name: 'Composer 2 Fast', description: null },
    { key: 'gemini-3-flash', name: 'Gemini 3 Flash', description: null },
    { key: 'gemini-3-pro', name: 'Gemini 3 Pro', description: null },
    { key: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', description: null },
    { key: 'gpt-5.1', name: 'GPT-5.1', description: null },
    { key: 'gpt-5.1-codex-max-medium', name: 'GPT-5.1 Codex Max', description: null },
    { key: 'gpt-5.1-codex-max-xhigh', name: 'GPT-5.1 Codex Max Extra High', description: null },
    { key: 'gpt-5.1-codex-max-xhigh-fast', name: 'GPT-5.1 Codex Max Extra High Fast', description: null },
    { key: 'gpt-5.1-codex-max-high', name: 'GPT-5.1 Codex Max High', description: null },
    { key: 'gpt-5.1-codex-max-high-fast', name: 'GPT-5.1 Codex Max High Fast', description: null },
    { key: 'gpt-5.1-codex-max-low', name: 'GPT-5.1 Codex Max Low', description: null },
    { key: 'gpt-5.1-codex-max-low-fast', name: 'GPT-5.1 Codex Max Low Fast', description: null },
    { key: 'gpt-5.1-codex-max-medium-fast', name: 'GPT-5.1 Codex Max Medium Fast', description: null },
    { key: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', description: null },
    { key: 'gpt-5.1-codex-mini-high', name: 'GPT-5.1 Codex Mini High', description: null },
    { key: 'gpt-5.1-codex-mini-low', name: 'GPT-5.1 Codex Mini Low', description: null },
    { key: 'gpt-5.1-high', name: 'GPT-5.1 High', description: null },
    { key: 'gpt-5.1-low', name: 'GPT-5.1 Low', description: null },
    { key: 'gpt-5.2', name: 'GPT-5.2', description: null },
    { key: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', description: null },
    { key: 'gpt-5.2-codex-xhigh', name: 'GPT-5.2 Codex Extra High', description: null },
    { key: 'gpt-5.2-codex-xhigh-fast', name: 'GPT-5.2 Codex Extra High Fast', description: null },
    { key: 'gpt-5.2-codex-fast', name: 'GPT-5.2 Codex Fast', description: null },
    { key: 'gpt-5.2-codex-high', name: 'GPT-5.2 Codex High', description: null },
    { key: 'gpt-5.2-codex-high-fast', name: 'GPT-5.2 Codex High Fast', description: null },
    { key: 'gpt-5.2-codex-low', name: 'GPT-5.2 Codex Low', description: null },
    { key: 'gpt-5.2-codex-low-fast', name: 'GPT-5.2 Codex Low Fast', description: null },
    { key: 'gpt-5.2-xhigh', name: 'GPT-5.2 Extra High', description: null },
    { key: 'gpt-5.2-xhigh-fast', name: 'GPT-5.2 Extra High Fast', description: null },
    { key: 'gpt-5.2-fast', name: 'GPT-5.2 Fast', description: null },
    { key: 'gpt-5.2-high', name: 'GPT-5.2 High', description: null },
    { key: 'gpt-5.2-high-fast', name: 'GPT-5.2 High Fast', description: null },
    { key: 'gpt-5.2-low', name: 'GPT-5.2 Low', description: null },
    { key: 'gpt-5.2-low-fast', name: 'GPT-5.2 Low Fast', description: null },
    { key: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', description: null },
    { key: 'gpt-5.3-codex-xhigh', name: 'GPT-5.3 Codex Extra High', description: null },
    { key: 'gpt-5.3-codex-xhigh-fast', name: 'GPT-5.3 Codex Extra High Fast', description: null },
    { key: 'gpt-5.3-codex-fast', name: 'GPT-5.3 Codex Fast', description: null },
    { key: 'gpt-5.3-codex-high', name: 'GPT-5.3 Codex High', description: null },
    { key: 'gpt-5.3-codex-high-fast', name: 'GPT-5.3 Codex High Fast', description: null },
    { key: 'gpt-5.3-codex-low', name: 'GPT-5.3 Codex Low', description: null },
    { key: 'gpt-5.3-codex-low-fast', name: 'GPT-5.3 Codex Low Fast', description: null },
    { key: 'gpt-5.3-codex-spark-preview', name: 'GPT-5.3 Codex Spark', description: null },
    { key: 'gpt-5.3-codex-spark-preview-xhigh', name: 'GPT-5.3 Codex Spark Extra High', description: null },
    { key: 'gpt-5.3-codex-spark-preview-high', name: 'GPT-5.3 Codex Spark High', description: null },
    { key: 'gpt-5.3-codex-spark-preview-low', name: 'GPT-5.3 Codex Spark Low', description: null },
    { key: 'gpt-5.4-medium', name: 'GPT-5.4 1M', description: null },
    { key: 'gpt-5.4-xhigh', name: 'GPT-5.4 1M Extra High', description: null },
    { key: 'gpt-5.4-high', name: 'GPT-5.4 1M High', description: null },
    { key: 'gpt-5.4-low', name: 'GPT-5.4 1M Low', description: null },
    { key: 'gpt-5.4-xhigh-fast', name: 'GPT-5.4 Extra High Fast', description: null },
    { key: 'gpt-5.4-medium-fast', name: 'GPT-5.4 Fast', description: null },
    { key: 'gpt-5.4-high-fast', name: 'GPT-5.4 High Fast', description: null },
    { key: 'gpt-5.4-mini-medium', name: 'GPT-5.4 Mini', description: null },
    { key: 'gpt-5.4-mini-xhigh', name: 'GPT-5.4 Mini Extra High', description: null },
    { key: 'gpt-5.4-mini-high', name: 'GPT-5.4 Mini High', description: null },
    { key: 'gpt-5.4-mini-low', name: 'GPT-5.4 Mini Low', description: null },
    { key: 'gpt-5.4-mini-none', name: 'GPT-5.4 Mini None', description: null },
    { key: 'gpt-5.4-nano-medium', name: 'GPT-5.4 Nano', description: null },
    { key: 'gpt-5.4-nano-xhigh', name: 'GPT-5.4 Nano Extra High', description: null },
    { key: 'gpt-5.4-nano-high', name: 'GPT-5.4 Nano High', description: null },
    { key: 'gpt-5.4-nano-low', name: 'GPT-5.4 Nano Low', description: null },
    { key: 'gpt-5.4-nano-none', name: 'GPT-5.4 Nano None', description: null },
    { key: 'gpt-5-mini', name: 'GPT-5 Mini', description: null },
    { key: 'grok-4-20', name: 'Grok 4.20', description: null },
    { key: 'grok-4-20-thinking', name: 'Grok 4.20 Thinking', description: null },
    { key: 'kimi-k2.5', name: 'Kimi K2.5', description: null },
    { key: 'claude-4.5-opus-high', name: 'Opus 4.5', description: null },
    { key: 'claude-4.5-opus-high-thinking', name: 'Opus 4.5 Thinking', description: null },
    { key: 'claude-4.6-opus-high', name: 'Opus 4.6 1M', description: null },
    { key: 'claude-4.6-opus-max', name: 'Opus 4.6 1M Max', description: null },
    { key: 'claude-4.6-opus-max-thinking', name: 'Opus 4.6 1M Max Thinking', description: null },
    { key: 'claude-4.6-opus-high-thinking', name: 'Opus 4.6 1M Thinking', description: null },
    { key: 'claude-4-sonnet', name: 'Sonnet 4', description: null },
    { key: 'claude-4-sonnet-1m', name: 'Sonnet 4 1M', description: null },
    { key: 'claude-4-sonnet-1m-thinking', name: 'Sonnet 4 1M Thinking', description: null },
    { key: 'claude-4-sonnet-thinking', name: 'Sonnet 4 Thinking', description: null },
    { key: 'claude-4.5-sonnet', name: 'Sonnet 4.5 1M', description: null },
    { key: 'claude-4.5-sonnet-thinking', name: 'Sonnet 4.5 1M Thinking', description: null },
    { key: 'claude-4.6-sonnet-medium', name: 'Sonnet 4.6 1M', description: null },
    { key: 'claude-4.6-sonnet-medium-thinking', name: 'Sonnet 4.6 1M Thinking', description: null },
];

export function getCursorModelModes(translate: Translate): ModelMode[] {
    return CURSOR_MODELS.map((m) =>
        m.key === 'auto'
            ? { ...m, name: translate('agentInput.cursorModel.auto') }
            : m
    );
}

export function getHardcodedPermissionModes(flavor: AgentFlavor, translate: Translate): PermissionMode[] {
    if (flavor === 'codex') {
        return getCodexPermissionModes(translate);
    }
    if (flavor === 'cursor' || flavor === 'cursor-acp' || flavor === 'acp-cursor') {
        return getCursorPermissionModes(translate);
    }
    if (flavor === 'gemini') {
        return getGeminiPermissionModes(translate);
    }
    return getClaudePermissionModes(translate);
}

export function getHardcodedModelModes(flavor: AgentFlavor, translate: Translate): ModelMode[] {
    if (flavor === 'codex') {
        return getCodexModelModes(translate);
    }
    if (flavor === 'cursor' || flavor === 'cursor-acp' || flavor === 'acp-cursor') {
        return getCursorModelModes(translate);
    }
    if (flavor === 'gemini') {
        return getGeminiModelModes();
    }
    return getClaudeModelModes();
}

export function getAvailableModels(
    flavor: AgentFlavor,
    metadata: Metadata | null | undefined,
    translate: Translate,
): ModelMode[] {
    const metadataModels = mapMetadataOptions(metadata?.models);
    if (metadataModels.length > 0) {
        return metadataModels;
    }
    return getHardcodedModelModes(flavor, translate);
}

export function getAvailablePermissionModes(
    flavor: AgentFlavor,
    metadata: Metadata | null | undefined,
    translate: Translate,
): PermissionMode[] {
    if (flavor === 'claude' || flavor === 'codex' || flavor === 'cursor' || flavor === 'cursor-acp' || flavor === 'acp-cursor') {
        return hackModes(getHardcodedPermissionModes(flavor, translate));
    }

    const metadataModes = mapMetadataOptions(metadata?.operatingModes);
    if (metadataModes.length > 0) {
        return hackModes(metadataModes);
    }

    return hackModes(getHardcodedPermissionModes(flavor, translate));
}

export function findOptionByKey<T extends ModeOption>(options: T[], key: string | null | undefined): T | null {
    if (!key) {
        return null;
    }
    return options.find((option) => option.key === key) ?? null;
}

export function resolveCurrentOption<T extends ModeOption>(
    options: T[],
    preferredKeys: Array<string | null | undefined>,
): T | null {
    for (const key of preferredKeys) {
        const option = findOptionByKey(options, key);
        if (option) {
            return option;
        }
    }
    return null;
}

export function getDefaultModelKey(flavor: AgentFlavor): string {
    if (flavor === 'codex') {
        return 'gpt-5-codex-high';
    }
    if (flavor === 'cursor' || flavor === 'cursor-acp' || flavor === 'acp-cursor') {
        return 'auto';
    }
    if (flavor === 'gemini') {
        return 'gemini-2.5-pro';
    }
    return 'default';
}

export function getDefaultPermissionModeKey(_flavor: AgentFlavor): string {
    return 'default';
}
