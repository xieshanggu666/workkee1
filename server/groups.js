import db, { getSetting, setSetting, tx } from './db.js'

// 领队团队行程模块：
// 领队提交「入园 + 多设施」行程（pending，不占名额）→ 运营确认（confirmed，统一锁定各时段名额 + 收订金）
// → 分批核销入园/设施（首次核销入园自动结清尾款）→ 尾款结算 / 部分退团 / 整团取消
// → 设施停运或时段关闭：自动重排同设施其他时段，无法安置则园方全额退款 → 闭园日结：未核销按爽约结清
// 名额锚定在 reservations（source='team'，amount=0），仅占用 reservation_slots 库存；
// 现金与财务流水由本模块按「订金 / 尾款 / 退款 / 违约」统一记账，散客预约模块不重复处理。

const DEFAULT_DEPOSIT_RATE = 30   // 默认订金比例 30%
const LATE_CANCEL_FEE = 0.5       // 当日退团/取消保留 50%
const MIN_HEADCOUNT = 5
const MAX_HEADCOUNT = 200

export const GRP_ERR = {
  NOT_FOUND: 'GRP_NOT_FOUND',
  LEG_NOT_FOUND: 'GRP_LEG_NOT_FOUND',
  STATUS_CONFLICT: 'GRP_STATUS_CONFLICT',
  VALIDATION: 'GRP_INVALID',
  SLOT_FULL: 'SLOT_FULL',
  SLOT_CLOSED: 'SLOT_CLOSED',
  SLOT_PAST: 'SLOT_PAST',
  SLOT_MISMATCH: 'SLOT_MISMATCH',
  RIDE_UNAVAILABLE: 'RIDE_UNAVAILABLE',
  ITINERARY_INVALID: 'GRP_ITINERARY_INVALID',
  NOT_DUE: 'GRP_NOT_DUE',
  NO_BALANCE: 'GRP_NO_BALANCE',
  NO_ROUTE: 'GRP_NO_ALTERNATIVE',
  TX_FAILED: 'TX_FAILED'
}

const fail = (code, msg, extra = {}) => ({ ok: false, code, msg, ...extra })
class TxError extends Error {
  constructor(code, msg, extra = {}) { super(msg); this.code = code; this.extra = extra }
}
function runAtomic(fn) {
  try {
    return tx(fn)
  } catch (e) {
    if (e instanceof TxError) return fail(e.code, e.message, e.extra)
    console.error('[groups] 事务执行失败，已整体回滚:', e)
    return fail(GRP_ERR.TX_FAILED, '系统繁忙，本次操作未生效，请稍后重试')
  }
}

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

// 幂等执行：与预约模块共用 idempotency_keys（scope 区分），双击/重试重放首次结果；系统异常不缓存
function idempotent(scope, requestId, fn) {
  const key = String(requestId || '').trim().slice(0, 80)
  if (!key) return fn()
  const hit = db.prepare('SELECT response FROM idempotency_keys WHERE scope=? AND key=?').get(scope, key)
  if (hit) return { ...JSON.parse(hit.response), replay: true }
  const result = fn()
  if (result?.code !== GRP_ERR.TX_FAILED) {
    db.prepare('INSERT OR IGNORE INTO idempotency_keys(scope,key,response,created_tick,created_day) VALUES(?,?,?,?,?)')
      .run(scope, key, JSON.stringify(result), ctx.tick(), ctx.day())
  }
  return result
}

const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  ticket: () => num(getSetting('ticket'), 120),
  logFinance: null,
  createComplaint: null
}
export function initGroupContext(deps) { Object.assign(ctx, deps) }

// ---------------- 基础读取 ----------------
const SLOT_SELECT = `SELECT s.*,
  (s.capacity + s.oversell - s.booked_count) AS remain,
  (s.booked_count - s.checked_count - s.refund_count) AS pending
  FROM reservation_slots s`
const getSlot = id => db.prepare(`${SLOT_SELECT} WHERE s.id=?`).get(id)
const getGroup = id => db.prepare('SELECT * FROM group_bookings WHERE id=?').get(id)
const getLeg = id => db.prepare('SELECT * FROM group_legs WHERE id=?').get(id)
const groupLegs = gid => db.prepare('SELECT * FROM group_legs WHERE group_id=? ORDER BY seq, id').all(gid)

function logGroup(gid, action, note = '') {
  db.prepare('INSERT INTO group_logs(group_id,tick,day,hour,action,note) VALUES(?,?,?,?,?,?)')
    .run(gid, ctx.tick(), ctx.day(), ctx.hour(), action, note)
}
function logAnchor(rsvId, action, note) {
  db.prepare('INSERT INTO reservation_logs(reservation_id,tick,day,hour,action,note) VALUES(?,?,?,?,?,?)')
    .run(rsvId, ctx.tick(), ctx.day(), ctx.hour(), action, `[团队] ${note}`)
}

const STATUS_NAMES = {
  pending: '待确认', confirmed: '已锁定', active: '入园中',
  settled: '已结清', cancelled: '已取消'
}
const LEG_STATUS_NAMES = {
  pending: '待确认', locked: '已锁名额', checked: '已核销',
  noshow: '爽约', refunded: '已退款', routed: '已改期'
}

// 团队在途名额（未核销未退款）合计：用于尾款/退款核算
function groupLiveValue(g) {
  return num(g.total_amount) - num(g.cancelled_amount)
}
// 当前应付尾款 = 剩余行程价 + 已计手续费（从订金没收）- 已付款 + 已退款
function balanceDue(g) {
  return Math.max(0, num(g.total_amount) - num(g.cancelled_amount) + num(g.fee_amount) - num(g.paid_amount) + num(g.refund_amount))
}

