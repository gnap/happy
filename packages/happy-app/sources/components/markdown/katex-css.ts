// Minimal KaTeX CSS required for rendering (sans @font-face rules).
// Injected once into document head by MathRenderer on web platform.
export const KATEX_CSS = `
.katex{font:normal 1.21em KaTeX_Main,Times New Roman,serif;line-height:1.2;text-indent:0;text-rendering:auto}
.katex *{border-color:currentColor}
.katex .katex-mathml{clip:rect(1px,1px,1px,1px);border:0;height:1px;overflow:hidden;padding:0;position:absolute;width:1px}
.katex .katex-html>.newline{display:block}
.katex .base{position:relative;white-space:nowrap;width:min-content}
.katex .base,.katex .strut{display:inline-block}
.katex .textbf{font-weight:700}
.katex .textit{font-style:italic}
.katex .textrm{font-family:KaTeX_Main}
.katex .texttt{font-family:KaTeX_Typewriter}
.katex .mathit{font-family:KaTeX_Main;font-style:italic}
.katex .mathrm{font-style:normal}
.katex .mathbf{font-family:KaTeX_Main;font-weight:700}
.katex .boldsymbol{font-family:KaTeX_Math;font-style:italic;font-weight:700}
.katex .amsrm{font-family:KaTeX_AMS}
.katex .mathcal{font-family:KaTeX_Caligraphic}
.katex .mathfrak{font-family:KaTeX_Fraktur}
.katex .mathtt{font-family:KaTeX_Typewriter}
.katex .mathscr{font-family:KaTeX_Script}
.katex .mathsf{font-family:KaTeX_SansSerif}
.katex .mainrm{font-family:KaTeX_Main;font-style:normal}
.katex .vlist-t{border-collapse:collapse;display:inline-table;table-layout:fixed}
.katex .vlist-r{display:table-row}
.katex .vlist{display:table-cell;position:relative;vertical-align:bottom}
.katex .vlist>span{display:block;height:0;position:relative}
.katex .vlist>span>span{display:inline-block}
.katex .vlist>span>.pstrut{overflow:hidden;width:0}
.katex .vlist-t2{margin-right:-2px}
.katex .vlist-s{display:table-cell;font-size:1px;min-width:2px;vertical-align:bottom;width:2px}
.katex .vbox{align-items:baseline;display:inline-flex;flex-direction:column}
.katex .hbox{width:100%}
.katex .hbox,.katex .thinbox{display:inline-flex;flex-direction:row}
.katex .thinbox{max-width:0;width:0}
.katex .msupsub{text-align:left}
.katex .mfrac>span>span{text-align:center}
.katex .mfrac .frac-line{border-bottom-style:solid;display:inline-block;width:100%}
.katex .hdashline,.katex .hline,.katex .mfrac .frac-line,.katex .overline .overline-line,.katex .rule,.katex .underline .underline-line{min-height:1px}
.katex .mspace{display:inline-block}
.katex .smash{display:inline;line-height:0}
.katex .clap,.katex .llap,.katex .rlap{position:relative;width:0}
.katex .clap>.inner,.katex .llap>.inner,.katex .rlap>.inner{position:absolute}
.katex .clap>.fix,.katex .llap>.fix,.katex .rlap>.fix{display:inline-block}
.katex .llap>.inner{right:0}
.katex .clap>.inner,.katex .rlap>.inner{left:0}
.katex .clap>.inner>span{margin-left:-50%;margin-right:50%}
.katex .rule{border:0 solid;display:inline-block;position:relative}
.katex .hline,.katex .overline .overline-line,.katex .underline .underline-line{border-bottom-style:solid;display:inline-block;width:100%}
.katex .hdashline{border-bottom-style:dashed;display:inline-block;width:100%}
.katex .sqrt>.root{margin-left:.2777777778em;margin-right:-.5555555556em}
.katex .stretchy{display:block;overflow:hidden;position:relative;width:100%}
.katex .stretchy:after,.katex .stretchy:before{content:""}
.katex .hide-tail{overflow:hidden;position:relative;width:100%}
.katex .halfarrow-left{left:0;overflow:hidden;position:absolute;width:50.2%}
.katex .halfarrow-right{overflow:hidden;position:absolute;right:0;width:50.2%}
.katex .brace-left{left:0;overflow:hidden;position:absolute;width:25.1%}
.katex .brace-center{left:25%;overflow:hidden;position:absolute;width:50%}
.katex .brace-right{overflow:hidden;position:absolute;right:0;width:25.1%}
.katex .x-arrow-pad{padding:0 .5em}
.katex .cd-arrow-pad{padding:0 .55556em 0 .27778em}
.katex .mover,.katex .munder,.katex .x-arrow{text-align:center}
.katex .boxpad{padding:0 .3em}
.katex .fbox,.katex .fcolorbox{border:.04em solid;box-sizing:border-box}
.katex .cancel-pad{padding:0 .2em}
.katex .cancel-lap{margin-left:-.2em;margin-right:-.2em}
.katex .sout{border-bottom-style:solid;border-bottom-width:.08em}
.katex .angl{border-right:.049em solid;border-top:.049em solid;box-sizing:border-box;margin-right:.03889em}
.katex .anglpad{padding:0 .03889em}
.katex .mtr-glue{width:50%}
.katex .cd-vert-arrow{display:inline-block;position:relative}
.katex .cd-label-left{display:inline-block;position:absolute;right:calc(50% + .3em);text-align:left}
.katex .cd-label-right{display:inline-block;left:calc(50% + .3em);position:absolute;text-align:right}
.katex-display{display:block;margin:1em 0;text-align:center}
.katex-display>.katex{display:block;text-align:center;white-space:nowrap}
.katex-display>.katex>.katex-html{display:block;position:relative}
.katex-display>.katex>.katex-html>.tag{position:absolute;right:0}
.katex-display.leqno>.katex>.katex-html>.tag{left:0;right:auto}
.katex-display.fleqn>.katex{padding-left:2em;text-align:left}
body{counter-reset:katexEqnNo mmlEqnNo}
.katex svg{fill:currentColor;stroke:currentColor;display:block;height:inherit;position:absolute;width:100%}
.katex svg path{stroke:none}
.katex svg{fill-rule:nonzero;fill-opacity:1;stroke-width:1;stroke-linecap:butt;stroke-linejoin:miter;stroke-miterlimit:4;stroke-dasharray:none;stroke-dashoffset:0;stroke-opacity:1}
.katex .eqn-num:before{content:"(" counter(katexEqnNo) ")";counter-increment:katexEqnNo}
.katex .mml-eqn-num:before{content:"(" counter(mmlEqnNo) ")";counter-increment:mmlEqnNo}
`;
