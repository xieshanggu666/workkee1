<script setup>
import { ref, computed, onMounted, watch, reactive } from 'vue'
import { useParkStore, newRequestId } from '@/store/park'

const store = useParkStore()
onMounted(loadRideSlots)
watch(() => store.clock.tick, () => { if (tab.value === 'submit') loadRideSlots(true) })

const today = computed(() => store.clock.day)
const stats = computed(() => store.groupStats)

function errText(r, fallback = '操作失败，请稍后重试') {
  if (r?.ok) return ''
  const msg = r?.msg || fallback
  const tag = r?.code ? `〔${r.code}${r.reqId ? ' · ' + r.reqId : ''}〕` : ''
  return msg + tag
}

const tabs = [
  { k: 'submit', label: '领队报名' },
  { k: 'approve', label: '运营确认' },
  { k: 'service', label: '核销·结算·退团' },
  { k: 'all', label: '全部团单' }
]
const tab = ref('submit')

const dayTabs = [0, 1, 2]
const dayLabel = off => off === 0 ? '今天' : off === 1 ? '明天' : '后天'
const rideName = id => store.rides.find(r => r.id === id)?.name || `设施#${id}`

const STATUS_BADGE = {
  pending: { cls: 'b-pending', text: '待确认' },
  confirmed: { cls: 'b-confirmed', text: '已锁定' },
  active: { cls: 'b-active', text: '入园中' },
  settled: { cls: 'b-settled', text: '已结清' },
  cancelled: { cls: 'b-cancelled', text: '已取消' }
}
const LEG_BADGE = {
  pending: { cls: 'b-pending', text: '待确认' },
  locked: { cls: 'b-confirmed', text: '已锁名额' },
  checked: { cls: 'b-settled', text: '已核销' },
  noshow: { cls: 'b-cancelled', text: '爽约' },
  refunded: { cls: 'b-refund', text: '已退款' },
  routed: { cls: 'b-active', text: '已改期' }
}

// ============ 页签一：领队报名 ============
const form = reactive({
  leader_name: '', leader_phone: '', org: '', headcount: 10, deposit_rate: 30,
  dayOffset: 1
})
// 已选行程：[{scope, slot_id, ride_id, day, hour, price, ride_name}]
const itinerary = ref([])
const bookMsg = ref(null)
const booking = ref(false)
const bookReqId = ref(newRequestId())
const pickScope = ref('entry')
const pickRide = ref(0)
watch([() => form.leader_name, () => form.headcount, () => form.deposit_rate, () => form.dayOffset, itinerary], () => {
  bookReqId.value = newRequestId()
}, { deep: true })

const rideSlotsMap = ref({})
async function loadRideSlots(silent = false) {
  const rides = store.rides.filter(r => r.status === 'operating')
  const entries = await Promise.all(rides.map(r => store.rideSlots(r.id)))
  const map = {}
  entries.forEach((e, i) => { map[rides[i].id] = e.list || [] })
  rideSlotsMap.value = map
}
const pickDay = computed(() => today.value + form.dayOffset)
const pickEntrySlots = computed(() =>
  store.entrySlots.filter(s => s.day === pickDay.value).sort((a, b) => a.hour - b.hour))
const pickRideSlots = computed(() =>
  pickRide.value ? (rideSlotsMap.value[pickRide.value] || []).filter(s => s.day === pickDay.value).sort((a, b) => a.hour - b.hour) : [])

function pickSlotState(s) {
  if (s.status !== 'open') return { cls: 'closed', text: '已关闭' }
  if (s.day < today.value || (s.day === today.value && s.hour <= store.clock.hour)) return { cls: 'past', text: '已过期' }
  if (s.remain < form.headcount) return { cls: 'full', text: `余${s.remain}` }
  return { cls: 'open', text: `余 ${s.remain}` }
}
function addLeg(s) {
  const ride = pickScope.value === 'ride' ? store.rides.find(r => r.id === pickRide.value) : null
  if (pickScope.value === 'ride' && itinerary.value.some(l => l.slot_id === s.id)) { bookMsg.value = { ok: false, text: '该设施时段已在行程中' }; return }
  if (itinerary.value.some(l => l.day === s.day && l.hour === s.hour)) { bookMsg.value = { ok: false, text: '同一时刻只能安排一项行程' }; return }
  itinerary.value.push({
    scope: pickScope.value, slot_id: s.id, ride_id: ride?.id || null,
    day: s.day, hour: s.hour, price: ride?.price ?? +store.ticket, ride_name: ride?.name || ''
  })
  itinerary.value.sort((a, b) => a.hour - b.hour)
  bookMsg.value = null
}
function removeLeg(slotId) {
  itinerary.value = itinerary.value.filter(l => l.slot_id !== slotId)
  bookReqId.value = newRequestId()
}
const totalPrice = computed(() => itinerary.value.reduce((s, l) => s + l.price * form.headcount, 0))
const deposit = computed(() => Math.round(totalPrice.value * form.deposit_rate / 100))

