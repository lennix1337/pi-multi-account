const TRAILING_EFFORT =
	/\s+(?:\((?:none|low|medium|high|xhigh|max|extra\s*high)\)|(?:None|Low|Medium|High|Extra High|xHigh|Max))\s*$/i;

export function cursorModelDisplayName(name: string): string {
	const stripped = name.replace(TRAILING_EFFORT, "").trim();
	return stripped || name;
}
