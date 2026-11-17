module page_control {
  type State = { owner: int, cancelled: bool, epoch: int, pending: bool, ticket: int, ready: bool, blocked: bool, violation: bool, dispatched: int, stoppedAt: int, successorDispatches: int }
  var s: State
  action init = s' = { owner: 1, cancelled: false, epoch: 0, pending: false, ticket: 0, ready: true, blocked: false, violation: false, dispatched: 0, stoppedAt: 0, successorDispatches: 0 }
  action queue = all { s.ready, not(s.pending), s' = s.with("pending", true).with("ticket", s.epoch) }
  action cancel = all { not(s.cancelled), s' = s.with("cancelled", true).with("stoppedAt", s.dispatched).with("epoch", s.epoch + 1) }
  action take = all { s.owner == 1, s' = s.with("owner", 2).with("blocked", true) }
  action returnPage = all { s.owner == 2, s' = s.with("owner", 1).with("blocked", false).with("epoch", s.epoch + 1) }
  action dispatch = all {
    s.pending, s.ready, not(s.cancelled), not(s.blocked), s.ticket == s.epoch,
    s' = s.with("pending", false).with("dispatched", s.dispatched + 1).with("violation", s.violation or s.owner != 1)
  }
  action successorDispatch = all { s.ready, s.owner == 2, s' = s.with("successorDispatches", s.successorDispatches + 1) }
  action lateResult = s' = s.with("pending", true).with("ticket", 0)
  action crash = all { s.ready, s' = s.with("ready", false) }
  action reconcile = all { not(s.ready), s' = s.with("ready", true).with("pending", false).with("epoch", s.epoch + 1) }
  action unsafeRestore = all { not(s.ready), s' = s.with("ready", true).with("blocked", false) }
  action step = any { queue, cancel, take, returnPage, dispatch, successorDispatch, lateResult, crash, reconcile }
  action unsafeStep = any { step, unsafeRestore }
  val authorizedDispatch = not(s.violation)
  val cancelledCannotDispatch = s.cancelled implies s.dispatched == s.stoppedAt
  val successorProgressed = s.successorDispatches > 0
  val progressed = s.dispatched > 0
}
