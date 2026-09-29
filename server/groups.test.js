// 领队团队行程一致性测试：
// 提交/确认锁定名额/订金/幂等/失败回滚/分批核销与尾款/部分退团/整团取消/
// 设施停运跨设施重排或园方退款/时段关闭改期/闭园日结爽约（node:test，内存库隔离）
// 运行：node --experimental-sqlite --test server/groups.test.js（需 Node >= 22.5）
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

process.env.PARK_DB_PATH = ':memory:'   // 必须在导入 db.js 前由测试启动环境注入
const { default: db, getSetting, setSetting } = await import('./db.js')
const RSV = await import('./reservations.js')
const G = await import('./groups.js')

const finLogs = []
let complaints = 0
RSV.initReservationContext({
  logFinance: (d, l, a, n) => finLogs.push({ day: d, label: l, amount: a, detail: n }),
  createComplaint: () => ({ id: ++complaints, code: 'TS' + String(complaints).padStart(4, '0') })
})
G.initGroupContext({
  logFinance: (d, l, a, n) => finLogs.push({ day: d, label: l, amount: a, detail: n }),
  createComplaint: () => ({ id: ++complaints, code: 'TS' + String(complaints).padStart(4, '0') })
})
RSV.initReservationContext({
  onGroupRideDown: r => G.parkRefundRideGroups(r),
  onGroupSlotClosed: s => G.handleGroupSlotClosed(s)
})

const cash = () => Number(getSetting('cash'))
const slotOf = (scope, day, hour, rideId = null) =>
  db.prepare(`SELECT * FROM reservation_slots WHERE scope=? AND day=? AND hour=? ${scope === 'ride' ? 'AND ride_id=?' : ''}`)
    .get(scope, day, hour, ...(scope === 'ride' ? [rideId] : []))
const setClock = (day, hour) => { setSetting('day', day); setSetting('hour', hour) }
const groupRow = id => db.prepare('SELECT * FROM group_bookings WHERE id=?').get(id)
const legsOf = id => db.prepare('SELECT * FROM group_legs WHERE group_id=? ORDER BY seq').all(id)

before(() => {
  setSetting('day', 1); setSetting('hour', 9); setSetting('tick', 0)
  setSetting('cash', 100000); setSetting('ticket', 100)
  RSV.ensureSlots()
})

const rides = db.prepare("SELECT * FROM rides WHERE status='operating' ORDER BY id LIMIT 3").all()
// 重新开放所有运营设施未来时段（前序停运测试可能关停过时段；rides 表状态未被 syncRideSlots 改动）
function reopenRideSlots(day) {
  db.prepare("UPDATE reservation_slots SET status='open' WHERE scope='ride' AND day=?").run(day)
}
function buildLegs(day, { entryHour = 10, rideHours = [11, 13], rideIds = null } = {}) {
  const ids = rideIds || rides.map(r => r.id)
  const legs = [{ scope: 'entry', slot_id: slotOf('entry', day, entryHour).id }]
  rideHours.forEach((h, i) => {
    legs.push({ scope: 'ride', slot_id: slotOf('ride', day, h, ids[i]).id, ride_id: ids[i] })
  })
  return legs
}

test('提交校验：必须恰好一个入园腿且排第一项、同日、不撞时刻、人数区间', () => {
  const noEntry = G.submitGroup({ leader_name: 'A', headcount: 10, legs: [
    { scope: 'ride', slot_id: slotOf('ride', 2, 11, rides[0].id).id, ride_id: rides[0].id }
  ] }, 'v-no-entry')
  assert.equal(noEntry.ok, false)
  assert.equal(noEntry.code, 'GRP_ITINERARY_INVALID')

  const twoEntry = G.submitGroup({ leader_name: 'A', headcount: 10, legs: [
    { scope: 'entry', slot_id: slotOf('entry', 2, 10).id },
    { scope: 'entry', slot_id: slotOf('entry', 2, 11).id }
  ] }, 'v-two-entry')
  assert.equal(twoEntry.ok, false)

  const clash = G.submitGroup({ leader_name: 'A', headcount: 10, legs: [
    { scope: 'entry', slot_id: slotOf('entry', 2, 11).id },
    { scope: 'ride', slot_id: slotOf('ride', 2, 11, rides[0].id).id, ride_id: rides[0].id }
  ] }, 'v-clash')
  assert.equal(clash.ok, false)

  const tooFew = G.submitGroup({ leader_name: 'A', headcount: 2, legs: buildLegs(2) }, 'v-small')
  assert.equal(tooFew.ok, false)
  assert.equal(tooFew.code, 'GRP_INVALID')

  // 提交不占名额、不收款
  const cash0 = cash()
  const booked0 = slotOf('entry', 2, 12).booked_count
  G.submitGroup({ leader_name: 'A', headcount: 10, legs: [
    { scope: 'entry', slot_id: slotOf('entry', 2, 12).id }
  ] }, 'v-pending-no-hold')
  assert.equal(slotOf('entry', 2, 12).booked_count, booked0)
  assert.equal(cash(), cash0)
})

