import * as React from 'react';
import { Platform, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import katex from 'katex';
import { injectKatexCss } from './MathRenderer';

// Ensure KaTeX CSS+fonts are injected at module load time.
// EnrichedMarkdownText handles block math, so InlineMath may never render,
// but we still need CSS for all math elements in the page.
if (typeof document !== 'undefined') {
    injectKatexCss();
    // MathML stretchy operators need a dedicated math font.
    // Latin Modern Math via CDN — best coverage for stretchy braces.
    if (!document.getElementById('mathml-fonts-css')) {
        const mm = document.createElement('style');
        mm.id = 'mathml-fonts-css';
        mm.textContent = `
            @font-face {
                font-family: 'Latin Modern Math';
                src: url('https://cdn.jsdelivr.net/npm/@examindev/mathlifier@0.1.0/dist/fonts/latinmodern-math.woff2') format('woff2');
            }
            math { font-family: 'Latin Modern Math', 'STIX Two Math', 'Cambria Math', serif; }
        `;
        document.head.appendChild(mm);
    }
}

const ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ',
    eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
    nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigmaf: 'ς',
    sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ',
    Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ',
    Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ',
    Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
    times: '×', divide: '÷', pm: '±', mp: '∓', cdot: '⋅',
    sum: '∑', prod: '∏', int: '∫',
    partial: '∂', nabla: '∇', infin: '∞',
    ne: '≠', le: '≤', ge: '≥', equiv: '≡', approx: '≈', sim: '∼', simeq: '≃',
    larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
    lArr: '⇐', rArr: '⇒',
    forall: '∀', exist: '∃', empty: '∅',
    isin: '∈', notin: '∉',
    deg: '°', prime: '′',
    ndash: '–', mdash: '—',
    copy: '©', reg: '®', euro: '€',
    frac12: '½', frac14: '¼', frac34: '¾',
    hellip: '…', bullet: '•', circ: '∘',
    ang: '∠', and: '∧', or: '∨', not: '¬',
    sub: '⊂', sup: '⊃', sube: '⊆', supe: '⊇',
    oplus: '⊕', otimes: '⊗',
    lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
    perp: '⟂', propto: '∝', cong: '≅',
    mid: '∣', parallel: '∥',
    aleph: 'ℵ', wp: '℘', vert: '|',
};

const ENTITY_RE = /&([a-zA-Z]+);/g;

function decodeEntities(str: string): string {
    return str.replace(ENTITY_RE, (_, name: string) => ENTITIES[name] || `&${name};`);
}

function renderKatexText(html: string): string {
    let text = html.replace(/<span class="katex-mathml">[\s\S]*?<\/span>/, '');
    text = text.replace(/<[^>]*>/g, '');
    text = decodeEntities(text);
    text = text.replace(/\s+/g, ' ').trim();
    return text;
}

export const InlineMath = React.memo((props: {
    expr: string;
}) => {
    if (Platform.OS === 'web') {
        injectKatexCss();
        let displayHtml: string;
        try {
            displayHtml = katex.renderToString(props.expr, { displayMode: false, throwOnError: false });
        } catch {
            return (
                // @ts-ignore
                <span style={{ color: '#888' }}>${props.expr}$</span>
            );
        }
        const wrappedHtml = displayHtml.replace(
            /class="katex"/g,
            'class="katex" style="white-space:normal;overflow-wrap:anywhere"',
        );
        return (
            // @ts-ignore
            <span style={{ display: 'inline' }} dangerouslySetInnerHTML={{ __html: wrappedHtml }} />
        );
    }

    let displayText: string;
    try {
        const html = katex.renderToString(props.expr, { displayMode: false, throwOnError: false });
        displayText = renderKatexText(html);
        if (!displayText) displayText = props.expr;
    } catch {
        displayText = props.expr;
    }

    return <Text style={style.math}>{displayText}</Text>;
});

const style = StyleSheet.create((theme) => ({
    math: {
        fontStyle: 'italic',
        fontSize: 16,
        color: theme.colors.text,
    },
}));
