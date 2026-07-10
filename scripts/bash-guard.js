#!/usr/bin/env node
/**
 * PreToolUse hook - blocks chained/piped Bash commands.
 *
 * Reads hook context JSON from stdin. If the tool is Bash and the command
 * contains a forbidden shell operator outside of quoted strings, emits a deny
 * decision to stdout. Otherwise exits silently (implicit allow).
 *
 * Quote tracking honors backslash escapes outside single quotes (POSIX single
 * quotes have no escape mechanism). It is a guard, not a full shell parser, so
 * it deliberately does not model every quoting nuance (e.g. ANSI-C `$'...'`).
 */

/**
 * Detect a stderr-swallowing redirect (`2>/dev/null` or `2>&1`) starting at
 * `index`, tolerating optional whitespace after the `>`. Returns the operator
 * label, or null if none starts here.
 */
function redirectAt(commandText, index) {
  if (commandText[index] !== '2' || commandText[index + 1] !== '>') return null;
  let afterRedirect = index + 2;
  while (commandText[afterRedirect] === ' ' || commandText[afterRedirect] === '\t') {
    afterRedirect++;
  }
  if (commandText.startsWith('/dev/null', afterRedirect)) return '2>/dev/null';
  if (commandText.startsWith('&1', afterRedirect)) return '2>&1';
  return null;
}

/**
 * Walk `commandText` character by character, tracking single/double quote state
 * and honoring backslash escapes, and return the first forbidden operator found
 * outside quotes, or null. The two-character operators (`&&`, `||`) are tested
 * before the single-character `|` so a `||` is reported as `||`, not `|`.
 */
function findForbiddenOperator(commandText) {
  let inSingle = false;
  let inDouble = false;

  for (let index = 0; index < commandText.length; index++) {
    const character = commandText[index];

    // A backslash escapes the next character everywhere except inside single
    // quotes, so an escaped quote cannot desync quote tracking (and an escaped
    // operator is correctly treated as a literal, not a separator).
    if (character === '\\' && !inSingle) {
      index++;
      continue;
    }

    if (character === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (character === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (inSingle || inDouble) continue;

    if (commandText.startsWith('&&', index)) return '&&';
    if (commandText.startsWith('||', index)) return '||';
    if (character === '|') return '|';
    if (character === ';') return ';';
    const redirect = redirectAt(commandText, index);
    if (redirect) return redirect;
  }
  return null;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    return; // malformed JSON - allow
  }

  // Any non-object JSON (null, numbers, arrays) degrades the same way malformed
  // JSON does, rather than crashing on a property access.
  if (!data || typeof data !== 'object' || data.tool_name !== 'Bash') return;

  const command = data.tool_input && data.tool_input.command;
  if (typeof command !== 'string') return;

  const found = findForbiddenOperator(command);
  if (!found) return;

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Single-command Bash calls only. Found: ${found}. ` +
        'Use separate Bash calls or dedicated tools (Read, Grep, Glob).',
    },
  };
  process.stdout.write(JSON.stringify(output));
});
