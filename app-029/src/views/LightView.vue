<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import PanelPreview from '../components/PanelPreview.vue'
import { computeLed, ledRows } from '../logic/led'
import { applyLedModule } from '../logic/materials'
import { getProject } from '../logic/store'
import { useSession } from '../logic/useSession'
import type { Project } from '../logic/types'

const route = useRoute()
const loaded = ref<Project | null>(getProject(String(route.params.id)))
const session = useSession(loaded)
const project = computed(() => loaded.value)
const layout = session.layout
const preset = session.preset

const led = computed(() =>
  project.value && layout.value
    ? computeLed(layout.value.ledLengthMm, project.value.led, preset.value.psu)
    : null
)

const rows = computed(() => (layout.value && project.value ? ledRows(layout.value.chars, project.value.led) : []))
const totalLumen = computed(() => (led.value ? led.value.modules * project.value!.led.moduleLumen : 0))

function applyModule(id: string): void {
  if (!project.value) return
  const m = preset.value.ledModules.find((x) => x.id === id)
  project.value.ledModuleId = id
  // 换规格：间距 / 单颗功率 / 亮度必须随规格一起带过去，重算模组数、额定功率与密度提示
  if (m) project.value.led = applyLedModule(project.value.led, m)
}

/**
 * 布点密度提示：间距要相对「实际排出来的字号」评估，
 * 间距/字号太大则中间发暗（偏稀），太小则浪费且发热（偏密）。
 * 改字号、改间距都会即时重判，而不是永远显示「合适」。
 */
const grade = computed<{ text: string; cls: string } | null>(() => {
  if (!led.value || !project.value || !layout.value || led.value.modules === 0) return null
  const spacing = project.value.led.moduleSpacingMm
  const size = layout.value.sizeMm
  const ratio = spacing / Math.max(1, size)
  if (ratio > 0.75) {
    return { text: `模组间距 ${spacing}mm 相对字号 ${size}mm 偏大（比值 ${ratio.toFixed(2)}），布点偏稀，字心可能发暗，建议减小间距或换小间距规格`, cls: 'warn' }
  }
  if (ratio < 0.2) {
    return { text: `模组间距 ${spacing}mm 相对字号 ${size}mm 偏小（比值 ${ratio.toFixed(2)}），布点偏密，浪费且易发热，建议加大间距`, cls: 'warn' }
  }
  return { text: `模组间距 ${spacing}mm / 字号 ${size}mm（比值 ${ratio.toFixed(2)}），布点密度合适`, cls: 'ok' }
})
</script>

<template>
  <div class="page">
    <div v-if="!project" class="card">
      <h1>项目不存在</h1>
      <router-link to="/">返回项目列表</router-link>
    </div>

    <template v-else>
      <div class="split">
        <section class="card">
          <header>
            <h1>LED 与电源计算</h1>
            <span class="hint">{{ project.name }}</span>
          </header>

          <div class="field">
            <label>模组规格预设</label>
            <div class="ctl">
              <select :value="project.ledModuleId" @change="applyModule(($event.target as HTMLSelectElement).value)">
                <option v-for="m in preset.ledModules" :key="m.id" :value="m.id">{{ m.spec }}</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>模组间距（mm）</label>
            <div class="ctl"><input type="number" v-model.number="project.led.moduleSpacingMm" min="20" step="10" /></div>
          </div>
          <div class="field">
            <label>单模组功率（W）</label>
            <div class="ctl"><input type="number" v-model.number="project.led.modulePowerW" min="0.05" step="0.01" /></div>
          </div>
          <div class="field">
            <label>单模组亮度（lm）</label>
            <div class="ctl"><input type="number" v-model.number="project.led.moduleLumen" min="5" step="5" /></div>
          </div>
          <div class="field">
            <label>安全系数</label>
            <div class="ctl">
              <input type="number" v-model.number="project.led.safetyFactor" min="1" max="2" step="0.05" />
              <span class="muted">默认 1.2</span>
            </div>
          </div>
          <div class="field">
            <label>电源效率</label>
            <div class="ctl">
              <input type="number" v-model.number="project.led.psuEfficiency" min="0.5" max="1" step="0.01" />
              <span class="muted">默认 0.85</span>
            </div>
          </div>

          <h3 style="margin-top: 14px">计算公式（可复算）</h3>
          <div class="formula">总布点长度 L = Σ 每个连通域的外轮廓周长（不含内孔）= {{ layout?.ledLengthMm ?? 0 }} mm