async function submit() {
  bookMsg.value = null
  if (booking.value) return
  if (!form.leader_name.trim()) { bookMsg.value = { ok: false, text: '请填写领队姓名' }; return }
  if (form.headcount < 5 || form.headcount > 200) { bookMsg.value = { ok: false, text: '团队人数需在 5 ~ 200 人之间' }; return }
  if (!itinerary.value.length) { bookMsg.value = { ok: false, text: '请至少安排一个入园时段' }; return }
  if (!itinerary.value.some(l => l.scope === 'entry')) { bookMsg.value = { ok: false, text: '行程必须包含入园时段' }; return }
  booking.value = true
  try {
    const r = await store.submitGroup({
      leader_name: form.leader_name, leader_phone: form.leader_phone, org: form.org,
      headcount: form.headcount, deposit_rate: form.deposit_rate,
      legs: itinerary.value.map(l => ({ scope: l.scope, slot_id: l.slot_id, ride_id: l.ride_id })),
      request_id: bookReqId.value
    })
    if (r?.ok) {
      bookMsg.value = { ok: true, text: `行程已提交（团号 ${r.code}），合计 ¥${r.total.toLocaleString()}，请等待运营确认并收取订金 ¥${r.deposit.toLocaleString()}` }
      itinerary.value = []
      form.leader_name = form.leader_phone = form.org = ''
      bookReqId.value = newRequestId()
    } else {
      bookMsg.value = { ok: false, text: errText(r, '行程提交失败') }
    }
  } finally { booking.value = false }
}

// ============ 页签二/三/四：团单操作 ============
const approveFilter = ref('pending')
const approveGroups = computed(() =>
  store.groups.filter(g => approveFilter.value === 'all' ? true : g.status === approveFilter.value))
const serviceGroups = computed(() =>
  store.groups.filter(g => ['confirmed', 'active'].includes(g.status)))
const rowBusy = ref({})
async function rowOp(key, fn) {
  if (rowBusy.value[key]) return
  rowBusy.value[key] = true
  try { return await fn() } finally { rowBusy.value[key] = false }
}
const flashes = ref({})
function flash(id, msg, ok) { flashes.value[id] = { msg, ok: !!ok } }

async function approve(g) {
  await rowOp('cfm' + g.id, async () => {
    const r = await store.confirmGroup(g.id, newRequestId())
    flash(g.id, r?.ok ? `已锁定全部时段名额，收取订金 ¥${r.deposit.toLocaleString()}` : errText(r, '确认失败'), r?.ok)
  })
}
const rejectOpen = ref({})
const rejectReason = ref({})
async function reject(g) {
  await rowOp('rej' + g.id, async () => {
    const r = await store.rejectGroup(g.id, rejectReason.value[g.id] || '', newRequestId())
    if (r?.ok) { rejectOpen.value[g.id] = false; rejectReason.value[g.id] = '' }
    flash(g.id, r?.ok ? '行程已拒绝' : errText(r), r?.ok)
  })
}
// 分批核销
const checkinQty = ref({})
async function checkin(g, leg) {
  const qty = Math.min(leg.qty, Math.max(1, +(checkinQty.value[leg.id] ?? leg.qty)))
  await rowOp('ck' + leg.id, async () => {
    const r = await store.checkinGroup(g.id, { leg_id: leg.id, qty, request_id: newRequestId() })
    if (r?.ok) {
      checkinQty.value[leg.id] = ''
      flash(g.id, `已核销 ${r.checked} 人${r.collected ? `，现场收齐尾款 ¥${r.collected.toLocaleString()}` : ''}`, true)
    } else flash(g.id, errText(r), false)
  })
}
async function settleAll(g) {
  await rowOp('set' + g.id, async () => {
    const r = await store.settleGroup(g.id, { request_id: newRequestId() })
    flash(g.id, r?.ok ? `已收尾款 ¥${r.paid.toLocaleString()}` : errText(r, '结算失败'), r?.ok)
  })
}
// 部分退团
const refundOpen = ref({})
const refundQty = ref({})
async function partialRefund(g) {
  const qty = Math.max(1, +refundQty.value[g.id] || 1)
  await rowOp('rf' + g.id, async () => {
    const r = await store.refundGroup(g.id, qty, newRequestId())
    if (r?.ok) { refundOpen.value[g.id] = false; refundQty.value[g.id] = '' }
    flash(g.id, r?.ok ? `退团完成：退回 ¥${r.refund}${r.fee ? `，手续费/没收 ¥${r.fee}` : ''}` : errText(r, '退团失败'), r?.ok)
  })
}
async function cancelAll(g) {
  await rowOp('cc' + g.id, async () => {
    const r = await store.cancelGroup(g.id, newRequestId())
    flash(g.id, r?.ok ? `整团已取消：退回 ¥${r.refund}${r.fee ? `，手续费 ¥${r.fee}` : ''}` : errText(r, '取消失败'), r?.ok)
  })
}
// 改期
const rerouteOpen = ref({})
const rerouteTarget = ref({})
function rerouteCandidates(g, leg) {
  const sameRide = (rideSlotsMap.value[leg.ride_id] || [])
  const otherHours = new Set(g.legs.filter(l => l.id !== leg.id && l.status === 'locked').map(l => `${l.slot_day}-${l.slot_hour}`))
  return sameRide.filter(s => s.status === 'open' && s.remain >= leg.qty
    && (s.day > today.value || (s.day === today.value && s.hour >= store.clock.hour))
    && !(s.day === leg.slot_day && s.hour === leg.slot_hour)
    && !otherHours.has(`${s.day}-${s.hour}`))
}
async function doReroute(g, leg) {
  const sid = +rerouteTarget.value[leg.id]
  if (!sid) return
  await rowOp('rr' + leg.id, async () => {
    const r = await store.rerouteGroupLeg(g.id, leg.id, sid, newRequestId())
    if (r?.ok) { rerouteOpen.value[leg.id] = false; await loadRideSlots(true) }
    flash(g.id, r?.ok ? '行程已改期' : errText(r, '改期失败'), r?.ok)
  })
}

