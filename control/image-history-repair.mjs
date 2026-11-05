import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readJson, saveJson, listPages } from './shared-task-operations.mjs';
import { prepareImageReferences } from './image-reference-content.mjs';
import { replaceArchivedImages } from './image-reference-windows.mjs';
import { confirmationPath, imageEpisode, permitDecision, repairIdentity, resumeSettings,
  exclusiveJson, rolloutUnder, checkedPin } from './image-repair-policy.mjs';

const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const continuation = '画像履歴が原因と確認されたシステムエラーから、保存済み画像をファイル参照に置換し、コンテキスト圧縮を完了しました。同じ担当・保存済み進捗・元の設定と権限で、未完の許可済み作業だけを継続してください。利用者の停止／設計待ち／公開HOLDを守り、実行済み操作や送信結果UNKNOWNを再送しないでください。新しい範囲や権限は付与されません。画像は参照先から必要なものだけ扱ってください。';

// This listener owns one compaction request. A receipt is not completion.
export async function compactImages(client, threadId, update) {
  let finish, reject, turnId = null, compactItem = false;
  const done = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
  // The result can fail before the RPC receipt arrives; keep it handled then.
  done.catch(() => {});
  const notification = event => {
    const p = event.params ?? {};
    if (p.threadId !== threadId) return;
    if (event.method === 'turn/started' && !turnId) { turnId = p.turn?.id; update({ compactionTurnId: turnId }); }
    if (['item/started', 'item/completed'].includes(event.method) && p.item?.type === 'contextCompaction'
        && (!p.turnId || p.turnId === turnId)) compactItem = true;
    if (event.method === 'turn/completed' && p.turn?.id === turnId) {
      if (compactItem && p.turn.status === 'completed' && !p.turn.error) finish(p.turn);
      else reject(Error('Compaction did not complete successfully'));
    }
  };
  const disconnected = () => reject(Error('Compaction outcome unknown; do not resend'));
  client.on('notification', notification); client.on('disconnected', disconnected);
  try {
    await client.call('thread/compact/start', { threadId }, null);
    update({ compactionAccepted: true });
    return await done;
  } finally {
    client.off('notification', notification); client.off('disconnected', disconnected);
  }
}

