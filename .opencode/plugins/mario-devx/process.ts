export const pidLooksAlive = (pid: unknown): boolean | null => {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ESRCH") {
      return false;
    }
    return null;
  }
};