// ---------------- 领队提交行程 ----------------
// 提交不锁名额、不收款；运营确认时再按当时库存/价格体系之外的提交快照统一锁定。
export function submitGroup(input, requestId = '') {
  return idempotent('group_submit', requestId, () => {
    const leaderName = String(input.leader_name || '').trim()
    if (!leaderName) return fail(GRP_ERR.VALIDATION, '请填写领队姓名')
    const headcount = Math.round(num(input.headcount, 0))
    if (headcount < MIN_HEADCOUNT || headcount > MAX_HEADCOUNT) {
      return fail(GRP_ERR.VALIDATION, `团队人数需在 ${MIN_HEADCOUNT} ~ ${MAX_HEADCOUNT} 人之间`)
    }
    const rawLegs = Array.isArray(input.legs) ? input.legs : []
    if (!rawLegs.length) return fail(GRP_ERR.ITINERARY_INVALID, '请至少安排一个入园时段')

    // 校验行程：恰好一条入园腿；设施腿需设施运营中、时段匹配、同一时刻不重复排程
    const parsed = []
    const seenHours = new Set()
    let entryCount = 0
    for (const l of rawLegs) {
      const scope = l.scope === 'ride' ? 'ride' : 'entry'
      const slot = getSlot(num(l.slot_id))
      if (!slot) return fail(GRP_ERR.SLOT_MISMATCH, '行程中存在无效时段，请刷新后重新选择')
      if (slot.scope !== scope) return fail(GRP_ERR.SLOT_MISMATCH, '行程类型与时段不匹配')
      let ride = null
      if (scope === 'ride') {
        ride = db.prepare("SELECT * FROM rides WHERE id=?").get(slot.ride_id)
        if (!ride || ride.status !== 'operating') return fail(GRP_ERR.RIDE_UNAVAILABLE, `设施「${ride?.name || ''}」当前不开放预约`)
        if (num(l.ride_id) !== ride.id) return fail(GRP_ERR.SLOT_MISMATCH, '设施与时段不匹配')
      } else {
        entryCount += 1
      }
      if (slot.status !== 'open') return fail(GRP_ERR.SLOT_CLOSED, `第${slot.day}天 ${slot.hour}:00 时段已关闭预约`)
      if (slot.day < ctx.day() || (slot.day === ctx.day() && slot.hour <= ctx.hour())) {
        return fail(GRP_ERR.SLOT_PAST, '行程时段已开始/过期，请选择未来时段')
      }
      const hourKey = `${slot.day}-${slot.hour}`
      if (seenHours.has(hourKey)) return fail(GRP_ERR.ITINERARY_INVALID, `第${slot.day}天 ${slot.hour}:00 排了两个行程，同一时间只能安排一项`)
      seenHours.add(hourKey)
      parsed.push({ scope, ride, slot })
    }
    if (entryCount !== 1) return fail(GRP_ERR.ITINERARY_INVALID, '团队行程必须包含且只能包含一个入园时段')
    parsed.sort((a, b) => a.slot.day - b.slot.day || a.slot.hour - b.slot.hour)
    if (parsed[0].scope !== 'entry') return fail(GRP_ERR.ITINERARY_INVALID, '入园时段必须是行程第一项（先入园再游玩）')
    const visitDay = parsed[0].slot.day
    if (parsed.some(p => p.slot.day !== visitDay)) return fail(GRP_ERR.ITINERARY_INVALID, '团队行程需安排在同一游戏日内')

    let total = 0
    for (const p of parsed) {
      const price = p.scope === 'entry' ? ctx.ticket() : num(p.ride.price, 30)
      total += price * headcount
      p.unitPrice = price
    }
    const rate = Math.max(0, Math.min(100, Math.round(num(input.deposit_rate, DEFAULT_DEPOSIT_RATE))))

    return runAtomic(() => {
      const r = db.prepare(`INSERT INTO group_bookings
        (code,leader_name,leader_phone,org,visit_day,headcount,total_amount,deposit_rate,status,created_tick,created_day)
        VALUES('',?,?,?,?,?,?,?,'pending',?,?)`)
        .run(leaderName, String(input.leader_phone || '').trim().slice(0, 20),
          String(input.org || '').trim().slice(0, 40),
          visitDay, headcount, total, rate, ctx.tick(), ctx.day())
      const id = Number(r.lastInsertRowid)
      const code = 'TD' + String(id).padStart(4, '0')
      db.prepare('UPDATE group_bookings SET code=? WHERE id=?').run(code, id)
      const insLeg = db.prepare(`INSERT INTO group_legs
        (group_id,seq,scope,ride_id,slot_day,slot_hour,unit_price,qty,original_qty,status)
        VALUES(?,?,?,?,?,?,?,?,?,'pending')`)
      parsed.forEach((p, i) => {
        insLeg.run(id, i + 1, p.scope, p.ride?.id ?? null, p.slot.day, p.slot.hour, p.unitPrice, headcount, headcount)
      })
      logGroup(id, 'submit', `领队 ${leaderName} 提交行程：${headcount} 人 · ${parsed.length} 项 · 合计 ¥${total}，订金比例 ${rate}%，待运营确认`)
      return { ok: true, id, code, total, deposit: Math.round(total * rate / 100) }
    })
  })
}

// ---------------- 运营确认：统一锁定名额 + 收订金 ----------------
// 所有时段条件占用 + 锚点预约单 + 订金入账同一事务：任一时段名额不足整体回滚，不存在锁了一半
export function confirmGroup(id, requestId = '') {
  return idempotent('group_confirm', requestId, () => {
    const g = getGroup(id)
    if (!g) return fail(GRP_ERR.NOT_FOUND, '团队行程不存在')
    if (g.status !== 'pending') return fail(GRP_ERR.STATUS_CONFLICT, '该行程已处理，请勿重复确认')

    const legs = groupLegs(id)
    const deposit = Math.round(g.total_amount * g.deposit_rate / 100)

    return runAtomic(() => {
      // 确认前再次校验：设施可能已停运、时段可能已关闭/约满（在事务内校验，失败整体回滚并返回业务错误）
      for (const leg of legs) {
        const realSlot = db.prepare(`${SLOT_SELECT} WHERE s.day=? AND s.hour=? ${leg.scope === 'ride' ? 'AND s.ride_id=?' : "AND s.scope='entry'"}`)
          .get(leg.slot_day, leg.slot_hour, ...(leg.scope === 'ride' ? [leg.ride_id] : []))
        if (!realSlot) throw new TxError(GRP_ERR.SLOT_MISMATCH, '行程时段不存在')
        if (realSlot.status !== 'open') throw new TxError(GRP_ERR.SLOT_CLOSED,
          `${leg.scope === 'entry' ? '入园' : '设施'}时段 第${leg.slot_day}天 ${leg.slot_hour}:00 已关闭，无法锁定`)
        if (realSlot.remain < g.headcount) throw new TxError(GRP_ERR.SLOT_FULL,
          `第${leg.slot_day}天 ${leg.slot_hour}:00 时段余量不足（剩 ${Math.max(0, realSlot.remain)}，需 ${g.headcount}），请领队改签后再确认`)
        if (leg.scope === 'ride') {
          const ride = db.prepare('SELECT status FROM rides WHERE id=?').get(leg.ride_id)
          if (!ride || ride.status !== 'operating') throw new TxError(GRP_ERR.RIDE_UNAVAILABLE, '行程中设施已停运，请调整行程')
        }
      }
      // 逐时段原子占用（条件更新），命中 0 行抛错整体回滚
      for (const leg of legs) {
        const slot = db.prepare(`SELECT id FROM reservation_slots WHERE day=? AND hour=? ${leg.scope === 'ride' ? 'AND ride_id=?' : "AND scope='entry'"}`)
          .get(leg.slot_day, leg.slot_hour, ...(leg.scope === 'ride' ? [leg.ride_id] : []))
        const u = db.prepare(`UPDATE reservation_slots SET booked_count=booked_count+?
                              WHERE id=? AND status='open' AND capacity+oversell-booked_count>=?`)
          .run(g.headcount, slot.id, g.headcount)
        if (u.changes === 0) throw new TxError(GRP_ERR.SLOT_FULL,
          `第${leg.slot_day}天 ${leg.slot_hour}:00 名额锁定失败（并发占用），请刷新后重试`)
        // 锚点预约单：仅占名额，金额 0（团款由团队模块记账），散客核销/爽约/退款流程跳过
        const rr = db.prepare(`INSERT INTO reservations
          (code,guest_name,guest_phone,scope,ride_id,slot_id,slot_day,slot_hour,qty,amount,status,source,created_tick,created_day,group_id)
          VALUES(?,?,?,?,?,?,?,?,?,0,'booked','team',?,?,?)`)
          .run(`${g.code}-${leg.seq}`, g.leader_name, g.leader_phone, leg.scope, leg.ride_id,
            slot.id, leg.slot_day, leg.slot_hour, leg.qty, ctx.tick(), ctx.day(), g.id)
        db.prepare("UPDATE group_legs SET status='locked', reservation_id=? WHERE id=?").run(Number(rr.lastInsertRowid), leg.id)
        logAnchor(Number(rr.lastInsertRowid), 'create', `团队 ${g.code} 确认锁定 ${g.headcount} 个名额（订金由团单统一收取）`)
      }
      // 订金收取（现金制入账；尾款在首次入园核销时自动结清）
      setSetting('cash', Math.round(ctx.cash() + deposit))
      ctx.logFinance?.(ctx.day(), '团订金', deposit,
        `团队 ${g.code}（${g.leader_name}${g.org ? '·' + g.org : ''}）${g.headcount} 人 · 第${g.visit_day}天行程订金 ${g.deposit_rate}%`)
      db.prepare("UPDATE group_bookings SET status='confirmed', paid_amount=?, confirmed_tick=? WHERE id=? AND status='pending'")
        .run(deposit, ctx.tick(), g.id)
      logGroup(g.id, 'confirm', `运营确认行程，锁定 ${legs.length} 个时段各 ${g.headcount} 个名额，收取订金 ¥${deposit}，尾款 ¥${g.total_amount - deposit} 入园时结清`)
      return { ok: true, deposit, balance: g.total_amount - deposit }
    })
  })
}

