/**
 * LED 与电源计算（规格书第 8 节公式，界面同步展示公式，可复算）：
 *   L = Σ 每个连通域的外轮廓周长（不含内孔）
 *   N = ceil(L / 模组间距)
 *   P = N × 单模组功率 × 安全系数
 *   电源功率 = P / 电源效率，再按标准档位向上取
 * 取整与超档一律显式提示，不许静默。
 */

import type { LedCfg, LedResult } from './types'
import type { PlacedChar } from './layout'

export interface PsuPreset {
  spec: string
  efficiency: number
  safetyFactor: number
  tiers: number[]
  pricePerWattCents: number
  parallelNote: string
}

export function computeLed(perimeterTotalMm: number, cfg: LedCfg, psu: PsuPreset): LedResult {
  const L = Math.max(0, perimeterTotalMm)
  const spacing = Math.max(1, cfg.moduleSpacingMm)
  const exact = L / spacing
  const base = Math.floor(exact + 1e-9)
  const modules = Math.ceil(exact - 1e-9)
  const extraModules = modules - base
  const ratedW = modules * cfg.modulePowerW * cfg.safetyFactor
  const needW = ratedW / Math.max(0.1, cfg.psuEfficiency)
  const tiers = [...psu.tiers].sort((a, b) => a - b)
  const maxTier = tiers.length ? tiers[tiers.length - 1] : 400
  const tier = tiers.find((t) => t >= needW - 1e-9)
  const psuCount = tier ? 1 : Math.max(2, Math.ceil(needW / maxTier))
  const psuUnitW = tier ?? maxTier
  const spareMm = Math.max(0, L - (modules - 1) * spacing)
  const notes: string[] = []
  if (extraModules > 0) notes.push(`因布点不足补足 ${extraModules} 个模组（${exact.toFixed(1)} 个 → 向上取整 ${modules} 个）`)
  if (tier) notes.push(`电源功率 ${needW.toFixed(1)}W → 取标准档位 ${tier}W`)
  else notes.push(psu.parallelNote)
  if (modules === 0) notes.push('当前无布点长度（尚未输入文字或字体未就绪）')
  return {
    perimeterTotalMm: Math.round(L * 10) / 10,
    modules,
    ratedW: Math.round(ratedW * 100) / 100,
    recommendedW: Math.round(needW * 10) / 10,
    suggestedPsu: `${psuUnitW}W × ${psuCount} 台`,
    note: notes.join('；'),
    extraModules,
    exactModules: Math.round(exact * 100) / 100,
    spareMm: Math.round(spareMm * 10) / 10,
    psuCount,
    psuUnitW
  }
}

export interface LedCharRow {
  char: string
  blocks: number
  outerPerimeterMm: number
  modules: number
  ratedW: number
}

/**
 * 逐字 LED 用量明细。
 * 字形几何按「本地单位 1000 em」缓存，实际字号只做线性缩放：
 * 周长必须先乘该字的实际缩放比 k = inkW / geom.inkW（= 字号/1000）折算成 mm，
 * 不能直接拿本地单位当 mm，否则逐字数值会比整排合计大一大截、与字号脱钩。
 */
export function ledRows(chars: PlacedChar[], cfg: LedCfg): LedCharRow[] {
  const spacing = Math.max(1, cfg.moduleSpacingMm)
  return chars.map((c) => {
    const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
    const perimeterMm = c.geom.outerPerimeter * k
    // 与 computeLed 同一取整口径（整数倍时不静默多取 1 个）
    const modules = Math.ceil(perimeterMm / spacing - 1e-9)
    return {
      char: c.char,
      blocks: c.geom.strokeBlocks,
      outerPerimeterMm: Math.round(perimeterMm * 10) / 10,
      modules,
      // 功率按「该字实际分配的模组数」计，不再按周长直乘（否则逐字功率之和远超总额定功率）
      ratedW: Math.round(modules * cfg.modulePowerW * cfg.safetyFactor * 100) / 100
    }
  })
}

export interface LedDot {
  x: number
  y: number
}

/**
 * LED 布点示意：沿每个连通域的外轮廓，按模组间距做「弧长等距」布点。
 * 输入为已排版字形（面板 mm 坐标），用于预览叠加显示。
 *
 * 关键点：
 * - 轮廓是字形本地单位（1000 em），必须先按该字实际缩放比 k 折算成 mm，
 *   间距也是 mm，不能拿「顶点索引等间隔抽点」冒充弧长等距
 *   （顶点疏密随字形曲率变化，抽点会在复杂笔画处挤成一团）；
 * - 在闭合多边形上按累计弧长步进，相邻点的弧长距离恒为 spacing，
 *   首尾对齐（闭合环不重复画起点），间距调大调小疏密立即跟着变；
 * - 短于一个间距的小轮廓至少布 1 点。
 */
export function ledDots(chars: PlacedChar[], spacingMm: number): LedDot[] {
  const dots: LedDot[] = []
  const spacing = Math.max(1, spacingMm)
  for (const c of chars) {
    if (c.missing || c.blank) continue
    const k = c.geom.inkW > 0 ? c.inkW / c.geom.inkW : 0
    // mm 坐标 = c.x + (轮廓点 - bbox 原点) × k，
    // 必须与 PanelPreview 的 translate(x,y) scale(k) translate(-bbox.x0,-bbox.y0) 一致。
    const ox = c.x - c.geom.bbox.x0 * k
    const oy = c.y - c.geom.bbox.y0 * k
    // 只取外轮廓（非孔）连通域
    const outerRings = c.geom.rings.filter((r) => !r.isHole)
    for (const r of outerRings) {
      const ring = r.ring
      const n = ring.length
      if (n === 0) continue
      // 闭合环总弧长（mm）
      let total = 0
      for (let i = 0, j = n - 1; i < n; j = i++) {
        total += Math.hypot(ring[i].x - ring[j].x, ring[i].y - ring[j].y) * k
      }
      if (total <= 1e-6) {
        dots.push({ x: ox + ring[0].x * k, y: oy + ring[0].y * k })
        continue
      }
      const count = Math.max(1, Math.round(total / spacing))
      const step = total / count
      // 在环上沿累计弧长放置 count 个点（首尾不重复）
      let segStart = ring[n - 1]
      let segEnd = ring[0]
      let segLen = Math.hypot(segEnd.x - segStart.x, segEnd.y - segStart.y) * k
      let acc = 0 // 当前线段起点的累计弧长
      let si = 0
      for (let d = 0; d < count; d++) {
        const target = d * step
        while (si < n - 1 && acc + segLen < target - 1e-9) {
          acc += segLen
          si++
          segStart = segEnd
          segEnd = ring[si + 1]
          segLen = Math.hypot(segEnd.x - segStart.x, segEnd.y - segStart.y) * k
        }
        const t = segLen > 1e-9 ? (target - acc) / segLen : 0
        dots.push({
          x: ox + (segStart.x + (segEnd.x - segStart.x) * t) * k,
          y: oy + (segStart.y + (segEnd.y - segStart.y) * t) * k
        })
      }
    }
  }
  return dots
}