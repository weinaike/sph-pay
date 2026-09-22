/**
 * MP4 头解析（只读 moov）：时长/分辨率/体积元数据的自托管来源。
 * 背景：sph-api 解析载荷的 content_details.video 全为零值（实测 2026-09-22），
 * 微信匿名 get_feed_info 也无 mediaList —— 客户端原靠 ffprobe，现改为服务端
 * Range 拉 moov 头解析 mvhd/tkhd（腾讯 CDN mp4 实测 faststart，moov 在前）。
 * 任何失败都返回全 null（非致命：deliver 不因此报错，只是缺元数据）。
 */

const MAX_MOOV_BYTES = 4 * 1024 * 1024; // 4K 长视频的 moov 也远小于此；超出视为异常放弃

/** 拉指定字节区间（Range: bytes=a-b），返回 Buffer；非 206/200 或中断抛错 */
async function fetchRange(cdnUrl, start, end, timeoutMs, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(cdnUrl, {
    headers: { Range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`CDN Range ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 解析 mp4 元数据：{ duration_s, width, height } 或全 null。
 * duration_s 向下取整；width/height 取第一个非零 tkhd（视频轨）。
 */
export async function probeMp4Meta(cdnUrl, { timeoutMs = 10_000, fetchImpl = globalThis.fetch } = {}) {
  try {
    // 第一段：足够走过 ftyp 等前置 box 读到 moov 的 size（moov 实测紧跟 ftyp）
    let head = await fetchRange(cdnUrl, 0, 16 * 1024 - 1, timeoutMs, fetchImpl);
    const moov = findTopLevelMoov(head);
    if (!moov) return nulls();

    // moov 超出首段 → 按 box size 精确补拉（+8 = box 头）
    if (8 + moov.size > head.length) {
      if (moov.size > MAX_MOOV_BYTES) return nulls();
      head = await fetchRange(cdnUrl, 0, 8 + moov.size - 1, timeoutMs, fetchImpl);
    }
    return parseMoov(head.subarray(moov.offset + 8, moov.offset + 8 + moov.size));
  } catch {
    return nulls();
  }
}

/** 走顶层 box 链找 moov 的 {offset, size}；容器截断/size 异常返回 null */
function findTopLevelMoov(buf) {
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (size < 8) return null; // size 异常（含 0/1 扩展形式，此场景不会出现）
    if (type === 'moov') return { offset: i, size };
    i += size;
  }
  return null;
}

/** 在完整 moov 载荷内解析 mvhd(duration) 与首个非零 tkhd(width/height) */
function parseMoov(moov) {
  let durationS = null;
  let width = null;
  let height = null;

  for (const box of iterBoxes(moov)) {
    if (box.type === 'mvhd' && durationS === null) {
      durationS = parseMvhd(box.payload);
    } else if (box.type === 'trak' && (width === null || height === null)) {
      const tkhd = iterBoxes(box.payload).find(b => b.type === 'tkhd');
      if (tkhd) {
        const dim = parseTkhd(tkhd.payload);
        if (dim.width > 0 && dim.height > 0) ({ width, height } = dim);
      }
    }
  }
  return { durationS, width, height };
}

/** 逐 box 迭代（只走一层）：{type, payload}；size 异常即停 */
function* iterBoxes(buf) {
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (size < 8 || i + size > buf.length) return;
    yield { type, payload: buf.subarray(i + 8, i + size) };
    i += size;
  }
}

function parseMvhd(p) {
  const version = p.readUInt8(0);
  // version 0: version(1) flags(3) created(4) modified(4) timescale(4) duration(4)
  // version 1: version(1) flags(3) created(8) modified(8) timescale(4) duration(8)
  if (version === 1) {
    const timescale = p.readUInt32BE(20);
    const duration = Number(p.readBigUInt64BE(24));
    return timescale > 0 ? Math.floor(duration / timescale) : null;
  }
  const timescale = p.readUInt32BE(12);
  const duration = p.readUInt32BE(16);
  return timescale > 0 ? Math.floor(duration / timescale) : null;
}

/** tkhd 尾部的 width/height 是 16.16 定点数（>>16 取整） */
function parseTkhd(p) {
  const version = p.readUInt8(0);
  // version 0 载荷 84 字节、version 1 载荷 96 字节，width/height 恒在末尾 8 字节
  const w = p.readInt32BE(p.length - 8);
  const h = p.readInt32BE(p.length - 4);
  return { width: w >> 16, height: h >> 16 };
}

const nulls = () => ({ durationS: null, width: null, height: null });
