// Engine profiles: named sets of environment variables for the engine process, shipped with the app
// (bundled config.json) and chosen by the user. Provider-agnostic: a profile may select a cloud
// resource, a region, a base URL … It is applied after process.env, so it overrides the system
// environment; a null value removes the variable. Values are never logged or shown in the UI.
export type ProfileEnv = Record<string, string | null>;
export type EngineProfiles = Record<string, ProfileEnv>;

// Upper-case names only: Windows environments are case-insensitive, so a differently cased duplicate
// of an existing variable would be ambiguous for the child process.
const VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

/** Keeps only well-formed profiles: plain objects whose keys are variable names and whose values are strings or null. */
export function sanitizeProfiles(raw: unknown): EngineProfiles | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: EngineProfiles = {};
  for (const [name, env] of Object.entries(raw as Record<string, unknown>)) {
    if (!name.trim() || !env || typeof env !== 'object' || Array.isArray(env)) continue;
    const clean: ProfileEnv = {};
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (VAR_NAME.test(key) && (typeof value === 'string' || value === null)) clean[key] = value;
    }
    out[name] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A copy of `base` with the profile applied: strings set, nulls removed. */
export function applyProfileEnv(base: NodeJS.ProcessEnv, extra?: ProfileEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}
