// Only an explicit size rejection permits another write. Network failures and
// unknown outcomes must reach the caller without an automatic duplicate send.
export async function deliverCardWithSizeFallback(deliver, options, fallback) {
  try {
    return { message: await deliver(options), attachmentOnly: false };
  } catch (error) {
    if (error.status !== 400 || error.code !== 40005) throw error;
    return { message: await deliver(fallback()), attachmentOnly: true };
  }
}
