// A maintenance continuation may restore only its own recorded pause.
export async function restoreRecordedPause(client, record, beforeSet = () => {}) {
  const expected=record?.goal;
  if(!record?.threadId || expected?.threadId!==record.threadId || expected.status!=='paused') {
    throw new Error('An exact recorded paused goal is required.');
  }
  const {goal}=await client.call('thread/goal/get',{threadId:record.threadId});
  for(const key of ['threadId','objective','tokenBudget','createdAt','updatedAt','status']) {
    if(goal?.[key]!==expected[key])throw new Error('The maintenance pause changed; do not restore it.');
  }
  for(const key of ['tokensUsed','timeUsedSeconds']) {
    if(!Number.isFinite(goal[key]) || goal[key]<expected[key])throw new Error('Goal usage continuity is unverified.');
  }
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
