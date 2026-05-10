/**
 * Verifies that `src/styles/_theme.scss` declares `color-scheme` for
 * each theme class so the user-agent renders native scrollbars,
 * autofill, color-input swatches, and other UA-painted controls in
 * the matching palette. M7f-1b.
 *
 * Approach: stylesheet introspection (the M7g testing pattern) -
 * iterate `document.styleSheets` and substring-match `cssText`.
 * Programmatically setting body classes and checking
 * `getComputedStyle(document.body).colorScheme` is unreliable in
 * Karma's headless Chrome because Material's emitted styles also
 * carry `color-scheme`, so the cascade can mask the rule we care
 * about.
 */
describe('global theme stylesheet (color-scheme)', () => {
  function findRulesContaining(...substrings: string[]): string[] {
    const matches: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        // Cross-origin stylesheets refuse cssRules access.
        continue;
      }
      for (const rule of Array.from(rules)) {
        const cssText = ruleText(rule);
        if (cssText && substrings.every((s) => cssText.includes(s))) {
          matches.push(cssText);
        }
      }
    }
    return matches;
  }

  /**
   * Returns the rule's cssText flattened across nested @media wrappers
   * so substring matches work regardless of whether the rule is bare
   * or inside a `@media (prefers-color-scheme: light) { ... }` block.
   */
  function ruleText(rule: CSSRule): string | null {
    if (rule instanceof CSSStyleRule) return rule.cssText;
    if (rule instanceof CSSMediaRule) {
      const parts = [`@media ${rule.conditionText} {`];
      for (const inner of Array.from(rule.cssRules)) {
        const t = ruleText(inner);
        if (t) parts.push(t);
      }
      parts.push('}');
      return parts.join('\n');
    }
    return null;
  }

  it('declares color-scheme: dark on the .theme-dark class', () => {
    const matches = findRulesContaining('.theme-dark', 'color-scheme', 'dark');
    expect(matches.length)
      .withContext(
        'src/styles/_theme.scss must declare `color-scheme: dark` on `.theme-dark` / `:root` so native UI follows the dark palette',
      )
      .toBeGreaterThan(0);
  });

  it('declares color-scheme: light on the .theme-light class', () => {
    const matches = findRulesContaining('.theme-light', 'color-scheme', 'light');
    expect(matches.length)
      .withContext(
        'src/styles/_theme.scss must declare `color-scheme: light` on `.theme-light` so native UI follows the light palette',
      )
      .toBeGreaterThan(0);
  });

  it('declares color-scheme: light on .theme-system inside the prefers-color-scheme: light media query', () => {
    const matches = findRulesContaining(
      'prefers-color-scheme: light',
      '.theme-system',
      'color-scheme',
      'light',
    );
    expect(matches.length)
      .withContext(
        'src/styles/_theme.scss must include a `@media (prefers-color-scheme: light) { .theme-system { color-scheme: light; } }` rule so the pre-bootstrap body class follows OS preference',
      )
      .toBeGreaterThan(0);
  });
});