test('确认锁定：各时段名额统一占用+订金入账，任一不足整体回滚；幂等重放只锁一次', () => {
  const sub = G.submitGroup({ leader_name: '王领队', org: '阳光旅行社', headcount: 20, deposit_rate: 30,
    legs: buildLegs(2) }, 'c-sub')
  assert.equal(sub.ok, true)
  const total = 100 * 20 + rides[0].price * 20 + rides[1].price * 20
  assert.equal(sub.total, total)
  const deposit = Math.round(total * 0.3)

  const cash0 = cash()
  const slots = [slotOf('entry', 2, 10), slotOf('ride', 2, 11, rides[0].id), slotOf('ride', 2, 13, rides[1].id)]
  const booked0 = slots.map(s => s.booked_count)

  const conf = G.confirmGroup(sub.id, 'c-ok')
  assert.equal(conf.ok, true)
  assert.equal(conf.deposit, deposit)
  assert.equal(cash(), cash0 + deposit)
  slots.forEach((s, i) => assert.equal(slotOf(s.scope, s.day, s.hour, s.ride_id).booked_count, booked0[i] + 20))
  assert.equal(groupRow(sub.id).status, 'confirmed')

  // 幂等重放
  const replay = G.confirmGroup(sub.id, 'c-ok')
  assert.equal(replay.replay, true)
  assert.equal(cash(), cash0 + deposit, '订金不得重复收取')
  slots.forEach((s, i) => assert.equal(slotOf(s.scope, s.day, s.hour, s.ride_id).booked_count, booked0[i] + 20))

  // 名额不足：另一个团确认时原子锁定失败，名额/现金零残留
  const sub2 = G.submitGroup({ leader_name: '李领队', headcount: 20, legs: buildLegs(2) }, 'c-sub2')
  assert.equal(sub2.ok, true)
  // 把其中一个时段真实容量清零（直接改库存层；剩余余量不足以容纳该团）
  const capSlot = slotOf('ride', 2, 13, rides[1].id)
  db.prepare('UPDATE reservation_slots SET capacity=0, oversell=0 WHERE id=?').run(capSlot.id)
  const beforeCash = cash()
  const bookedBefore = [slotOf('entry', 2, 10), slotOf('ride', 2, 11, rides[0].id), slotOf('ride', 2, 13, rides[1].id)]
    .map(s => s.booked_count)
  const fail = G.confirmGroup(sub2.id, 'c-fail')
  assert.equal(fail.ok, false)
  assert.equal(fail.code, 'SLOT_FULL')
  assert.equal(cash(), beforeCash, '失败不得收订金')
  const bookedAfter = [slotOf('entry', 2, 10), slotOf('ride', 2, 11, rides[0].id), slotOf('ride', 2, 13, rides[1].id)]
    .map(s => s.booked_count)
  assert.deepEqual(bookedAfter, bookedBefore, '任一腿锁定失败整体回滚，不得占用任何时段名额')
  assert.equal(groupRow(sub2.id).status, 'pending')
  db.prepare('UPDATE reservation_slots SET capacity=220 WHERE id=?').run(capSlot.id)
})

