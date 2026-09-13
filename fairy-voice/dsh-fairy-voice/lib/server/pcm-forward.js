/* PCM forwarding has no route, provider, or settings ownership. It only moves
 * an upstream audio body to the downstream response with cancellation. */
export function createPcmStreamHandler() {
  return {
    async pipe(response, res, signal) {
      if (!response.body) throw Object.assign(new Error('local synthesis returned no audio'), { code: 'local-service-failed' });
      try {
        for await (const chunk of response.body) {
          if (signal.aborted) break;
          if (!res.write(Buffer.from(chunk))) {
            await new Promise((resolve) => {
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                res.removeListener('drain', finish);
                res.removeListener('close', finish);
                signal.removeEventListener('abort', finish);
                resolve();
              };
              res.once('drain', finish);
              res.once('close', finish);
              signal.addEventListener('abort', finish, { once: true });
            });
          }
        }
      } finally {
        // Breaking an async iterator does not close every fetch implementation's
        // body immediately. Explicitly cancel an aborted stream so session
        // switches, reloads, and client disconnects release the socket now.
        if (signal.aborted && typeof response.body.cancel === 'function') {
          await response.body.cancel().catch((error) => {
            if (!signal.aborted && error?.name !== 'AbortError') throw error;
          });
        }
      }
    },
  };
}