// 运营拒绝行程（待确认状态，未锁名额未收款，无副作用）
export function rejectGroup(id, reason = '', requestId = '') {
  return idempotent('group_reject', requestId, () => {
    const g = getGroup(id)
    if (!g) return fail(GRP_ERR.NOT_FOUND, '团队行程不存在')
    if (g.status !== 'pending') return fail(GRP_ERR.STATUS_CONFLICT, '仅待确认行程可拒绝')
    return runAtomic(() => {
      db.prepare("UPDATE group_bookings SET status='cancelled', reject_reason=?, closed_tick=?, closed_day=? WHERE id=?")
        .run(String(reason || '').slice(0, 100), ctx.tick(), ctx.day(), id)
      db.prepare("UPDATE group_legs SET status='refunded' WHERE group_id=? AND status='pending'").run(id)
      logGroup(id, 'reject', `运营拒绝行程：${reason || '未填写原因'}`)
      return { ok: true }
    })
  })
}

// ---------------- 锚点预约单拆分（分批核销 / 部分退团） ----------------
// 已核销 take 人留在原单（置 checked），其余人数拆到一张新的 booked 锚点单，名额 booked_count 不变
function splitAnchorChecked(anc, take, slotId) {
  const stay = anc.qty - take
  let bookedId = anc.id
  if (stay > 0) {
    const nr = db.prepare(`INSERT INTO reservations
      (code,guest_name,guest_phone,scope,ride_id,slot_id,slot_day,slot_hour,qty,amount,status,source,created_tick,created_day,group_id)
      VALUES(?,?,?,?,?,?,?,?,?,0,'booked','team',?,?,?)`)
      .run(anc.code + '-R', anc.guest_name, anc.guest_phone, anc.scope, anc.ride_id,
        anc.slot_id, anc.slot_day, anc.slot_hour, stay, ctx.tick(), ctx.day(), anc.group_id)
    bookedId = Number(nr.lastInsertRowid)
    logAnchor(bookedId, 'split', `团队分批核销拆单：${stay} 人留待后续核销`)
  }
  db.prepare("UPDATE reservations SET qty=?, status='checked', checked_tick=? WHERE id=?").run(take, ctx.tick(), anc.id)
  db.prepare('UPDATE reservation_slots SET checked_count=checked_count+? WHERE id=?').run(take, slotId)
  return bookedId
}

// 部分退团：take 人在原锚点单就地标记退款，剩余 stay 人拆到新的 booked 锚点单；释放名额。
// 返回剩余在途锚点单 id（全退时返回原单 id，其已为退款态，调用方不会再用作在途锚点）
function splitAnchorRefund(anc, take, slotId, reason, half) {
  const status = half ? 'refunded_half' : 'refunded'
  const stay = anc.qty - take
  let bookedId = anc.id
  if (stay > 0) {
    // 剩余在途人员拆到新 booked 单
    const nr = db.prepare(`INSERT INTO reservations
      (code,guest_name,guest_phone,scope,ride_id,slot_id,slot_day,slot_hour,qty,amount,status,source,created_tick,created_day,group_id)
      VALUES(?,?,?,?,?,?,?,?,?,0,'booked','team',?,?,?)`)
      .run(anc.code + '-X', anc.guest_name, anc.guest_phone, anc.scope, anc.ride_id,
        anc.slot_id, anc.slot_day, anc.slot_hour, stay, ctx.tick(), ctx.day(), anc.group_id)
    bookedId = Number(nr.lastInsertRowid)
    // 原单转为 take 人的退款单
    db.prepare("UPDATE reservations SET qty=?, status=?, reason=?, closed_tick=?, closed_day=? WHERE id=?")
      .run(take, status, reason, ctx.tick(), ctx.day(), anc.id)
  } else {
    db.prepare("UPDATE reservations SET status=?, reason=?, closed_tick=?, closed_day=? WHERE id=?")
      .run(status, reason, ctx.tick(), ctx.day(), anc.id)
  }
  db.prepare('UPDATE reservation_slots SET booked_count=MAX(0,booked_count-?), refund_count=refund_count+? WHERE id=?')
    .run(take, take, slotId)
  return bookedId
}

function anchorNoshow(anc, slotId) {
  db.prepare("UPDATE reservations SET status='noshow', reason='noshow', closed_tick=?, closed_day=? WHERE id=? AND status='booked'")
    .run(ctx.tick(), ctx.day(), anc.id)
  db.prepare('UPDATE reservation_slots SET noshow_count=noshow_count+? WHERE id=?').run(anc.qty, slotId)
}

