import fs from 'node:fs';
import path from 'node:path';
import {validateSharedRuntime} from '../control/codex-shared.mjs';
import {connectCanonical,readJson,saveJson} from '../control/shared-task-operations.mjs';
const [postPath,ownThreadId,expectedTurnId]=process.argv.slice(2);
if(!postPath||!ownThreadId||!expectedTurnId)throw new Error('Postboot file, exact current owner and active turn required.');
const post=readJson(postPath),dir=path.dirname(postPath),admission=readJson(path.join(dir,'admission-job.json'));
const admin=readJson('C:/ProgramData/CodexAdminTerminal/current.json');
const result=readJson(path.join('C:/ProgramData/CodexAdminTerminal/results',post.operationId+'.json'));
if(post.threadId!==ownThreadId||post.phase!=='prepared'||admission.phase!=='armed'||!admission.controllerPid||!admission.workerPid||admin.activeOperationId!==post.operationId||admin.phase!=='executing'||result.phase!=='running'||result.task.threadId!==ownThreadId)throw new Error('The exact independent restart worker is not live and admitted.');
if(!post.pausedGoalReadbackPath||fs.existsSync(post.pausedGoalReadbackPath))throw new Error('No unused own pause path; inspect without repeating.');
await validateSharedRuntime({timeoutMilliseconds:60000});
const client=await connectCanonical({requestTimeoutMs:300000});
try {
  const [read,turns,{goal}]=await Promise.all([client.call('thread/read',{threadId:ownThreadId,includeTurns:false}),client.call('thread/turns/list',{threadId:ownThreadId,limit:1,sortDirection:'desc',itemsView:'notLoaded'}),client.call('thread/goal/get',{threadId:ownThreadId})]);
  const turn=turns.data?.[0];
  if(read.thread.cwd!==post.workspace||read.thread.model!==post.recordedSettings.model||read.thread.reasoningEffort!==post.recordedSettings.reasoningEffort||turn?.id!==expectedTurnId||turn.status!=='inProgress'||goal?.status!=='active')throw new Error('Owner, settings or current turn changed.');
  for(const key of ['threadId','objective','createdAt','tokenBudget'])if(goal[key]!==post.recordedGoal[key])throw new Error('Original goal changed; no pause.');
  fs.mkdirSync(path.join(dir,'owner-pause-reservation'));
  saveJson(path.join(dir,'owner-before-maintenance-pause.json'),{at:new Date().toISOString(),read,turns,goal});
  saveJson(path.join(dir,'owner-pause-intent.json'),{at:new Date().toISOString(),threadId:ownThreadId,turnId:turn.id,action:'status paused only for this one authorized reboot',beforeGoal:goal});
  await client.call('thread/goal/set',{threadId:ownThreadId,status:'paused'});
  const {goal:paused}=await client.call('thread/goal/get',{threadId:ownThreadId});
  for(const key of ['threadId','objective','createdAt','tokenBudget'])if(paused?.[key]!==goal[key])throw new Error('Pause identity uncertain; do not repeat.');
  if(paused.status!=='paused'||paused.tokensUsed<goal.tokensUsed||paused.timeUsedSeconds<goal.timeUsedSeconds)throw new Error('Pause accounting uncertain; do not repeat.');
  saveJson(post.pausedGoalReadbackPath,{schema:'codex-maintenance-paused-goal/v1',at:new Date().toISOString(),threadId:ownThreadId,turnId:turn.id,goal:paused,reason:'One authorized restart with verified independent recovery.'});
  console.log(JSON.stringify({phase:'paused_for_one_authorized_restart',record:post.pausedGoalReadbackPath,operationId:post.operationId,objectiveAndBudgetPreserved:true,usageNotReset:true,restarted:false}));
} finally {client.close();}
