// WebSocket heartbeat — standard `ws` library ping/pong zombie detection.
//
// Extracted from server.js so the behavior is unit-testable: server.js wires
// it to the real WebSocketServer; tests drive it with fake sockets and timers.

export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Mark a new connection alive and reset the flag whenever a pong arrives.
 * Call once per connection from the wss 'connection' handler.
 */
export function attachHeartbeat(ws) {
  ws._isAlive = true;
  ws.on('pong', () => { ws._isAlive = true; });
}

/**
 * One heartbeat sweep: terminate sockets that missed the previous ping,
 * ping the live ones, and invoke `onAlive(ws)` for each surviving socket
 * (server.js uses this to send the game state-sync heartbeat).
 */
export function heartbeatTick(wss, onAlive) {
  for (const ws of wss.clients) {
    if (!ws._isAlive) { ws.terminate(); continue; }
    ws._isAlive = false;
    ws.ping();
    onAlive?.(ws);
  }
}

/**
 * Start the periodic sweep. The interval is cleared when the wss closes.
 * `timers` is injectable for tests; returns the interval handle.
 */
export function startHeartbeat(wss, onAlive, intervalMs = HEARTBEAT_INTERVAL_MS,
                               timers = { setInterval, clearInterval }) {
  const handle = timers.setInterval(() => heartbeatTick(wss, onAlive), intervalMs);
  wss.on('close', () => timers.clearInterval(handle));
  return handle;
}
