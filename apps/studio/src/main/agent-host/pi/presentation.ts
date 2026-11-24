import type { ToolKind } from '@studio/events';
import type { EventPresentation } from '../event-log.js';
import { filledStr as str } from '../coerce.js';
import { CLAUDE_PRESENTATION, toolKind, toolPresentation } from '../reduce.js';

const PI_TOOL_ALIAS: Readonly<Record<string, { name: string; kind: ToolKind; title: string }>> = {
  read: { name: 'Read', kind: 'read', title: 'Read' },
  edit: { name: 'Edit', kind: 'edit', title: 'Edit' },
  write: { name: 'Write', kind: 'edit', title: 'Write' },
  bash: { name: 'Bash', kind: 'execute', title: 'Bash' },
  powershell: { name: 'PowerShell', kind: 'execute', title: 'PowerShell' },
  grep: { name: 'Grep', kind: 'search', title: 'Grep' },
  find: { name: 'Glob', kind: 'search', title: 'Find' },
  ls: { name: 'Glob', kind: 'search', title: 'List' },
};

function targetOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  return str(record['path']) ?? str(record['file_path']) ?? str(record['command']) ?? str(record['pattern']);
}

export const PI_PRESENTATION: EventPresentation = {
  present(name, input, cwd) {
    const alias = PI_TOOL_ALIAS[name.toLowerCase()];
    if (alias !== undefined) {
      const target = targetOf(input);
      const changedTargets = alias.kind === 'edit' && target !== undefined ? [target] : undefined;
      return {
        name: alias.name,
        kind: alias.kind,
        title: alias.title,
        ...(target === undefined ? {} : { target }),
        ...(changedTargets === undefined ? {} : { changedTargets }),
      };
    }
    return { name, kind: toolKind(name), ...toolPresentation(name, input, cwd) };
  },
  resultLanguage(kind, name) {
    return CLAUDE_PRESENTATION.resultLanguage(kind, name);
  },
  diffStats(name, input) {
    return CLAUDE_PRESENTATION.diffStats(name, input);
  },
};
