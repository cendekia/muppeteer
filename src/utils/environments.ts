const apiPort = Number(process.env.API_PORT || 3000)

// How many renders may hold a Chrome page at once. Each render is a full
// page load plus screenshots; running many in parallel starves Chrome and
// surfaces as ProtocolError / IO.read timeouts (seen in production).
const maxConcurrentRenders = Math.max(1, Number(process.env.MAX_CONCURRENT_RENDERS || 2))

// CDP call timeout for the shared browser (puppeteer default is 180s).
const protocolTimeoutMs = Number(process.env.PROTOCOL_TIMEOUT_MS || 180000)

// How long to wait for the page's network to go quiet before rendering
// anyway. Pages with sockets or polling never go idle.
const networkIdleTimeoutMs = Number(process.env.NETWORK_IDLE_TIMEOUT_MS || 15000)

export default {
  apiPort,
  maxConcurrentRenders,
  protocolTimeoutMs,
  networkIdleTimeoutMs,
}
