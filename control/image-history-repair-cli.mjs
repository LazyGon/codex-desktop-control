import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { validateSharedRuntime } from './codex-shared.mjs';
import { connectCanonical, readJson } from './shared-task-operations.mjs';
import { defaultDirectory, snapshot, runOnce, validateConfig } from './system-error-recovery.mjs';
import { inspectImageReferences } from './image-reference-content.mjs';
import { confirmationPath, exclusiveJson, imageSafety, pinFile, repairIdentity,
  resumeSettings, rolloutUnder, sha256, imageEpisode } from './image-repair-policy.mjs';

export async function confirmImageCause({ client, directory, threadId, failedTurnId, evidenceFile,
  confirmedImageCause, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') }) {
  if (confirmedImageCause !== true) throw Error('An operator must establish the image-history cause before confirmation');
  const config = validateConfig(readJson(path.join(directory, 'config.json')));
  if (!config.enabled || config.imageHistoryRepair !== true) throw Error('Image history recovery is disabled');
  const before = await snapshot(client, threadId, null);
  const reason = imageSafety(before, config.excludedThreadIds);
  if (reason || before.turns[0]?.id !== failedTurnId) throw Error(reason || 'Failed turn changed');
  const file = confirmationPath(directory, threadId, failedTurnId);
  if (fs.existsSync(file)) throw Error('Confirmation already exists; inspect it without replay');
  const evidence = pinFile(evidenceFile);
  rolloutUnder(before.thread.path, path.join(codexHome, 'sessions'), threadId);
  const resumed = await client.call('thread/resume', { threadId, excludeTurns: true }, null);
  const after = await snapshot(client, threadId, null);
  if (resumed.thread?.id !== threadId || imageSafety(after, config.excludedThreadIds)
      || !isDeepStrictEqual(repairIdentity(before.thread), repairIdentity(after.thread))
      || !isDeepStrictEqual(before.turns[0], after.turns[0])) throw Error('Target changed during confirmation');
  const sourcePath = rolloutUnder(after.thread.path, path.join(codexHome, 'sessions'), threadId);
  const images = await inspectImageReferences(sourcePath);
  if (!images.embeddedImages.length) throw Error('No embedded images to repair');
  const final = await snapshot(client, threadId, null);
  const current = validateConfig(readJson(path.join(directory, 'config.json')));
  if (!current.enabled || current.imageHistoryRepair !== true || imageSafety(final, current.excludedThreadIds)
      || !isDeepStrictEqual(repairIdentity(after.thread), repairIdentity(final.thread))
      || !isDeepStrictEqual(after.turns[0], final.turns[0])
      || !isDeepStrictEqual(pinFile(evidenceFile), evidence)) throw Error('Confirmation target or authorization changed');
  // This records the operator's causal diagnosis; image presence alone is not one.
  exclusiveJson(file, { schemaVersion: 1, confirmedCause: 'embedded-image-history',
    threadId, failedTurnId, errorSha256: sha256(JSON.stringify(after.turns[0].error)),
    identity: repairIdentity(after.thread), settings: resumeSettings(resumed), evidence,
    createdAt: new Date().toISOString(), embeddedImages: images.embeddedImages.length });
  return { action: 'confirmed-specific-image-episode', threadId, failedTurnId, file };
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] || 'status', value = flag => args[args.indexOf(flag) + 1];
  const directory = args.includes('--directory') ? path.resolve(value('--directory')) : defaultDirectory;
  if (command === 'run') return runOnce(directory, false);
  const threadId = value('--thread'), failedTurnId = value('--failed-turn');
  if (!args.includes('--thread') || !args.includes('--failed-turn')) throw Error('Specify --thread and --failed-turn');
  const file = confirmationPath(directory, threadId, failedTurnId);
  if (command === 'status') {
    const operation = path.join(directory, 'image-history', 'operations', imageEpisode(threadId, failedTurnId), 'operation.json');
    return { confirmation: fs.existsSync(file) ? readJson(file) : null,
      operation: fs.existsSync(operation) ? readJson(operation) : null };
  }
  if (command === 'revoke') {
    if (!fs.existsSync(file)) return { action: 'no-confirmation' };
    fs.renameSync(file, file + '.revoked-' + Date.now());
    return { action: 'confirmation-revoked' };
  }
  if (command !== 'confirm') throw Error('Expected confirm, status, revoke or run');
  if (!args.includes('--evidence') || !args.includes('--confirmed-image-cause')) throw Error('Specify --evidence and --confirmed-image-cause after diagnosis');
  await validateSharedRuntime({ timeoutMilliseconds: null });
  const config = validateConfig(readJson(path.join(directory, 'config.json')));
  const client = await connectCanonical({ requestTimeoutMs: null, statePath: config.sharedStatePath });
  try {
    return await confirmImageCause({ client, directory, threadId, failedTurnId,
      evidenceFile: value('--evidence'), confirmedImageCause: true });
  } finally { client.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await main(); process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0)); }
  catch (error) { process.stderr.write(error.message + '\n', () => process.exit(1)); }
}
