export async function requestWakeLock() {
  if (!navigator.wakeLock) {
    return null;
  }

  try {
    return await navigator.wakeLock.request("screen");
  } catch {
    return null;
  }
}

export async function releaseWakeLock(lock: WakeLockSentinel | null) {
  if (!lock || lock.released) {
    return;
  }

  await lock.release().catch(() => undefined);
}
