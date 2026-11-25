/**
 * Model tiers, and the environment that says which build each tier means.
 *
 * Codex names models by version (`gpt-6.2-sol`), and those versions move. The App should offer
 * the stable idea — Sol, Astra, Terra, Luna — and the machine should decide which concrete build
 * that is today, the way Claude Code's `ANTHROPIC_DEFAULT_OPUS_MODEL` maps a tier to a version.
 * Codex itself has no such alias: its config accepts only a real model slug (or a full catalog of
 * real slugs), so the mapping lives here.
 *
 * `CODEX_MODEL_<TIER>` overrides the default for one tier; `CODEX_MODEL` names the default when
 * the session does not choose. Both tolerate a real slug as well as a tier name, so a profile
 * that already carries `gpt-6.1-sol` keeps working.
 */

export type CodexModelTier = 'sol' | 'astra' | 'terra' | 'luna';

export const CODEX_MODEL_TIERS: readonly CodexModelTier[] = ['sol', 'astra', 'terra', 'luna'];

const TIER_LABELS: Record<CodexModelTier, { name: string; description: string }> = {
    sol: { name: 'Sol', description: 'Fast, go-to model for coding and everyday work' },
    astra: { name: 'Astra', description: 'Most capable model for complex coding and professional work' },
    terra: { name: 'Terra', description: 'Efficient model for visual understanding and computer use' },
    luna: { name: 'Luna', description: 'Fast and affordable model for easier tasks' },
};

const DEFAULT_TIER_MODELS: Record<CodexModelTier, string> = {
    sol: 'gpt-6.2-sol',
    astra: 'gpt-6.2-astra',
    terra: 'gpt-6.1-terra',
    luna: 'gpt-6-luna',
};

/** Session model keys written by earlier builds, read as the tier they stood for. */
const LEGACY_MODEL_TIERS: Record<string, CodexModelTier> = {
    'gpt-5-codex-high': 'sol',
    'gpt-5-codex-medium': 'terra',
    'gpt-5-codex-low': 'luna',
};

function nonEmpty(value: string | undefined | null): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function asTier(value: string | null | undefined): CodexModelTier | undefined {
    const lower = value?.trim().toLowerCase();
    if (!lower) return undefined;
    if ((CODEX_MODEL_TIERS as readonly string[]).includes(lower)) {
        return lower as CodexModelTier;
    }
    return LEGACY_MODEL_TIERS[lower];
}

/** The concrete model a tier means on this machine. */
export function modelForTier(tier: CodexModelTier): string {
    return nonEmpty(process.env[`CODEX_MODEL_${tier.toUpperCase()}`]) ?? DEFAULT_TIER_MODELS[tier];
}

/** The tier a model key names, when it names one; otherwise the raw model. */
export function tierOfModel(model: string | null | undefined): string | undefined {
    const value = nonEmpty(model);
    if (!value) return undefined;
    return asTier(value) ?? value;
}

/**
 * The model slug to send to Codex for a session's requested model.
 *
 * A tier name (or a legacy tier key) becomes its concrete model; a real slug passes through. With
 * no request, `CODEX_MODEL` is the default when set, else the Sol tier.
 */
export function resolveCodexModel(requested?: string | null): string {
    const value = nonEmpty(requested);
    if (value) {
        const tier = asTier(value);
        return tier ? modelForTier(tier) : value;
    }
    const configured = nonEmpty(process.env.CODEX_MODEL);
    if (configured) {
        const tier = asTier(configured);
        return tier ? modelForTier(tier) : configured;
    }
    return modelForTier('sol');
}

/**
 * The model to send when the account's own default should decide unless a person named one.
 *
 * A ChatGPT login has no tier-to-version table of its own: the models it can reach are the plan's,
 * and the defaults in this file name builds from a different provider. So in that mode only an
 * explicit choice — a real slug, or a tier whose `CODEX_MODEL_<TIER>` / `CODEX_MODEL` is set — is
 * sent; otherwise the model is omitted and Codex picks its default.
 */
export function resolveCodexModelIfExplicit(requested?: string | null): string | undefined {
    // A tier name alone means "this file's default build", which belongs to another provider; in a
    // ChatGPT login it must not be sent unless the machine mapped that tier to a real model.
    const defaultSlug = (): string | undefined => {
        const configured = nonEmpty(process.env.CODEX_MODEL);
        if (!configured || asTier(configured)) return undefined;
        return configured;
    };
    const value = nonEmpty(requested);
    if (value) {
        const tier = asTier(value);
        if (!tier) return value;
        return nonEmpty(process.env[`CODEX_MODEL_${tier.toUpperCase()}`]) ?? defaultSlug();
    }
    return defaultSlug();
}

/** What the App's model picker shows: stable tier keys, display names, and descriptions. */
export function codexModelOptions(): Array<{ code: string; value: string; description?: string }> {
    return CODEX_MODEL_TIERS.map((tier) => ({
        code: tier,
        value: TIER_LABELS[tier].name,
        description: TIER_LABELS[tier].description,
    }));
}

/** The tier key to publish as the session's current model, falling back to the raw model. */
export function currentTierCode(requested?: string | null): string {
    const value = nonEmpty(requested);
    const tier = asTier(value);
    if (tier) return tier;
    if (value) return value;
    const configured = nonEmpty(process.env.CODEX_MODEL);
    const configuredTier = asTier(configured);
    return configuredTier ?? configured ?? 'sol';
}