test('分批核销：首次入园核销自动收齐尾款；设施腿分批核销拆单名额不蒸发', () => {
  const sub = G.submitGroup({ leader_name: '赵领队', headcount: 10, deposit_rate: 30,
    legs: buildLegs(3, { entryHour: 9, rideHours: [10, 12] }) }, 'k-sub')
  const total = sub.total
  const dep = Math.round(total * 0.3)
  assert.equal(G.confirmGroup(sub.id, 'k-confirm').ok, true)
  const cashAfterDep = cash()

  // 未到时段不可核销
  setClock(3, 8)
  const early = G.checkinGroupLeg(sub.id, { qty: 10, requestId: 'k-early' })
  assert.equal(early.ok, false)
  assert.equal(early.code, 'GRP_NOT_DUE')

  setClock(3, 9)
  // 首次仅 6 人入园：尾款仍按整团行程一次收齐
  const e1 = G.checkinGroupLeg(sub.id, { qty: 6, requestId: 'k-e1' })
  assert.equal(e1.ok, true)
  assert.equal(e1.checked, 6)
  assert.equal(e1.collected, total - dep, '尾款在首次入园时收齐')
  assert.equal(cash(), cashAfterDep + (total - dep))
  assert.equal(groupRow(sub.id).status, 'active')

  // 剩余 4 人入园：不再收款
  const cashBefore2 = cash()
  const e2 = G.checkinGroupLeg(sub.id, { qty: 4, requestId: 'k-e2' })
  assert.equal(e2.ok, true)
  assert.equal(e2.collected, 0)
  assert.equal(cash(), cashBefore2)
  const entryLeg = legsOf(sub.id)[0]
  assert.equal(entryLeg.status, 'checked')
  assert.equal(entryLeg.checked_qty, 10)
  assert.equal(entryLeg.qty, 0)
  const entrySlot = slotOf('entry', 3, 9)
  assert.equal(entrySlot.checked_count, 10)
  assert.equal(entrySlot.booked_count, 10, '在途名额总量不随拆单蒸发（checked 不释放）')

  // 设施腿分两批：6 + 4，锚点单迁移到剩余在途单
  setClock(3, 10)
  const r1a = G.checkinGroupLeg(sub.id, { legId: legsOf(sub.id)[1].id, qty: 6, requestId: 'k-r1a' })
  assert.equal(r1a.ok, true)
  const mid = legsOf(sub.id)[1]
  assert.equal(mid.qty, 4)
  const anchor = db.prepare('SELECT * FROM reservations WHERE id=?').get(mid.reservation_id)
  assert.equal(anchor.qty, 4)
  assert.equal(anchor.status, 'booked')
  const r1b = G.checkinGroupLeg(sub.id, { legId: mid.id, qty: 4, requestId: 'k-r1b' })
  assert.equal(r1b.ok, true)
  assert.equal(legsOf(sub.id)[1].status, 'checked')
  // 幂等：同一请求重放不重复放行
  const replay = G.checkinGroupLeg(sub.id, { legId: mid.id, qty: 4, requestId: 'k-r1b' })
  assert.equal(replay.replay, true)
  assert.equal(slotOf('ride', 3, 10, rides[0].id).checked_count, 10)
})

