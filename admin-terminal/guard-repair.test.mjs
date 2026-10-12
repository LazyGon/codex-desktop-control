import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const repair = fs.readFileSync(new URL('./Repair-AdminTerminalGuard.ps1', import.meta.url), 'utf8');
const verify = fs.readFileSync(new URL('./Verify-AdminTerminal.ps1', import.meta.url), 'utf8');

test('guard-only forward update requires its exact executing host operation', () => {
  assert.match(repair, /\$state\.phase -ne 'executing'/);
  assert.match(repair, /\$state\.activeOperationId -ne \$job\.operationId/);
  assert.match(repair, /expectedHostPid/);
  assert.match(repair, /expectedHostStartTime/);
  assert.match(repair, /beforeSha256/);
  assert.match(repair, /sourceSha256/);
  assert.match(repair, /\[IO\.File\]::Replace\(\$temporary, \$target, \$backup\)/);
  assert.doesNotMatch(repair, /RunAs|Restart-Computer|Stop-Process|Add-MpPreference|Set-MpPreference/);
});

test('installed envelope is decoded through the legacy code page and ACLs remain protected', () => {
  assert.match(repair, /StandardOutputEncoding = \[Text\.Encoding\]::GetEncoding\(932\)/);
  assert.match(repair, /guardResultJson/);
  assert.match(repair, /ConvertFromUtf32\(0x1f600\)/);
  assert.match(repair, /\$beforeAcl -ne \$afterAcl/);
  assert.match(verify, /\$guardUpdate\.beforeSha256 -ne \$expected/);
  assert.match(verify, /\$guardUpdate\.sourceSha256 -ne \$guardUpdate\.installedSha256/);
  assert.match(verify, /guardUpdatePath/);
});