// ---------------- 核销（分批） ----------------
// legId 不传时核销入园腿；首次核销入园自动收齐尾款。只允许在行程时段当小时核销。
export function checkinGroupLeg(groupId, { legId = null, qty, requestId = '' }) {
  return idempotent('group_checkin', requestId, () => {
    const g = getGroup(groupId)
    if (!g) return fail(GRP_ERR.NOT_FOUND, '团队行程不存在')
    if (!['confirmed', 'active'].includes(g.status)) return fail(GRP_ERR.STATUS_CONFLICT, '当前行程状态不可核销')
    const legs = groupLegs(groupId)
    const leg = legId ? legs.find(l => l.id === num(legId)) : legs.find(l => l.scope === 'entry')
    if (!leg || leg.status !== 'locked') return fail(GRP_ERR.LEG_NOT_FOUND, '该行程项目不存在或已处理')
    if (leg.slot_day !== ctx.day() || leg.slot_hour !== ctx.hour()) {
      return fail(GRP_ERR.NOT_DUE, `仅在第${leg.slot_day}天 ${leg.slot_hour}:00 该时段当小时核销（当前第${ctx.day()}天 ${ctx.hour()}:00）`)
    }
    const take = Math.min(leg.qty, Math.max(1, Math.round(num(qty, leg.qty))))
    const anc = db.prepare("SELECT * FROM reservations WHERE id=? AND status='booked'").get(leg.reservation_id)
    if (!anc) return fail(GRP_ERR.STATUS_CONFLICT, '名额锚点单状态异常，请刷新')
    const slot = db.prepare('SELECT * FROM reservation_slots WHERE id=?').get(leg.slot_id ?? anc.slot_id)
    if (slot && slot.checked_count + take > slot.capacity) {
      return fail(GRP_ERR.SLOT_FULL, `本场已核销 ${slot.checked_count} 人，容量 ${slot.capacity}，团队名额可能被运营调减，请现场协调`)
    }

    return runAtomic(() => {
      // 入园腿首次核销：收齐全部尾款（现金制），后续分批核销不再收款
      let collected = 0
      if (leg.scope === 'entry') {
        const due = balanceDue(g)
        if (due > 0) {
          collected = due
          setSetting('cash', Math.round(ctx.cash() + due))
          ctx.logFinance?.(ctx.day(), '团尾款', due,
            `团队 ${g.code} 入园核销 ${take} 人，现场结清尾款（含其余行程）`)
          db.prepare('UPDATE group_bookings SET paid_amount=paid_amount+? WHERE id=?').run(due, g.id)
        }
      }
      const bookedAnchorId = splitAnchorChecked(anc, take, anc.slot_id)
      db.prepare('UPDATE group_legs SET qty=qty-?, checked_qty=checked_qty+?, reservation_id=? WHERE id=?')
        .run(take, take, bookedAnchorId, leg.id)
      if (leg.qty - take === 0) db.prepare("UPDATE group_legs SET status='checked' WHERE id=?").run(leg.id)
      const target = leg.scope === 'entry' ? '入园' : '设施'
      logGroup(g.id, 'checkin', `${target}时段 ${leg.slot_hour}:00 分批核销 ${take} 人${leg.qty - take > 0 ? `，余 ${leg.qty - take} 人待核销` : '，本项到齐'}${collected ? `；收齐尾款 ¥${collected}` : ''}`)
      if (leg.scope === 'entry') {
        db.prepare("UPDATE group_bookings SET status='active' WHERE id=? AND status='confirmed'").run(g.id)
      }
      return { ok: true, checked: take, collected, scope: leg.scope, rideId: leg.ride_id }
    })
  })
}

// 运营提前收取尾款（可分次，金额不超过当前应付）；首次入园核销也会自动收齐
export function settleGroupBalance(groupId, amount = null, requestId = '') {
  return idempotent('group_settle', requestId, () => {
    const g = getGroup(groupId)
    if (!g) return fail(GRP_ERR.NOT_FOUND, '团队行程不存在')
    if (!['confirmed', 'active'].includes(g.status)) return fail(GRP_ERR.STATUS_CONFLICT, '当前状态不可结算尾款')
    const due = balanceDue(g)
    if (due <= 0) return fail(GRP_ERR.NO_BALANCE, '该团没有待收尾款')
    const pay = amount == null ? due : Math.min(due, Math.max(1, Math.round(num(amount, due))))
    return runAtomic(() => {
      setSetting('cash', Math.round(ctx.cash() + pay))
      ctx.logFinance?.(ctx.day(), '团尾款', pay, `团队 ${g.code} 预缴/补缴尾款（应付尾款 ¥${due}）`)
      db.prepare('UPDATE group_bookings SET paid_amount=paid_amount+? WHERE id=?').run(pay, g.id)
      logGroup(g.id, 'settle', `收取尾款 ¥${pay}，剩余应付 ¥${Math.max(0, due - pay)}`)
      return { ok: true, paid: pay, balance: Math.max(0, due - pay) }
    })
  })
}

// ---------------- 退团 / 取消（信用 = 行程价冲减；现金按已收款为上限） ----------------
// 对团内在途腿执行冲减（按同一人数逐腿核减）；reason: guest 提前(全退)/late 当日(退50%)/park 园方(全退无手续费)
// onlyLegs 不传 = 团内全部未开始在途腿（领队退团/取消）；传入 = 仅指定腿（设施停运/时段关闭联动）
// 返回 { credit, wantedBack, cashBack, fee, legs:[{legId,take,back,fee}] }
function creditLegs(g, reason, onlyLegs = null, take0 = null) {
  const half = reason === 'late'
  let legs
  if (onlyLegs) {
    legs = onlyLegs.filter(l => l.status === 'locked' && l.qty > 0 && isFutureLeg(l)).sort((a, b) => a.seq - b.seq)
  } else {
    legs = groupLegs(g.id)
      .filter(l => l.status === 'locked' && l.qty > 0)
      .filter(l => reason === 'park' ? isFutureLeg(l)
        : (l.slot_day > ctx.day() || (l.slot_day === ctx.day() && l.slot_hour > ctx.hour())))
      .sort((a, b) => a.seq - b.seq)
  }
  const take = onlyLegs ? (legs.length ? Math.min(...legs.map(l => l.qty)) : 0) : take0
  const details = []
  let credit = 0
  let wanted = 0
  // 部分退团语义：take 个人退出剩余全部行程，因此每条在途腿都核减 take 人（不是跨腿合计 take 人）
  for (const leg of legs) {
    if (leg.qty <= 0) continue
    const n = Math.min(take, leg.qty)
    const value = n * leg.unit_price
    const back = reason === 'late' ? Math.round(value * (1 - LATE_CANCEL_FEE)) : value
    credit += value
    wanted += back
    // 先拆锚点单/释放名额，现金在团维度统一分配（不超过已收款）
    const anc = db.prepare("SELECT * FROM reservations WHERE id=? AND status='booked'").get(leg.reservation_id)
    if (anc) {
      const bookedId = splitAnchorRefund(anc, n, anc.slot_id, reason === 'park' ? 'park' : half ? 'late' : 'guest', half)
      if (bookedId !== anc.id) db.prepare('UPDATE group_legs SET reservation_id=? WHERE id=?').run(bookedId, leg.id)
    }
    db.prepare('UPDATE group_legs SET qty=qty-?, refunded_qty=refunded_qty+? WHERE id=?').run(n, n, leg.id)
    if (leg.qty - n === 0) {
      const allGone = leg.checked_qty === 0
      db.prepare("UPDATE group_legs SET status=? WHERE id=?").run(allGone ? 'refunded' : 'checked', leg.id)
    }
    details.push({ legId: leg.id, take: n, value, back, fee: value - back, rideId: leg.ride_id, scope: leg.scope })
  }
  if (!details.length) return { credit: 0, wantedBack: 0, cashBack: 0, fee: 0, legs: [] }

  // 现金退款口径：
  //   park（园方停运/关时段）与 guest（提前取消）→ 承诺全额退；
  //   late（当日取消）→ 应退 50%，其余名义手续费；
  // 实际退现以「已收款 − 已退款」为上限（未预收的尾款不可能退出现金）。
  // 当日取消时：应退部分超出已收款的差额不向游客补收，且全部未退金额（名义手续费 +
  // 订金不足以覆盖应退的缺口）均作违约没收。
  const avail = Math.max(0, g.paid_amount - g.refund_amount)
  const fullRefund = reason === 'park' || reason === 'guest'
  const wantedBack = fullRefund ? credit : wanted
  const cashBack = Math.min(wantedBack, avail)
  const fee = reason === 'late' ? credit - cashBack : 0
  // 按各腿应退比例分配现金，尾差并入最后一条
  let allocated = 0
  details.forEach((d, i) => {
    const base = fullRefund ? d.value : d.back
    let part = wantedBack > 0 ? Math.round(cashBack * base / wantedBack) : 0
    if (i === details.length - 1) part = cashBack - allocated
    allocated += part
    d.back = part
    d.fee = fullRefund ? 0 : Math.max(0, d.value - part)
  })
  for (const d of details) {
    db.prepare('UPDATE group_legs SET refund_amount=refund_amount+?, fee_amount=fee_amount+? WHERE id=?')
      .run(d.back, d.fee, d.legId)
  }
  return { credit, wantedBack, cashBack, fee, legs: details }
}