test('提前部分退团与整团取消：提前全退、当日退50%，现金退款不超过已收款', () => {
  setClock(1, 9)
  // 未来日行程：提前退 3 人（入园 100 + 两设施单价，按提交快照计算）
  const t4legs = () => [
    { scope: 'entry', slot_id: slotOf('entry', 2, 15).id },
    { scope: 'ride', slot_id: slotOf('ride', 2, 16, rides[1].id).id, ride_id: rides[1].id },
    { scope: 'ride', slot_id: slotOf('ride', 2, 17, rides[2].id).id, ride_id: rides[2].id }
  ]
  const sub = G.submitGroup({ leader_name: '孙领队', headcount: 10, deposit_rate: 30,
    legs: t4legs() }, 'r-sub')
  G.confirmGroup(sub.id, 'r-conf')
  const g0 = groupRow(sub.id)
  const cash0 = cash()
  const perPerson = g0.total_amount / 10

  const pr = G.partialRefund(sub.id, 3, 'r-part')
  assert.equal(pr.ok, true)
  assert.equal(pr.credit, 3 * perPerson, '提前退：信用全额冲减')
  assert.equal(pr.refund, 3 * perPerson)
  assert.equal(pr.fee, 0)
  assert.equal(cash(), cash0 - 3 * perPerson)
  const legs = legsOf(sub.id)
  legs.forEach(l => {
    assert.equal(l.qty, 7)
    assert.equal(l.refunded_qty, 3)
  })
  // 名额释放
  assert.equal(slotOf('entry', 2, 15).booked_count, 7)

  // 整团取消剩余 7 人（仍是未来时段）：订金已在部分退团时退完，未预收尾款不退现金、不收手续费
  const cash2 = cash()
  const cc = G.cancelGroup(sub.id, 'r-cancel')
  assert.equal(cc.ok, true)
  assert.equal(cc.fee, 0, '提前取消不产生手续费')
  assert.equal(cc.refund, 0, '已收款（订金）已退完，无现金可退')
  assert.equal(cash(), cash2)
  assert.equal(groupRow(sub.id).status, 'cancelled')
  assert.equal(slotOf('entry', 2, 15).booked_count, 0, '剩余名额全部释放')

  // 当日退团：行程当天申请，退 50%，其余作手续费
  setClock(2, 9)
  const sub2 = G.submitGroup({ leader_name: '周领队', headcount: 10, deposit_rate: 30,
    legs: [
      { scope: 'entry', slot_id: slotOf('entry', 2, 14).id },
      { scope: 'ride', slot_id: slotOf('ride', 2, 15, rides[1].id).id, ride_id: rides[1].id },
      { scope: 'ride', slot_id: slotOf('ride', 2, 16, rides[2].id).id, ride_id: rides[2].id }
    ] }, 'r2-sub')
  G.confirmGroup(sub2.id, 'r2-conf')
  // 当日取消应退 50%（=825），但实际退现以已收订金（30%=495）为上限；未退的 1155 全部没收
  const cashBeforeLate = cash()
  const late = G.partialRefund(sub2.id, 10, 'r2-late')
  assert.equal(late.ok, true)
  const unit2 = groupRow(sub2.id).total_amount / 10
  assert.equal(late.credit, 10 * unit2)
  assert.equal(late.refund, Math.round(0.3 * 10 * unit2), '现金退款不超过已收订金')
  assert.equal(late.fee, 10 * unit2 - late.refund, '名义手续费 + 订金不足缺口一并没收')
  assert.equal(cash(), cashBeforeLate - late.refund)
  assert.ok(finLogs.some(f => f.label === '违约' && f.amount === late.fee && f.amount > 0))
  assert.equal(groupRow(sub2.id).status, 'cancelled', '入园名额全部退光 → 整团取消')
})

test('设施停运：在途团队腿优先同日跨设施改排，无法安置则园方全额退款并豁免尾款', () => {
  setClock(1, 9)
  // 团行程：入园 + 设施A(14) + 设施B(16)（第 3 天独立时段，避开其他测试）
  const dlegs = () => [
    { scope: 'entry', slot_id: slotOf('entry', 3, 13).id },
    { scope: 'ride', slot_id: slotOf('ride', 3, 14, rides[0].id).id, ride_id: rides[0].id },
    { scope: 'ride', slot_id: slotOf('ride', 3, 16, rides[1].id).id, ride_id: rides[1].id }
  ]
  const sub = G.submitGroup({ leader_name: 'A', headcount: 8, deposit_rate: 30,
    legs: dlegs() }, 'd-sub')
  G.confirmGroup(sub.id, 'd-conf')
  const rideB = rides[1]
  const oldSlot = slotOf('ride', 3, 16, rideB.id)
  assert.equal(oldSlot.booked_count, 8)

  // 停运设施 B：应改排到同团空闲的其他运营设施（A 在 14 点，不同时刻）
  const beforeComplaints = complaints
  RSV.syncRideSlots({ ...rideB, status: 'maintenance' })
  const after = legsOf(sub.id)[2]
  assert.equal(after.reschedules, 1)
  assert.notEqual(after.ride_id, rideB.id, '应跨设施改排到其他运营设施')
  assert.equal(slotOf('ride', 3, 16, rideB.id).booked_count, 0, '原时段名额释放')
  const newSlot = slotOf('ride', after.slot_day, after.slot_hour, after.ride_id)
  assert.equal(newSlot.booked_count, 8, '新时段占用名额')
  assert.equal(complaints, beforeComplaints, '成功改排不产生投诉')
  assert.equal(groupRow(sub.id).total_amount, sub.total, '改排不加价')

  // 关停全部其他设施，制造无法安置场景，再停运改排后设施 → 园方全额退款
  const otherRides = db.prepare("SELECT * FROM rides WHERE status='operating'").all().filter(r => r.id !== after.ride_id)
  // 直接对该团目标设施停运，但先把除当前设施外的运营设施全部关闭时段，使 findCrossRideSlot 无候选
  const target = db.prepare('SELECT * FROM rides WHERE id=?').get(after.ride_id)
  // 关闭其他设施未来时段（仅库存层，使候选不可用）
  for (const r of otherRides) {
    db.prepare("UPDATE reservation_slots SET status='closed' WHERE scope='ride' AND ride_id=?").run(r.id)
  }
  const cash0 = cash()
  const c0 = complaints
  RSV.syncRideSlots({ ...target, status: 'maintenance' })
  const legNow = legsOf(sub.id)[2]
  assert.equal(legNow.status, 'refunded')
  assert.ok(legNow.refund_amount > 0, '园方按已收款比例全额退回该腿订金')
  assert.equal(groupRow(sub.id).fee_amount, 0, '园方原因不计手续费')
  assert.ok(complaints > c0, '无法改排应生成投诉')
  // 现金确实退回
  assert.ok(cash() < cash0)
})