// 详情时间线
const detail = ref(null)
const detailLogs = ref([])
const ACTION_LABEL = {
  submit: '领队提交', confirm: '运营确认锁定', reject: '运营拒绝',
  checkin: '分批核销', settle: '尾款结算', refund: '退团/退款',
  reroute: '行程改期/重排', cancel: '整团取消', noshow: '爽约日结'
}
async function openDetail(g) {
  const d = await store.groupDetail(g.id)
  if (d?.group) { detail.value = d.group; detailLogs.value = d.logs || [] }
}

function legDue(g, leg) {
  return leg.slot_day === today.value && leg.slot_hour === store.clock.hour && leg.status === 'locked'
}
function fmt(n) { return '¥' + Number(n || 0).toLocaleString() }
</script>

<template>
  <div class="grp">
    <div class="stat-grid">
      <div class="card stat"><span>📝</span><b>{{ stats.pending }}</b><em>待确认行程 / {{ stats.pendingQty }} 人</em></div>
      <div class="card stat"><span>🔒</span><b>{{ stats.active }}</b><em>已锁定/在园 / {{ stats.activeQty }} 人</em></div>
      <div class="card stat"><span>🚌</span><b>{{ stats.todayGroups }}</b><em>今日到园团队</em></div>
      <div class="card stat"><span class="money">¥</span><b class="money">{{ stats.depositHeld.toLocaleString() }}</b><em>在管订金（已收）</em></div>
      <div class="card stat"><span class="money">¥</span><b class="money">{{ stats.outstanding.toLocaleString() }}</b><em>待收尾款</em></div>
      <div class="card stat" :class="{ alert: stats.refundToday }"><span>↩️</span><b :class="stats.refundToday ? 'neg' : ''">{{ stats.refundToday.toLocaleString() }}</b><em>今日团退款</em></div>
      <div class="card stat"><span>✅</span><b>{{ stats.settledToday }}</b><em>今日已结清</em></div>
    </div>

    <div class="tabs card">
      <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.label }}</button>
      <span class="muted hint" v-if="tab === 'submit'">领队提交入园 + 多设施行程，运营确认后统一锁定名额并收订金</span>
      <span class="muted hint" v-else-if="tab === 'approve'">逐团审核：确认即原子锁定各时段名额并收取订金，可拒绝行程</span>
      <span class="muted hint" v-else-if="tab === 'service'">分批核销入园与设施、尾款结算、部分退团、手动改期</span>
      <span class="muted hint" v-else>全部团队与生命周期时间线</span>
    </div>

    <!-- ============ 领队报名 ============ -->
    <div v-if="tab === 'submit'" class="submit-grid">
      <div class="card">
        <h3>🧾 团队信息</h3>
        <label class="fld">领队姓名 *<input v-model="form.leader_name" placeholder="如：王领队" maxlength="12" /></label>
        <label class="fld">联系电话<input v-model="form.leader_phone" placeholder="选填" maxlength="20" /></label>
        <label class="fld">组团单位<input v-model="form.org" placeholder="旅行社 / 企业 / 学校（选填）" maxlength="40" /></label>
        <label class="fld">团队人数（5 ~ 200）
          <div class="stepper">
            <button type="button" @click="form.headcount = Math.max(5, form.headcount - 1)">－</button>
            <b>{{ form.headcount }}</b>
            <button type="button" @click="form.headcount = Math.min(200, form.headcount + 1)">＋</button>
          </div>
        </label>
        <label class="fld">订金比例
          <div class="chips">
            <button v-for="r in [20, 30, 50]" :key="r" type="button" class="chip" :class="{ on: form.deposit_rate === r }" @click="form.deposit_rate = r">{{ r }}%</button>
          </div>
        </label>
        <label class="fld">入园日期
          <div class="chips">
            <button v-for="off in dayTabs" :key="off" type="button" class="chip" :class="{ on: form.dayOffset === off }" @click="form.dayOffset = off; itinerary = []">
              第{{ today + off }}天 · {{ dayLabel(off) }}
            </button>
          </div>
        </label>
        <div class="quote">
          <span>行程 {{ itinerary.length }} 项 · 合计 <b class="money">{{ fmt(totalPrice) }}</b></span>
          <span>确认时收订金 <b class="money">{{ fmt(deposit) }}</b> · 尾款 <b class="money">{{ fmt(totalPrice - deposit) }}</b>（首次入园核销时结清）</span>
          <em class="muted">同一时刻只能安排一项；入园须排在第一项。提前退团全退、当日退 50%；设施停运时自动重排或全额退款。</em>
        </div>
        <button class="primary wide" :disabled="booking" @click="submit">
          {{ booking ? '提交中…' : `提交行程 · 订金 ${fmt(deposit)}` }}
        </button>
        <em v-if="bookMsg" class="bookmsg" :class="{ err: !bookMsg.ok }">{{ bookMsg.text }}</em>
      </div>

      <div class="card">
        <h3>🕘 安排行程
          <span class="muted" style="font-size:12px">第{{ pickDay }}天 · {{ form.headcount }} 人</span>
        </h3>
        <div class="seg">
          <button :class="{ on: pickScope === 'entry' }" @click="pickScope = 'entry'">🏞️ 入园时段</button>
          <button :class="{ on: pickScope === 'ride' }" @click="pickScope = 'ride'">🎢 加设施</button>
        </div>
        <select v-if="pickScope === 'ride'" v-model.number="pickRide" class="ride-select">
          <option :value="0" disabled>选择设施…</option>
          <option v-for="r in store.rides.filter(x => x.status === 'operating')" :key="r.id" :value="r.id">
            {{ r.name }}（¥{{ r.price }}/人）
          </option>
        </select>
        <div class="slot-grid">
          <button v-for="s in (pickScope === 'entry' ? pickEntrySlots : pickRideSlots)" :key="s.id" class="slot"
                  :class="[pickSlotState(s).cls]" :disabled="pickSlotState(s).cls !== 'open'"
                  @click="addLeg(s)">
            <b>{{ s.hour }}:00</b>
            <em>{{ pickSlotState(s).text }}</em>
          </button>
        </div>

        <h4 class="itin-title">已选行程（{{ itinerary.length }}）</h4>
        <div class="itin-list">
          <div v-for="(l, i) in itinerary" :key="l.slot_id" class="itin-row" :class="l.scope">
            <b>{{ i + 1 }}</b>
            <span class="ik">{{ l.scope === 'entry' ? '🏞️ 入园' : '🎢 ' + l.ride_name }}</span>
            <span class="muted">第{{ l.day }}天 {{ l.hour }}:00</span>
            <span class="muted">¥{{ l.price }}/人</span>
            <button class="ghost mini-btn" @click="removeLeg(l.slot_id)">移除</button>
          </div>
          <div v-if="!itinerary.length" class="muted empty-inline">先选择入园时段，再按需添加设施项目</div>
        </div>
      </div>
    </div>

    <!-- ============ 运营确认 ============ -->
    <div v-if="tab === 'approve'" class="card">
      <div class="seg short">
        <button :class="{ on: approveFilter === 'pending' }" @click="approveFilter = 'pending'">待确认（{{ stats.pending }}）</button>
        <button :class="{ on: approveFilter === 'all' }" @click="approveFilter = 'all'">全部</button>
      </div>
      <div v-for="g in approveGroups" :key="g.id" class="gcard">
        <div class="gc-head">
          <div class="gc-code">
            <b>{{ g.code }}</b>
            <span class="badge" :class="STATUS_BADGE[g.status]?.cls">{{ g.status_name }}</span>
            <span class="tag">第{{ g.visit_day }}天</span>
          </div>
          <div class="gc-meta muted">{{ g.leader_name }} {{ g.org ? '· ' + g.org : '' }} · {{ g.headcount }} 人</div>
          <div class="gc-money">
            <span>合计 <b class="money">{{ fmt(g.total_amount) }}</b></span>
            <span>订金 <b class="money">{{ fmt(Math.round(g.total_amount * g.deposit_rate / 100)) }}</b></span>
          </div>
        </div>
        <div class="legs-line">
          <span v-for="l in g.legs" :key="l.id" class="leg-chip" :class="l.scope">
            {{ l.scope === 'entry' ? '🏞️' : '🎢' }} {{ l.scope === 'entry' ? '入园' : l.ride_name }} {{ l.slot_hour }}:00
          </span>
        </div>
        <div class="gc-ops" v-if="g.status === 'pending'">
          <button class="succ" :disabled="rowBusy['cfm' + g.id]" @click="approve(g)">✅ 确认并锁定名额 · 收订金</button>
          <button class="ghost" :disabled="rowBusy['rej' + g.id]" @click="rejectOpen[g.id] = !rejectOpen[g.id]">拒绝行程</button>
        </div>
        <div class="reject-box" v-if="rejectOpen[g.id]">
          <input v-model="rejectReason[g.id]" placeholder="拒绝原因（选填，将展示给领队）" maxlength="100" />
          <button class="danger" @click="reject(g)">确认拒绝</button>
        </div>
        <em v-if="flashes[g.id]" class="flash" :class="{ ok: flashes[g.id].ok, err: !flashes[g.id].ok }">{{ flashes[g.id].msg }}</em>
      </div>
      <div v-if="!approveGroups.length" class="muted empty">暂无{{ approveFilter === 'pending' ? '待确认' : '' }}团队行程。</div>
    </div>

    <!-- ============ 核销·结算·退团 ============ -->
    <div v-if="tab === 'service'" class="svc">
      <div v-for="g in serviceGroups" :key="g.id" class="card gcard">
        <div class="gc-head">
          <div class="gc-code">
            <b>{{ g.code }}</b>
            <span class="badge" :class="STATUS_BADGE[g.status]?.cls">{{ g.status_name }}</span>
            <span class="tag">第{{ g.visit_day }}天</span>
          </div>
          <div class="gc-meta muted">{{ g.leader_name }} {{ g.org ? '· ' + g.org : '' }} · 报名 {{ g.headcount }} 人 · 已入园 {{ g.checked_persons }} 人</div>
          <div class="gc-money">
            <span>已收 <b class="money">{{ fmt(g.paid_amount) }}</b></span>
            <span>已退 <b class="money neg">{{ fmt(g.refund_amount) }}</b></span>
            <span>待收尾款 <b :class="g.balance_due ? 'money' : 'muted'">{{ fmt(g.balance_due) }}</b></span>
          </div>
        </div>

        <div class="svc-legs">
          <div v-for="l in g.legs" :key="l.id" class="leg-row" :class="{ due: legDue(g, l) }">
            <div class="leg-info">
              <span class="leg-name">{{ l.scope === 'entry' ? '🏞️ 入园' : '🎢 ' + l.ride_name }}</span>
              <span class="muted">第{{ l.slot_day }}天 {{ l.slot_hour }}:00</span>
              <span class="badge" :class="LEG_BADGE[l.status]?.cls">{{ l.status_name }}</span>
              <span class="tag due-tag" v-if="legDue(g, l)">⏰ 当前时段</span>
              <span class="tag rr-tag" v-if="l.reschedules">已改期 {{ l.reschedules }} 次</span>
            </div>
            <div class="leg-nums muted">
              排 {{ l.original_qty }} · 待核销 <b :class="l.qty ? '' : 'muted'">{{ l.qty }}</b>
              · 已核 {{ l.checked_qty }} · 已退 {{ l.refunded_qty }}
              <span v-if="l.refund_amount"> · 退款 {{ fmt(l.refund_amount) }}</span>
            </div>
            <div class="leg-ops" v-if="l.status === 'locked'">
              <template v-if="legDue(g, l)">
                <input type="number" class="qty-in" min="1" :max="l.qty" v-model.number="checkinQty[l.id]" :placeholder="`核销人数（剩 ${l.qty}）`" />
                <button class="succ" :disabled="rowBusy['ck' + l.id]" @click="checkin(g, l)">✅ 核销</button>
              </template>
              <button class="ghost" :disabled="rowBusy['rr' + l.id]" @click="rerouteOpen[l.id] = !rerouteOpen[l.id]">改期</button>
              <div class="reroute-box" v-if="rerouteOpen[l.id]">
                <select v-model.number="rerouteTarget[l.id]">
                  <option :value="0" disabled>改到同设施其他时段…</option>
                  <option v-for="s in rerouteCandidates(g, l)" :key="s.id" :value="s.id">
                    第{{ s.day }}天 {{ s.hour }}:00 · 余 {{ s.remain }}
                  </option>
                </select>
                <button class="primary" :disabled="!rerouteTarget[l.id] || rowBusy['rr' + l.id]" @click="doReroute(g, l)">确认改期（不加价）</button>
              </div>
            </div>
          </div>
        </div>

        <div class="gc-ops">
          <button class="primary" v-if="g.balance_due > 0" :disabled="rowBusy['set' + g.id]" @click="settleAll(g)">
            💰 收取尾款 {{ fmt(g.balance_due) }}
          </button>
          <button class="ghost" :disabled="rowBusy['rf' + g.id] || !g.legs.some(l => l.status === 'locked')"
                  @click="refundOpen[g.id] = !refundOpen[g.id]">部分退团</button>
          <button class="danger" :disabled="rowBusy['cc' + g.id] || !g.legs.some(l => l.status === 'locked')" @click="cancelAll(g)">整团取消</button>
          <button class="ghost" @click="openDetail(g)">时间线</button>
        </div>
        <div class="reject-box" v-if="refundOpen[g.id]">
          <input type="number" min="1" :max="g.headcount" v-model.number="refundQty[g.id]" placeholder="退团人数（对未开始行程统一核减）" />
          <button class="danger" @click="partialRefund(g)">确认退团（提前全退 / 当日退50%）</button>
        </div>
        <em v-if="flashes[g.id]" class="flash" :class="{ ok: flashes[g.id].ok, err: !flashes[g.id].ok }">{{ flashes[g.id].msg }}</em>
      </div>
      <div v-if="!serviceGroups.length" class="muted empty card">当前没有已锁定/在园团队。</div>
    </div>

    <!-- ============ 全部团单 ============ -->
    <div v-if="tab === 'all'" class="card">
      <div v-for="g in store.groups" :key="g.id" class="glist-row">
        <div class="gl-main" @click="openDetail(g)">
          <b>{{ g.code }}</b>
          <span class="badge" :class="STATUS_BADGE[g.status]?.cls">{{ g.status_name }}</span>
          <span class="muted">{{ g.leader_name }} {{ g.org ? '· ' + g.org : '' }}</span>
          <span class="muted">第{{ g.visit_day }}天 · {{ g.headcount }} 人</span>
          <span class="leg-dots">
            <i v-for="l in g.legs" :key="l.id" :class="['dot', l.scope, l.status]" :title="`${l.scope === 'entry' ? '入园' : l.ride_name} ${l.slot_hour}:00 · ${l.status_name}`"></i>
          </span>
        </div>
        <div class="gl-money muted">
          合计 {{ fmt(g.total_amount) }} · 已收 {{ fmt(g.paid_amount) }} · 退 {{ fmt(g.refund_amount) }}
          <span v-if="g.fee_amount"> · 手续费 {{ fmt(g.fee_amount) }}</span>
        </div>
        <button class="ghost" @click="openDetail(g)">时间线</button>
      </div>
      <div v-if="!store.groups.length" class="muted empty">暂无团队行程。</div>
    </div>

    <!-- 详情时间线 -->
    <div class="mask" v-if="detail" @click.self="detail = null">
      <div class="dialog card">
        <h3>🚌 团队 {{ detail.code }}
          <span class="badge" :class="STATUS_BADGE[detail.status]?.cls">{{ detail.status_name }}</span>
          <button class="ghost x" @click="detail = null">✕</button>
        </h3>
        <p class="d-meta muted">
          {{ detail.leader_name }} {{ detail.org ? '· ' + detail.org : '' }} · 第{{ detail.visit_day }}天 · {{ detail.headcount }} 人 · 订金比例 {{ detail.deposit_rate }}%
        </p>
        <div class="d-money">
          <span>合计 <b>{{ fmt(detail.total_amount) }}</b></span>
          <span>已收 <b>{{ fmt(detail.paid_amount) }}</b></span>
          <span>已退 <b class="neg">{{ fmt(detail.refund_amount) }}</b></span>
          <span>手续费 <b>{{ fmt(detail.fee_amount) }}</b></span>
          <span>待收尾款 <b>{{ fmt(detail.balance_due) }}</b></span>
        </div>
        <h4>行程明细</h4>
        <div v-for="l in detail.legs" :key="l.id" class="d-leg">
          <b>{{ l.seq }}.</b>
          <span>{{ l.scope === 'entry' ? '🏞️ 入园' : '🎢 ' + l.ride_name }}</span>
          <span class="muted">第{{ l.slot_day }}天 {{ l.slot_hour }}:00 · ¥{{ l.unit_price }}/人</span>
          <span class="badge" :class="LEG_BADGE[l.status]?.cls">{{ l.status_name }}</span>
          <span class="muted">排{{ l.original_qty }} / 核{{ l.checked_qty }} / 退{{ l.refunded_qty }}</span>
        </div>
        <h4>处理时间线</h4>
        <div class="logs">
          <div v-for="l in detailLogs" :key="l.id" class="log">
            <span class="ldot"></span>
            <b>{{ ACTION_LABEL[l.action] || l.action }}</b>
            <em class="muted">第{{ l.day }}天 {{ l.hour }}:00</em>
            <p class="muted">{{ l.note }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grp { display: flex; flex-direction: column; gap: 14px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.stat { display: flex; flex-direction: column; gap: 3px; }
.stat span { font-size: 20px; }
.stat b { font-size: 21px; }
.stat em { font-style: normal; color: var(--muted); font-size: 12px; }
.stat.alert { border-color: rgba(255,107,107,.55); }
.neg { color: var(--red); }

.tabs { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tabs button { padding: 7px 16px; }
.tabs button.on { border-color: var(--accent); background: rgba(255,107,107,.14); color: var(--accent); }
.tabs .hint { margin-left: 8px; font-size: 12px; }

.submit-grid { display: grid; grid-template-columns: 360px 1fr; gap: 14px; align-items: start; }
@media (max-width: 1000px) { .submit-grid { grid-template-columns: 1fr; } }
.fld { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); margin-bottom: 12px; }
.stepper { display: flex; align-items: center; gap: 14px; }
.stepper button { width: 38px; padding: 6px 0; }
.stepper b { font-size: 18px; min-width: 24px; text-align: center; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { padding: 5px 12px; font-size: 12px; border-radius: 16px; background: var(--panel2); border: 1px solid var(--border); color: var(--muted); }
.chip.on { background: rgba(255,107,107,.18); border-color: var(--accent); color: var(--accent); }
.quote { background: var(--panel2); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; margin-bottom: 12px; }
.quote em { font-size: 11px; line-height: 1.5; }
.wide { width: 100%; padding: 11px; }
.bookmsg { display: block; margin-top: 10px; font-size: 12.5px; color: var(--green); font-style: normal; }
.bookmsg.err { color: var(--red); }

.seg { display: flex; gap: 6px; margin-bottom: 12px; }
.seg button { flex: 1; }
.seg.short { max-width: 320px; }
.seg button.on { border-color: var(--accent); background: rgba(255,107,107,.14); color: var(--accent); }
.ride-select { margin-bottom: 12px; width: 100%; }
.slot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; }
.slot { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; padding: 10px; border-radius: 10px; text-align: left; }
.slot b { font-size: 14px; }
.slot em { font-style: normal; font-size: 11px; color: var(--muted); }
.slot.open:hover { border-color: var(--accent); background: rgba(255,107,107,.1); }
.slot.full, .slot.closed, .slot.past { opacity: .45; cursor: not-allowed; }
.slot.full em { color: var(--red); }
.itin-title { margin: 16px 0 8px; font-size: 13px; }
.itin-list { display: flex; flex-direction: column; gap: 6px; }
.itin-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: var(--panel2); border-radius: 8px; font-size: 13px; }
.itin-row b { width: 20px; height: 20px; border-radius: 50%; background: rgba(255,107,107,.2); color: var(--accent); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
.itin-row.ride b { background: rgba(102,166,255,.2); color: var(--blue); }
.itin-row .ik { min-width: 90px; }
.mini-btn { font-size: 11px; padding: 3px 10px; margin-left: auto; }
.empty-inline { font-size: 12px; padding: 8px 2px; }
.empty { padding: 22px; text-align: center; }

.gcard { padding: 14px 16px; margin-bottom: 12px; }
.gc-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 10px; }
.gc-code { display: flex; align-items: center; gap: 8px; }
.gc-code b { font-size: 14px; }
.gc-meta { font-size: 12.5px; }
.gc-money { margin-left: auto; display: flex; gap: 14px; font-size: 12.5px; }
.legs-line { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.leg-chip { font-size: 12px; padding: 3px 10px; border-radius: 14px; background: var(--panel2); border: 1px solid var(--border); color: var(--muted); }
.leg-chip.entry { color: var(--accent2); border-color: rgba(255,209,102,.4); }
.gc-ops { display: flex; gap: 8px; flex-wrap: wrap; }
.gc-ops button { font-size: 12.5px; }
.reject-box { display: flex; gap: 8px; margin-top: 10px; }
.reject-box input { flex: 1; }

.badge { font-size: 11px; padding: 2px 9px; border-radius: 20px; border: 1px solid var(--border); background: var(--panel2); color: var(--muted); }
.b-pending { color: var(--accent2) !important; border-color: rgba(255,209,102,.5) !important; }
.b-confirmed { color: var(--blue) !important; border-color: rgba(102,166,255,.5) !important; }
.b-active { color: #fff !important; background: var(--accent) !important; border-color: var(--accent) !important; }
.b-settled { color: var(--green) !important; border-color: rgba(109,213,160,.5) !important; }
.b-cancelled { color: var(--red) !important; border-color: rgba(255,107,107,.5) !important; }
.b-refund { color: var(--purple) !important; border-color: rgba(167,139,250,.5) !important; }
.tag { font-size: 11px; padding: 2px 8px; border-radius: 12px; background: var(--panel2); border: 1px solid var(--border); color: var(--muted); }
.due-tag { color: var(--accent); border-color: rgba(255,107,107,.5); }
.rr-tag { color: var(--blue); border-color: rgba(102,166,255,.5); }
.flash { font-style: normal; font-size: 12.5px; margin-top: 8px; }
.flash.ok { color: var(--green); }
.flash.err { color: var(--red); }

.svc-legs { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.leg-row { display: grid; grid-template-columns: 1.4fr 1.6fr auto; gap: 10px; align-items: center; padding: 9px 12px; background: var(--panel2); border-radius: 10px; border: 1px solid transparent; }
.leg-row.due { border-color: rgba(255,107,107,.55); background: rgba(255,107,107,.07); }
.leg-info { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.leg-name { font-weight: 600; }
.leg-nums { font-size: 12px; }
.leg-ops { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.qty-in { width: 130px; padding: 6px 8px; }
.reroute-box { display: flex; gap: 6px; grid-column: 1 / -1; width: 100%; }
.reroute-box select { flex: 1; max-width: 360px; }

.glist-row { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 11px 6px; border-bottom: 1px solid var(--border); font-size: 13px; }
.gl-main { display: flex; align-items: center; gap: 9px; cursor: pointer; flex-wrap: wrap; }
.gl-main:hover { opacity: .85; }
.gl-money { font-size: 12px; }
.leg-dots { display: inline-flex; gap: 4px; margin-left: 6px; }
.leg-dots .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--panel); border: 1px solid var(--border); }
.leg-dots .dot.entry { border-color: rgba(255,209,102,.6); }
.leg-dots .dot.checked { background: var(--green); border-color: var(--green); }
.leg-dots .dot.locked { background: var(--blue); border-color: var(--blue); }
.leg-dots .dot.noshow { background: var(--red); border-color: var(--red); }
.leg-dots .dot.refunded { background: var(--purple); border-color: var(--purple); }

.mask { position: fixed; inset: 0; background: rgba(5,8,18,.65); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
.dialog { width: min(620px, 100%); max-height: 86vh; overflow-y: auto; }
.dialog .x { margin-left: auto; }
.d-meta { font-size: 13px; margin: 8px 0; }
.d-money { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); background: var(--panel2); padding: 10px 12px; border-radius: 10px; margin-bottom: 12px; }
.d-money b { color: var(--text); }
.d-money .neg { color: var(--red); }
.dialog h4 { margin: 14px 0 8px; font-size: 13px; }
.d-leg { display: flex; gap: 10px; align-items: center; font-size: 12.5px; padding: 6px 0; border-bottom: 1px dashed var(--border); flex-wrap: wrap; }
.logs { display: flex; flex-direction: column; }
.log { position: relative; padding: 0 0 16px 20px; border-left: 2px solid var(--border); margin-left: 5px; }
.log:last-child { border-left-color: transparent; padding-bottom: 0; }
.log .ldot { position: absolute; left: -7px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); border: 2px solid var(--bg); }
.log b { font-size: 13px; margin-right: 8px; }
.log em { font-size: 11px; }
.log p { font-size: 12px; margin-top: 3px; }
</style>
