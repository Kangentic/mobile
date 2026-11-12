/**
 * `parseLinkStreamCommand` (task #147): the pure parser behind the mock
 * desktop's `/link-stream` command. A message is a command only when it is
 * exactly `/link-stream` plus one of the three known words.
 */
import { describe, expect, it } from 'vitest';
import { parseLinkStreamCommand } from '@/devsupport/terminalLinkStream';

describe('parseLinkStreamCommand', () => {
  it('reads each known word, ignoring the whitespace around the message', () => {
    expect(parseLinkStreamCommand('/link-stream still')).toBe('still');
    expect(parseLinkStreamCommand('/link-stream scroll')).toBe('scroll');
    expect(parseLinkStreamCommand('  /link-stream off  ')).toBe('off');
  });

  /**
   * `constructor`, `toString` and `__proto__` are inherited members of any
   * plain object, so a key lookup would answer them with a function or an
   * object instead of null.
   *
   * Mutation that reddens this: restore the old lookup,
   * `const LINK_STREAM_COMMANDS: Record<string, TerminalLinkStreamCommand> = { still: 'still', scroll: 'scroll', off: 'off' };`
   * and `return LINK_STREAM_COMMANDS[match[1]] ?? null;`. The `constructor`
   * case then returns Object's constructor function.
   */
  it('returns null for anything that is not exactly the command and a known word', () => {
    for (const message of [
      '/link-stream bogus',
      '/link-stream constructor',
      '/link-stream toString',
      '/link-stream __proto__',
      '/link-stream',
      '/link-stream still now',
      'hello',
    ]) {
      expect(parseLinkStreamCommand(message), message).toBeNull();
    }
  });
});
