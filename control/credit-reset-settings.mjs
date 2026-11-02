import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defaultDirectory, validateConfig } from './system-error-recovery.mjs';
import { accountHash, creditBalance, validateCreditPolicy } from './credit-reset-policy.mjs';
import { creditResetStore } from './credit-reset-store.mjs';
import { connectCanonical, readJson, saveJson } from './shared-task-operations.mjs';

export async function configureCreditPolicy(client, getConfig, setConfig, threshold, paidRecoveryThreadIds, now = Date.now()) {
  if (!Number.isSafeInteger(threshold) || threshold < 0) throw new Error('Expected a nonnegative integer credit threshold');
  const rate = await client.call('account/rateLimits/read', {}, null);
  const hash = accountHash(rate.accountId);
  if (!hash || creditBalance(rate) === null) throw new Error('Account or finite credit balance not confirmed');
  const credits = rate.rateLimitResetCredits?.credits;
  if (!Array.isArray(credits)) throw new Error('Reset details unavailable; no configuration was changed');
  const selected = credits.filter(c => c.status === 'available' && c.resetType === 'codexRateLimits'
    && (c.expiresAt === null || (Number.isFinite(c.expiresAt) && c.expiresAt * 1000 > now)))
    .sort((a,b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))[0];
  if (!selected || typeof selected.id !== 'string' || !selected.id) throw new Error('No confirmed available reset');
  const config = validateConfig(getConfig());
  if (config.creditResetPolicy?.enabled) throw new Error('An enabled authorization already exists; inspect or disable it first');
  const policy = validateCreditPolicy({ enabled:true, authorizationId:crypto.randomUUID(), accountHash:hash,
    creditId:selected.id, balanceThreshold:threshold, paidRecoveryThreadIds });
  setConfig({ ...config, creditResetPolicy:policy });
  return { enabled:true,balanceThreshold:threshold,automaticResetLimit:1,selectedExpiresAt:selected.expiresAt,
    balanceBand:creditBalance(rate)>threshold?'above-threshold':'at-or-below-threshold',paidRecoveryThreadIds };
}
async function main(args) {
  const command=args[0]??'status';
  const option=(key,fallback)=>{const i=args.indexOf('--'+key);return i<0?fallback:args[i+1];};
  const directory=path.resolve(option('directory',defaultDirectory)),file=path.join(directory,'config.json');
  const getConfig=()=>validateConfig(readJson(file)),setConfig=value=>saveJson(file,value);
  if(command==='disable'){
    const config=getConfig();
    if(config.creditResetPolicy){config.creditResetPolicy.enabled=false;setConfig(config);}
    return {enabled:false};
  }
  if(command==='status'){
    const policy=getConfig().creditResetPolicy;
    return {configured:!!policy,enabled:policy?.enabled??false,balanceThreshold:policy?.balanceThreshold??null,
      paidRecoveryThreadIds:policy?.paidRecoveryThreadIds??[],automaticResetLimit:1,
      attempts:policy?creditResetStore(directory).records().filter(r=>r.authorizationId===policy.authorizationId)
        .map(r=>({phase:r.phase,createdAt:r.createdAt})):[]};
  }
  if(command!=='configure')throw new Error('Expected configure, status or disable');
  const threads=args.flatMap((arg,i)=>arg==='--paid-thread'?[args[i+1]]:[]);
  const config=getConfig();
  const client=await connectCanonical({statePath:config.sharedStatePath,requestTimeoutMs:null});
  try{return await configureCreditPolicy(client,getConfig,setConfig,Number(option('threshold','10000')),threads);}
  finally{client.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main(process.argv.slice(2)).then(result=>{
    process.stdout.write(JSON.stringify(result)+'\n',()=>process.exit(0));
  }).catch(error=>{
    process.stderr.write(error.message+'\n',()=>process.exit(1));
  });
}
