// Path helpers for config values. Pure (no electron import), so they are testable with `node --test`.

/**
 * "~" or "~/x" (also "~\x") means the user's home folder: a shipped config.json can then name a
 * per-user folder without knowing the user name. Anything else is returned unchanged.
 */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return home.replace(/[\\/]+$/, '') + '\\' + p.slice(2).replace(/^[\\/]+/, '');
  return p;
}
