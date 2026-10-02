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

/** 逐字 LED 用量明细 */
export function ledRows(chars: PlacedChar[], cfg: LedCfg): LedCharRow[] {
  return chars.map((c) => ({
    char: c.char,
    blocks: c.geom.strokeBlocks,
    outerPerimeterMm: Math.round(c.geom.outerPerimeter * 10) / 10,
    modules: Math.ceil(c.geom.outerPerimeter / Math.max(1, cfg.moduleSpacingMm)),
    ratedW: Math.round(c.geom.outerPerimeter * cfg.modulePowerW * cfg.safetyFactor * 100) / 100
  }))
}

export interface LedDot {
  x: number
  y: number
}

/**
 * LED 布点示意：沿每个连通域的外轮廓按模组间距均匀布点。
 * 输入为已排版字形（面板 mm 坐标），用于预览叠加显示。
 */
export function ledDots(chars: PlacedChar[], spacingMm: number): LedDot[] {
  const dots: LedDot[] = []
  const spacing = Math.max(20, spacingMm)
  for (const c of chars) {
    if (c.missing || c.blank) continue
    const k = c.inkW / Math.max(1e-6, c.geom.inkW)
    const ox = c.x - c.geom.bbox.x0 * k
    const oy = c.y - c.geom.bbox.y0 * k
    // 只取外轮廓（非孔）连通域
    const outerRings = c.geom.rings.filter((r) => !r.isHole)
    for (const r of outerRings) {
      const ring = r.ring
      // 沿周长按顶点等间隔抽点
      const step = Math.max(1, Math.round(ring.length / Math.max(1, Math.round((r.perimeter * k) / spacing))))
      for (let i = 0; i < ring.length; i += step) {
        dots.push({ x: ox + ring[i].x * k, y: oy + ring[i].y * k })
      }
    }
  }
  return dots
}