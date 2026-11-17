module send_confirm {
  var phase: str
  var isFrame: bool
  var coordMoved: bool
  var btnKind: str
  var hasContent: bool
  var bindingEpoch: int
  var cancelled: bool
  var declined: bool
  var pendingLock: bool
  var sendConfirmed: bool
  var confirmedBinding: int
  var userApproved: bool
  var dispatchedOnKind: str
  var dispatchedWithContent: bool
  var dispatchedApproved: bool
  var dispatchedBindingMismatch: bool
  var dispatchedCancelled: bool
  var dispatchedCount: int

  action init = all {
    phase' = "idle",
    isFrame' = false,
    coordMoved' = false,
    btnKind' = "reply",
    hasContent' = false,
    bindingEpoch' = 1,
    cancelled' = false,
    declined' = false,
    pendingLock' = false,
    sendConfirmed' = false,
    confirmedBinding' = 0,
    userApproved' = false,
    dispatchedOnKind' = "none",
    dispatchedWithContent' = false,
    dispatchedApproved' = false,
    dispatchedBindingMismatch' = false,
    dispatchedCancelled' = false,
    dispatchedCount' = 0,
  }

  action startClick(frameFlag: bool, initKind: str, initContent: bool): bool = all {
    phase == "idle",
    not(cancelled),
    initKind != "pay",
    phase' = "located",
    isFrame' = frameFlag,
    coordMoved' = false,
    btnKind' = initKind,
    hasContent' = initContent,
    bindingEpoch' = bindingEpoch,
    cancelled' = cancelled,
    declined' = declined,
    pendingLock' = pendingLock,
    sendConfirmed' = false,
    confirmedBinding' = 0,
    userApproved' = false,
    dispatchedOnKind' = dispatchedOnKind,
    dispatchedWithContent' = dispatchedWithContent,
    dispatchedApproved' = dispatchedApproved,
    dispatchedBindingMismatch' = dispatchedBindingMismatch,
    dispatchedCancelled' = dispatchedCancelled,
    dispatchedCount' = dispatchedCount,
  }

  action skipConfirm = all {
    phase == "located",
    (btnKind == "normal") or (btnKind == "reply" and not(hasContent)),
    phase' = "moving",
    sendConfirmed' = false,
    isFrame' = isFrame, coordMoved' = coordMoved, btnKind' = btnKind, hasContent' = hasContent,
    bindingEpoch' = bindingEpoch, cancelled' = cancelled, declined' = declined,
    pendingLock' = pendingLock, confirmedBinding' = confirmedBinding, userApproved' = userApproved,
    dispatchedOnKind' = dispatchedOnKind, dispatchedWithContent' = dispatchedWithContent,
    dispatchedApproved' = dispatchedApproved, dispatchedBindingMismatch' = dispatchedBindingMismatch,
    dispatchedCancelled' = dispatchedCancelled, dispatchedCount' = dispatchedCount,
  }

  action enterConfirm = all {
    phase == "located",
    (btnKind == "send") or (btnKind == "reply" and hasContent),
    not(declined),
    not(pendingLock),
    phase' = "waiting_user",
    pendingLock' = true,
    confirmedBinding' = bindingEpoch,
    isFrame' = isFrame, coordMoved' = coordMoved, btnKind' = btnKind, hasContent' = hasContent,
    bindingEpoch' = bindingEpoch, cancelled' = cancelled, declined' = declined,
    sendConfirmed' = sendConfirmed, userApproved' = userApproved,
    dispatchedOnKind' = dispatchedOnKind, dispatchedWithContent' = dispatchedWithContent,
    dispatchedApproved' = dispatchedApproved, dispatchedBindingMismatch' = dispatchedBindingMismatch,
    dispatchedCancelled' = dispatchedCancelled, dispatchedCount' = dispatchedCount,
  }

  action userApprove = all {
    phase == "waiting_user",
    not(cancelled),
    confirmedBinding == bindingEpoch,
    phase' = "moving",
    pendingLock' = false,
    sendConfirmed' = true,
    userApproved' = true,
    isFrame' = isFrame, coordMoved' = coordMoved, btnKind' = btnKind, hasContent' = hasContent,
    bindingEpoch' = bindingEpoch, cancelled' = cancelled, declined' = declined,
    confirmedBinding' = confirmedBinding,
    dispatchedOnKind' = dispatchedOnKind, dispatchedWithContent' = dispatchedWithContent,
    dispatchedApproved' = dispatchedApproved, dispatchedBindingMismatch' = dispatchedBindingMismatch,
    dispatchedCancelled' = dispatchedCancelled, dispatchedCount' = dispatchedCount,
  }

  action userDecline = all {
    phase == "waiting_user",
    phase' = "aborted",
    pendingLock' = false,
    declined' = true,
    isFrame' = isFrame, coordMoved' = coordMoved, btnKind' = btnKind, hasContent' = hasContent,
    bindingEpoch' = bindingEpoch, cancelled' = cancelled,
    sendConfirmed' = sendConfirmed, confirmedBinding' = confirmedBinding, userApproved' = userApproved,
    dispatchedOnKind' = dispatchedOnKind, dispatchedWithContent' = dispatchedWithContent,
    dispatchedApproved' = dispatchedApproved, dispatchedBindingMismatch' = dispatchedBindingMismatch,
    dispatchedCancelled' = dispatchedCancelled, dispatchedCount' = dispatchedCount,
  }

  action abortWaiting = all {
    phase == "waiting_user",
    phase' = "aborted",
    pendingLock' = false,
    isFrame' = isFrame, coordMoved' = coordMoved, btnKind' = btnKind, hasContent' = hasContent,
    bindingEpoch' = bindingEpoch, cancelled' = cancelled, declined' = declined,
    sendConfirmed' = sendConfirmed, confirmedBinding' = confirmedBinding, userApproved' = userApproved,
    dispatchedOnKind' = dispatchedOnKind, dispatchedWithContent' = dispatchedWithContent,
    dispatchedApproved' = dispatchedApproved, dispatchedBindingMismatch' = dispatchedBindingMismatch,
    dispatchedCancelled' = dispatchedCancelled, dispatchedCount' = dispatchedCount,
  }

  action finishMovingLegacy(moved: bool): bool = all {
    phase == "moving",
    not(cancelled),
    not(moved and btnKind == "pay"),
    not(moved and not(sendConfirmed) and ((btnKind == "send") or (btnKind == "reply" and hasContent))),
    not(sendConfirmed and confirmedBinding != bindingEpoch),
    not(isFrame and btnKind == "pay"),
    not(isFrame and not(sendConfirmed) and (btnKind == "send" or btnKind == "reply")),
    phase' = "preflight",
    coordMoved' = moved,
    isFrame' = isFrame, btnKind' = btnKind, hasContent' = hasContent,
    bindingEpoch' = bindingEpoch, cancelled' = cancelled, declined' = declined,
    pendingLock' = pendingLock, sendConfirmed' = sendConfirmed,
    confirmedBinding' = confirmedBinding, userApproved' = userApproved,
    dispatchedOnKind' = dispatchedOnKind, dispatchedWithContent' = dispatchedWithContent,
    dispatchedApproved' = dispatchedApproved, dispatchedBindingMismatch' = dispatchedBindingMismatch,
    dispatchedCancelled' = dispatchedCancelled, dispatchedCount' = dispatchedCount,
  }

  action finishMovingGuarded(moved: bool): bool = all {
    phase == "moving",
    not(cancelled),
    not(moved and btnKind == "pay"),
    not(moved and not(sendConfirmed) and ((btnKind == "send") or (btnKind == "reply" and hasContent))),
    not(sendConfirmed and confirmedBinding != bindingEpoch),
    btnKind != "pay",
    not(not(sendConfirmed) and (btnKind == "send" or (btnKind == "reply" and hasContent))),
    phase' = "preflight",
    coordMoved' = moved,
    isFrame' = isFrame, btnKind' = btnKind, hasContent' = hasContent,
    bindingEpoch' = bindingEpoch, cancelled' = cancelled, declined' = declined,
    pendingLock' = pendingLock, sendConfirmed' = sendConfirmed,
    confirmedBinding' = confirmedBinding, userApproved' = userApproved,
    dispatchedOnKind' = dispatchedOnKind, dispatchedWithContent' = dispatchedWithContent,
    dispatchedApproved' = dispatchedApproved, dispatchedBindingMismatch' = dispatchedBindingMismatch,
    dispatchedCancelled' = dispatchedCancelled, dispatchedCount' = dispatchedCount,
  }

  action dispatchPress = all {
    phase == "preflight",
    not(cancelled),
    phase' = "dispatched",
    dispatchedOnKind' = btnKind,
    dispatchedWithContent' = hasContent,
    dispatchedApproved' = userApproved,
    dispatchedBindingMismatch' = (sendConfirmed and confirmedBinding != bindingEpoch),
    dispatchedCancelled' = cancelled,
    dispatchedCount' = dispatchedCount + 1,
    isFrame' = isFrame, coordMoved' = coordMoved, btnKind' = btnKind, hasContent' = hasContent,
    bindingEpoch' = bindingEpoch, cancelled' = cancelled, declined' = declined,
    pendingLock' = pendingLock, sendConfirmed' = sendConfirmed,
    confirmedBinding' = confirmedBinding, userApproved' = userApproved,
  }

  action dispatchPressGuarded = all {
    phase == "preflight",
    not(cancelled),
    btnKind != "pay",
    not(not(sendConfirmed) and (btnKind == "send" or (btnKind == "reply" and hasContent))),
    not(sendConfirmed and confirmedBinding != bindingEpoch),
    phase' = "dispatched",
    dispatchedOnKind' = btnKind,
    dispatchedWithContent' = hasContent,
    dispatchedApproved' = userApproved,
    dispatchedBindingMismatch' = false,
    dispatchedCancelled' = cancelled,
    dispatchedCount' = dispatchedCount + 1,
    isFrame' = isFrame, coordMoved' = coordMoved, btnKind' = btnKind, hasContent' = hasContent,
    bindingEpoch' = bindingEpoch, cancelled' = cancelled, declined' = declined,
    pendingLock' = pendingLock, sendConfirmed' = sendConfirmed,
    confirmedBinding' = confirmedBinding, userApproved' = userApproved,
  }

  action pageMutateButton(newKind: str, newContent: bool): bool = all {
    phase == "moving" or phase == "waiting_user",
    btnKind' = newKind,
    hasContent' = newContent,
    bindingEpoch' = bindingEpoch + 1,
    phase' = phase, isFrame' = isFrame, coordMoved' = coordMoved,
    cancelled' = cancelled, declined' = declined, pendingLock' = pendingLock,
    sendConfirmed' = sendConfirmed, confirmedBinding' = confirmedBinding, userApproved' = userApproved,
    dispatchedOnKind' = dispatchedOnKind, dispatchedWithContent' = dispatchedWithContent,
    dispatchedApproved' = dispatchedApproved, dispatchedBindingMismatch' = dispatchedBindingMismatch,
    dispatchedCancelled' = dispatchedCancelled, dispatchedCount' = dispatchedCount,
  }

  action userCancel = all {
    not(cancelled),
    cancelled' = true,
    phase' = phase, isFrame' = isFrame, coordMoved' = coordMoved,
    btnKind' = btnKind, hasContent' = hasContent, bindingEpoch' = bindingEpoch,
    declined' = declined, pendingLock' = pendingLock, sendConfirmed' = sendConfirmed,
    confirmedBinding' = confirmedBinding, userApproved' = userApproved,
    dispatchedOnKind' = dispatchedOnKind, dispatchedWithContent' = dispatchedWithContent,
    dispatchedApproved' = dispatchedApproved, dispatchedBindingMismatch' = dispatchedBindingMismatch,
    dispatchedCancelled' = dispatchedCancelled, dispatchedCount' = dispatchedCount,
  }

  action resetForNextClick = all {
    phase == "aborted" or phase == "dispatched",
    phase' = "idle",
    isFrame' = isFrame, coordMoved' = false, btnKind' = btnKind, hasContent' = hasContent,
    bindingEpoch' = bindingEpoch, cancelled' = cancelled, declined' = declined,
    pendingLock' = pendingLock, sendConfirmed' = false, confirmedBinding' = 0, userApproved' = false,
    dispatchedOnKind' = dispatchedOnKind, dispatchedWithContent' = dispatchedWithContent,
    dispatchedApproved' = dispatchedApproved, dispatchedBindingMismatch' = dispatchedBindingMismatch,
    dispatchedCancelled' = dispatchedCancelled, dispatchedCount' = dispatchedCount,
  }

  action unsafeStep = any {
    startClick(false, "normal", false),
    startClick(false, "reply", false),
    startClick(false, "reply", true),
    startClick(false, "send", true),
    startClick(true, "reply", false),
    startClick(true, "send", true),
    skipConfirm,
    enterConfirm,
    userApprove,
    userDecline,
    abortWaiting,
    finishMovingLegacy(false),
    finishMovingLegacy(true),
    dispatchPress,
    pageMutateButton("send", true),
    pageMutateButton("reply", true),
    pageMutateButton("pay", true),
    userCancel,
    resetForNextClick,
  }

  action step = any {
    startClick(false, "normal", false),
    startClick(false, "reply", false),
    startClick(false, "reply", true),
    startClick(false, "send", true),
    startClick(true, "reply", false),
    startClick(true, "send", true),
    skipConfirm,
    enterConfirm,
    userApprove,
    userDecline,
    abortWaiting,
    finishMovingGuarded(false),
    finishMovingGuarded(true),
    dispatchPressGuarded,
    pageMutateButton("send", true),
    pageMutateButton("reply", true),
    pageMutateButton("pay", true),
    userCancel,
    resetForNextClick,
  }

  val noUnconfirmedSend =
    (dispatchedOnKind == "send" or (dispatchedOnKind == "reply" and dispatchedWithContent))
      implies (dispatchedApproved and not(dispatchedBindingMismatch))
  val noPayClick = dispatchedOnKind != "pay"
  val noCancelledDispatch = not(dispatchedCancelled)
  val progressed = dispatchedCount > 0
}
