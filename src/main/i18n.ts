// UI language of the main process: the app's own Terminal lines, error texts, dialog and window
// titles. The renderer has its own table (src/renderer/i18n.js). Not translated on purpose: the
// tokens the engine receives ([Datei: …]) and the persona system prompt.
export type Language = 'de' | 'en';
export const LANGUAGES: Language[] = ['de', 'en'];

const DE = {
  'window.title': 'Termi - Assistant for all',
  'dialog.chooseFolder': 'Arbeitsordner wählen',
  'greeting': 'Hallo {agent}',
  'err.unexpected': 'Unerwarteter Fehler: {e}',
  'err.engineStart': 'Engine konnte nicht starten: {e}',
  'err.engineNotRunning': 'Die Engine läuft gerade nicht – bitte kurz warten oder neu starten.',
  'err.configBroken': 'config.json ist fehlerhaft und wird ignoriert (Standardwerte aktiv). Beim nächsten Speichern wird eine Kopie als .bak angelegt: {path}',
  'err.saveConfig': 'Einstellungen konnten nicht gespeichert werden ({path})',
  'err.workspaceMissing': 'Arbeitsumgebung {repo} nicht gefunden – es wird stattdessen {cwd} verwendet. Pfad ggf. in {config} anpassen.',
  'workspace.cloning': 'Arbeitsumgebung wird zum ersten Mal heruntergeladen ({url}) – das kann ein paar Minuten dauern …',
  'workspace.cloned': 'Arbeitsumgebung heruntergeladen: {url} → {dir}',
  'workspace.updated': 'Arbeitsumgebung ist aktuell ({dir})',
  'workspace.notGit': '{dir} ist keine git-Kopie – wird nicht aktualisiert',
  'workspace.gitMissing': 'Git ist auf diesem PC nicht installiert. Bitte die IT, „Git für Windows" zu installieren, und starte die App dann neu.',
  'workspace.cloneFailed': 'Die Arbeitsumgebung konnte nicht heruntergeladen werden. Bist du im Firmennetz bzw. VPN und hast Zugriff auf {url}? Details: {e}',
  'workspace.pullFailed': 'Aktualisieren der Arbeitsumgebung nicht möglich – es geht mit der vorhandenen Version weiter. Details: {e}',
  'err.modelList': 'Modellliste nicht verfügbar: {e}',
  'err.liveSwitch': 'Live-Wechsel fehlgeschlagen ({e}) – neue Sitzung',
  'engine.starting': '{agent}-Engine startet in {cwd}',
  'engine.skipWarning': 'ACHTUNG: --dangerously-skip-permissions – Freigaben sind deaktiviert',
  'engine.bypassWarning': 'ACHTUNG: Freigabemodus „Bypass" – Freigaben sind ausgeschaltet',
  'engine.startFailed': 'Engine-Start fehlgeschlagen: {e}',
  'engine.claudeAuth': 'Claude konnte nicht starten. Bitte zuerst in Claude anmelden (Befehl "claude" im Terminal, dann /login) und die App neu starten. Details: {e}',
  'engine.error': 'Engine-Fehler: {e}',
  'engine.interrupted': 'Unterbrochen durch Nutzer',
  'engine.interruptFailed': 'Unterbrechen fehlgeschlagen: {e}',
  'engine.deniedByUser': 'Vom Nutzer in der Freigabe-Karte abgelehnt.',
  'engine.sessionEnded': 'Sitzung beendet.',
  'engine.aborted': 'Abgebrochen.',
  'engine.allowed': 'FREIGEGEBEN',
  'engine.denied': 'ABGELEHNT',
  'engine.approvalAsk': 'FREIGABE? {tool}: {summary}',
  'engine.approvalModeSwitched': 'Freigabemodus gewechselt: {mode}',
  'engine.modelSwitched': 'Modell gewechselt: {model}',
  'engine.defaultModel': 'Standard',
  'engine.thinking': '… denkt nach',
  'engine.toolRunning': '  … {tool} läuft seit {s} s',
  'engine.readyClaude': 'Bereit · Claude Code {version} · Modell {model} · Freigabemodus {mode} · {n} Skills',
  'engine.readyAgy': 'Bereit · agy{model}',
  'engine.modelSuffix': ' · Modell {model}',
  'engine.done': '✓ fertig',
  'engine.failed': '✗ Fehler',
  'engine.resultLine': '{status} · {s} s · {n} Schritte',
  'engine.costSuffix': ' · Gesamtkosten der Sitzung ≈ ${cost}',
  'engine.toolOk': 'Erfolgreich',
  'engine.toolError': 'Fehler',
  'agy.modelListFailed': 'Modellliste von agy nicht verfügbar: {e}',
  'agy.invalidModel': 'Ungültiger Modellname: {model}',
  'agy.notFound': 'Agy-Engine konnte nicht starten: agy nicht gefunden – ist es installiert und im PATH?',
  'agy.badCwd': 'Agy-Engine konnte nicht starten: Arbeitsordner nicht gefunden ({cwd}).',
  'agy.startFailed': 'Agy-Engine konnte nicht starten: {e}',
  'agy.exited': 'Agy-Prozess beendet mit Code {code}',
  'agy.notRunning': 'Agy-Prozess läuft nicht – Nachricht nicht gesendet.',
  'agy.noInterrupt': 'Agy kann nicht angehalten werden – die Sitzung wird neu gestartet (der bisherige Gesprächsverlauf geht verloren).',
  'gpts.notImplemented': 'GPTS Integration ist in dieser Version noch nicht implementiert.',
  'gpts.placeholder': 'GPTS Engine ist noch ein Platzhalter.',
  'tool.write': 'Datei anlegen: {path}',
  'tool.edit': 'Datei ändern: {path}',
  'tool.editDetail': 'Ersetzen:\n{old}\n\nDurch:\n{new}',
  'tool.read': 'Datei lesen: {path}',
  'tool.search': 'Suchen: {pattern}',
  'tool.webFetch': 'Webseite abrufen: {url}',
  'tool.webSearch': 'Im Web suchen: {query}',
  'tool.agent': 'Hilfsagent: {desc}',
  'tool.emptyResult': '(leer)',
};

