function tokensFor(command) {
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
          if (next === '`' || next === '\n' || next === '\r') return null;
          if (next === quote) {
            if (command[index] === quote) { value += quote; index += 1; continue; }
            closed = true;
            break;
          }
          if (next === '\\' && command[index] === '"') return null;
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

function formatSimple(tokens) {
  const invocation = tokens[0]?.raw === '&';
  const executableIndex = invocation ? 1 : 0;
  const executable = tokens[executableIndex];
  if (!executable || executable.operator) return null;
  if (/[$%*?]/u.test(executable.value)) return null;
  const name = leaf(executable.value);
  const kind = name.toLowerCase().replace(/\.exe$/u, '');
  const args = tokens.slice(executableIndex + 1);
  if (['powershell', 'pwsh', 'cmd'].includes(kind)) {
    const commandFlag = kind === 'cmd' ? '/c' : '-command';
    const position = args.findIndex(token => token.value.toLowerCase() === commandFlag);
    const harmless = kind === 'cmd' ? ['/d', '/s'] : ['-nologo', '-noprofile', '-noninteractive'];
    if (position >= 0 && args.length === position + 2
      && args.slice(0, position).every(token => harmless.includes(token.value.toLowerCase()))) {
      const inner = summarize(args[position + 1].value);
      if (inner !== null) return `${name} ${commandFlag} ${inner}`;
    }
  }
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
