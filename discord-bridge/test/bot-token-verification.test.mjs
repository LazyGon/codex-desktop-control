import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import test from 'node:test';

test('Windows token verification differentiates identity errors without returning the token', { skip: process.platform !== 'win32' }, () => {
  const helper = path.resolve(import.meta.dirname, '../DiscordBotToken.ps1').replaceAll("'", "''");
  const powershell = path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const command = `
    $ErrorActionPreference = 'Stop';
    . '${helper}';
    function Invoke-RestMethod { param($Uri,$Headers,$UserAgent,$TimeoutSec)
      if ($Headers.Authorization -ne 'Bot fake-test-token') { throw 'Bad normalized header' };
      if ($UserAgent -notlike 'DiscordBot (*') { throw 'Missing Discord User-Agent' };
      return $script:fakeBot;
    };
    $script:fakeBot = [pscustomobject]@{ id='1527845761331494992'; bot=$true };
    $normalized = ConvertTo-DiscordBotTokenText -Value ' "Bot fake-test-token" ';
    $valid = Test-DiscordBotIdentity -TokenText $normalized -ApplicationId '1527845761331494992';
    $mismatch = Test-DiscordBotIdentity -TokenText $normalized -ApplicationId '1527845761331494993';
    $script:fakeBot = [pscustomobject]@{ id='250912750916599808' };
    $user = Test-DiscordBotIdentity -TokenText $normalized -ApplicationId '1527845761331494992';
    function Invoke-RestMethod { param($Uri,$Headers,$UserAgent,$TimeoutSec); throw 'fake-test-token should never be returned' };
    $network = Test-DiscordBotIdentity -TokenText $normalized -ApplicationId '1527845761331494992';
    @{normalizedOk=($normalized -eq 'fake-test-token'); valid=$valid; mismatch=$mismatch; user=$user; network=$network} | ConvertTo-Json -Depth 5 -Compress;
  `;
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const results = JSON.parse(output);
  assert.equal(results.normalizedOk, true);
  assert.equal(results.valid.Code, 'VERIFIED');
  assert.equal(results.valid.Valid, true);
  assert.equal(results.mismatch.Code, 'BOT_ID_MISMATCH');
  assert.equal(results.user.Code, 'NOT_BOT');
  assert.equal(results.network.Code, 'NETWORK_ERROR');
  assert.equal(output.includes('fake-test-token'), false);
});

test('real DPAPI save round-trips with restricted ACL from a WinForms callback', { skip: process.platform !== 'win32' }, (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-token-save-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const helper = path.resolve(import.meta.dirname, '../DiscordBotToken.ps1').replaceAll("'", "''");
  const destination = path.join(directory, 'token.dpapi').replaceAll("'", "''");
  const powershell = path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const command = `
    $ErrorActionPreference='Stop'; . '${helper}'; Add-Type -AssemblyName System.Windows.Forms;
    $form=[Windows.Forms.Form]::new(); $form.ShowInTaskbar=$false; $form.Opacity=0;
    $button=[Windows.Forms.Button]::new(); $form.Controls.Add($button);
    $button.Add_Click({
      try {
        Write-DiscordProtectedBotToken -TokenText 'fake-token-test-only' -TokenPath '${destination}';
        $secure=Microsoft.PowerShell.Security\\ConvertTo-SecureString ([IO.File]::ReadAllText('${destination}').Trim());
        $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);
        try { $script:roundTrip=([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) -eq 'fake-token-test-only') }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() };
        $acl=Microsoft.PowerShell.Security\\Get-Acl -LiteralPath '${destination}';
        $script:protected=$acl.AreAccessRulesProtected;
        $script:rules=$acl.Access.Count;
        Write-DiscordProtectedBotToken -TokenText 'fake-token-test-only' -TokenPath '${destination}';
      } catch { $script:failed=$_.Exception.GetType().FullName; $script:failedMessage=$_.Exception.Message + ' / ' + $_.ScriptStackTrace } finally { $form.Close() }
    });
    $form.Add_Shown({$button.PerformClick()}); $form.ShowDialog() | Out-Null;
    @{roundTrip=$script:roundTrip; protected=$script:protected; rules=$script:rules; failed=$script:failed; failedMessage=$script:failedMessage} | ConvertTo-Json -Compress;
  `.replace("$ErrorActionPreference='Stop';", "$ErrorActionPreference='Stop'; $script:roundTrip=$false; $script:protected=$false; $script:rules=0; $script:failed=$null; $script:failedMessage=$null;");
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const result = JSON.parse(output);
  assert.equal(result.failed, null, result.failedMessage);
  assert.equal(result.roundTrip, true);
  assert.equal(result.protected, true);
  assert.equal(result.rules, 1);
  assert.equal(output.includes('fake-token-test-only'), false);
});