export async function repairImageHistory({ client, snapshot, initial, directory, allowed,
  dryRun = false, prepare = prepareImageReferences, replace = replaceArchivedImages,
  compact = compactImages, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') }) {
  const id = initial.thread.id, failedTurnId = initial.turns[0]?.id;
  const key = imageEpisode(id, failedTurnId), base = path.join(directory, 'image-history');
  const permitFile = confirmationPath(directory, id, failedTurnId);
  if (!fs.existsSync(permitFile)) return { action: 'image-cause-unconfirmed' };
  const permit = readJson(permitFile), decision = permitDecision(initial, permit);
  if (decision !== 'confirmed-image-episode') return { action: decision };
  const permitted = async () => {
    try { checkedPin(permit.evidence); return isDeepStrictEqual(readJson(permitFile), permit) && await allowed(); }
    catch { return false; }
  };
  const operationDirectory = path.join(base, 'operations', key), journal = path.join(operationDirectory, 'operation.json');
  if (fs.existsSync(journal)) return { action: 'image-episode-already-recorded', phase: readJson(journal).phase };
  if (!await permitted()) return { action: 'config-stopped' };
  if (dryRun) return { action: 'would-repair-confirmed-image-history' };
  const state = { schemaVersion: 1, operationId: crypto.randomUUID(), threadId: id, failedTurnId,
    phase: 'prepared', createdAt: new Date().toISOString() };
  try { exclusiveJson(journal, state); }
  catch (error) { if (error.code === 'EEXIST') return { action: 'image-episode-already-recorded' }; throw error; }
  const update = patch => { Object.assign(state, patch); saveJson(journal, state); };
  const same = s => permitDecision(s, permit) === 'confirmed-image-episode';
  const check = async () => {
    if (!await permitted()) throw Error('Recovery stopped, excluded, or confirmation revoked');
    const fresh = await snapshot(id);
    if (!same(fresh) || !await permitted()) throw Error('Target or confirmation changed');
    return fresh;
  };
  let archiveKnown = false, restored = false, replacementStarted = false;
  try {
    let fresh = await check();
    rolloutUnder(fresh.thread.path, path.join(codexHome, 'sessions'), id);
    const children = await listPages(client, 'thread/list', { archived: false, ancestorThreadId: id,
      sourceKinds, useStateDbOnly: true });
    if (children.length) throw Error('Archive would affect descendants; no history mutation');
    update({ phase: 'session-dispatching' });
    const session = await client.call('thread/resume', { threadId: id, excludeTurns: true }, null);
    if (session.thread?.id !== id || !isDeepStrictEqual(resumeSettings(session), permit.settings)) {
      throw Error('Original settings changed');
    }
    fresh = await check();
    const sourcePath = rolloutUnder(fresh.thread.path, path.join(codexHome, 'sessions'), id);
    update({ phase: 'preparing-references' });
    const manifest = await prepare({ sourcePath, outputPath: path.join(operationDirectory, 'candidate.jsonl'),
      assetDirectory: path.join(base, 'images', id) });
    update({ manifest });
    if (!manifest.replacements.length) { update({ phase: 'no-embedded-images' }); return { action: state.phase }; }
    await check();
    // Re-read descendant scope immediately before the archive mutation.
    if ((await listPages(client, 'thread/list', { archived: false, ancestorThreadId: id,
      sourceKinds, useStateDbOnly: true })).length) throw Error('Descendant scope changed');
    if (!await permitted()) throw Error('Recovery stopped before archive');
    update({ phase: 'archive-dispatching' });
    await client.call('thread/archive', { threadId: id }, null);
    archiveKnown = true;
    update({ phase: 'archive-accepted' });
    const [archived, loaded, listed] = await Promise.all([
      snapshot(id), listPages(client, 'thread/loaded/list', {}),
      listPages(client, 'thread/list', { archived: true, useStateDbOnly: true, sourceKinds }),
    ]);
    if (loaded.some(t => (typeof t === 'string' ? t : t.id) === id) || !listed.some(t => t.id === id)
        || !isDeepStrictEqual(repairIdentity(archived.thread), permit.identity)
        || archived.turns[0]?.id !== failedTurnId || archived.goal !== null) throw Error('Archive unload not confirmed');
    const archiveRoot = path.join(codexHome, 'archived_sessions');
    const archivePath = rolloutUnder(archived.thread.path, archiveRoot, id);
    if (!await permitted()) throw Error('Recovery stopped before replacement');
    update({ phase: 'replace-dispatching', archivePath });
    replacementStarted = true;
    const proof = await replace({ operationId: state.operationId, threadId: id, manifest, archiveRoot,
      archivePath, backupPath: path.join(path.dirname(archivePath), '.image-original-' + state.operationId + '.jsonl'),
      resultPath: path.join(operationDirectory, 'replace-result.json') }, operationDirectory);
    update({ phase: 'replaced-verified', proof });
    // Restore visibility even if the owner stops automatic work after the swap.
    update({ phase: 'unarchive-dispatching' });
    await client.call('thread/unarchive', { threadId: id }, null);
    restored = true; archiveKnown = false;
    update({ phase: 'unarchive-accepted' });
    if (!await permitted()) { update({ phase: 'stopped-after-restore' }); return { action: state.phase }; }
    update({ phase: 'reload-dispatching' });
    const reloaded = await client.call('thread/resume', { threadId: id, excludeTurns: true }, null);
    if (reloaded.thread?.id !== id || !isDeepStrictEqual(resumeSettings(reloaded), permit.settings)) {
      throw Error('Restored settings differ; no compaction or continuation');
    }
    await check();
    update({ phase: 'compact-dispatching' });
    const completed = await compact(client, id, update);
    update({ phase: 'compact-completed', compactionTurnId: completed.id });
    fresh = await snapshot(id);
    if (!await permitted() || fresh.goal !== null || fresh.thread.status?.type === 'active'
        || fresh.turns[0]?.id !== completed.id || fresh.turns[0].status !== 'completed'
        || !isDeepStrictEqual(repairIdentity(fresh.thread), permit.identity)) {
      update({ phase: 'changed-after-compaction-no-start' }); return { action: state.phase };
    }
    const finalSession = await client.call('thread/resume', { threadId: id, excludeTurns: true }, null);
    if (!isDeepStrictEqual(resumeSettings(finalSession), permit.settings)) throw Error('Permissions changed before continuation');
    fresh = await snapshot(id);
    if (!await permitted() || fresh.goal !== null || fresh.thread.status?.type === 'active'
        || fresh.turns[0]?.id !== completed.id || fresh.turns[0].status !== 'completed'
        || !isDeepStrictEqual(repairIdentity(fresh.thread), permit.identity)) {
      update({ phase: 'changed-before-continuation-no-start' }); return { action: state.phase };
    }
    // The cold resume above compared permissions as well as metadata. No settings
    // overrides or goal activation are used anywhere in this path.
    update({ phase: 'continuation-dispatching' });
    const receipt = await client.call('turn/start', { threadId: id,
      clientUserMessageId: 'image-history-recovery:' + key,
      input: [{ type: 'text', text: continuation, text_elements: [] }] }, null);
    if (!receipt.turn?.id) throw Error('Missing continuation identity');
    update({ phase: 'accepted', acceptedTurnId: receipt.turn.id });
    return { action: 'image-recovery-accepted', acceptedTurnId: receipt.turn.id, operationId: state.operationId };
  } catch (error) {
    const failedPhase = state.phase;
    // A known archive followed by a failure before any file replacement may be
    // safely unarchived. Ambiguous replacement/RPC outcomes require inspection.
    if (archiveKnown && (!replacementStarted || error.notReplaced === true) && !restored) {
      update({ phase: 'cleanup-unarchive-dispatching', failedPhase });
      try {
        await client.call('thread/unarchive', { threadId: id }, null);
        update({ phase: 'aborted-restored', error: error.message });
        return { action: state.phase };
      } catch { /* preserve unknown fence below */ }
    }
    update({ phase: 'unknown-or-aborted-no-resend', failedPhase, error: error.message });
    return { action: state.phase, operationId: state.operationId };
  }
}
