import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

test('TypeSafe environment writer supports SDK variable without exposing it or changing user scope in tests', context => {
  if (process.platform !== 'win32') { context.skip('Windows PowerShell test'); return; }
  const helper = path.join(directory, 'TypeSafeEnvironment.ps1').replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
. '${helper}'
$beforeUser = [Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'User')
$fixture = 'fixture-' + [guid]::NewGuid().ToString('N')
$output = @(Set-TypeSafeApiKeyEnvironment -ApiKeyText (' ' + $fixture + ' ') -Target Process)
$matched = [Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'Process') -ceq $fixture
$rejected = $false
try { Set-TypeSafeApiKeyEnvironment -ApiKeyText 'invalid key' -Target Process } catch { $rejected = $true }
[ordered]@{matched=$matched;noSecretOutput=($output.Count -eq 0);invalidRejected=$rejected;
    userUntouched=([Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'User') -ceq $beforeUser);
    previousValuePreserved=([Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'Process') -ceq $fixture)} | ConvertTo-Json -Compress
`;
  const shell = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20000 });
  assert.deepEqual(JSON.parse(output.trim()), { matched: true, noSecretOutput: true, invalidRejected: true,
    userUntouched: true, previousValuePreserved: true });
});

test('input UI masks the key, discloses user-level plaintext persistence, and never calls an API', () => {
  const source = fs.readFileSync(path.join(directory, 'Enter-TypeSafeApiKey.ps1'), 'utf8');
  assert.match(source, /UseSystemPasswordChar = \$true/);
  assert.match(source, /Set-TypeSafeApiKeyEnvironment -ApiKeyText \$inputBox.Text -Target User/);
  assert.match(source, /レジストリ平文/);
  assert.match(source, /apiValidated = \$false/);
  assert.doesNotMatch(source, /Invoke-(RestMethod|WebRequest)|ConvertFrom-SecureString/);
});