// 部分退团：对尚未开始的项目统一核减人数；提前全退、当日退 50%，园方停运走 park 通道
export function partialRefund(groupId, qtyInput, requestId = '') {
  return idempotent('group_refund', requestId, () => {
    const g = getGroup(groupId)
    if (!g) return fail(GRP_ERR.NOT_FOUND, '团队行程不存在')
    if (!['confirmed', 'active'].includes(g.status)) return fail(GRP_ERR.STATUS_CONFLICT, '当前状态不可退团')
    const legs = groupLegs(groupId)
    // 仅未开始的在途腿可退（已核销的人不能退；已开始时段的名额留给现场/日结爽约）
    const eligible = legs.filter(l => l.status === 'locked'
      && (l.slot_day > ctx.day() || (l.slot_day === ctx.day() && l.slot_hour > ctx.hour())))
    if (!eligible.length) return fail(GRP_ERR.STATUS_CONFLICT, '没有可退的未开始行程项目')
    const maxByEntry = Math.min(...eligible.map(l => l.qty))
    const take = Math.min(maxByEntry, Math.max(1, Math.round(num(qtyInput, 1))))
    const today = eligible.some(l => l.slot_day === ctx.day())
    const reason = today ? 'late' : 'guest'
    return commitRefund(g, eligible, take, reason,
      today ? '部分成员当日退团（当日取消退 50%）' : '部分成员提前退团')
  })
}

// 整团取消（领队侧；未开始项目，提前全退/当日 50%）
export function cancelGroup(groupId, requestId = '') {
  return idempotent('group_cancel', requestId, () => {
    const g = getGroup(groupId)
    if (!g) return fail(GRP_ERR.NOT_FOUND, '团队行程不存在')
    if (g.status === 'cancelled' || g.status === 'settled') return fail(GRP_ERR.STATUS_CONFLICT, '行程已结束，不可取消')
    const legs = groupLegs(groupId)
    const locked = legs.filter(l => l.status === 'locked')
    if (!locked.length) return fail(GRP_ERR.STATUS_CONFLICT, '行程没有可取消的在途项目')
    if (locked.some(l => l.slot_day < ctx.day() || (l.slot_day === ctx.day() && l.slot_hour <= ctx.hour()))) {
      return fail(GRP_ERR.SLOT_PAST, '已有行程项目开始/结束，不可整团取消，请使用部分退团')
    }
    const take = Math.min(...locked.map(l => l.qty))
    const reason = locked.some(l => l.slot_day === ctx.day()) ? 'late' : 'guest'
    return commitRefund(g, null, take, reason,
      reason === 'late' ? '领队当日整团取消（退 50%）' : '领队提前整团取消',
      { markCancelled: true })
  })
}

// 退款落库（团维度金额）：冲减行程价、退现金（≤已收款）、手续费没收、流水与日志，全部并入一个事务
// markCancelled: 是否将团单置为 cancelled（整团取消）；否则由调用方按入园情况决定
function commitRefund(g, _legs, take, reason, note, { markCancelled = false } = {}) {
  return runAtomic(() => {
    const r = creditLegs(g, reason, null, take)
    if (!r.legs.length) throw new TxError(GRP_ERR.STATUS_CONFLICT, '没有可退的在途名额')
    if (r.cashBack > 0) {
      setSetting('cash', Math.round(ctx.cash() - r.cashBack))
      ctx.logFinance?.(ctx.day(), '团退款', -r.cashBack, `团队 ${g.code} ${note}：退回 ¥${r.cashBack}（${r.legs.length} 项行程）`)
    }
    if (r.fee > 0) ctx.logFinance?.(ctx.day(), '违约', r.fee, `团队 ${g.code} 退团手续费/订金没收`)
    let sets = 'cancelled_amount=cancelled_amount+?, fee_amount=fee_amount+?, refund_amount=refund_amount+?'
    const vals = [r.credit, r.fee, r.cashBack]
    if (markCancelled) { sets += ", status='cancelled', closed_tick=?, closed_day=?"; vals.push(ctx.tick(), ctx.day()) }
    vals.push(g.id)
    db.prepare(`UPDATE group_bookings SET ${sets} WHERE id=?`).run(...vals)
    const legMap = new Map(groupLegs(g.id).map(l => [l.id, l]))
    for (const d of r.legs) {
      const ll = legMap.get(d.legId)
      logGroup(g.id, 'refund',
        `${d.scope === 'entry' ? '入园' : '设施'} 第${ll?.slot_day}天${ll?.slot_hour}:00 核减 ${d.take} 人，退款 ¥${d.back}${d.fee ? `，手续费/没收 ¥${d.fee}` : ''}`)
    }
    // 入园腿已无人且无一人入园 → 整团取消（部分退团把入园名额也退光的兜底）
    const entry = groupLegs(g.id).find(l => l.scope === 'entry')
    if (entry && entry.qty === 0 && entry.checked_qty === 0 && !markCancelled) {
      db.prepare("UPDATE group_bookings SET status='cancelled', closed_tick=?, closed_day=? WHERE id=?")
        .run(ctx.tick(), ctx.day(), g.id)
    }
    return { ok: true, refund: r.cashBack, fee: r.fee, credit: r.credit }
  })
}

