function tokensFor(command, commandArgument = false) {
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    if (/\s/u.test(command[index])) { index += 1; continue; }
    const start = index;
    if (/[;|&]/u.test(command[index])) {
      const character = command[index++];
      if (command[index] === character && character !== ';') index += 1;
      tokens.push({ operator: true, raw: command.slice(start, index) });
      continue;
    }
    let value = '';
    while (index < command.length && !/[\s;|&]/u.test(command[index])) {
      const character = command[index++];
      // Shell expressions and redirection need a real shell parser. Never
      // guess their meaning or hide effects behind an attractive caption.
      if (/[`{}()<>\r\n]/u.test(character)) return null;
      if (character === "'" || character === '"') {
        const quote = character;
        let closed = false;
        while (index < command.length) {
          const next = command[index++];
          if ((next === '`' && (!commandArgument || quote === '"'))
            || (!commandArgument && (next === '\n' || next === '\r'))) return null;
          if (next === quote) {
            if (!commandArgument && command[index] === quote) { value += quote; index += 1; continue; }
            closed = true;
            break;
          }
          if (next === '\\' && quote === '"' && /["\\$`]/u.test(command[index] ?? '')) {
            if (!commandArgument) return null;
            value += command[index++];
            continue;
          }
          value += next;
        }
        if (!closed) return null;
      } else {
        if (character === '\\' && /\s/u.test(command[index] ?? '')) return null;
        value += character;
      }
    }
    tokens.push({ raw: command.slice(start, index), value });
  }
  return tokens;
}

function absolutePath(value) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(value);
}

function leaf(value) {
  return value.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? value;
}

function targetPath(token) {
  if (!absolutePath(token.value)) return token.raw;
  const parts = token.value.replaceAll('\\', '/').split('/').filter(Boolean);
  const display = `…/${parts.slice(-2).join('/')}`;
  return /\s/u.test(display) ? JSON.stringify(display) : display;
}

function startupCommand(command) {
  const prefix = command.match(/^\s*(?:&\s+)?("[^"\r\n]+"|'[^'\r\n]+'|[^\s"'&|;]+)([\s\S]*)$/u);
  if (!prefix) return null;
  const executable = prefix[1].replace(/^(['"])(.*)\1$/u, '$2');
  if (/[$%*?`]/u.test(executable)) return null;
  const kind = leaf(executable).toLowerCase().replace(/\.exe$/u, '');
  const argumentsPattern = kind === 'cmd'
    ? /^(?:[ \t]+\/(?:d|s))*[ \t]+\/c[ \t]+([\s\S]+)$/iu
    : ['pwsh', 'powershell'].includes(kind)
      ? /^(?:[ \t]+-(?:nologo|noprofile|noninteractive))*[ \t]+-(?:command|c)[ \t]+([\s\S]+)$/iu
      : null;
  const payload = argumentsPattern?.exec(prefix[2])?.[1];
  if (!payload) return null;
  // Command history joins argv using shell quoting. Decode only one complete
  // command argument; a following outer pipeline/chain must keep its scope.
  const words = tokensFor(payload, true);
  if (words?.length !== 1 || words[0].operator || !words[0].value || words[0].value === '-') return null;
  return words[0].value;
}

function formatSimple(tokens) {
  const invocation = tokens[0]?.raw === '&';
  const executableIndex = invocation ? 1 : 0;
  const executable = tokens[executableIndex];
  if (!executable || executable.operator) return null;
  if (/[$%*?]/u.test(executable.value)) return null;
  const name = leaf(executable.value);
  const kind = name.toLowerCase().replace(/\.exe$/u, '');
  const args = tokens.slice(executableIndex + 1);
  const inner = startupCommand(tokens.map(token => token.raw).join(' '));
  if (inner !== null) return `(${summarize(inner) ?? inner})`;
  const rendered = [absolutePath(executable.value)
    ? (/\s/u.test(name) ? JSON.stringify(name) : name) : executable.raw];
  let scriptPending = ['node', 'python', 'python3', 'pythonw', 'pwsh', 'powershell'].includes(kind);
  const testFiles = kind === 'node' && args.some(token => token.value === '--test');
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const script = (scriptPending || testFiles) && /\.(?:[cm]?js|py|ps1)$/iu.test(token.value);
    const workingDirectory = kind === 'git' && args[index - 1]?.value === '-C';
    rendered.push(script || workingDirectory ? targetPath(token) : token.raw);
    if (script) scriptPending = false;
    // Inline code and its arguments must remain opaque, not mistaken for paths.
    if (['-e', '--eval', '-c', '-command', '-encodedcommand'].includes(token.value.toLowerCase())) scriptPending = false;
  }
  return rendered.join(' ');
}

function summarize(command) {
  const inner = startupCommand(command);
  if (inner !== null) return summarize(inner) ?? inner;
  // Newlines outside quotes can be shell command boundaries too.
  if (/[\r\n]/u.test(command)) return null;
  const tokens = tokensFor(command);
  if (!tokens?.length) return null;
  const result = [];
  let current = [];
  for (const token of tokens) {
    if (token.operator && !(token.raw === '&' && current.length === 0)) {
      const formatted = formatSimple(current);
      if (!formatted) return null;
      result.push(formatted, token.raw);
      current = [];
    } else current.push(token);
  }
  const formatted = formatSimple(current);
  if (!formatted) return null;
  return [...result, formatted].join(' ');
}

export function summarizeActivityCommand(command) {
  const original = String(command ?? '');
  return summarize(original) ?? original;
}