test('单时段关闭：团内命中腿自动改期到同设施其他时段，不退款不投诉', () => {
  setClock(1, 9)
  reopenRideSlots(3)
  const slegs = () => [
    { scope: 'entry', slot_id: slotOf('entry', 3, 9).id },
    { scope: 'ride', slot_id: slotOf('ride', 3, 11, rides[2].id).id, ride_id: rides[2].id },
    { scope: 'ride', slot_id: slotOf('ride', 3, 15, rides[2].id).id, ride_id: rides[2].id }
  ]
  const sub = G.submitGroup({ leader_name: 'B', headcount: 6, deposit_rate: 30,
    legs: slegs() }, 's-sub')
  G.confirmGroup(sub.id, 's-conf')
  const rideC = rides[2]
  const s11 = slotOf('ride', 3, 11, rideC.id)
  const c0 = complaints
  RSV.updateSlot(s11.id, { status: 'closed' })
  const a = legsOf(sub.id)[1]
  assert.equal(a.reschedules, 1)
  assert.equal(a.ride_id, rideC.id, '同设施改期')
  assert.notEqual(a.slot_hour, 11)
  assert.equal(a.status, 'locked')
  assert.equal(complaints, c0, '改期成功不投诉不退款')
  assert.equal(a.refund_amount, 0)
})

test('闭园日结：当日未核销项目按爽约结清（不退款不补收尾款），未入园团撤单', () => {
  setClock(1, 9)
  reopenRideSlots(3)
  // 确认第 3 天行程，全天无人核销（独立时段；rides[2] 未被前序测试停运）
  const nlegs = () => [
    { scope: 'entry', slot_id: slotOf('entry', 3, 9).id },
    { scope: 'ride', slot_id: slotOf('ride', 3, 13, rides[2].id).id, ride_id: rides[2].id }
  ]
  const sub = G.submitGroup({ leader_name: 'C', headcount: 5, deposit_rate: 30,
    legs: nlegs() }, 'n-sub')
  assert.equal(sub.ok, true, sub.msg || '提交失败')
  G.confirmGroup(sub.id, 'n-conf')
  setClock(3, 18)
  const g0 = groupRow(sub.id)
  const cash0 = cash()
  const r = G.dayCloseGroups(3)
  assert.ok(r.groups >= 1)
  const g1 = groupRow(sub.id)
  assert.equal(g1.status, 'cancelled', '未入园团撤单')
  assert.equal(g1.cancelled_amount, g0.total_amount)
  assert.equal(cash(), cash0, '订金不退、尾款不补收')
  legsOf(sub.id).forEach(l => assert.equal(l.status, 'noshow'))
  // 锚点单进入 noshow
  const anchors = db.prepare("SELECT COUNT(*) n FROM reservations WHERE group_id=? AND status='noshow'").get(sub.id).n
  assert.ok(anchors >= 1)
  // 重复日结幂等：无残留可处理
  const again = G.dayCloseGroups(3)
  assert.equal(again.legs, 0)
  const legs2 = legsOf(sub.id)
  assert.ok(legs2.every(l => l.status === 'noshow'))
})