// ---------------- 设施停运 / 时段关闭：自动重排或退款 ----------------
function isFutureLeg(leg) {
  return leg.slot_day > ctx.day() || (leg.slot_day === ctx.day() && leg.slot_hour >= ctx.hour())
}

// 同设施/入园其他可安置时段：开放、有余量、与团内其他在途腿不撞时刻
function findRerouteSlot(g, leg) {
  const otherHours = new Set(
    groupLegs(g.id).filter(l => l.id !== leg.id && l.status === 'locked').map(l => `${l.slot_day}-${l.slot_hour}`)
  )
  const rows = db.prepare(`${SLOT_SELECT} WHERE s.scope=? AND s.status='open'
    AND (s.day>? OR (s.day=? AND s.hour>=?))
    ${leg.scope === 'ride' ? 'AND s.ride_id=?' : ''}
    ORDER BY s.day, s.hour`)
    .all(leg.scope, ctx.day(), ctx.day(), ctx.hour(), ...(leg.scope === 'ride' ? [leg.ride_id] : []))
  return rows.find(s => s.remain >= leg.qty && !otherHours.has(`${s.day}-${s.hour}`)
    && !(s.day === leg.slot_day && s.hour === leg.slot_hour))
}

// 单腿改期（同设施/入园，不加价）：目标原子占用 → 锚点单条件转移 → 原时段释放，同事务
function rerouteLeg(g, leg, target) {
  const claim = db.prepare(`UPDATE reservation_slots SET booked_count=booked_count+?
    WHERE id=? AND status='open' AND capacity+oversell-booked_count>=?`).run(leg.qty, target.id, leg.qty)
  if (claim.changes === 0) return false
  const anc = db.prepare("SELECT * FROM reservations WHERE id=? AND status='booked'").get(leg.reservation_id)
  if (!anc) throw new TxError(GRP_ERR.STATUS_CONFLICT, '锚点单状态异常，无法改期')
  const u = db.prepare("UPDATE reservations SET slot_id=?, slot_day=?, slot_hour=?, reschedules=reschedules+1 WHERE id=? AND status='booked'")
    .run(target.id, target.day, target.hour, anc.id)
  if (u.changes === 0) throw new TxError(GRP_ERR.STATUS_CONFLICT, '锚点单状态异常，无法改期')
  db.prepare('UPDATE reservation_slots SET booked_count=MAX(0,booked_count-?) WHERE id=?').run(leg.qty, anc.slot_id)
  db.prepare('UPDATE group_legs SET slot_day=?, slot_hour=?, reschedules=reschedules+1, status=? WHERE id=?')
    .run(target.day, target.hour, 'locked', leg.id)
  logAnchor(anc.id, 'auto_reschedule', `团队行程改期至 第${target.day}天 ${target.hour}:00`)
  logGroup(g.id, 'reroute', `设施停运联动：${leg.scope === 'entry' ? '入园' : '设施'}行程改期至 第${target.day}天 ${target.hour}:00（${leg.qty} 人）`)
  return true
}

// 园方原因批量退款（设施整体停运 / 设施拆除）：优先同日跨设施改排，无法安置则全额退订金已收部分，未收尾款豁免
// 由预约模块在 syncRideSlots 同事务内调用；抛错会随外层整体回滚。
export function parkRefundRideGroups(rideLike) {
  const rideId = rideLike.id ?? rideLike.ride_id
  const rideName = rideLike.name || `设施#${rideId}`
  const legs = db.prepare(`SELECT l.* FROM group_legs l
    JOIN reservations r ON r.id=l.reservation_id
    WHERE l.scope='ride' AND l.ride_id=? AND l.status='locked' AND r.status='booked'`).all(rideId)
    .filter(isFutureLeg)
  const byGroup = new Map()
  for (const leg of legs) {
    if (!byGroup.has(leg.group_id)) byGroup.set(leg.group_id, [])
    byGroup.get(leg.group_id).push(leg)
  }
  for (const [gid, groupLegsList] of byGroup) {
    const g = getGroup(gid)
    if (!g) continue
    const routed = []
    const refundLegs = []
    for (const leg of groupLegsList) {
      const alt = findCrossRideSlot(g, leg)
      if (alt) {
        rerouteLegAcross(g, leg, alt.slot, alt.ride)
        routed.push({ leg, alt })
      } else {
        refundLegs.push(leg)
      }
    }
    if (routed.length) {
      logGroup(gid, 'reroute', `设施「${rideName}」停运，${routed.length} 项行程已同日改排到其他运营设施（园方承担差价）`)
    }
    if (!refundLegs.length) continue
    const r = creditLegs(g, 'park', refundLegs)
    if (!r.legs.length) continue
    if (r.cashBack > 0) {
      setSetting('cash', Math.round(ctx.cash() - r.cashBack))
      ctx.logFinance?.(ctx.day(), '团退款', -r.cashBack,
        `团队 ${g.code} 关联设施「${rideName}」停运，无法改排，园方全额退款（不计手续费）`)
    }
    db.prepare('UPDATE group_bookings SET cancelled_amount=cancelled_amount+?, refund_amount=refund_amount+? WHERE id=?')
      .run(r.credit, r.cashBack, gid)
    for (const d of r.legs) {
      logGroup(gid, 'refund', `设施「${rideName}」停运且无可用替代设施，${d.take} 人该项目园方全额退款 ¥${d.back}（未收尾款豁免）`)
    }
    // 整趟行程全部被改排或退款均生成一次投诉；若有项目退款（非纯改排）才投诉
    ctx.createComplaint?.({
      category: 'facility', severity: 2,
      title: `团队行程受影响 · ${rideName}`,
      content: `团队 ${g.code}（${g.headcount} 人）行程中「${rideName}」临时停运，${routed.length ? `部分项目已改排其他设施，仍有 ${r.legs.length} 项` : '无法改排，'}已全额退还订金并豁免尾款，领队要求园方给说法。`,
      target: { type: 'ride', id: rideId, name: rideName },
      source: 'guest'
    })
  }
  return { ok: true, affected: byGroup.size }
}

// 跨设施改排候选：同游戏日内其他运营设施的开放时段，余量足够、与团内在途腿不撞时刻，优先同时段再往后
function findCrossRideSlot(g, leg) {
  const otherHours = new Set(
    groupLegs(g.id).filter(l => l.id !== leg.id && l.status === 'locked').map(l => `${l.ride_id}-${l.slot_day}-${l.slot_hour}`)
  )
  const rides = db.prepare("SELECT * FROM rides WHERE status='operating' AND id<>?").all(leg.ride_id)
  let best = null
  for (const ride of rides) {
    const rows = db.prepare(`${SLOT_SELECT} WHERE s.scope='ride' AND s.ride_id=? AND s.status='open' AND s.day=?
      ORDER BY ABS(s.hour-?), s.hour`).all(ride.id, leg.slot_day, leg.slot_hour)
    const hit = rows.find(s => s.remain >= leg.qty && !otherHours.has(`${ride.id}-${s.day}-${s.hour}`))
    if (hit && (!best || Math.abs(hit.hour - leg.slot_hour) < Math.abs(best.slot.hour - leg.slot_hour))) {
      best = { slot: hit, ride }
    }
  }
  return best
}