export type MessageKey = keyof typeof DE;

const EN: Record<MessageKey, string> = {
  'window.title': 'Termi - Assistant for all',
  'dialog.chooseFolder': 'Choose working folder',
  'greeting': 'Hello {agent}',
  'err.unexpected': 'Unexpected error: {e}',
  'err.engineStart': 'Engine could not start: {e}',
  'err.engineNotRunning': 'The engine is not running right now – please wait a moment or restart.',
  'err.configBroken': 'config.json is invalid and ignored (defaults active). A copy is kept as .bak on the next save: {path}',
  'err.saveConfig': 'Settings could not be saved ({path})',
  'err.workspaceMissing': 'Workspace {repo} not found – using {cwd} instead. Adjust the path in {config} if needed.',
  'workspace.cloning': 'Downloading the workspace for the first time ({url}) – this can take a few minutes …',
  'workspace.cloned': 'Workspace downloaded: {url} → {dir}',
  'workspace.updated': 'Workspace is up to date ({dir})',
  'workspace.notGit': '{dir} is not a git copy – not updated',
  'workspace.gitMissing': 'Git is not installed on this PC. Please ask IT to install "Git for Windows", then restart the app.',
  'workspace.cloneFailed': 'The workspace could not be downloaded. Are you on the company network or VPN, and do you have access to {url}? Details: {e}',
  'workspace.pullFailed': 'Could not update the workspace – continuing with the current version. Details: {e}',
  'err.modelList': 'Model list not available: {e}',
  'err.liveSwitch': 'Live switch failed ({e}) – new session',
  'engine.starting': '{agent} engine starting in {cwd}',
  'engine.skipWarning': 'WARNING: --dangerously-skip-permissions – approvals are disabled',
  'engine.bypassWarning': 'WARNING: approval mode "Bypass" – approvals are turned off',
  'engine.startFailed': 'Engine start failed: {e}',
  'engine.claudeAuth': 'Claude could not start. Please sign in to Claude first (run "claude" in a terminal, then /login) and restart the app. Details: {e}',
  'engine.error': 'Engine error: {e}',
  'engine.interrupted': 'Interrupted by user',
  'engine.interruptFailed': 'Interrupt failed: {e}',
  'engine.deniedByUser': 'Denied by the user in the approval card.',
  'engine.sessionEnded': 'Session ended.',
  'engine.aborted': 'Aborted.',
  'engine.allowed': 'APPROVED',
  'engine.denied': 'DENIED',
  'engine.approvalAsk': 'APPROVAL? {tool}: {summary}',
  'engine.approvalModeSwitched': 'Approval mode switched: {mode}',
  'engine.modelSwitched': 'Model switched: {model}',
  'engine.defaultModel': 'Default',
  'engine.thinking': '… thinking',
  'engine.toolRunning': '  … {tool} running for {s} s',
  'engine.readyClaude': 'Ready · Claude Code {version} · model {model} · permission mode {mode} · {n} skills',
  'engine.readyAgy': 'Ready · agy{model}',
  'engine.modelSuffix': ' · model {model}',
  'engine.done': '✓ done',
  'engine.failed': '✗ error',
  'engine.resultLine': '{status} · {s} s · {n} steps',
  'engine.costSuffix': ' · total session cost ≈ ${cost}',
  'engine.toolOk': 'Succeeded',
  'engine.toolError': 'Error',
  'agy.modelListFailed': 'Model list from agy not available: {e}',
  'agy.invalidModel': 'Invalid model name: {model}',
  'agy.notFound': 'Agy engine could not start: agy not found – is it installed and on the PATH?',
  'agy.badCwd': 'Agy engine could not start: working folder not found ({cwd}).',
  'agy.startFailed': 'Agy engine could not start: {e}',
  'agy.exited': 'Agy process exited with code {code}',
  'agy.notRunning': 'Agy process is not running – message not sent.',
  'agy.noInterrupt': 'Agy cannot be paused – the session is restarted (the earlier conversation is lost).',
  'gpts.notImplemented': 'GPTS integration is not implemented in this version yet.',
  'gpts.placeholder': 'The GPTS engine is still a placeholder.',
  'tool.write': 'Create file: {path}',
  'tool.edit': 'Edit file: {path}',
  'tool.editDetail': 'Replace:\n{old}\n\nWith:\n{new}',
  'tool.read': 'Read file: {path}',
  'tool.search': 'Search: {pattern}',
  'tool.webFetch': 'Fetch web page: {url}',
  'tool.webSearch': 'Search the web: {query}',
  'tool.agent': 'Helper agent: {desc}',
  'tool.emptyResult': '(empty)',
};

const TABLES: Record<Language, Record<MessageKey, string>> = { de: DE, en: EN };
let current: Language = 'de';

export function setLanguage(lang: Language): void {
  if (LANGUAGES.includes(lang)) current = lang;
}

export function getLanguage(): Language {
  return current;
}

/** OS language -> 'de' for any German locale, otherwise 'en'. */
export function detectLanguage(locale: string): Language {
  return locale.toLowerCase().startsWith('de') ? 'de' : 'en';
}

/** Message in the current language; {name} placeholders are filled from vars, unknown ones stay. */
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  const text = TABLES[current][key] ?? DE[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** For the key-completeness check (scratch test). */
export const _tables = TABLES;
