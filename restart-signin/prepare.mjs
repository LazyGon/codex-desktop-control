import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJson, saveJson, connectCanonical } from '../control/shared-task-operations.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=promisify(execFile);
export function collectPins(files) {
  const seen=new Map();
  function visit(file){
    file=path.resolve(file);if(seen.has(file))return;
    const bytes=fs.readFileSync(file);seen.set(file,{file,sha256:createHash('sha256').update(bytes).digest('hex').toUpperCase()});
    if(file.endsWith('.mjs')) for(const match of bytes.toString('utf8').matchAll(/from\s+['"](\.[^'"]+)['"]/g))visit(path.resolve(path.dirname(file),match[1]));
  }
  files.forEach(visit);return [...seen.values()];
}
async function prepare(threadId,authorizationReference) {
  if(!threadId||!authorizationReference)throw new Error('Exact owner and new explicit human restart-authorization reference required. This command never authorizes itself.');
  const config=readJson('C:/ProgramData/CodexRestartSignIn/config.json');
  if(readJson('C:/ProgramData/CodexRestartSignIn/current.json').phase!=='idle')throw new Error('An unresolved sign-in lease exists.');
  const client=await connectCanonical();
  try {
    const own=(await client.call('thread/read',{threadId,includeTurns:false})).thread;
    if(own.id!==threadId || !own.cwd || own.source!=='vscode' || own.canAcceptDirectInput!==true)throw new Error('An exact ordinary Desktop owner workspace is required.');
    // The protected admin guard verifies the live approval/sandbox at admission.
    // Reading a loaded Desktop task must not reload it through this client.
    const {goal}=await client.call('thread/goal/get',{threadId});
    const canonical=readJson(path.join(repo,'launcher/state/current.json'));
    const {stdout}=await run('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command','(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")'],{windowsHide:true});
    const previousBoot=stdout.trim();if(!Number.isFinite(Date.parse(previousBoot)))throw new Error('Boot identity unverified.');
    const operationId=randomUUID(),dir=path.join(repo,'state/restart-signin',operationId);fs.mkdirSync(dir,{recursive:true});
    const authorizationPath=path.join(dir,'authorization.json'),postbootPath=path.join(dir,'postboot.json');
    const sourcePins=collectPins([path.join(repo,'restart-signin/session.mjs'),path.join(repo,'restart-signin/Run-RestartSignIn.ps1'),path.join(repo,'restart-signin/Register-PostbootReceiver.ps1'),config.nodePath]);
    saveJson(authorizationPath,{operationId,phase:'prepared',threadId,workspace:own.cwd,userSid:config.userSid,previousBoot,previousServerPid:canonical.serverProcessId,authorizationPath,authorizationReference,restartAuthorized:true,restartSignInAuthorized:true,sourcePins});
    saveJson(postbootPath,{operationId,phase:'prepared',threadId,workspace:own.cwd,previousBoot,restoreRoot:'C:\\ProgramData\\CodexRestartSignIn',sourcePins,schedulerTask:'Codex Restart Sign-In Resume '+operationId,recordedSettings:Object.fromEntries(['model','modelProvider','cwd','reasoningEffort'].filter(k=>own[k]!==undefined).map(k=>[k,own[k]])),recordedGoal:goal,pausedGoalReadbackPath:goal?.status==='active'?path.join(dir,'paused-goal-readback.json'):null,completionInstructions:'Continue this one explicitly authorized restart only. Verify the protected result, new boot, original sign-in setting restoration and exact saved task/goal identities. Do not repeat the restart, feature operation or any UNKNOWN operation. Other tasks may be restored only from the separately saved exact pre-restart active-task snapshot and the current user authorization.'});
    console.log(JSON.stringify({operationId,authorizationPath,postbootPath,phase:'prepared-not-reboot-armed',restarted:false}));
  }finally{client.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepare(...process.argv.slice(2));
