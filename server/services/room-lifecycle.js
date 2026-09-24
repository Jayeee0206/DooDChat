function createRoomLifecycle({
  graceMs,
  resetMemoryState,
  uploadStore,
  audioCache,
}) {
  let active = false;
  let closed = false;
  let emptyTimer = null;
  let cleaning = null;
  let cleanupCount = 0;
  let lastCleanupReason = null;

  function cancelEmptyCleanup() {
    if (!emptyTimer) return;
    clearTimeout(emptyTimer);
    emptyTimer = null;
  }

  function markOccupied() {
    if (closed) return;
    active = true;
    cancelEmptyCleanup();
  }

  async function cleanup(reason) {
    cancelEmptyCleanup();
    if (cleaning) return cleaning;
    active = false;
    lastCleanupReason = reason;

    cleaning = (async () => {
      resetMemoryState();
      const results = await Promise.allSettled([
        uploadStore.clear(),
        audioCache.clear(),
      ]);
      cleanupCount += 1;
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    })().finally(() => {
      cleaning = null;
    });

    return cleaning;
  }

  function scheduleIfEmpty(onlineCount) {
    if (closed || !active || onlineCount > 0 || emptyTimer || cleaning) return;
    emptyTimer = setTimeout(() => {
      emptyTimer = null;
      cleanup('empty-room').catch(error => {
        console.error('房间自动清理失败（下次启动会重试）:', error.message);
      });
    }, graceMs);
    emptyTimer.unref?.();
  }

  function isCleaning() {
    return cleaning !== null;
  }

  async function shutdown() {
    closed = true;
    cancelEmptyCleanup();
    await cleanup('server-shutdown');
  }

  function status() {
    return {
      active,
      cleaning: isCleaning(),
      cleanupCount,
      cleanupScheduled: emptyTimer !== null,
      lastCleanupReason,
    };
  }

  return {
    cleanup,
    isCleaning,
    markOccupied,
    scheduleIfEmpty,
    shutdown,
    status,
  };
}

module.exports = { createRoomLifecycle };