模组数 N = ceil(L / 模组间距) = ceil({{ led?.perimeterTotalMm ?? 0 }} / {{ project.led.moduleSpacingMm }}) = {{ led?.modules ?? 0 }}
额定功率 P = N × 单模组功率 × 安全系数 = {{ led?.modules ?? 0 }} × {{ project.led.modulePowerW }} × {{ project.led.safetyFactor }} = {{ led?.ratedW ?? 0 }} W
电源功率 = P / 电源效率 = {{ led?.ratedW ?? 0 }} / {{ project.led.psuEfficiency }} = {{ led?.recommendedW ?? 0 }} W
标准档位：{{ preset.psu.tiers.join(' / ') }} W 向上取</div>

          <ul class="notes" style="margin-top: 10px">
            <li>模组数向上取整会显式提示补足数量，不静默取整。</li>
            <li>电源按标准档位向上取；超出常用档位时提示多电源并联/分区供电。</li>
            <li>布点长度取外轮廓（内孔不计），与车间实际走线一致。</li>
          </ul>
        </section>

        <section>
          <div class="card">
            <header>
              <h2>计算结果</h2>
              <span class="hint">当前项目材料预设置</span>
            </header>
            <div v-if="led" class="metrics">
              <span class="k">总布点长度 L</span><span class="v">{{ led.perimeterTotalMm }} mm</span>
              <span class="k">理论布点数（小数）</span><span class="v">{{ led.exactModules }}</span>
              <span class="k">模组数量 N</span><span class="v">{{ led.modules }} 只</span>
              <span class="k">向上取整补足</span><span class="v">{{ led.extraModules }} 只</span>
              <span class="k">末段余长</span><span class="v">{{ led.spareMm }} mm</span>
              <span class="k">额定功率（含安全系数）</span><span class="v">{{ led.ratedW }} W</span>
              <span class="k">电源需求功率</span><span class="v">{{ led.recommendedW }} W</span>
              <span class="k">建议电源</span><span class="v">{{ led.suggestedPsu }}</span>
              <span class="k">总光通量（估算）</span><span class="v">{{ totalLumen }} lm</span>
            </div>
            <div class="banner info" v-if="led">{{ led.note }}</div>
            <div class="banner" :class="grade?.cls ?? 'warn'" v-if="grade">{{ grade.text }}</div>
            <div class="banner warn" v-if="led && led.psuCount > 1">
              需 {{ led.psuCount }} 台电源：建议按字/按区分区供电，每区单独回路，避免长距离压降。
            </div>
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>布点示意（按模组间距在外轮廓上布点）</h2>
              <span class="hint">黄色圆点 = 模组位置</span>
            </header>
            <PanelPreview
              v-if="layout"
              :project="project"
              :layout="layout"
              :show-led="true"
              :show-dims="true"
              :show-margins="false"
            />
          </div>

          <div class="card" style="margin-top: 14px">
            <header>
              <h2>逐字用量明细</h2>
              <span class="hint">周长按各字实际字号折算；模组数按每字外轮廓分别向上取整</span>
            </header>
            <table>
              <thead>
                <tr>
                  <th>字符</th>
                  <th class="num">笔画块数</th>
                  <th class="num">外轮廓周长 mm</th>
                  <th class="num">模组数</th>
                  <th class="num">功率 W</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in rows" :key="i">
                  <td>{{ r.char }}</td>
                  <td class="num">{{ r.blocks }}</td>
                  <td class="num">{{ r.outerPerimeterMm }}</td>
                  <td class="num">{{ r.modules }}</td>
                  <td class="num">{{ r.ratedW }}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td>合计</td>
                  <td class="num">{{ rows.reduce((s, r) => s + r.blocks, 0) }}</td>
                  <td class="num">{{ led?.perimeterTotalMm ?? 0 }}</td>
                  <td class="num">{{ rows.reduce((s, r) => s + r.modules, 0) }}</td>
                  <td class="num">{{ rows.reduce((s, r) => s + r.ratedW, 0).toFixed(2) }}</td>
                </tr>
              </tfoot>
            </table>
            <p class="muted">
              各字周长按实际字号折算后列出，合计等于整排总布点长度。逐字模组数各自向上取整，之和可能略大于整排按总长一次取整的模组数（整排取整更省料），故逐字功率之和也可能略大于总额定功率；报价以总长度一次计算为准。
            </p>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>