// 跨设施改排落库：目标占用 → 锚点单改挂新设施/时段 → 原时段释放；价格按原行程价保留（园方承担差价，不加价不退款）
function rerouteLegAcross(g, leg, target, ride) {
  const claim = db.prepare(`UPDATE reservation_slots SET booked_count=booked_count+?
    WHERE id=? AND status='open' AND capacity+oversell-booked_count>=?`).run(leg.qty, target.id, leg.qty)
  if (claim.changes === 0) throw new TxError(GRP_ERR.SLOT_FULL, '替代设施名额不足')
  const anc = db.prepare("SELECT * FROM reservations WHERE id=? AND status='booked'").get(leg.reservation_id)
  if (!anc) throw new TxError(GRP_ERR.STATUS_CONFLICT, '锚点单状态异常，无法改排')
  const u = db.prepare("UPDATE reservations SET slot_id=?, slot_day=?, slot_hour=?, ride_id=?, reschedules=reschedules+1 WHERE id=? AND status='booked'")
    .run(target.id, target.day, target.hour, ride.id, anc.id)
  if (u.changes === 0) throw new TxError(GRP_ERR.STATUS_CONFLICT, '锚点单状态异常，无法改排')
  db.prepare('UPDATE reservation_slots SET booked_count=MAX(0,booked_count-?) WHERE id=?').run(leg.qty, anc.slot_id)
  // 行程腿改挂新设施，保留原单价（差价园方承担）；unit_price 用于退款/爽约口径，改排后按新设施价更新更合理——
  // 但园方承诺不加价，退款时应退回该腿实际承担价值，故沿用原单价。
  db.prepare('UPDATE group_legs SET slot_day=?, slot_hour=?, ride_id=?, reschedules=reschedules+1, status=? WHERE id=?')
    .run(target.day, target.hour, ride.id, 'locked', leg.id)
  logAnchor(anc.id, 'auto_reschedule', `团队跨设施改排：${rideName(leg.ride_id)} → ${ride.name}（第${target.day}天 ${target.hour}:00）`)
  logGroup(g.id, 'reroute', `停运改排：设施 ${rideName(leg.ride_id)} → 「${ride.name}」第${target.day}天 ${target.hour}:00（${leg.qty} 人，价格不变）`)
}
function rideName(id) { return db.prepare('SELECT name FROM rides WHERE id=?').get(id)?.name || `设施#${id}` }

// 单个时段被运营关闭（入园/设施）：团内命中腿优先自动改期，无法安置则园方全额退款。
// 同样运行在 updateSlot 的事务内。
export function handleGroupSlotClosed(slot) {
  const legs = db.prepare(`SELECT l.* FROM group_legs l
    JOIN reservations r ON r.id=l.reservation_id
    WHERE l.status='locked' AND r.status='booked'
      AND l.slot_day=? AND l.slot_hour=?
      ${slot.scope === 'ride' ? 'AND l.ride_id=?' : ''}`)
    .all(slot.day, slot.hour, ...(slot.scope === 'ride' ? [slot.ride_id] : []))
    .filter(isFutureLeg)
  const byGroup = new Map()
  for (const leg of legs) {
    if (!byGroup.has(leg.group_id)) byGroup.set(leg.group_id, { routed: [], refunded: [] })
    const g = getGroup(leg.group_id)
    const target = findRerouteSlot(g, leg)
    if (target && rerouteLeg(g, leg, target)) byGroup.get(leg.group_id).routed.push(leg)
    else byGroup.get(leg.group_id).refunded.push(leg)
  }
  for (const [gid, bag] of byGroup) {
    const g = getGroup(gid)
    if (!g) continue
    if (bag.refunded.length) {
      const r = creditLegs(g, 'park', bag.refunded)
      if (r.legs.length) {
        if (r.cashBack > 0) {
          setSetting('cash', Math.round(ctx.cash() - r.cashBack))
          ctx.logFinance?.(ctx.day(), '团退款', -r.cashBack, `团队 ${g.code} 时段临时关闭，无法改期，园方全额退款`)
        }
        db.prepare('UPDATE group_bookings SET cancelled_amount=cancelled_amount+?, refund_amount=refund_amount+? WHERE id=?')
          .run(r.credit, r.cashBack, gid)
        for (const d of r.legs) logGroup(gid, 'refund', `时段关闭且无可改期时段，${d.take} 人园方全额退款 ¥${d.back}`)
        const anyRide = bag.refunded[0].scope === 'ride'
        const targetName = anyRide ? db.prepare('SELECT name FROM rides WHERE id=?').get(bag.refunded[0].ride_id)?.name || '设施' : '分时入园'
        ctx.createComplaint?.({
          category: anyRide ? 'facility' : 'service', severity: 2,
          title: `团队行程时段取消 · ${targetName}`,
          content: `团队 ${g.code} 第${slot.day}天 ${slot.hour}:00 行程时段被园方临时关闭且无法改期，订金已全额退回，领队不满。`,
          target: anyRide ? { type: 'ride', id: bag.refunded[0].ride_id, name: targetName } : { type: '', id: null, name: '' },
          source: 'guest'
        })
      }
    }
  }
  return { ok: true, affected: byGroup.size }
}

// 运营手动改期单个行程腿（同设施/入园其他时段，不加价），供停运恢复后人工重排
export function rerouteGroupLeg(groupId, legId, targetSlotId, requestId = '') {
  return idempotent('group_reroute', requestId, () => {
    const g = getGroup(groupId)
    if (!g) return fail(GRP_ERR.NOT_FOUND, '团队行程不存在')
    if (!['confirmed', 'active'].includes(g.status)) return fail(GRP_ERR.STATUS_CONFLICT, '当前状态不可改期')
    const leg = groupLegs(groupId).find(l => l.id === num(legId))
    if (!leg) return fail(GRP_ERR.LEG_NOT_FOUND, '行程项目不存在')
    if (leg.status !== 'locked') return fail(GRP_ERR.STATUS_CONFLICT, '该项目已处理，不可改期')
    if (!isFutureLeg(leg)) return fail(GRP_ERR.SLOT_PAST, '项目时段已开始，不可改期')
    const target = getSlot(num(targetSlotId))
    if (!target || target.scope !== leg.scope || (leg.scope === 'ride' && target.ride_id !== leg.ride_id)) {
      return fail(GRP_ERR.SLOT_MISMATCH, '仅可改期到同一项目的其他时段')
    }
    if (target.status !== 'open') return fail(GRP_ERR.SLOT_CLOSED, '目标时段已关闭')
    if (target.day === leg.slot_day && target.hour === leg.slot_hour) return fail(GRP_ERR.SLOT_MISMATCH, '目标时段与原时段相同')
    const clash = groupLegs(groupId).some(l => l.id !== leg.id && l.status === 'locked' && l.slot_day === target.day && l.slot_hour === target.hour)
    if (clash) return fail(GRP_ERR.ITINERARY_INVALID, '目标时段与团内其他行程冲突')
    if (target.remain < leg.qty) return fail(GRP_ERR.SLOT_FULL, `目标时段余量不足（剩 ${Math.max(0, target.remain)}）`)
    return runAtomic(() => {
      if (!rerouteLeg(g, leg, target)) throw new TxError(GRP_ERR.SLOT_FULL, '目标时段名额不足，改期失败')
      return { ok: true }
    })
  })
}

