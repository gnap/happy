// Auto-inject KaTeX CSS+fonts and MathML fonts on web at import time.
import { KATEX_CSS_FULL } from './katex-css-full';

if (typeof document !== 'undefined') {
    // 1. KaTeX layout rules + @font-face (for KaTeX HTML rendering)
    if (!document.getElementById('katex-fonts-css')) {
        const style = document.createElement('style');
        style.id = 'katex-fonts-css';
        const CDN_BASE = 'https://cdn.jsdelivr.net/npm/katex@0.17.0/dist/fonts/';
        style.textContent = KATEX_CSS_FULL.replace(
            /url\(fonts\/([^)]+)\)/g,
            `url(${CDN_BASE}$1)`,
        );
        document.head.appendChild(style);
    }

    // 2. STIX Two Math font for MathML stretchy operators (underbrace, overbrace, etc.)
    if (!document.getElementById('mathml-fonts-css')) {
        const mathStyle = document.createElement('style');
        mathStyle.id = 'mathml-fonts-css';
        mathStyle.textContent = `
            @font-face {
                font-family: 'STIX Two Math';
                src: url('https://cdn.jsdelivr.net/npm/mathjax@3/es5/output/chtml/fonts/woff-v2/STIXTwoMath-Regular.woff2') format('woff2');
            }
            math, mtext, mi, mn, mo, ms, mspace, mphantom {
                font-family: 'STIX Two Math', 'Latin Modern Math', 'Cambria Math', serif;
            }
        `;
        document.head.appendChild(mathStyle);
    }
}
