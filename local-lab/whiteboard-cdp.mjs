// Bound every CDP wait so the browser owner's finally block can clean up.
export function connectCdp(ws, timeoutMs = 5000) {
  let sequence = 0;
  let failure;
  const pending = new Map();
  const wait = (id, action) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`CDP timed out: ${id}`)), timeoutMs);
    const finish = (error, value) => {
      clearTimeout(timer);
      pending.delete(id);
      if (error) reject(error);
      else resolve(value);
    };
    pending.set(id, finish);
    try { action(finish); } catch (error) { finish(error); }
  });
  const fail = error => {
    failure = error;
    for (const finish of pending.values()) finish(error);
  };
  ws.addEventListener('close', () => fail(new Error('CDP connection closed')));
  ws.addEventListener('error', () => fail(new Error('CDP connection failed')));
  ws.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data);
    const finish = pending.get(response.id);
    if (finish) finish(response.error ? new Error(JSON.stringify(response.error)) : null, response.result);
  });
  const call = (method, params = {}) => {
    if (failure) return Promise.reject(failure);
    return wait(++sequence, () => {
      if (ws.readyState !== 1) throw new Error('CDP connection is not open');
      ws.send(JSON.stringify({ id: sequence, method, params }));
    });
  };
  call.ready = wait('open', finish => {
    if (ws.readyState === 1) finish();
    else ws.addEventListener('open', () => finish(), { once: true });
  });
  return call;
}
