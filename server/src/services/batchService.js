/**
 * 批量解析编排（POST /api/resolve/batch）：替代 skill 端 batch_resolve.py 的
 * 客户端逐条节拍（6.5s/条 + 429 退避）——服务端内网直连 sph-api，无限流包袱。
 *
 * 计费语义与单条 /api/resolve 完全一致：24h 同短链免重扣、原子扣减、单条失败
 * 自动返还并继续。额度耗尽：余下条目整批标记 skipped（不再逐条撞 402）。
 *
 * 状态落 sqlite（resolve_batches / resolve_batch_items），进程重启后由
 * resumeInterruptedBatches() 续跑：已扣费未出结果的条目凭 charged=1 免重扣重解析。
 */
import { batches, users, usageLog } from '../db.js';
import { resolveOnce } from './resolveService.js';
import { newBatchId } from '../util/id.js';

const DEDUP_WINDOW_S = 24 * 3600;
const running = new Set(); // 批内防重入（同批只有一个 runner）

export function createBatch(userToken, urls) {
  const id = newBatchId();
  batches.create({ id, userToken, urls });
  kick(id);
  return { id, total: urls.length };
}

/** 启动一个批次 runner（不 await：调用方立即返回 batch_id） */
export function kick(batchId) {
  if (running.has(batchId)) return;
  running.add(batchId);
  runBatch(batchId).catch(e => {
    // runner 崩溃不致命：条目留在 pending/resolving，下一进程重启或下次触碰时续跑
    console.error(`[batch] ${batchId} runner 异常: ${e.message}`);
  }).finally(() => running.delete(batchId));
}

/** 进程启动时恢复中断批次：resolving 归位 pending 后续跑（幂等，配 kick 防重入） */
export function resumeInterruptedBatches() {
  const stalled = batches.listRunning();
  for (const b of stalled) {
    for (const it of batches.items(b.id)) {
      if (it.status === 'resolving') {
        batches.transitionItem(b.id, it.idx, 'resolving', 'pending', { error: null });
      }
    }
    console.log(`[batch] 恢复中断批次 ${b.id}（${b.total} 条）`);
    kick(b.id);
  }
  return stalled.length;
}

async function runBatch(batchId) {
  for (const it of batches.items(batchId)) {
    if (it.status !== 'pending') continue;
    const ok = await processItem(batchId, it);
    if (!ok) break; // 额度耗尽：余下已整批 skip
  }
  batches.finishIfSettled(batchId);
}

/**
 * 处理单条：pending → resolving → resolved | refunded | skipped。
 * 返回 false 表示额度耗尽（整批收尾），true 表示继续下一条。
 */
async function processItem(batchId, it) {
  if (!batches.transitionItem(batchId, it.idx, 'pending', 'resolving')) return true; // 已被并发处理
  const b = batches.get(batchId);
  const token = b.user_token;

  // 扣费：24h 去重 → 原子扣减（重启恢复的已扣费条目 charged=1，跳过）
  let logId = it.usage_log_id || null;
  if (!it.charged) {
    const deduped = usageLog.chargedSince('resolve', it.url, token, Math.floor(Date.now() / 1000) - DEDUP_WINDOW_S);
    if (!deduped) {
      if (!users.consumeLinkQuota(token)) {
        batches.transitionItem(batchId, it.idx, 'resolving', 'skipped', { error: 'no_link_quota' });
        batches.skipPending(batchId, 'no_link_quota');
        return false;
      }
      logId = usageLog.insert({ userToken: token, kind: 'resolve', target: it.url });
      batches.transitionItem(batchId, it.idx, 'resolving', 'resolving', { charged: 1, usage_log_id: logId });
    }
  }

  try {
    const r = await resolveOnce(it.url, { timeoutMs: 45_000 });
    batches.transitionItem(batchId, it.idx, 'resolving', 'resolved', {
      cdn_url: r.cdnUrl, title: r.title, file_size: r.fileSize,
      duration_s: r.durationS ?? null, width: r.width ?? null, height: r.height ?? null,
      like_count: r.likeCount ?? 0, fav_count: r.favCount ?? 0,
      forward_count: r.forwardCount ?? 0, comment_count: r.commentCount ?? 0,
    });
    return true;
  } catch (e) {
    // 失败返还：额度退回 + 台账标记（与单条 /api/resolve 语义一致），继续下一条。
    // 先查台账防双退：崩溃可能发生在「已返还未落状态」之间，恢复重跑再失败时不再退第二次
    if (logId != null && !usageLog.get(logId)?.refunded) {
      users.refundLinkQuota(token);
      usageLog.markRefunded(logId);
    }
    batches.transitionItem(batchId, it.idx, 'resolving', 'refunded', { error: e.message });
    return true;
  }
}
