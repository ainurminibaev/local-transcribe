// Persist the outbox separately from jobs: worker saves must not overwrite receipts.
export const terminalStates = new Set(['completed', 'failed', 'return_failed', 'cancelled']);
export async function alreadyAccepted(threads, threadId, marker) {
  if (JSON.stringify(await threads.queuedMessages.list({threadId})).includes(marker)) return true;
  let cursor;
  const seen = new Set();
  for (;;) {
    const page = await threads.timeline({threadId, segmentLimit:'100', deferContent:'false',
      ...(cursor ? {beforeAnchorId:cursor.anchorId,beforeAnchorSeq:String(cursor.anchorSeq)} : {})});
    if (JSON.stringify(page.rows).includes(marker)) return true;
    cursor = page.timelinePage?.olderCursor;
    if (!cursor) return false;
    const key = JSON.stringify(cursor);
    if (seen.has(key)) throw new Error('Notification history cursor did not advance');
    seen.add(key);
  }
}
export async function notifyJob({kv,threads,job,now=Date.now()}) {
  if (!job.notifyOnFinish || !job.threadId || !terminalStates.has(job.state)) return;
  // Delivery retry has its own terminal outcome and receipt.
  const key = 'notice:'+job.id+':'+job.state;
  let notice = await kv.get(key);
  if (notice?.status === 'sent' || notice?.status === 'suppressed' || notice?.retryAt > now) return;
  if (job.state === 'cancelled') {
    await kv.set(key,{status:'suppressed',reason:'cancelled',at:now});return;
  }
  const marker = '[local-transcribe:'+job.id+':'+job.state+']';
  const thread = await threads.get({threadId:job.threadId});
  const detail = thread.thread ?? thread;
  if (detail.archivedAt || detail.deletedAt) {
    await kv.set(key,{status:'suppressed',reason:'thread-unavailable',at:now});return;
  }
  if (notice?.status === 'sending' && await alreadyAccepted(threads,job.threadId,marker)) {
    await kv.set(key,{...notice,status:'sent',recovered:true,sentAt:now});return;
  }
  notice = {...notice,status:'sending',marker,attemptedAt:now,retryAt:now+60000};
  await kv.set(key,notice);
  const text = `${marker}\nЛокальная транскрибация: ${job.state}. Job ID: ${job.id}. `+
    `Прочитай local_transcribe_status один раз. `+
    (job.state==='completed'
      ? 'Проверь готовые файлы и выполни исходное поручение пользователя: транскрипт, а если запрошены — итоги и PDF. '
      : 'Сообщи причину и доступные файлы. return_failed означает проблему доставки: повторяй доставку, а не ASR. ')+
    'Не запускай цикл опроса или новую расшифровку без основания. Это служебное уведомление, подтверждать его отдельно не нужно.';
  try {
    // Queue behind a busy turn, never interrupt it. Accepted queue rows belong to BB.
    const receipt = await threads.send({threadId:job.threadId,mode:'queue',input:[{type:'text',text}]});
    if (!receipt?.ok) throw new Error('BB did not confirm notification acceptance');
    await kv.set(key,{...notice,status:'sent',sentAt:now,delivery:receipt.delivery,
      queuedMessageId:receipt.queuedMessage?.id ?? null});
  } catch (error) {
    // An ambiguous error may happen after acceptance. Recover from BB queue/history
    // before resending, including after a plugin/server restart.
    await kv.set(key,{...notice,error:String(error)});
  }
}