// ---------------- 引擎联动：当小时自动核销 / 闭园日结爽约 ----------------
// 团队当小时到期项目自动核销（团队整建制到场，不做随机到场率）；入园腿核销同时收齐尾款。
// 返回 { entry: 入园人数, ride: Map<rideId,qty>, errors }
export function autoProcessGroupArrivals(hour) {
  const day = ctx.day()
  const rows = db.prepare(`SELECT l.* FROM group_legs l
    JOIN reservations r ON r.id=l.reservation_id
    JOIN group_bookings g ON g.id=l.group_id
    WHERE l.status='locked' AND r.status='booked' AND l.slot_day=? AND l.slot_hour=?
      AND g.status IN ('confirmed','active')`).all(day, hour)
  let entry = 0
  const ride = new Map()
  let errors = 0
  for (const leg of rows) {
    const r = checkinGroupLeg(leg.group_id, { legId: leg.id, qty: leg.qty })
    if (!r.ok) { errors++; continue }
    if (leg.scope === 'entry') entry += r.checked
    else ride.set(leg.ride_id, (ride.get(leg.ride_id) || 0) + r.checked)
  }
  return { entry, ride, errors }
}

// 闭园日结：当日未核销的在途项目按爽约处理（订金/已付款不退、不补收尾款）；团单结清/取消
export function dayCloseGroups(day) {
  const rows = db.prepare(`SELECT l.* FROM group_legs l
    JOIN reservations r ON r.id=l.reservation_id
    WHERE l.status='locked' AND r.status='booked' AND l.slot_day=?`).all(day)
  const groupIds = new Set()
  runAtomic(() => {
    for (const leg of rows) {
      const anc = db.prepare("SELECT * FROM reservations WHERE id=? AND status='booked'").get(leg.reservation_id)
      if (!anc) continue
      anchorNoshow(anc, anc.slot_id)
      const qty = leg.qty
      db.prepare("UPDATE group_legs SET qty=0, status='noshow' WHERE id=?").run(leg.id)
      db.prepare('UPDATE group_bookings SET cancelled_amount=cancelled_amount+? WHERE id=?')
        .run(qty * leg.unit_price, leg.group_id)
      logGroup(leg.group_id, 'noshow', `闭园日结：${leg.scope === 'entry' ? '入园' : '设施'}项目 ${qty} 人未核销，按爽约处理，已付款不退、尾款不补收`)
      groupIds.add(leg.group_id)
    }
    for (const gid of groupIds) {
      const g = getGroup(gid)
      if (!g || ['settled', 'cancelled'].includes(g.status)) continue
      const entry = groupLegs(gid).find(l => l.scope === 'entry')
      const entered = entry && entry.checked_qty > 0
      db.prepare("UPDATE group_bookings SET status=?, closed_tick=?, closed_day=? WHERE id=?")
        .run(entered ? 'settled' : 'cancelled', ctx.tick(), day, gid)
      logGroup(gid, entered ? 'settle' : 'cancel', entered ? '团队行程结束，团单结清' : '团队当日未入园，按整团爽约撤单')
    }
    return { ok: true }
  })
  return { groups: groupIds.size, legs: rows.length }
}

// ---------------- 查询 ----------------
function enrichGroup(g, rides) {
  const legs = groupLegs(g.id).map(l => ({
    ...l,
    ride_name: l.scope === 'ride' ? (rides.find(r => r.id === l.ride_id)?.name || `设施#${l.ride_id}`) : '',
    status_name: LEG_STATUS_NAMES[l.status] || l.status,
    anchor_code: l.reservation_id ? (db.prepare('SELECT code FROM reservations WHERE id=?').get(l.reservation_id)?.code || '') : ''
  }))
  const refundedValue = legs.reduce((s, l) => s + l.refunded_qty * l.unit_price, 0)
  const checkedValue = legs.reduce((s, l) => s + l.checked_qty * l.unit_price, 0)
  return {
    ...g,
    status_name: STATUS_NAMES[g.status] || g.status,
    legs,
    live_value: groupLiveValue(g),
    refunded_value: refundedValue,
    checked_value: checkedValue,
    balance_due: balanceDue(g),
    checked_persons: legs.find(l => l.scope === 'entry')?.checked_qty || 0
  }
}

export function listGroups({ status = null, day = null, limit = 100 } = {}) {
  const rides = db.prepare('SELECT id,name FROM rides').all()
  const conds = []
  const vals = []
  if (status) { conds.push('status=?'); vals.push(status) }
  if (day) { conds.push('visit_day=?'); vals.push(num(day)) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM group_bookings ${where} ORDER BY id DESC LIMIT ?`).all(...vals, num(limit, 100))
  return rows.map(g => enrichGroup(g, rides))
}

export function groupDetail(id) {
  const g = getGroup(id)
  if (!g) return null
  const rides = db.prepare('SELECT id,name FROM rides').all()
  const logs = db.prepare('SELECT * FROM group_logs WHERE group_id=? ORDER BY id').all(id)
  return { group: enrichGroup(g, rides), logs }
}

export function groupStats() {
  const today = ctx.day()
  const one = (sql, ...v) => db.prepare(sql).get(...v)
  const pending = one("SELECT COUNT(*) n, COALESCE(SUM(headcount),0) q FROM group_bookings WHERE status='pending'")
  const locked = one("SELECT COUNT(*) n, COALESCE(SUM(headcount),0) q FROM group_bookings WHERE status IN ('confirmed','active') AND visit_day>=?", today)
  const todayGroups = one("SELECT COUNT(*) n FROM group_bookings WHERE visit_day=? AND status IN ('confirmed','active','settled')", today)
  const depositHeld = one("SELECT COALESCE(SUM(paid_amount-refund_amount),0) s FROM group_bookings WHERE status IN ('confirmed','active')").s
  const outstanding = (() => {
    let s = 0
    for (const g of db.prepare("SELECT * FROM group_bookings WHERE status IN ('confirmed','active')").all()) {
      s += balanceDue(g)
    }
    return s
  })()
  const todayRefund = one("SELECT COALESCE(SUM(refund_amount),0) s FROM group_bookings WHERE closed_day=?", today).s
  const settledToday = one("SELECT COUNT(*) n FROM group_bookings WHERE status='settled' AND closed_day=?", today).n
  return {
    pending: pending.n, pendingQty: pending.q,
    active: locked.n, activeQty: locked.q,
    todayGroups: todayGroups.n,
    depositHeld, outstanding,
    refundToday: todayRefund, settledToday
  }
}

export const GROUP_CONST = { DEFAULT_DEPOSIT_RATE, MIN_HEADCOUNT, MAX_HEADCOUNT }
