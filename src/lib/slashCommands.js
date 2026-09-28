/**
 * Slash command registry + parser.
 *
 * User types `/warmup`, `/quiz`, etc. to switch the conversational mode.
 * No LLM intent classification — explicit verbs only. Multilingual-safe.
 *
 * Adding a new command:
 *   1. Register here (label, description, accent)
 *   2. Implement the mode in src/lib/modes/<name>.js
 *   3. Wire dispatch in ChatPanel handleSlash() switch
 */

export const COMMANDS = {
  warmup: {
    label: '/warmup',
    description: 'Light recall — AI prompts you on stale notes',
    argsHint: '[scope hint]',
    accent: '#059669',
    ready: true,
  },
  quiz: {
    label: '/quiz',
    description: 'Closed-book test — AI scores your answers',
    argsHint: '[scope hint]',
    accent: '#dc2626',
    ready: true,
  },
  rehearse: {
    label: '/rehearse',
    description: 'Role-play — AI plays interviewer / examiner',
    argsHint: '<interviewer|examiner|colleague|skeptic|custom: ...>',
    accent: '#7c3aed',
    ready: true,
  },
  audit: {
    label: '/audit',
    description: 'Scan canvas for merges / conflicts / missing edges',
    accent: '#a16207',
    ready: true,
  },
  clear: {
    label: '/clear',
    description: 'Clear chat history for this canvas',
    accent: '#6b7280',
    ready: true,
  },
  exit: {
    label: '/exit',
    description: 'Exit current mode, return to free chat',
    accent: '#6b7280',
    ready: true,
  },
};

const SLASH_RE = /^\/([\w-]+)(?:\s+(.*))?$/;

/**
 * Parse a slash command. Returns null if not a slash command.
 *   parseSlash('/warmup redis')  → { command: 'warmup', args: 'redis', known: true }
 *   parseSlash('/foo')           → { command: 'foo', args: '',     known: false }
 *   parseSlash('hello /quiz')    → null (not at start)
 */
export function parseSlash(text) {
  const m = text.trim().match(SLASH_RE);
  if (!m) return null;
  const [, command, args] = m;
  return {
    command: command.toLowerCase(),
    args: (args || '').trim(),
    known: !!COMMANDS[command.toLowerCase()],
  };
}

/**
 * For autocomplete: given the current input text, return matching commands.
 * Only matches while the user is still typing the command part (no space yet).
 */
export function autocompleteFor(text) {
  if (!text || !text.startsWith('/')) return [];
  if (text.includes(' ')) return []; // user moved on to args
  const prefix = text.slice(1).toLowerCase();
  return Object.entries(COMMANDS)
    .filter(([name]) => name.startsWith(prefix))
    .map(([name, meta]) => ({ name, ...meta }));
}
