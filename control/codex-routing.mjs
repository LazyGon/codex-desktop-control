const subcommands = new Set([
  'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'mcp-server',
  'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor',
  'sandbox', 'debug', 'apply', 'resume', 'archive', 'delete',
  'migrate-rollouts', 'unarchive', 'fork', 'cloud', 'exec-server', 'features',
  'help',
]);

const optionsWithOneValue = new Set([
  '-c', '--config', '--remote', '--remote-auth-token-env', '-i', '--image',
  '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox',
  '-C', '--cd', '--add-dir', '-a', '--ask-for-approval',
]);

const remoteUnsupportedSubcommands = new Set([
  'exec', 'e', 'review', 'resume', 'fork',
]);

export function findCodexSubcommand(values) {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--') return null;
    if (optionsWithOneValue.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith('-')) continue;
    return subcommands.has(value) ? value : null;
  }
  return null;
}

export function routeCodexArguments(values) {
  const subcommand = findCodexSubcommand(values);
  if (subcommand && remoteUnsupportedSubcommands.has(subcommand)) {
    return { mode: 'unsupported', subcommand };
  }
  if (subcommand) return { mode: 'passthrough', subcommand };

  if (
    values.length > 0
    && values.every(value => ['-h', '--help', '-V', '--version'].includes(value))
  ) {
    return { mode: 'passthrough', subcommand: null };
  }

  return { mode: 'shared', subcommand: null };
}
