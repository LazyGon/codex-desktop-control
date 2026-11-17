// A maintenance continuation may restore only its own recorded pause.
export function assertRecordedPause(record,goal,latestTurn) {
  const expected=record?.goal;
  if(!record?.threadId || !record.turnId || expected?.threadId!==record.threadId || expected.status!=='paused') {
    throw new Error('An exact recorded paused goal is required.');
  }
  for(const key of ['threadId','objective','tokenBudget','createdAt','updatedAt','status']) {
    if(goal?.[key]!==expected[key])throw new Error('The maintenance pause changed; do not restore it.');
  }
  for(const key of ['tokensUsed','timeUsedSeconds']) {
    if(!Number.isFinite(goal[key]) || goal[key]<expected[key])throw new Error('Goal usage continuity is unverified.');
  }
  if(latestTurn?.id!==record.turnId || latestTurn.status!=='completed')throw new Error('The maintenance source turn changed or was interrupted.');
}

export async function restoreRecordedPause(client, record, beforeSet = () => {}) {
  const expected=record?.goal;
  const [{goal},turns]=await Promise.all([
    client.call('thread/goal/get',{threadId:record?.threadId}),
    client.call('thread/turns/list',{threadId:record?.threadId,limit:1,sortDirection:'desc',itemsView:'notLoaded'})
  ]);
  assertRecordedPause(record,goal,turns.data?.[0]);
  await beforeSet();
  await client.call('thread/goal/set',{threadId:record.threadId,status:'active'});
  const {goal:restored}=await client.call('thread/goal/get',{threadId:record.threadId});
  for(const key of ['threadId','objective','tokenBudget','createdAt']) {
    if(restored?.[key]!==expected[key])throw new Error('Restored goal identity is unverified; do not repeat.');
  }
  if(restored.status!=='active' || restored.tokensUsed<goal.tokensUsed || restored.timeUsedSeconds<goal.timeUsedSeconds) {
    throw new Error('Restored goal status/usage is unverified; do not repeat.');
  }
  return restored;
}
