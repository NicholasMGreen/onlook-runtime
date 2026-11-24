import { writeAtomicFile } from '../../fs-atomic.js';
import { ensurePiAgentDir, piGuardExtensionPath } from '../../pi/paths.js';

const ONLOOK_GUARD_SOURCE = `import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const WORKTREE_ROOT = realpathSync(resolve(process.env.ONLOOK_WORKTREE_ROOT || process.cwd()));

const SENSITIVE_BASH_PATTERNS = [
  /\\bgh\\s+/i,
  /\\bgit\\s+(?:[^;&|]*\\s)?(?:push|reset\\s+--hard|branch\\s+-(?:[a-zA-Z]*[dD])|branch\\s+--delete|clean\\s+-[a-zA-Z]*f|rebase)\\b/i,
  /\\brm\\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\\b/,
  /\\b(?:curl|wget)\\b[^\\n]*\\|\\s*(?:sh|bash|zsh)\\b/i,
];

function realTargetPath(rawPath) {
  const abs = resolve(WORKTREE_ROOT, rawPath);
  if (existsSync(abs)) return realpathSync(abs);
  let cursor = abs;
  const tail = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return abs;
    tail.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...tail);
}

function isOutsideWorktree(rawPath) {
  const target = realTargetPath(rawPath);
  const rel = relative(WORKTREE_ROOT, target);
  return isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep);
}

async function registerStudioTools(pi) {
  const baseUrl = process.env.ONLOOK_STUDIO_TOOLS_URL;
  const token = process.env.ONLOOK_STUDIO_TOOLS_TOKEN;
  if (!baseUrl || !token || typeof pi.registerTool !== 'function') return;
  try {
    const res = await fetch(baseUrl + '/tools', {
      headers: { authorization: 'Bearer ' + token },
    });
    if (!res.ok) return;
    const specs = await res.json();
    if (!Array.isArray(specs)) return;
    for (const spec of specs) {
      pi.registerTool({
        name: spec.name,
        label: spec.title || spec.name,
        description: spec.description || spec.name,
        parameters: spec.inputSchema,
        async execute(_toolCallId, params) {
          const callRes = await fetch(baseUrl + '/call', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer ' + token,
            },
            body: JSON.stringify({ name: spec.name, args: params ?? {} }),
          });
          const body = await callRes.json();
          return {
            content: Array.isArray(body.content)
              ? body.content
              : [{ type: 'text', text: JSON.stringify(body) }],
            isError: body.ok === false,
          };
        },
      });
    }
  } catch {
    // Studio tools bridge unavailable; Pi continues with built-in tools.
  }
}

export default function onlookGuard(pi) {
  void registerStudioTools(pi);

  pi.on('tool_call', async (event, ctx) => {
    if ((event.toolName === 'edit' || event.toolName === 'write') && typeof event.input?.path === 'string') {
      if (isOutsideWorktree(event.input.path)) {
        return {
          block: true,
          reason: 'Blocked by Onlook: path is outside the project worktree.',
        };
      }
    }

    if ((event.toolName === 'bash' || event.toolName === 'powershell') && typeof event.input?.command === 'string') {
      const cmd = event.input.command;
      if (SENSITIVE_BASH_PATTERNS.some((re) => re.test(cmd))) {
        const approved = await ctx.ui.confirm('Approve shell command?', cmd);
        if (!approved) {
          return { block: true, reason: 'User denied execution in Onlook.' };
        }
      }
    }
    return undefined;
  });
}
`;

export function materializeGuardExtension(root?: string): string {
  ensurePiAgentDir(root);
  const path = piGuardExtensionPath(root);
  writeAtomicFile(path, ONLOOK_GUARD_SOURCE);
  return path;
}
