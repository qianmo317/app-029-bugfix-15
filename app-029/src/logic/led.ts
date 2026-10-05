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

/** 模组规格预设（与 materials.json 的 ledModules 结构对应，这里只取需要的字段，避免与 materials.ts 互相依赖） */
export interface LedModuleSpecLike {
  id: string
  spacingMm: number
  powerW: number
  lumen: number
}

/**
 * 套用模组规格预设：切换模组时把该规格的「建议间距 / 单颗功率 / 单颗亮度」
 * 一起带入当前 LED 参数（安全系数、电源效率属于电源侧配置，不随模组规格变化）。
 */
export function applyLedModuleSpec(cfg: LedCfg, mod: LedModuleSpecLike): void {
  cfg.moduleSpacingMm = mod.spacingMm
  cfg.modulePowerW = mod.powerW
  cfg.moduleLumen = mod.lumen
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
 * 字形几何是 1000em 本地单位下缓存的，必须按「该字实际排版字号」折算成 mm
 * （逐字缩放系数 = 该字墨迹 mm / 几何墨迹宽），不能直接拿本地单位的周长，
 * 否则每行周长会比整排总长大出一截，模组数与功率也对不上整排合计。
 */
export function ledRows(chars: PlacedChar[], cfg: LedCfg): LedCharRow[] {
  const spacing = Math.max(1, cfg.moduleSpacingMm)
  return chars.map((c) => {
    const k = c.inkW / Math.max(1e-6, c.geom.inkW)
    const outerPerimeterMm = c.geom.outerPerimeter * k
    const modules = Math.ceil(outerPerimeterMm / spacing - 1e-9)
    return {
      char: c.char,
      blocks: c.geom.strokeBlocks,
      outerPerimeterMm: Math.round(outerPerimeterMm * 10) / 10,
      modules,
      ratedW: Math.round(modules * cfg.modulePowerW * cfg.safetyFactor * 100) / 100
    }
  })
}

export interface LedDot {
  x: number
  y: number
}

/**
 * LED 布点示意：沿每个连通域的外轮廓，严格按模组间距（弧长）均匀布点。
 * 输入为已排版字形（面板 mm 坐标），用于预览叠加显示。
 *
 * 做法：每条闭合外轮廓按「实际弧长」求周长，把它等分成 ceil(P/间距) 段，
 * 点落在弧长等分位置上（段内做线性插值）。这样：
 *  - 点间距真正等于设定的模组间距（调大/调小间距疏密立刻可见）；
 *  - 不依赖多边形顶点密度，曲线被字体离散成密集顶点时也不会在复杂字上挤成一团；
 *  - 起点偏移半个点距，避免首尾两点在轮廓闭合处重合。
 */
export function ledDots(chars: PlacedChar[], spacingMm: number): LedDot[] {
  const dots: LedDot[] = []
  const spacing = Math.max(1, spacingMm)
  for (const c of chars) {
    if (c.missing || c.blank) continue
    const k = c.inkW / Math.max(1e-6, c.geom.inkW)
    const ox = c.x - c.geom.bbox.x0 * k
    const oy = c.y - c.geom.bbox.y0 * k
    // 只取外轮廓（非孔）环
    for (const r of c.geom.rings) {
      if (r.isHole) continue
      const ring = r.ring
      const n = ring.length
      if (n < 2) continue
      // 预计算各段长度（mm）与前缀弧长
      const segLen = new Float64Array(n)
      const cum = new Float64Array(n + 1)
      for (let i = 0; i < n; i++) {
        const a = ring[i]
        const b = ring[(i + 1) % n]
        segLen[i] = Math.hypot(b.x - a.x, b.y - a.y) * k
        cum[i + 1] = cum[i] + segLen[i]
      }
      const perimeter = cum[n]
      if (perimeter <= 1e-9) continue
      const count = Math.max(1, Math.ceil(perimeter / spacing - 1e-9))
      const pitch = perimeter / count
      for (let i = 0; i < count; i++) {
        // 偏移半个点距，闭合处两端点之间也是一个 pitch，不会挤在一起
        let dist = (i + 0.5) * pitch
        if (dist >= perimeter) dist -= perimeter
        // 二分找到 dist 所在的段
        let lo = 0
        let hi = n - 1
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (cum[mid + 1] < dist) lo = mid + 1
          else hi = mid
        }
        const segL = segLen[lo]
        const t = segL > 1e-9 ? (dist - cum[lo]) / segL : 0
        const a = ring[lo]
        const b = ring[(lo + 1) % n]
        dots.push({ x: ox + (a.x + (b.x - a.x) * t) * k, y: oy + (a.y + (b.y - a.y) * t) * k })
      }
    }
  }
  return dots
}

export type LedDensityLevel = 'dense' | 'ok' | 'sparse'

export interface LedDensityGrade {
  level: LedDensityLevel
  text: string
}

/**
 * 布点密度提示：不能固定说「合适」，必须随设定间距与实际字号变化。
 * 判据一（与字的尺度比）：外轮廓布点间距取字号的 25%~75% 较合适——
 *   间距 > 75% 字号：沿轮廓灯点过稀，字内可能发暗、亮度不均；
 *   间距 < 25% 字号：灯点过密，浪费灯珠且集中发热。
 * 判据二（与所选模组规格的建议间距）：偏离 ±50% 给出过密/过稀提示。
 */
export function ledDensityGrade(spacingMm: number, charSizeMm: number, recommendedSpacingMm: number | null): LedDensityGrade | null {
  if (!(charSizeMm > 0) || !(spacingMm > 0)) return null
  const ratio = spacingMm / charSizeMm
  let level: LedDensityLevel
  if (ratio > 0.75) level = 'sparse'
  else if (ratio < 0.25) level = 'dense'
  else level = 'ok'

  if (recommendedSpacingMm && recommendedSpacingMm > 0) {
    if (spacingMm > recommendedSpacingMm * 1.5) level = 'sparse'
    else if (spacingMm < recommendedSpacingMm * 0.5) level = 'dense'
  }

  const ratioPct = Math.round(ratio * 100)
  const base = `当前字号 ${Math.round(charSizeMm)}mm、模组间距 ${spacingMm}mm（间距/字号 ≈ ${ratioPct}%）：`
  if (level === 'sparse') {
    return {
      level,
      text:
        base +
        `布点偏稀，建议间距不超过字号的 75%（${Math.round(charSizeMm * 0.75)}mm）` +
        (recommendedSpacingMm ? `，且不超过该模组建议间距 ${recommendedSpacingMm}mm 的 1.5 倍` : '') +
        '，否则字内发暗、亮度不均。'
    }
  }
  if (level === 'dense') {
    return {
      level,
      text:
        base +
        `布点偏密，建议间距不小于字号的 25%（${Math.round(charSizeMm * 0.25)}mm）` +
        (recommendedSpacingMm ? `，且不小于该模组建议间距 ${recommendedSpacingMm}mm 的一半` : '') +
        '，否则浪费灯珠且集中发热。'
    }
  }
  return {
    level,
    text:
      base +
      '布点密度合适（参考范围：字号的 25%~75%' +
      (recommendedSpacingMm ? `；该模组建议间距 ${recommendedSpacingMm}mm` : '') +
      '）。'
  }
}