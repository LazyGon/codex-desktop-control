import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readJson, saveJson, connectCanonical, taskSnapshot } from '../control/shared-task-operations.mjs';
import { restoreRecordedPause, assertRecordedPause } from '../control/paused-goal-continuation.mjs';
import { createRuntimeCompletionRoute } from '../launcher/runtime-completion-desktop.mjs';
import { deliverRuntimeCompletion } from '../launcher/runtime-update-drain.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function decideIdle(snapshot,workspace) {
  if(path.resolve(snapshot.own.cwd).toLowerCase()!==path.resolve(workspace).toLowerCase()) throw new Error('Owner workspace changed.');
  if(snapshot.otherActive.length) throw new Error('Other tasks are active.');
  return snapshot.activeTurn || snapshot.own.status?.type==='active' ? 'wait-own-idle':'ready';
}
export function verifyPins(pins) {
  for(const pin of pins) if(createHash('sha256').update(fs.readFileSync(pin.file)).digest('hex').toUpperCase()!==pin.sha256) throw new Error('Reviewed continuation dependency changed.');
}
async function waitIdle(job) {
  const client=await connectCanonical();
  try {
    await new Promise((resolve,reject)=>{
      let busy=false,again=false,done=false;
      const check=async()=>{
        if(done)return;if(busy){again=true;return;}busy=true;
        try {
          const latest=readJson(job.authorizationPath);
          if(latest.phase!=='prepared' || latest.operationId!==job.operationId || latest.restartAuthorized!==true) throw new Error('Authorization canceled or changed.');
          verifyPins(job.sourcePins);
          const canonical=readJson(path.join(repo,'launcher/state/current.json'));
          if(canonical.serverProcessId!==job.previousServerPid || !canonical.desktopConnectionVerified) throw new Error('Canonical runtime changed before restart.');
          const snapshot=await taskSnapshot(client,job.threadId);
          if(decideIdle(snapshot,job.workspace)==='ready'){
            const post=readJson(job.postbootPath??path.join(path.dirname(job.authorizationPath),'postboot.json'));
            if(post.pausedGoalReadbackPath) {
              const paused=readJson(post.pausedGoalReadbackPath);
              const [{goal},turns]=await Promise.all([
                client.call('thread/goal/get',{threadId:job.threadId}),
                client.call('thread/turns/list',{threadId:job.threadId,limit:1,sortDirection:'desc',itemsView:'notLoaded'})
              ]);
              assertRecordedPause(paused,goal,turns.data?.[0]);
            }
            // Admission has already authenticated this owner and permission profile.
            // Do not steal a loaded Desktop task just to read its settings.
            done=true;resolve();
          }
        }catch(error){done=true;reject(error);}finally{busy=false;if(again&&!done){again=false;queueMicrotask(check);}}
      };
      client.on('notification',m=>{if(['turn/completed','thread/status/changed'].includes(m.method))void check();});
      client.on('disconnected',()=>{if(!done){done=true;reject(new Error('Shared server disconnected; no restart.'));}});
      void check();
    });
  } finally {client.close();}
}
async function logon(jobPath) {
  const job=readJson(jobPath);
  if(['delivered','unknown-do-not-resend','failed-no-resend','canceled','prepared'].includes(job.phase))return;
  if(job.phase!=='armed-for-next-boot' && job.phase!=='waiting-restoration-runtime')throw new Error('Unexpected postboot state.');
  const fd=fs.openSync(jobPath+'.delivery.lock','wx');let runtimeWatcher,restoreWatcher,state=job;
  try {
    verifyPins(state.sourcePins);
    state.phase='waiting-restoration-runtime';saveJson(jobPath,state);
    await new Promise((resolve,reject)=>{
      let busy=false,again=false,done=false;
      const check=async()=>{
        if(done)return;if(busy){again=true;return;}busy=true;
        try {
          if(readJson(jobPath).phase==='canceled'){done=true;resolve();return;}
          const operation=readJson(path.join(state.restoreRoot,'operations',state.operationId+'.json'));
          if(operation.phase!=='restored-after-logon')return;
          if(Date.parse(operation.observedBoot)<=Date.parse(state.previousBoot))throw new Error('No new OS boot.');
          let canonical;try{canonical=readJson(path.join(repo,'launcher/state/current.json'));}catch{return;}
          if(!canonical.desktopConnectionVerified || Date.parse(canonical.startedAt)<Date.parse(operation.observedBoot))return;
          let client;try{client=await connectCanonical();}catch{return;}
          try {
            verifyPins(state.sourcePins);
            const own=(await client.call('thread/read',{threadId:state.threadId,includeTurns:false})).thread;
            if(path.resolve(own.cwd).toLowerCase()!==path.resolve(state.workspace).toLowerCase())throw new Error('Owner workspace changed.');
            for(const key of ['model','modelProvider','cwd','reasoningEffort']) {
              if(state.recordedSettings?.[key]!==undefined&&own[key]!==state.recordedSettings[key])throw new Error('Owner settings changed; do not override.');
            }
            const route=createRuntimeCompletionRoute(client,{endpoint:canonical.websocketUrl,expectedServerPid:canonical.serverProcessId,requestId:state.operationId});
            if(own.status?.type==='notLoaded')await route.prepareDesktopThread(state.threadId);
            if(state.pausedGoalReadbackPath) {
              const paused=readJson(state.pausedGoalReadbackPath);
              if(paused.threadId!==state.threadId || paused.goal?.objective!==state.recordedGoal?.objective || paused.goal?.createdAt!==state.recordedGoal?.createdAt || paused.goal?.tokenBudget!==state.recordedGoal?.tokenBudget)throw new Error('Restart goal pause does not match its original owner.');
              state.restoredGoal=await restoreRecordedPause(client,paused,()=>{state.phase='restoring-recorded-goal';saveJson(jobPath,state);});
            }
            const message=`One authorized restart completed a new boot and restored the original sign-in setting. Read ${jobPath} and protected operation ${state.operationId} first. Verify actual ARSO versus manual sign-in, normal opt-out restored, lock state, administrator host, canonical Desktop/Bridge and original task settings. No repeated restart, installer, password reading, UNKNOWN resend or settings override. ${state.completionInstructions??''}`;
            state.phase='dispatching';saveJson(jobPath,state);
            const result=await deliverRuntimeCompletion(client,state.threadId,message,route);
            state.phase='delivered';state.acceptedTurnId=result.turnId;state.deliveryMethod=result.mode;state.deliveredAt=new Date().toISOString();saveJson(jobPath,state);done=true;resolve();
          }finally{client.close();}
        }catch(error){done=true;reject(error);}finally{busy=false;if(again&&!done){again=false;queueMicrotask(check);}}
      };
      runtimeWatcher=fs.watch(path.join(repo,'launcher/state'),()=>void check());
      restoreWatcher=fs.watch(path.join(state.restoreRoot,'operations'),()=>void check());
      runtimeWatcher.on('error',reject);restoreWatcher.on('error',reject);void check();
    });
  }catch(error){state.failure={message:error.message,at:new Date().toISOString()};state.phase=state.phase==='dispatching'?'unknown-do-not-resend':'failed-no-resend';saveJson(jobPath,state);throw error;}
  finally{runtimeWatcher?.close();restoreWatcher?.close();fs.closeSync(fd);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [mode,file]=process.argv.slice(2);
  if(mode==='wait-idle')await waitIdle(readJson(file));
  else if(mode==='logon')await logon(path.resolve(file));
  else throw new Error('Use wait-idle or logon with an explicitly prepared new job.');
}
